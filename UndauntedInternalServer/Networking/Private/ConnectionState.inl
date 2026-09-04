    static void ResetConsiderCache() {
        ConsiderCache.clear();
        CandidateActorLookup.clear();
        PriorityScratch.clear();
        InitialDeliveryScratch.clear();
        CachedLevelActorCounts.clear();
        ActorReplicationStates.clear();
        ConnectionBootstrapStates.clear();
        ConnectionScheduleStates.clear();
        CurrentSchedulerActorStates = 0;
        CurrentConnections.clear();
        LiveConnections.clear();
        PendingConnectionEventCount = 0;
        PendingUrgentDamageTargetCount = 0;
		CurrentConnectionPass = 0;
        CachedWorld = nullptr;
        CachedWorldIdentity = {};
        LastConsiderCacheBuildMs = 0;
        ConsiderCacheDirtyForNextConnection = true;
    }

    static void QueueConnectionEvent(const ConnectionEvent& Event) {
        if (PendingConnectionEventCount < PendingConnectionEvents.size()) {
            PendingConnectionEvents[PendingConnectionEventCount++] = Event;
        }
        else {
            ++ProfileCounters.DroppedLifecycleEvents;
        }
    }

    static void EmitPendingConnectionEvents() {
        if (!LifecycleEventSinkEnabled()) {
            PendingConnectionEventCount = 0;
            return;
        }

        for (size_t Index = 0; Index < PendingConnectionEventCount; ++Index) {
            const ConnectionEvent& Event = PendingConnectionEvents[Index];
            const std::string CommonFields =
                "\"connection\":" + PointerValue(Event.Connection) +
                ",\"networkTick\":" + std::to_string(Event.NetworkTick) +
                ",\"valueA\":" + std::to_string(Event.ValueA) +
                ",\"valueB\":" + std::to_string(Event.ValueB) +
                ",\"elapsedMs\":" + std::to_string(Event.ElapsedMilliseconds);

            if (Event.Type == ConnectionEventType::Open) {
                RecordLifecycleEvent("connection_open", CommonFields);
            }
            else if (Event.Type == ConnectionEventType::Close) {
                RecordLifecycleEvent("connection_close", CommonFields);
            }
            else if (Event.Type == ConnectionEventType::BootstrapStarted) {
                RecordLifecycleEvent("connection_bootstrap_started", CommonFields);
            }
            else if (Event.Type == ConnectionEventType::BootstrapRestarted) {
                RecordLifecycleEvent("connection_bootstrap_restarted", CommonFields);
            }
            else if (Event.Type == ConnectionEventType::LoadedWorldAccepted) {
                RecordLifecycleEvent("loaded_world_accepted", CommonFields);
            }
            else if (Event.Type == ConnectionEventType::LoadedWorldMismatch) {
                RecordLifecycleEvent("loaded_world_mismatch", CommonFields);
            }
            else if (Event.Type == ConnectionEventType::PossessionAcknowledged) {
                RecordLifecycleEvent("possession_acknowledged", CommonFields);
            }
            else if (Event.Type == ConnectionEventType::CriticalActorDiscovered) {
                RecordLifecycleEvent("bootstrap_critical_actor_discovered", CommonFields +
                    ",\"role\":\"" + InitializationRoleName(Event.ValueA) + "\"");
            }
            else if (Event.Type == ConnectionEventType::CriticalChannelAcknowledged) {
                RecordLifecycleEvent("bootstrap_critical_channel_acknowledged", CommonFields +
                    ",\"role\":\"" + InitializationRoleName(Event.ValueA) + "\"");
            }
            else if (Event.Type == ConnectionEventType::BootstrapCompleted) {
                RecordLifecycleEvent("connection_bootstrap_completed", CommonFields);
            }
            else if (Event.Type == ConnectionEventType::BootstrapDeadline) {
                RecordLifecycleEvent("connection_bootstrap_deadline", CommonFields);
            }
            else {
                const char* EventName = "native_unknown";
                switch (Event.Type) {
                case ConnectionEventType::NativePostLogin:
                    EventName = "native_post_login"; break;
                case ConnectionEventType::NativeReciprocalRepair:
                    EventName = "native_reciprocal_repair"; break;
                case ConnectionEventType::NativeDispatchConflict:
                    EventName = "native_dispatch_conflict"; break;
                default:
                    break;
                }
                RecordLifecycleEvent(EventName, CommonFields);
            }
        }
        PendingConnectionEventCount = 0;
    }

    static void RefreshConnectionState(UNetDriver* Driver, uint32_t CurrentTick) {
        CurrentConnections.clear();
        LiveConnections.clear();

        if (!Driver)
            return;

        CurrentConnections.reserve(Driver->ClientConnections.Num());
        LiveConnections.reserve(Driver->ClientConnections.Num());

        for (UNetConnection* Connection : Driver->ClientConnections) {
            if (!IsOpenConnection(Connection))
                continue;

            CurrentConnections.insert(Connection);
            LiveConnections.push_back(Connection);

            auto ScheduleIt = ConnectionScheduleStates.find(Connection);
            if (ScheduleIt == ConnectionScheduleStates.end()) {
                ConnectionScheduleStates.emplace(Connection,
                    MakeConnectionScheduleState(Connection, Driver->World));
            }
            else if (!IdentityMatches(ScheduleIt->second.Connection, Connection) ||
                !IdentityMatches(ScheduleIt->second.World, Driver->World)) {
                const uint32_t Removed = static_cast<uint32_t>(ScheduleIt->second.Actors.size());
                CurrentSchedulerActorStates = Removed <= CurrentSchedulerActorStates
                    ? CurrentSchedulerActorStates - Removed
                    : 0;
                ScheduleIt->second = MakeConnectionScheduleState(Connection, Driver->World);
            }
            else {
                const ObjectIdentity ViewTargetIdentity =
                    TrackObject(Connection->ViewTarget);
                if (!IdentitiesEqual(ScheduleIt->second.ViewTarget,
                    ViewTargetIdentity)) {
                    ScheduleIt->second.ViewTarget = ViewTargetIdentity;
                    for (auto& [Actor, State] : ScheduleIt->second.Actors)
                        State.NextRelevancyCheckMs = 0;
                }
            }

            auto StateIt = ConnectionBootstrapStates.find(Connection);
            if (StateIt == ConnectionBootstrapStates.end()) {
                ConnectionBootstrapStates.emplace(Connection,
                    MakeConnectionBootstrapState(Connection, Driver->World));
                ++ProfileCounters.BootstrapStarts;
                QueueConnectionEvent({ ConnectionEventType::Open, Connection, CurrentTick,
                    static_cast<uint32_t>(Driver->ClientConnections.Num()),
                    static_cast<uint32_t>(LiveConnections.size()), 0 });
                QueueConnectionEvent({ ConnectionEventType::BootstrapStarted, Connection, CurrentTick,
                    0, 0, 0 });
                continue;
            }

            APlayerController* CurrentController = Connection->PlayerController;
            if (!IdentityMatches(StateIt->second.Connection, Connection) ||
                !IdentityMatches(StateIt->second.World, Driver->World) ||
                !IdentityMatches(StateIt->second.Controller, CurrentController)) {
                StateIt->second = MakeConnectionBootstrapState(Connection, Driver->World);
                ++ProfileCounters.BootstrapRestarts;
                QueueConnectionEvent({ ConnectionEventType::BootstrapRestarted, Connection, CurrentTick,
                    CurrentController ? 1u : 0u, 0, 0 });
            }
        }

        for (auto It = ConnectionBootstrapStates.begin(); It != ConnectionBootstrapStates.end();) {
            if (!CurrentConnections.contains(It->first)) {
                QueueConnectionEvent({ ConnectionEventType::Close, It->first, CurrentTick, 0, 0, 0 });
                ClearConnectionScheduleState(It->first);
                It = ConnectionBootstrapStates.erase(It);
            }
            else {
                ++It;
            }
        }
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
            && Actor->bReplicates
            && Actor->RemoteRole != ENetRole::ROLE_None
            && Actor->Role != ENetRole::ROLE_None
            && !Actor->bActorIsBeingDestroyed
            && (!NetDriver || Actor->NetDriverName.IsNone() ||
                Actor->NetDriverName == NetDriver->NetDriverName)
            && GetActorWorld(Actor) == World;
    }

    static __forceinline bool IsCachedActorStillReplicatable(AActor* Actor) {
        return Actor
            && Actor->Class
            && Actor->bReplicates
            && Actor->RemoteRole != ENetRole::ROLE_None
            && Actor->Role != ENetRole::ROLE_None
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

    static bool GetCacheRebuildReason(
        UWorld* World,
        CacheRebuildReason& Reason
    ) {
        if (!World)
            return false;

        if (CachedWorld != World) {
            Reason = CacheRebuildReason::WorldChanged;
            return true;
        }

        if (!IsStableIdentity(CachedWorldIdentity, CachedWorld)) {
            Reason = CacheRebuildReason::WorldIdentity;
            return true;
        }

        if (GetTickCount64() - LastConsiderCacheBuildMs >= ConsiderCacheMaxAgeMs) {
            Reason = CacheRebuildReason::MaximumAge;
            return true;
        }

        if (CachedLevelActorCounts.size() != World->Levels.Num()) {
            Reason = CacheRebuildReason::LevelCount;
            return true;
        }

        for (int i = 0; i < World->Levels.Num(); i++) {
            ULevel* Level = World->Levels[i];
            int ActorCount = Level ? Level->Actors.Num() : -1;

            if (CachedLevelActorCounts[i] != ActorCount) {
                Reason = CacheRebuildReason::ActorCount;
                return true;
            }
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

    static uint32_t ClassifyReplicationClass(
        AActor* Actor,
        const ReplicationClassCache& ClassCache
    ) {
        uint32_t Flags = 0;
        if (Actor->IsA(ClassCache.PlayerController)) Flags |= ClassPlayerController;
        if (Actor->IsA(ClassCache.ArchonCharacter)) Flags |= ClassArchonCharacter;
        if (Actor->IsA(ClassCache.ArchonBehemoth)) Flags |= ClassArchonBehemoth;
        if (Actor->IsA(ClassCache.ArchonLantern)) Flags |= ClassArchonLantern;
        if (Actor->IsA(ClassCache.Projectile)) Flags |= ClassProjectile;
        if (Actor->IsA(ClassCache.Pawn)) Flags |= ClassPawn;
        if (Actor->IsA(ClassCache.ArchonEquipment)) Flags |= ClassArchonEquipment;
        if (Actor->IsA(ClassCache.ArchonLoadout)) Flags |= ClassArchonLoadout;
        if (Actor->IsA(ClassCache.ArchonAoe)) Flags |= ClassArchonAoe;
        if (Actor->IsA(ClassCache.ArchonBeam)) Flags |= ClassArchonBeam;
        if (Actor->IsA(ClassCache.AbilityActor)) Flags |= ClassAbilityActor;
        return Flags;
    }

    static ReplicationBucket ClassifyReplicationBucket(
        AActor* Actor,
        uint32_t ClassFlags,
        const TransformSample& Sample
    ) {
        if ((ClassFlags & (ClassPlayerController | ClassArchonLantern)) != 0 ||
            !Actor->bReplicateMovement)
            return ReplicationBucket::Immediate;

        if ((ClassFlags & ClassArchonCharacter) != 0)
            return ReplicationBucket::ArchonCharacter;

        if ((ClassFlags & ClassArchonBehemoth) != 0)
            return ReplicationBucket::ArchonBehemoth;

        if ((ClassFlags & ClassProjectile) != 0)
            return ReplicationBucket::Projectile;

        if ((ClassFlags & ClassPawn) != 0)
            return ReplicationBucket::PawnOrCharacter;

        return HasAnyMovementSignal(Actor, Sample)
            ? ReplicationBucket::MovementActor
            : ReplicationBucket::Immediate;
    }

    static bool IsCriticalReplicationActor(uint32_t ClassFlags) {
        if (!kAlwaysReplicateCriticalActors)
            return false;

        return (ClassFlags & (ClassPlayerController |
            ClassArchonCharacter | ClassArchonLantern)) != 0;
    }

    static bool IsLatencySensitiveOwnedActor(uint32_t ClassFlags) {
        return (ClassFlags & (
            ClassArchonEquipment |
            ClassArchonLoadout |
            ClassArchonAoe |
            ClassArchonBeam |
            ClassAbilityActor)) != 0;
    }

    static bool IsChannelOpenAcknowledged(UActorChannel* Channel);
    static uint32_t CurrentNetworkTick();

    static void PruneReplicationState(UWorld* World) {
        std::erase_if(ActorReplicationStates,
            [World](const auto& Entry) {
                return !IsStableIdentity(Entry.second.Identity, Entry.first) ||
                    !IsActorReplicationCandidate(World, Entry.first);
            });
    }

    static void PruneSchedulerState(UWorld* World) {
        for (auto& [Connection, Schedule] : ConnectionScheduleStates) {
            const size_t Removed = std::erase_if(Schedule.Actors,
                [World](const auto& Entry) {
                    return !IsStableIdentity(Entry.second.Actor, Entry.first) ||
                        !IsActorReplicationCandidate(World, Entry.first);
                });
            CurrentSchedulerActorStates = Removed <= CurrentSchedulerActorStates
                ? CurrentSchedulerActorStates - static_cast<uint32_t>(Removed)
                : 0;
            ProfileCounters.SchedulerStatePrunes += Removed;
        }
}
