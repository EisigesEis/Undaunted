#include "../Networking.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <unordered_map>
#include <unordered_set>
#include <vector>

using namespace SDK;

namespace Networking {
    UNetDriver* NetDriver = nullptr;
    static std::string LastListenError;
    static bool NativeDispatchOwnershipMismatchLogged = false;
    static FName NativeGameNetDriverName{};
    static bool NativeOwnershipConflictLogged = false;
    static LifecycleEventSink LifecycleSink = nullptr;

    void ConfigureLifecycleEventSink(LifecycleEventSink Sink) {
        LifecycleSink = Sink;
    }

    static void RecordLifecycleEvent(const std::string& EventName,
        const std::string& FieldsJson) {
        if (LifecycleSink != nullptr)
            LifecycleSink(EventName, FieldsJson);
    }

    namespace {
        constexpr bool kAlwaysReplicateCriticalActors = true;

        constexpr uintptr_t OffsetActorGetWorldVTable = 0x150;
        // AActor::CallPreReplication. Native ServerReplicateActors invokes this
        // once per considered actor and replication frame before any connection
        // serializes the actor. It refreshes ReplicatedMovement and calls the
        // actor/component PreReplication virtuals.
        constexpr uintptr_t OffsetActorCallPreReplication = 0x306B150;
        constexpr uintptr_t OffsetCreateNamedNetDriver = 0x371A5E0;
        constexpr uintptr_t OffsetFindNamedNetDriver = 0x37213A0;
        constexpr uintptr_t OffsetSetNetDriverWorld = 0x3491890;
        constexpr uintptr_t OffsetNetDriverNotify = 0x208;
        constexpr uintptr_t OffsetNetDriverTickCount = 0x2AC;
        constexpr uintptr_t OffsetConnectionState = 0x134;
        constexpr uintptr_t OffsetChannelFlags = 0x30;
        // Verified UIpNetDriver vtable slots in this build: +0x268 is the
        // trivial IsAvailable method, while +0x280 is InitListen and invokes
        // InitBase before creating/binding the socket.
        constexpr uintptr_t OffsetNetDriverInitListen = 0x280;
        constexpr uintptr_t OffsetCreateChannelByName = 0x3449E10;
        constexpr uintptr_t OffsetSetChannelActor = 0x3283450;
        constexpr uintptr_t OffsetActorChannelReplicationFlags = 0x90;
        constexpr uintptr_t OffsetActorChannelReplicateActor = 0x327E860;
        constexpr uintptr_t OffsetPlayerControllerUpdateCamera = 0x359F9D0;
        constexpr uintptr_t OffsetActorIsNetRelevantFor = 0x307C970;

        constexpr uint32_t OpenChannelFlag = 1 << 1;
        constexpr uint32_t ReplicationFlagNeedsTick = 2u;
        constexpr uint32_t OpenConnectionState = 3;
        constexpr uint32_t ChannelOpenAcknowledgedMask = 0x801u;
        constexpr ULONGLONG BootstrapMinimumDurationMs = 3000;
        constexpr ULONGLONG BootstrapMaximumDurationMs = 5000;
        constexpr ULONGLONG BootstrapStableMs = 1000;
        constexpr ULONGLONG DefaultConsiderCacheMaxAgeMs = 250;
        constexpr size_t MaximumOwnerChainDepth = 8;
        constexpr size_t MaximumScheduledActorsPerConnection = 4096;
        constexpr size_t MaximumUrgentDamageTargets = 32;
        constexpr ULONGLONG UrgentDamageTargetMaximumAgeMs = 1000;
        constexpr uint8_t AdaptiveNoDataThreshold = 4;
        constexpr float SchedulerMaximumFrequencyHz = 30.0f;
        // Once bootstrap has completed, quiet non-core owner-chain actors may
        // follow a conservative half-rate floor. Core presentation/combat
        // classes remain at 30 Hz and any produced data restores full rate.
        constexpr float OwnedCriticalAdaptiveFloorHz = 15.0f;
        constexpr ULONGLONG StaticRelevancyAuditMs = 1000;
        constexpr ULONGLONG IrrelevantRecheckMs = 250;
        constexpr uint16_t ImmediateMetricOverflowSlot =
            static_cast<uint16_t>(ImmediateMetricTrackedClassCount);
        constexpr uint16_t ImmediateMetricInvalidSlot =
            static_cast<uint16_t>(ImmediateMetricTrackedClassCount + 1);
        constexpr uint16_t ImmediateMetricNotApplicable = 0xFFFF;

        using GetActorWorldFn = UWorld* (*)(AActor*);
        using CallActorPreReplicationFn = void (*)(AActor*, UNetDriver*);
        using CreateNamedNetDriverFn = uint8_t (*)(UEngine*, void*, FName, FName);
        using FindNamedNetDriverFn = UNetDriver* (*)(UEngine*, void*, FName);
        using SetNetDriverWorldFn = void (*)(UNetDriver*, UWorld*);
        using InitListenFn = bool (*)(UNetDriver*, void*, FURL*, bool, FString*);
        using CreateChannelByNameFn = UActorChannel* (*)(UNetConnection*, FName*, unsigned int, int);
        using SetChannelActorFn = void (*)(UActorChannel*, AActor*, unsigned int);
        using ReplicateActorFn = bool (*)(UActorChannel*);
        using UpdateCameraFn = void (*)(APlayerController*);
        using IsNetRelevantForFn = bool (*)(AActor*, AActor*, AActor*, const FVector*);

        enum class ReplicationBucket : uint8_t {
            Immediate,
            ArchonCharacter,
            ArchonBehemoth,
            Projectile,
            PawnOrCharacter,
            MovementActor
        };

        enum ReplicationClassFlag : uint32_t {
            ClassPlayerController = 1u << 0,
            ClassArchonCharacter = 1u << 1,
            ClassArchonBehemoth = 1u << 2,
            ClassArchonLantern = 1u << 3,
            ClassProjectile = 1u << 4,
            ClassPawn = 1u << 5,
            ClassArchonEquipment = 1u << 6,
            ClassArchonLoadout = 1u << 7,
            ClassArchonAoe = 1u << 8,
            ClassArchonBeam = 1u << 9,
            ClassAbilityActor = 1u << 10
        };

        struct TransformSample {
            FVector Location{};
            FRotator Rotation{};
            bool Valid = false;
        };

        struct ObjectIdentity {
            UObject* Object = nullptr;
            int32_t Index = -1;
            int32_t SerialNumber = 0;
        };

        struct ActorReplicationState {
            ObjectIdentity Identity{};
            uint32_t LastPreReplicationTick = 0;
            uint16_t ConsecutiveImmediateNoDataPasses = 0;
            uint32_t ImmediatePassAttempts = 0;
            uint32_t ImmediatePassSuccesses = 0;
            uint32_t ImmediatePassNetworkTick = 0;
            uint32_t ImmediatePassFinalizedTick = 0;
            uint32_t ImmediateMetricGeneration = 0;
            uint16_t ImmediateMetricSlot = ImmediateMetricNotApplicable;
        };

        struct ReplicationClassCache {
            UClass* PlayerController = nullptr;
            UClass* ArchonCharacter = nullptr;
            UClass* ArchonBehemoth = nullptr;
            UClass* ArchonLantern = nullptr;
            UClass* ArchonEquipment = nullptr;
            UClass* Projectile = nullptr;
            UClass* Pawn = nullptr;
            UClass* PlayerState = nullptr;
            UClass* ArchonLoadout = nullptr;
            UClass* ArchonInventory = nullptr;
            UClass* ArchonBuff = nullptr;
            UClass* ArchonAoe = nullptr;
            UClass* ArchonBeam = nullptr;
            UClass* AbilityActor = nullptr;
            UClass* MonsterPartActor = nullptr;
        };

        struct ActorScheduleState;

        struct ReplicationCandidate {
            AActor* Actor = nullptr;
            ReplicationBucket Bucket = ReplicationBucket::Immediate;
            uint32_t ClassFlags = 0;
            bool IsPlayerController = false;
            bool IsCritical = false;
            ActorReplicationState* ReplicationState = nullptr;
			uint64_t LastReplicatedConnectionPass = 0;
        };

        struct PrioritizedCandidate {
            ReplicationCandidate* Candidate = nullptr;
            float Priority = 0.0f;
            ActorScheduleState* State = nullptr;
        };

        enum class ConnectionBootstrapPhase : uint8_t {
            Bootstrapping,
            Active
        };

        enum class InitializationActorRole : uint8_t {
            Controller,
            GameState,
            PlayerState,
            Pawn,
            ViewTarget,
            OwnedActor
        };

        struct CriticalActorState {
            ObjectIdentity Identity{};
            InitializationActorRole Role = InitializationActorRole::OwnedActor;
            uint8_t OwnerDepth = 0;
            bool ChannelAcknowledged = false;
        };

        struct ConnectionBootstrapState {
            ObjectIdentity Connection{};
            ObjectIdentity World{};
            ObjectIdentity Controller{};
            ObjectIdentity Pawn{};
            ConnectionBootstrapPhase Phase = ConnectionBootstrapPhase::Bootstrapping;
            ULONGLONG StartedAtMs = 0;
            ULONGLONG LoadedWorldAtMs = 0;
            ULONGLONG PossessionAcknowledgedAtMs = 0;
            ULONGLONG LastCriticalActorDiscoveredAtMs = 0;
            FName LastLoadedWorldPackage{};
            bool PossessionAcknowledged = false;
            std::unordered_map<AActor*, CriticalActorState> CriticalActors{};
        };

        struct ImmediateClassRegistryEntry {
            UClass* Class = nullptr;
            int32_t Index = -1;
            int32_t SerialNumber = 0;
        };

        struct ActorScheduleState {
            ObjectIdentity Actor{};
            ObjectIdentity Owner{};
            AActor* OwnerPointer = nullptr;
            TransformSample LastSample{};
            uint8_t ConsecutiveNoDataCalls = 0;
            ULONGLONG LastConsideredAtMs = 0;
            ULONGLONG LastAttemptAtMs = 0;
            ULONGLONG LastSuccessfulDataAtMs = 0;
            ULONGLONG NextFrequencyDeadlineMs = 0;
            ULONGLONG NextRelevancyCheckMs = 0;
            ULONGLONG LastRelevancyCheckMs = 0;
            ENetDormancy LastDormancy = ENetDormancy::DORM_MAX;
            bool OwnerTrackable = true;
            bool RelevancyKnown = false;
            bool LastRelevant = true;
            bool TemporaryRetired = false;
            bool TearOffRetired = false;
        };

        struct ConnectionScheduleState {
            ObjectIdentity Connection{};
            ObjectIdentity World{};
            ObjectIdentity ViewTarget{};
            std::unordered_map<AActor*, ActorScheduleState> Actors{};
        };

        enum class LivePolicyDecision : uint8_t {
            Eligible,
            InvalidIdentity,
            DriverMismatch,
            Dormant,
            NotRelevant,
            NotDue,
            TemporaryRetired,
            TearOffRetired
        };

        enum class CacheRebuildReason : uint8_t {
            Forced,
            WorldChanged,
            WorldIdentity,
            MaximumAge,
            LevelCount,
            ActorCount
        };

        struct LivePolicyResult {
            LivePolicyDecision Decision = LivePolicyDecision::InvalidIdentity;
            ActorScheduleState* State = nullptr;
            bool Moved = false;
        };

        struct UrgentDamageTarget {
            ObjectIdentity Identity{};
            ObjectIdentity TargetConnection{};
            ULONGLONG QueuedAtMs = 0;
            uint8_t SetupRetries = 0;
			UrgentReplicationReason Reason = UrgentReplicationReason::Stagger;
        };

        struct UrgentCandidateEntry {
            ReplicationCandidate* Candidate = nullptr;
            ObjectIdentity Identity{};
            ObjectIdentity TargetConnection{};
            ULONGLONG QueuedAtMs = 0;
            uint8_t SetupRetries = 0;
			UrgentReplicationReason Reason = UrgentReplicationReason::Stagger;
        };

        struct UrgentCandidateBatch {
            std::array<UrgentCandidateEntry, MaximumUrgentDamageTargets> Entries{};
            size_t Count = 0;
        };
    }

    static uintptr_t BaseAddress = 0x0;
    static std::vector<ReplicationCandidate> ConsiderCache{};
    static std::unordered_map<AActor*, ReplicationCandidate*> CandidateActorLookup{};
    static std::vector<PrioritizedCandidate> PriorityScratch{};
    static std::vector<int> CachedLevelActorCounts{};
    static UWorld* CachedWorld = nullptr;
    static ObjectIdentity CachedWorldIdentity{};
    static ULONGLONG LastConsiderCacheBuildMs = 0;
    static std::unordered_map<AActor*, UActorChannel*> ScratchActorChannels{};
    static std::unordered_map<AActor*, ActorReplicationState> ActorReplicationStates{};
    static std::unordered_map<UNetConnection*, ConnectionBootstrapState> ConnectionBootstrapStates{};
    static std::unordered_map<UNetConnection*, ConnectionScheduleState> ConnectionScheduleStates{};
    static std::unordered_set<UNetConnection*> CurrentConnections{};
    static std::vector<UNetConnection*> LiveConnections{};
    static ProfilingCounters ProfileCounters{};
    static uint32_t CurrentSchedulerActorStates = 0;
    static IsNetRelevantForFn NativeIsNetRelevantFor = nullptr;
    static CallActorPreReplicationFn NativeCallActorPreReplication = nullptr;
    static bool NativeRelevancySignatureValid = false;
    static bool NativePreReplicationSignatureValid = false;
    static ULONGLONG ConsiderCacheMaxAgeMs = DefaultConsiderCacheMaxAgeMs;
    static bool ConsiderCacheDirtyForNextConnection = true;
    static bool ActorPropertyDistributionDirty = true;
    static uint32_t ImmediateMetricGeneration = 1;
    static std::array<ImmediateClassRegistryEntry, ImmediateMetricTrackedClassCount>
        ImmediateClassRegistry{};
    static std::array<UrgentDamageTarget, MaximumUrgentDamageTargets> PendingUrgentDamageTargets{};
    static size_t PendingUrgentDamageTargetCount = 0;
	static uint64_t CurrentConnectionPass = 0;

    enum class ConnectionEventType : uint8_t {
        Open,
        Close,
        BootstrapStarted,
        BootstrapRestarted,
        LoadedWorldAccepted,
        LoadedWorldMismatch,
        PossessionAcknowledged,
        CriticalActorDiscovered,
        CriticalChannelAcknowledged,
        BootstrapCompleted,
        BootstrapDeadline,
        NativePostLogin,
        NativeReciprocalRepair,
        NativeDispatchConflict
    };
    struct ConnectionEvent {
        ConnectionEventType Type{};
        UNetConnection* Connection = nullptr;
        uint32_t NetworkTick = 0;
        uint32_t ValueA = 0;
        uint32_t ValueB = 0;
        uint64_t ElapsedMilliseconds = 0;
    };
    static std::array<ConnectionEvent, 128> PendingConnectionEvents{};
    static size_t PendingConnectionEventCount = 0;

    static int64_t PerformanceTimestamp() {
        LARGE_INTEGER Value{};
        QueryPerformanceCounter(&Value);
        return Value.QuadPart;
    }

    static uint64_t ElapsedMicroseconds(int64_t StartedAt) {
        static const int64_t Frequency = []() {
            LARGE_INTEGER Value{};
            QueryPerformanceFrequency(&Value);
            return Value.QuadPart;
        }();

        const int64_t Elapsed = PerformanceTimestamp() - StartedAt;
        return Frequency > 0 && Elapsed > 0
            ? static_cast<uint64_t>((Elapsed * 1000000ll) / Frequency)
            : 0ull;
    }

    static std::string PointerValue(const void* Value) {
        return std::to_string(reinterpret_cast<uintptr_t>(Value));
    }

    static const char* InitializationRoleName(uint32_t Value) {
        switch (static_cast<InitializationActorRole>(Value)) {
        case InitializationActorRole::Controller: return "controller";
        case InitializationActorRole::GameState: return "game_state";
        case InitializationActorRole::PlayerState: return "player_state";
        case InitializationActorRole::Pawn: return "pawn";
        case InitializationActorRole::ViewTarget: return "view_target";
        default: return "owned_actor";
        }
    }

    static bool IsOpenConnection(UNetConnection* Connection) {
        return Connection
            && Connection->OwningActor
            && *reinterpret_cast<uint32_t*>((uintptr_t)Connection + OffsetConnectionState) == OpenConnectionState;
    }

    static ObjectIdentity TrackObject(UObject* Object) {
        if (!Object || Object->Index < 0)
            return {};

        FUObjectItem* Item = UObject::GObjects->GetItemByIndex(Object->Index);
        if (!Item || Item->Object != Object)
            return {};

        return { Object, Object->Index, Item->SerialNumber };
    }

    static UObject* ResolveObject(const ObjectIdentity& Identity) {
        if (!Identity.Object || Identity.Index < 0)
            return nullptr;

        FUObjectItem* Item = UObject::GObjects->GetItemByIndex(Identity.Index);
        if (!Item || Item->Object != Identity.Object || Item->SerialNumber != Identity.SerialNumber ||
            (static_cast<uint32_t>(Item->Flags) & 0x30000000u) != 0)
            return nullptr;

        UObject* Object = Item->Object;
        if ((Object->Flags & EObjectFlags::BeginDestroyed) || (Object->Flags & EObjectFlags::FinishDestroyed))
            return nullptr;

        return Object;
    }

    static bool IdentityMatches(const ObjectIdentity& Stored, UObject* Current) {
        if (!Current)
            return !Stored.Object;

        const ObjectIdentity Fresh = TrackObject(Current);
        return Fresh.Object == Current
            && Stored.Object == Fresh.Object
            && Stored.Index == Fresh.Index
            && Stored.SerialNumber == Fresh.SerialNumber;
    }

    static bool IdentitiesEqual(const ObjectIdentity& Left, const ObjectIdentity& Right) {
        return Left.Object == Right.Object
            && Left.Index == Right.Index
            && Left.SerialNumber == Right.SerialNumber;
    }

	static size_t UrgentReasonIndex(UrgentReplicationReason Reason) {
		const size_t Index = static_cast<size_t>(Reason);
		return Index < UrgentReplicationReasonCount ? Index : 0;
	}

    static bool IsStableIdentity(const ObjectIdentity& Identity, const UObject* Expected) {
        return Expected && ResolveObject(Identity) == Expected;
    }

    static ConnectionScheduleState MakeConnectionScheduleState(
        UNetConnection* Connection,
        UWorld* World
    ) {
        ConnectionScheduleState State{};
        State.Connection = TrackObject(Connection);
        State.World = TrackObject(World);
        State.ViewTarget = TrackObject(Connection ? Connection->ViewTarget : nullptr);
        State.Actors.reserve((std::min)(MaximumScheduledActorsPerConnection,
            (std::max)(size_t{ 256 }, ConsiderCache.size())));
        return State;
    }

    static void ClearConnectionScheduleState(UNetConnection* Connection) {
        const auto It = ConnectionScheduleStates.find(Connection);
        if (It == ConnectionScheduleStates.end())
            return;

        const uint32_t Removed = static_cast<uint32_t>(It->second.Actors.size());
        CurrentSchedulerActorStates = Removed <= CurrentSchedulerActorStates
            ? CurrentSchedulerActorStates - Removed
            : 0;
        ConnectionScheduleStates.erase(It);
    }

    static uint16_t RegisterImmediateClass(UClass* Class) {
        const ObjectIdentity Identity = TrackObject(Class);
        if (!Identity.Object || ResolveObject(Identity) != Class)
            return ImmediateMetricInvalidSlot;

        const uint32_t IdentityHash =
            static_cast<uint32_t>(Identity.Index) * 0x9E3779B1u
            ^ static_cast<uint32_t>(Identity.SerialNumber);
        for (size_t Probe = 0; Probe < ImmediateClassRegistry.size(); ++Probe) {
            const size_t Slot = (IdentityHash + Probe) % ImmediateClassRegistry.size();
            ImmediateClassRegistryEntry& Entry = ImmediateClassRegistry[Slot];
            if (Entry.Index == Identity.Index && Entry.SerialNumber == Identity.SerialNumber)
                return static_cast<uint16_t>(Slot);
            if (Entry.Index >= 0)
                continue;

            Entry.Class = Class;
            Entry.Index = Identity.Index;
            Entry.SerialNumber = Identity.SerialNumber;
            return static_cast<uint16_t>(Slot);
        }
        return ImmediateMetricOverflowSlot;
    }

    static size_t ImmediateNoDataBand(uint16_t Streak) {
        if (Streak <= 1) return 0;
        if (Streak <= 3) return 1;
        if (Streak <= 15) return 2;
        if (Streak <= 63) return 3;
        if (Streak <= 255) return 4;
        return 5;
    }

    static size_t NetFrequencyBand(float Frequency) {
        if (!std::isfinite(Frequency)) return 0;
        if (Frequency <= 0.0f) return 1;
        if (Frequency <= 2.0f) return 2;
        if (Frequency <= 5.0f) return 3;
        if (Frequency <= 10.0f) return 4;
        if (Frequency <= 15.0f) return 5;
        if (Frequency <= 30.0f) return 6;
        if (Frequency <= 60.0f) return 7;
        if (Frequency <= 100.0f) return 8;
        return 9;
    }

    static size_t NetDormancyBand(ENetDormancy Dormancy) {
        const size_t Value = static_cast<size_t>(Dormancy);
        return Value < NetDormancyBandCount - 1 ? Value : NetDormancyBandCount - 1;
    }

    static void RecordActorPropertyDistribution(
        AActor* Actor,
        ReplicationBucket Bucket,
        bool IsCritical
    ) {
        if (!Actor)
            return;

        ++ProfileCounters.ActorPropertySamples;
        ++ProfileCounters.NetUpdateFrequencyBands[NetFrequencyBand(Actor->NetUpdateFrequency)];
        ++ProfileCounters.MinNetUpdateFrequencyBands[NetFrequencyBand(Actor->MinNetUpdateFrequency)];
        ++ProfileCounters.NetDormancyBands[NetDormancyBand(Actor->NetDormancy)];
        if (Actor->Owner) ++ProfileCounters.OwnedActorSamples;
        if (Actor->bReplicateMovement) ++ProfileCounters.ReplicatedMovementSamples;
        if (IsCritical) ++ProfileCounters.CriticalActorSamples;
        if (Bucket == ReplicationBucket::Immediate) ++ProfileCounters.ImmediateActorSamples;
        if (Actor->bNetTemporary) ++ProfileCounters.NetTemporarySamples;
        if (Actor->bNetStartup) ++ProfileCounters.NetStartupSamples;
        if (Actor->bNetLoadOnClient) ++ProfileCounters.NetLoadOnClientSamples;
        if (Actor->bOnlyRelevantToOwner) ++ProfileCounters.OnlyRelevantToOwnerSamples;
        if (Actor->bAlwaysRelevant) ++ProfileCounters.AlwaysRelevantSamples;
        if (Actor->bNetUseOwnerRelevancy) ++ProfileCounters.OwnerRelevancySamples;
        if (Actor->bTearOff) ++ProfileCounters.TearOffSamples;
    }

    static uint16_t ResolveImmediateMetricSlot(
        AActor* Actor,
        ActorReplicationState* State
    ) {
        if (!Actor || !Actor->Class || !State)
            return ImmediateMetricInvalidSlot;
        if (State->ImmediateMetricGeneration != ImmediateMetricGeneration) {
            State->ImmediateMetricGeneration = ImmediateMetricGeneration;
            State->ImmediateMetricSlot = RegisterImmediateClass(Actor->Class);
        }
        return State->ImmediateMetricSlot;
    }

    static void RecordClassReplicationResult(
        AActor* Actor,
        ActorReplicationState* State,
        ReplicationBucket Bucket,
        bool ProducedData
    ) {
        uint16_t MetricSlot = ResolveImmediateMetricSlot(Actor, State);
        if (MetricSlot >= ProfileCounters.ImmediateClasses.size())
            MetricSlot = ImmediateMetricInvalidSlot;

        ImmediateClassCounters& Counters = ProfileCounters.ImmediateClasses[MetricSlot];
        ++Counters.Attempts;
        if (Bucket == ReplicationBucket::Immediate && State &&
            State->ImmediatePassAttempts < (std::numeric_limits<uint32_t>::max)())
            ++State->ImmediatePassAttempts;
        if (ProducedData) {
            ++Counters.Successes;
            if (Bucket == ReplicationBucket::Immediate && State &&
                State->ImmediatePassSuccesses < (std::numeric_limits<uint32_t>::max)()) {
                ++State->ImmediatePassSuccesses;
            }
        }
    }

    static void PopulateImmediateClassNames(ProfilingCounters& Snapshot) {
        for (size_t Index = 0; Index < ImmediateClassRegistry.size(); ++Index) {
            const ImmediateClassRegistryEntry& Entry = ImmediateClassRegistry[Index];
            if (Entry.Index < 0)
                continue;

            // Name work is intentionally deferred until after the replication
            // pass. Resolve the interval-scoped class identity again rather than
            // trusting a pointer retained by the hot-path registry.
            const ObjectIdentity Identity{
                Entry.Class,
                Entry.Index,
                Entry.SerialNumber
            };
            UObject* Resolved = ResolveObject(Identity);
            const std::string Name = Resolved
                ? static_cast<UClass*>(Resolved)->GetName()
                : "invalidated";
            auto& Destination = Snapshot.ImmediateClasses[Index].ClassName;
            const size_t CopyLength = (std::min)(Name.size(), Destination.size() - 1);
            if (CopyLength)
                std::memcpy(Destination.data(), Name.data(), CopyLength);
        }

        constexpr char OverflowName[] = "overflow";
        constexpr char InvalidName[] = "invalid";
        std::memcpy(Snapshot.ImmediateClasses[ImmediateMetricOverflowSlot].ClassName.data(),
            OverflowName, sizeof(OverflowName));
        std::memcpy(Snapshot.ImmediateClasses[ImmediateMetricInvalidSlot].ClassName.data(),
            InvalidName, sizeof(InvalidName));
    }

    static void ResetImmediateClassRegistry() {
        ImmediateClassRegistry = {};
        if (++ImmediateMetricGeneration == 0)
            ImmediateMetricGeneration = 1;
    }

    static ConnectionBootstrapState MakeConnectionBootstrapState(UNetConnection* Connection, UWorld* World) {
        ConnectionBootstrapState State{};
        State.Connection = TrackObject(Connection);
        State.World = TrackObject(World);
        State.Controller = TrackObject(Connection ? Connection->PlayerController : nullptr);
        State.Pawn = TrackObject(Connection && Connection->PlayerController ? Connection->PlayerController->Pawn : nullptr);
        State.Phase = ConnectionBootstrapPhase::Bootstrapping;
        State.StartedAtMs = GetTickCount64();
        State.LastCriticalActorDiscoveredAtMs = State.StartedAtMs;
        State.CriticalActors.reserve(32);
        return State;
}
