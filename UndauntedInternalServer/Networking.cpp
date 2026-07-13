#include "networking.h"

#include <iostream>
#include <unordered_map>

using namespace SDK;

namespace Networking {
    UNetDriver* NetDriver = nullptr;
    static uintptr_t BaseAddress = 0x0;
    static std::vector<AActor*> ConsiderCache = std::vector<AActor*>();
    static std::vector<int> CachedLevelActorCounts = std::vector<int>();
    static UWorld* CachedWorld = nullptr;
    static ULONGLONG LastConsiderCacheBuildMs = 0;

    static UWorld* GetActorWorld(AActor* Actor) {
        return reinterpret_cast<UWorld * (*)(AActor*)>(*(void**)((uintptr_t)Actor->VTable + 0x150))(Actor);
    }

    static bool IsActorReplicationCandidate(UWorld* World, AActor* Actor) {
        if (!Actor)
            return false;

        if (Actor->RemoteRole == ENetRole::ROLE_None)
            return false;

        if (Actor->bActorIsBeingDestroyed)
            return false;

        if (GetActorWorld(Actor) != World)
            return false;

        return true;
    }

    static bool ShouldRebuildConsiderCache(UWorld* World) {
        if (CachedWorld != World)
            return true;

        if (GetTickCount64() - LastConsiderCacheBuildMs >= 100)
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

    static void RebuildConsiderCache(UWorld* World, UNetDriver* Driver) {
        ConsiderCache.clear();
        CachedLevelActorCounts.clear();

        for (ULevel* Level : World->Levels) {
            CachedLevelActorCounts.push_back(Level ? Level->Actors.Num() : -1);

            if (!Level)
                continue;

            for (AActor* Actor : Level->Actors) {
                if (!IsActorReplicationCandidate(World, Actor))
                    continue;

                reinterpret_cast<void(*)(AActor*, UNetDriver*)>(BaseAddress + 0x306B150)(Actor, Driver);

                ConsiderCache.push_back(Actor);
            }
        }

        /*
        for (int i = 0; i < SDK::UObject::GObjects->Num(); i++)
        {
            SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);

            if (!Obj)
                continue;

            if (Obj->IsDefaultObject())
                continue;

            if (Obj->IsA(SDK::AActor::StaticClass()))
            {
                AActor* Actor = (AActor*)Obj;

                if (Actor->RemoteRole == ENetRole::ROLE_None)
                    continue;

                if (Actor->bActorIsBeingDestroyed)
                    continue;

                if (!reinterpret_cast<UWorld * (*)(AActor*)>(*(void**)((uintptr_t)Actor->VTable + 0x150))(Actor)) {
                    continue;
                }
                
                reinterpret_cast<void(*)(AActor*, UNetDriver*)>(BaseAddress + 0x306B150)(Actor, Driver);

                Actors.push_back(Actor);
            }
        }
        */

        CachedWorld = World;
        LastConsiderCacheBuildMs = GetTickCount64();
    }

    static std::vector<AActor*>& GetConsiderList(UWorld* World, UNetDriver* Driver) {
        if (ShouldRebuildConsiderCache(World)) {
            RebuildConsiderCache(World, Driver);
        }

        return ConsiderCache;
    }

    static std::unordered_map<AActor*, UActorChannel*> BuildActorChannelMap(UNetConnection* Connection) {
        std::unordered_map<AActor*, UActorChannel*> ChannelsByActor = std::unordered_map<AActor*, UActorChannel*>();

        for (UChannel* Channel : Connection->OpenChannels) {
            if (Channel->Class == UActorChannel::StaticClass() && ((UActorChannel*)Channel)->Actor) {
                ChannelsByActor[((UActorChannel*)Channel)->Actor] = ((UActorChannel*)Channel);
            }
        }

        return ChannelsByActor;
    }

    bool Listen(UEngine* Engine, int Port) {
        BaseAddress = (uintptr_t)GetModuleHandleA(nullptr);

        UWorld* World = UWorld::GetWorld();

        if (!Engine || !World) {
            std::cout << "Listen failed: engine or world missing" << std::endl;
            return false;
        }

        FName GameNetDriver = UKismetStringLibrary::Conv_StringToName(L"GameNetDriver");

        std::cout << "Net driver create: " << (int)reinterpret_cast<uint8_t(*)(UEngine*, void*, FName, FName)>(BaseAddress + 0x371A5E0)(Engine, World, GameNetDriver, GameNetDriver) << std::endl;

        for (int i = 0; i < SDK::UObject::GObjects->Num(); i++)
        {
            SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);

            if (!Obj)
                continue;

            if (Obj->IsDefaultObject())
                continue;

            if (Obj->IsA(SDK::UNetDriver::StaticClass()))
            {
                NetDriver = (UNetDriver*)Obj;
                break;
            }
        }

        if (!NetDriver) {
            std::cout << "Listen failed: no UNetDriver found" << std::endl;
            return false;
        }

        std::cout << NetDriver->GetFullName() << std::endl;

        reinterpret_cast<void(*)(UNetDriver*, UWorld*)>(BaseAddress + 0x3491890)(NetDriver, World);

        FURL url = FURL();

        url.Port = Port;

        FString empy = FString();

        bool ListenStatus = (*(reinterpret_cast<bool(**)(UNetDriver*, void*, FURL*, bool, FString*)>(*(__int64*)NetDriver + 0x280)))(NetDriver, (void*)World->NetworkNotify, &url, false, &empy);

        std::cout << "Listen Status: " << ListenStatus << std::endl;

        if (!ListenStatus)
            return false;

        reinterpret_cast<void(*)(UNetDriver*, UWorld*)>(BaseAddress + 0x3491890)(NetDriver, World);

        World->NetDriver = NetDriver;

        return true;
    }

    void TickNetworking() {
        UWorld* World = UWorld::GetWorld();

        World->NetDriver = NetDriver;

        NetDriver->World = World;

        static FName name = FName();
        static bool nameInit = false;

        if (!nameInit) {
            nameInit = true;
            name = UKismetStringLibrary::Conv_StringToName(L"Actor");
        }

        ++ * (uint32_t*)((uintptr_t)NetDriver + 0x2AC);

        std::vector<AActor*>& Actors = GetConsiderList(World, NetDriver);

        for (UNetConnection* Connection : NetDriver->ClientConnections) {
            if (!Connection->OwningActor || *(uint32_t*)((uintptr_t)Connection + 0x134) != 3)
                continue;

            std::unordered_map<AActor*, UActorChannel*> ActorChannels = BuildActorChannelMap(Connection);

            for (AActor* Actor : Actors) {
                if (!IsActorReplicationCandidate(World, Actor))
                    continue;

                if (Actor->Class->CastFlags & EClassCastFlags::PlayerController) {
                    if (Actor != Connection->OwningActor) {
                        continue;
                    }
                    else {
                        Connection->ViewTarget = ((APlayerController*)Actor)->GetViewTarget();

                        reinterpret_cast<void(*)(APlayerController*)>(BaseAddress + 0x359F9D0)((APlayerController*)Actor);
                    }
                }

                //

                UActorChannel* ActorChannel = nullptr;
                auto ActorChannelIt = ActorChannels.find(Actor);

                if (ActorChannelIt != ActorChannels.end()) {
                    ActorChannel = ActorChannelIt->second;
                }

                if (!ActorChannel) {
                    ActorChannel = reinterpret_cast<UActorChannel * (*)(UNetConnection*, FName*, unsigned int, int)>(BaseAddress + 0x3449E10)(Connection, &name, 1 << 1, -1);

                    if (ActorChannel) {
                        reinterpret_cast<void(*)(UActorChannel*, AActor*, unsigned int)>(BaseAddress + 0x3283450)(ActorChannel, Actor, 0);
                        ActorChannels[Actor] = ActorChannel;
                    }
                }

                if (ActorChannel && ActorChannel->Actor) {
                    if (!(*(int*)((uintptr_t)ActorChannel + 0x90) & 2u)) {
                        *(int*)((uintptr_t)ActorChannel + 0x90) |= 2u;
                    }
                    if (reinterpret_cast<bool(*)(UActorChannel*)>(BaseAddress + 0x327E860)(ActorChannel)) {
                        //std::cout << ActorChannel->Actor->GetFullName() << std::endl;
                    }
                }
            }
        }
    }
}
