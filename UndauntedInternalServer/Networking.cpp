#include "Networking.h"

#include <iostream>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using namespace SDK;

namespace Networking {
    UNetDriver* NetDriver = nullptr;

    namespace {
        // Replication config: default keeps the proven cache/channel optimizations on.
        constexpr bool kEnableOptimizedReplication = true;
        constexpr bool kEnableReplicationThrottling = true;
        constexpr bool kAlwaysReplicateCriticalActors = true;
        constexpr uint32_t kConnectionWarmupFullReplicationTicks = 300;

        constexpr uintptr_t OffsetActorGetWorldVTable = 0x150;
        constexpr uintptr_t OffsetActorSetNetDriver = 0x306B150;
        constexpr uintptr_t OffsetCreateNamedNetDriver = 0x371A5E0;
        constexpr uintptr_t OffsetSetNetDriverWorld = 0x3491890;
        constexpr uintptr_t OffsetNetDriverTickCount = 0x2AC;
        constexpr uintptr_t OffsetConnectionState = 0x134;
        constexpr uintptr_t OffsetNetDriverLowLevelListen = 0x280;
        constexpr uintptr_t OffsetCreateChannelByName = 0x3449E10;
        constexpr uintptr_t OffsetSetChannelActor = 0x3283450;
        constexpr uintptr_t OffsetActorChannelReplicationFlags = 0x90;
        constexpr uintptr_t OffsetActorChannelReplicateActor = 0x327E860;
        constexpr uintptr_t OffsetPlayerControllerUpdateCamera = 0x359F9D0;

        constexpr uint32_t OpenChannelFlag = 1 << 1;
        constexpr uint32_t ReplicationFlagNeedsTick = 2u;
        constexpr uint32_t OpenConnectionState = 3;
        constexpr ULONGLONG ConsiderCacheMaxAgeMs = 100;

        constexpr float CharacterMovementDeltaSquared = 10.0f * 10.0f;
        constexpr float BehemothMovementDeltaSquared = 25.0f * 25.0f;
        constexpr float ProjectileMovementDeltaSquared = 5.0f * 5.0f;
        constexpr float DefaultMovementDeltaSquared = 75.0f * 75.0f;
        constexpr float CharacterRotationDelta = 4.0f;
        constexpr float BehemothRotationDelta = 6.0f;
        constexpr float ProjectileRotationDelta = 3.0f;
        constexpr float DefaultRotationDelta = 20.0f;

        using GetActorWorldFn = UWorld* (*)(AActor*);
        using SetActorNetDriverFn = void (*)(AActor*, UNetDriver*);
        using CreateNamedNetDriverFn = uint8_t (*)(UEngine*, void*, FName, FName);
        using SetNetDriverWorldFn = void (*)(UNetDriver*, UWorld*);
        using LowLevelListenFn = bool (*)(UNetDriver*, void*, FURL*, bool, FString*);
        using CreateChannelByNameFn = UActorChannel* (*)(UNetConnection*, FName*, unsigned int, int);
        using SetChannelActorFn = void (*)(UActorChannel*, AActor*, unsigned int);
        using ReplicateActorFn = bool (*)(UActorChannel*);
        using UpdateCameraFn = void (*)(APlayerController*);

        enum class ReplicationBucket : uint8_t {
            Immediate,
            ArchonCharacter,
            ArchonBehemoth,
            Projectile,
            PawnOrCharacter,
            MovementActor
        };

        struct ReplicationPolicy {
            uint32_t Interval;
            float MovementDeltaSquared;
            float RotationDelta;
        };

        struct TransformSample {
            FVector Location{};
            FRotator Rotation{};
            bool Valid = false;
        };

        struct ActorReplicationState {
            TransformSample LastSample{};
            uint32_t LastReplicatedTick = 0;
            bool HasReplicated = false;
        };

        struct ReplicationClassCache {
            UClass* PlayerController = nullptr;
            UClass* ArchonCharacter = nullptr;
            UClass* ArchonBehemoth = nullptr;
            UClass* ArchonLantern = nullptr;
            UClass* Projectile = nullptr;
            UClass* Pawn = nullptr;
        };

        struct ReplicationCandidate {
            AActor* Actor = nullptr;
            ReplicationBucket Bucket = ReplicationBucket::Immediate;
            ReplicationPolicy Policy{ 1, 0.0f, 0.0f };
            bool IsPlayerController = false;
            bool IsCritical = false;
        };
    }

    static uintptr_t BaseAddress = 0x0;
    static std::vector<ReplicationCandidate> ConsiderCache{};
    static std::vector<ReplicationCandidate*> ReplicateList{};
    static std::unordered_set<ReplicationCandidate*> ReplicateSet{};
    static std::vector<int> CachedLevelActorCounts{};
    static UWorld* CachedWorld = nullptr;
    static ULONGLONG LastConsiderCacheBuildMs = 0;
    static std::unordered_map<AActor*, UActorChannel*> ScratchActorChannels{};
    static std::unordered_map<AActor*, ActorReplicationState> ActorReplicationStates{};
    static std::unordered_map<UNetConnection*, uint32_t> ConnectionOpenedTicks{};

    static bool IsOpenConnection(UNetConnection* Connection) {
        return Connection
            && Connection->OwningActor
            && *reinterpret_cast<uint32_t*>((uintptr_t)Connection + OffsetConnectionState) == OpenConnectionState;
    }

    static void ResetConsiderCache() {
        ConsiderCache.clear();
        ReplicateList.clear();
        ReplicateSet.clear();
        CachedLevelActorCounts.clear();
        ActorReplicationStates.clear();
        ConnectionOpenedTicks.clear();
        CachedWorld = nullptr;
        LastConsiderCacheBuildMs = 0;
    }

    static bool RefreshConnectionState(UNetDriver* Driver, uint32_t CurrentTick) {
        if (!Driver)
            return false;

        bool DidChange = false;
        std::unordered_set<UNetConnection*> LiveConnections{};
        LiveConnections.reserve(Driver->ClientConnections.Num());

        for (UNetConnection* Connection : Driver->ClientConnections) {
            if (!IsOpenConnection(Connection))
                continue;

            LiveConnections.insert(Connection);

            if (!ConnectionOpenedTicks.contains(Connection)) {
                ConnectionOpenedTicks[Connection] = CurrentTick;
                DidChange = true;
            }
        }

        for (auto It = ConnectionOpenedTicks.begin(); It != ConnectionOpenedTicks.end();) {
            if (!LiveConnections.contains(It->first)) {
                It = ConnectionOpenedTicks.erase(It);
                DidChange = true;
            }
            else {
                ++It;
            }
        }

        if (DidChange)
            ActorReplicationStates.clear();

        return DidChange;
    }

    static bool IsConnectionWarmingUp(UNetConnection* Connection, uint32_t CurrentTick) {
        auto It = ConnectionOpenedTicks.find(Connection);

        if (It == ConnectionOpenedTicks.end())
            return kConnectionWarmupFullReplicationTicks > 0;

        return CurrentTick - It->second < kConnectionWarmupFullReplicationTicks;
    }

    static UWorld* GetActorWorld(AActor* Actor) {
        if (!Actor || !Actor->VTable)
            return nullptr;

        return reinterpret_cast<GetActorWorldFn>(*(void**)((uintptr_t)Actor->VTable + OffsetActorGetWorldVTable))(Actor);
    }

    static bool IsActorReplicationCandidate(UWorld* World, AActor* Actor) {
        return World
            && Actor
            && Actor->Class
            && Actor->RemoteRole != ENetRole::ROLE_None
            && !Actor->bActorIsBeingDestroyed
            && GetActorWorld(Actor) == World;
    }

    static __forceinline bool IsCachedActorStillReplicatable(AActor* Actor) {
        return Actor
            && Actor->Class
            && Actor->RemoteRole != ENetRole::ROLE_None
            && !Actor->bActorIsBeingDestroyed;
    }

    static int CountWorldActors(UWorld* World) {
        int TotalActorCount = 0;

        for (ULevel* Level : World->Levels) {
            if (Level)
                TotalActorCount += Level->Actors.Num();
        }

        return TotalActorCount;
    }

    static bool ShouldRebuildConsiderCache(UWorld* World) {
        if (!World)
            return false;

        if (CachedWorld != World)
            return true;

        if (GetTickCount64() - LastConsiderCacheBuildMs >= ConsiderCacheMaxAgeMs)
            return true;

        if (CachedLevelActorCounts.size() != World->Levels.Num())
            return true;

        for (int i = 0; i < World->Levels.Num(); i++) {
            ULevel* Level = World->Levels[i];
            int ActorCount = Level ? Level->Actors.Num() : -1;

            if (CachedLevelActorCounts[i] != ActorCount)
                return true;
        }

        return false;
    }

    static __forceinline float VectorDistanceSquared(const FVector& A, const FVector& B) {
        float X = A.X - B.X;
        float Y = A.Y - B.Y;
        float Z = A.Z - B.Z;

        return X * X + Y * Y + Z * Z;
    }

    static __forceinline float RotationDelta(const FRotator& A, const FRotator& B) {
        float Pitch = A.Pitch > B.Pitch ? A.Pitch - B.Pitch : B.Pitch - A.Pitch;
        float Yaw = A.Yaw > B.Yaw ? A.Yaw - B.Yaw : B.Yaw - A.Yaw;
        float Roll = A.Roll > B.Roll ? A.Roll - B.Roll : B.Roll - A.Roll;
        float MaxPitchYaw = Pitch > Yaw ? Pitch : Yaw;

        return MaxPitchYaw > Roll ? MaxPitchYaw : Roll;
    }

    static __forceinline TransformSample SampleActorTransform(AActor* Actor) {
        TransformSample Sample{};

        if (Actor->RootComponent) {
            Sample.Location = Actor->RootComponent->RelativeLocation;
            Sample.Rotation = Actor->RootComponent->RelativeRotation;
        }
        else {
            Sample.Location = Actor->ReplicatedMovement.Location;
            Sample.Rotation = Actor->ReplicatedMovement.Rotation;
        }

        Sample.Valid = true;
        return Sample;
    }

    static __forceinline bool HasAnyMovementSignal(AActor* Actor, const TransformSample& Sample) {
        return !Sample.Location.IsZero()
            || !Actor->ReplicatedMovement.LinearVelocity.IsZero()
            || !Actor->ReplicatedMovement.AngularVelocity.IsZero();
    }

    static ReplicationPolicy GetReplicationPolicy(ReplicationBucket Bucket) {
        switch (Bucket) {
        case ReplicationBucket::ArchonCharacter:
            return { 2, CharacterMovementDeltaSquared, CharacterRotationDelta };
        case ReplicationBucket::ArchonBehemoth:
            return { 2, BehemothMovementDeltaSquared, BehemothRotationDelta };
        case ReplicationBucket::Projectile:
            return { 1, ProjectileMovementDeltaSquared, ProjectileRotationDelta };
        case ReplicationBucket::PawnOrCharacter:
            return { 4, CharacterMovementDeltaSquared, CharacterRotationDelta };
        case ReplicationBucket::MovementActor:
            return { 6, DefaultMovementDeltaSquared, DefaultRotationDelta };
        default:
            return { 1, 0.0f, 0.0f };
        }
    }

    static ReplicationBucket ClassifyReplicationBucket(AActor* Actor, const ReplicationClassCache& ClassCache, const TransformSample& Sample, bool IsPlayerController) {
        if (IsPlayerController || Actor->IsA(ClassCache.ArchonLantern) || !Actor->bReplicateMovement)
            return ReplicationBucket::Immediate;

        if (Actor->IsA(ClassCache.ArchonCharacter))
            return ReplicationBucket::ArchonCharacter;

        if (Actor->IsA(ClassCache.ArchonBehemoth))
            return ReplicationBucket::ArchonBehemoth;

        if (Actor->IsA(ClassCache.Projectile))
            return ReplicationBucket::Projectile;

        if (Actor->IsA(ClassCache.Pawn))
            return ReplicationBucket::PawnOrCharacter;

        return HasAnyMovementSignal(Actor, Sample)
            ? ReplicationBucket::MovementActor
            : ReplicationBucket::Immediate;
    }

    static bool IsCriticalReplicationActor(AActor* Actor, const ReplicationClassCache& ClassCache, bool IsPlayerController) {
        if (!kAlwaysReplicateCriticalActors)
            return false;

        return IsPlayerController
            || Actor->IsA(ClassCache.ArchonCharacter)
            || Actor->IsA(ClassCache.ArchonLantern);
    }

    static bool IsConnectionCriticalActor(AActor* Actor, UNetConnection* Connection) {
        if (!kAlwaysReplicateCriticalActors || !Actor || !Connection)
            return false;

        AActor* OwningActor = Connection->OwningActor;
        AActor* OwnedPawn = Connection->PlayerController ? Connection->PlayerController->Pawn : nullptr;
        AActor* ViewTarget = Connection->ViewTarget;

        return Actor == OwningActor
            || Actor == OwnedPawn
            || Actor == ViewTarget;
    }

    static void PruneReplicationState(UWorld* World) {
        for (auto It = ActorReplicationStates.begin(); It != ActorReplicationStates.end();) {
            if (!IsActorReplicationCandidate(World, It->first))
                It = ActorReplicationStates.erase(It);
            else
                ++It;
        }
    }

    static void RebuildConsiderCache(UWorld* World, UNetDriver* Driver, const ReplicationClassCache& ClassCache) {
        if (!World || !Driver) {
            ResetConsiderCache();
            return;
        }

        SetActorNetDriverFn SetActorNetDriver = reinterpret_cast<SetActorNetDriverFn>(BaseAddress + OffsetActorSetNetDriver);
        int TotalActorCount = CountWorldActors(World);

        ConsiderCache.clear();
        CachedLevelActorCounts.clear();
        ConsiderCache.reserve(TotalActorCount);
        ReplicateList.reserve(TotalActorCount);
        ActorReplicationStates.reserve(TotalActorCount);
        CachedLevelActorCounts.reserve(World->Levels.Num());

        for (ULevel* Level : World->Levels) {
            CachedLevelActorCounts.push_back(Level ? Level->Actors.Num() : -1);

            if (!Level)
                continue;

            for (AActor* Actor : Level->Actors) {
                if (!IsActorReplicationCandidate(World, Actor))
                    continue;

                TransformSample Sample = SampleActorTransform(Actor);
                bool IsPlayerController = Actor->IsA(ClassCache.PlayerController);
                ReplicationBucket Bucket = ClassifyReplicationBucket(Actor, ClassCache, Sample, IsPlayerController);
                bool IsCritical = IsCriticalReplicationActor(Actor, ClassCache, IsPlayerController);

                SetActorNetDriver(Actor, Driver);
                ConsiderCache.push_back({ Actor, Bucket, GetReplicationPolicy(Bucket), IsPlayerController, IsCritical });
            }
        }

        CachedWorld = World;
        LastConsiderCacheBuildMs = GetTickCount64();
        PruneReplicationState(World);
    }

    static void BuildReplicateList(uint32_t CurrentTick) {
        ReplicateList.clear();
        ReplicateSet.clear();
        ReplicateList.reserve(ConsiderCache.size());
        ReplicateSet.reserve(ConsiderCache.size());

        for (ReplicationCandidate& Candidate : ConsiderCache) {
            AActor* Actor = Candidate.Actor;

            if (!IsCachedActorStillReplicatable(Actor))
                continue;

            if (!kEnableReplicationThrottling || Candidate.IsCritical || Candidate.Bucket == ReplicationBucket::Immediate) {
                ReplicateList.push_back(&Candidate);
                ReplicateSet.insert(&Candidate);
                continue;
            }

            TransformSample Sample = SampleActorTransform(Actor);
            ActorReplicationState& State = ActorReplicationStates[Actor];

            if (!State.HasReplicated || !State.LastSample.Valid || !Sample.Valid) {
                State.LastSample = Sample;
                State.LastReplicatedTick = CurrentTick;
                State.HasReplicated = true;
                ReplicateList.push_back(&Candidate);
                ReplicateSet.insert(&Candidate);
                continue;
            }

            bool HasMoved = VectorDistanceSquared(Sample.Location, State.LastSample.Location) >= Candidate.Policy.MovementDeltaSquared;
            bool HasRotated = RotationDelta(Sample.Rotation, State.LastSample.Rotation) >= Candidate.Policy.RotationDelta;
            bool IntervalElapsed = CurrentTick - State.LastReplicatedTick >= Candidate.Policy.Interval;

            if (!HasMoved && !HasRotated && !IntervalElapsed)
                continue;

            State.LastSample = Sample;
            State.LastReplicatedTick = CurrentTick;
            State.HasReplicated = true;
            ReplicateList.push_back(&Candidate);
            ReplicateSet.insert(&Candidate);
        }
    }

    static UNetDriver* FindFirstNetDriver() {
        for (int Index = 0; Index < SDK::UObject::GObjects->Num(); Index++)
        {
            SDK::UObject* Object = SDK::UObject::GObjects->GetByIndex(Index);

            if (!Object || Object->IsDefaultObject())
                continue;

            if (Object->IsA(SDK::UNetDriver::StaticClass()))
                return static_cast<UNetDriver*>(Object);
        }

        return nullptr;
    }

    static std::vector<ReplicationCandidate> BuildPlainConsiderList(UWorld* World, UNetDriver* Driver, const ReplicationClassCache& ClassCache) {
        std::vector<ReplicationCandidate> Actors{};

        if (!World || !Driver)
            return Actors;

        SetActorNetDriverFn SetActorNetDriver = reinterpret_cast<SetActorNetDriverFn>(BaseAddress + OffsetActorSetNetDriver);
        Actors.reserve(CountWorldActors(World));

        for (ULevel* Level : World->Levels) {
            if (!Level)
                continue;

            for (AActor* Actor : Level->Actors) {
                if (!IsActorReplicationCandidate(World, Actor))
                    continue;

                TransformSample Sample = SampleActorTransform(Actor);
                bool IsPlayerController = Actor->IsA(ClassCache.PlayerController);
                ReplicationBucket Bucket = ClassifyReplicationBucket(Actor, ClassCache, Sample, IsPlayerController);
                bool IsCritical = IsCriticalReplicationActor(Actor, ClassCache, IsPlayerController);

                SetActorNetDriver(Actor, Driver);
                Actors.push_back({ Actor, Bucket, GetReplicationPolicy(Bucket), IsPlayerController, IsCritical });
            }
        }

        return Actors;
    }

    static bool ReplicateActorForConnection(
        UNetConnection* Connection,
        AActor* Actor,
        bool IsPlayerController,
        FName& ChannelName,
        CreateChannelByNameFn CreateChannelByName,
        SetChannelActorFn SetChannelActor,
        ReplicateActorFn ReplicateActor,
        UpdateCameraFn UpdateCamera
    ) {
        if (!Connection || !Actor)
            return false;

        if (IsPlayerController) {
            if (Actor != Connection->OwningActor)
                return false;

            APlayerController* PlayerController = static_cast<APlayerController*>(Actor);
            Connection->ViewTarget = PlayerController->GetViewTarget();
            UpdateCamera(PlayerController);
        }

        UActorChannel* ActorChannel = nullptr;
        auto ActorChannelIt = ScratchActorChannels.find(Actor);

        if (ActorChannelIt != ScratchActorChannels.end()) {
            ActorChannel = ActorChannelIt->second;
        }
        else {
            ActorChannel = CreateChannelByName(Connection, &ChannelName, OpenChannelFlag, -1);

            if (ActorChannel) {
                SetChannelActor(ActorChannel, Actor, 0);
                ScratchActorChannels[Actor] = ActorChannel;
            }
        }

        if (!ActorChannel || !ActorChannel->Actor)
            return false;

        int& ReplicationFlags = *reinterpret_cast<int*>((uintptr_t)ActorChannel + OffsetActorChannelReplicationFlags);

        if (!(ReplicationFlags & ReplicationFlagNeedsTick))
            ReplicationFlags |= ReplicationFlagNeedsTick;

        ReplicateActor(ActorChannel);
        return true;
    }

    static void BuildActorChannelScratchMap(UNetConnection* Connection, UClass* ActorChannelClass) {
        ScratchActorChannels.clear();
        ScratchActorChannels.reserve(Connection ? Connection->OpenChannels.Num() : 0);

        if (!Connection)
            return;

        for (UChannel* Channel : Connection->OpenChannels) {
            if (!Channel || Channel->Class != ActorChannelClass)
                continue;

            UActorChannel* ActorChannel = static_cast<UActorChannel*>(Channel);

            if (ActorChannel->Actor)
                ScratchActorChannels[ActorChannel->Actor] = ActorChannel;
        }
    }

    bool Listen(UEngine* Engine, int Port) {
        BaseAddress = (uintptr_t)GetModuleHandleA(nullptr);

        UWorld* World = UWorld::GetWorld();

        if (!Engine || !World) {
            std::cout << "Listen failed: engine or world missing" << std::endl;
            return false;
        }

        FName GameNetDriver = UKismetStringLibrary::Conv_StringToName(L"GameNetDriver");
        CreateNamedNetDriverFn CreateNamedNetDriver = reinterpret_cast<CreateNamedNetDriverFn>(BaseAddress + OffsetCreateNamedNetDriver);

        std::cout << "Net driver create: " << (int)CreateNamedNetDriver(Engine, World, GameNetDriver, GameNetDriver) << std::endl;

        NetDriver = FindFirstNetDriver();

        if (!NetDriver) {
            std::cout << "Listen failed: no UNetDriver found" << std::endl;
            return false;
        }

        std::cout << NetDriver->GetFullName() << std::endl;

        ResetConsiderCache();

        SetNetDriverWorldFn SetNetDriverWorld = reinterpret_cast<SetNetDriverWorldFn>(BaseAddress + OffsetSetNetDriverWorld);
        SetNetDriverWorld(NetDriver, World);

        FURL url = FURL();
        url.Port = Port;

        FString empty = FString();
        LowLevelListenFn LowLevelListen = *(reinterpret_cast<LowLevelListenFn*>(*reinterpret_cast<uintptr_t*>(NetDriver) + OffsetNetDriverLowLevelListen));
        bool ListenStatus = LowLevelListen(NetDriver, static_cast<void*>(World->NetworkNotify), &url, false, &empty);

        std::cout << "Listen Status: " << ListenStatus << std::endl;

        if (!ListenStatus)
            return false;

        SetNetDriverWorld(NetDriver, World);
        World->NetDriver = NetDriver;

        return true;
    }

    void TickNetworking() {
        UWorld* World = UWorld::GetWorld();

        if (!World || !NetDriver)
            return;

        World->NetDriver = NetDriver;
        NetDriver->World = World;

        static FName ChannelName = UKismetStringLibrary::Conv_StringToName(L"Actor");
        static UClass* ActorChannelClass = UActorChannel::StaticClass();
        static ReplicationClassCache ClassCache = {
            APlayerController::StaticClass(),
            AArchonCharacter::StaticClass(),
            AArchonBehemoth::StaticClass(),
            AArchonLantern::StaticClass(),
            Aprojectile_base_bp_C::StaticClass(),
            APawn::StaticClass()
        };
        static CreateChannelByNameFn CreateChannelByName = reinterpret_cast<CreateChannelByNameFn>(BaseAddress + OffsetCreateChannelByName);
        static SetChannelActorFn SetChannelActor = reinterpret_cast<SetChannelActorFn>(BaseAddress + OffsetSetChannelActor);
        static ReplicateActorFn ReplicateActor = reinterpret_cast<ReplicateActorFn>(BaseAddress + OffsetActorChannelReplicateActor);
        static UpdateCameraFn UpdateCamera = reinterpret_cast<UpdateCameraFn>(BaseAddress + OffsetPlayerControllerUpdateCamera);

        uint32_t& NetworkTick = *reinterpret_cast<uint32_t*>((uintptr_t)NetDriver + OffsetNetDriverTickCount);
        ++NetworkTick;
        RefreshConnectionState(NetDriver, NetworkTick);

        if constexpr (kEnableOptimizedReplication) {
            if (ShouldRebuildConsiderCache(World))
                RebuildConsiderCache(World, NetDriver, ClassCache);

            BuildReplicateList(NetworkTick);
        }

        for (UNetConnection* Connection : NetDriver->ClientConnections) {
            if (!IsOpenConnection(Connection))
                continue;

            BuildActorChannelScratchMap(Connection, ActorChannelClass);

            if (Connection->PlayerController)
                Connection->ViewTarget = Connection->PlayerController->GetViewTarget();

            if constexpr (kEnableOptimizedReplication) {
                bool IsWarmup = IsConnectionWarmingUp(Connection, NetworkTick);

                for (ReplicationCandidate& Candidate : ConsiderCache) {
                    AActor* Actor = Candidate.Actor;

                    if (!IsActorReplicationCandidate(World, Actor))
                        continue;

                    bool ShouldReplicate =
                        IsWarmup
                        || !kEnableReplicationThrottling
                        || Candidate.IsCritical
                        || IsConnectionCriticalActor(Actor, Connection)
                        || ReplicateSet.contains(&Candidate);

                    if (!ShouldReplicate)
                        continue;

                    ReplicateActorForConnection(Connection, Actor, Candidate.IsPlayerController, ChannelName, CreateChannelByName, SetChannelActor, ReplicateActor, UpdateCamera);
                }
            }
            else {
                std::vector<ReplicationCandidate> Actors = BuildPlainConsiderList(World, NetDriver, ClassCache);

                for (ReplicationCandidate& Candidate : Actors) {
                    ReplicateActorForConnection(Connection, Candidate.Actor, Candidate.IsPlayerController, ChannelName, CreateChannelByName, SetChannelActor, ReplicateActor, UpdateCamera);
                }
            }
        }
    }
}
