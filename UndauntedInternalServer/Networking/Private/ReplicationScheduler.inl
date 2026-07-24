    static void BuildActorChannelScratchMap(UNetConnection* Connection, UClass* ActorChannelClass) {
        ScratchActorChannels.clear();
        ScratchActorChannels.reserve(Connection ? Connection->OpenChannels.Num() : 0);

        if (!Connection)
            return;

        for (UChannel* Channel : Connection->OpenChannels) {
            if (!Channel || Channel->Class != ActorChannelClass)
                continue;

            UActorChannel* ActorChannel = static_cast<UActorChannel*>(Channel);

            // An actor channel owns the authoritative association here. A newly
            // created replicated actor can be valid before a global object-index
            // identity probe is stable; filtering it out permits a duplicate
            // channel and breaks the initial actor/subobject bunch sequence.
            if (ActorChannel->Actor)
                ScratchActorChannels[ActorChannel->Actor] = ActorChannel;
        }
    }

    static uint32_t CurrentNetworkTick() {
        return NetDriver
            ? *reinterpret_cast<uint32_t*>((uintptr_t)NetDriver + OffsetNetDriverTickCount)
            : 0;
    }

    static bool FindInitializationRole(
        UWorld* World,
        UNetConnection* Connection,
        AActor* Actor,
        InitializationActorRole& Role,
        uint8_t& OwnerDepth
    ) {
        if (!World || !Connection || !Actor || !Connection->PlayerController)
            return false;

        APlayerController* Controller = Connection->PlayerController;
        APlayerState* PlayerState = Controller->PlayerState;
        APawn* Pawn = Controller->Pawn;
        AActor* ViewTarget = Connection->ViewTarget;

        if (Actor == Controller) {
            Role = InitializationActorRole::Controller;
            OwnerDepth = 0;
            return true;
        }
        if (Actor == World->GameState) {
            Role = InitializationActorRole::GameState;
            OwnerDepth = 0;
            return true;
        }
        if (Actor == PlayerState) {
            Role = InitializationActorRole::PlayerState;
            OwnerDepth = 0;
            return true;
        }
        if (Actor == Pawn) {
            Role = InitializationActorRole::Pawn;
            OwnerDepth = 0;
            return true;
        }
        if (Actor == ViewTarget) {
            Role = InitializationActorRole::ViewTarget;
            OwnerDepth = 0;
            return true;
        }

        AActor* Owner = Actor->Owner;
        for (size_t Depth = 1; Owner && Depth <= MaximumOwnerChainDepth; ++Depth) {
            if (Owner == Controller || Owner == PlayerState || Owner == Pawn) {
                Role = InitializationActorRole::OwnedActor;
                OwnerDepth = static_cast<uint8_t>(Depth);
                return true;
            }

            const ObjectIdentity OwnerIdentity = TrackObject(Owner);
            if (ResolveObject(OwnerIdentity) != Owner)
                break;

            if (Owner->bActorIsBeingDestroyed || GetActorWorld(Owner) != World)
                break;

            Owner = Owner->Owner;
        }

        return false;
    }

    static CriticalActorState* EnsureCriticalActor(
        UNetConnection* Connection,
        ConnectionBootstrapState& State,
        AActor* Actor,
        InitializationActorRole Role,
        uint8_t OwnerDepth,
        uint32_t NetworkTick,
        ULONGLONG NowMs
    ) {
        if (!Actor)
            return nullptr;

        auto Existing = State.CriticalActors.find(Actor);
        if (Existing != State.CriticalActors.end())
            return &Existing->second;

        ObjectIdentity Identity = TrackObject(Actor);
        if (!Identity.Object)
            return nullptr;

        auto [Inserted, WasInserted] = State.CriticalActors.emplace(Actor,
            CriticalActorState{ Identity, Role, OwnerDepth, false });
        if (WasInserted) {
            State.LastCriticalActorDiscoveredAtMs = NowMs;
            ++ProfileCounters.CriticalActorsDiscovered;
            QueueConnectionEvent({ ConnectionEventType::CriticalActorDiscovered, Connection, NetworkTick,
                static_cast<uint32_t>(Role), OwnerDepth, NowMs - State.StartedAtMs });
        }
        return &Inserted->second;
    }

    static void PruneCriticalActors(ConnectionBootstrapState& State) {
        for (auto It = State.CriticalActors.begin(); It != State.CriticalActors.end();) {
            if (!ResolveObject(It->second.Identity))
                It = State.CriticalActors.erase(It);
            else
                ++It;
        }
    }

    static void RestartBootstrap(
        UNetConnection* Connection,
        ConnectionBootstrapState& State,
        UWorld* World,
        uint32_t NetworkTick,
        uint32_t Reason,
        ULONGLONG NowMs
    ) {
        State = MakeConnectionBootstrapState(Connection, World);
        State.StartedAtMs = NowMs;
        State.LastCriticalActorDiscoveredAtMs = NowMs;
        ++ProfileCounters.BootstrapRestarts;
        QueueConnectionEvent({ ConnectionEventType::BootstrapRestarted, Connection, NetworkTick,
            Reason, 0, 0 });
    }

    static void RefreshPawnState(
        UNetConnection* Connection,
        ConnectionBootstrapState& State,
        uint32_t NetworkTick,
        ULONGLONG NowMs
    ) {
        APawn* CurrentPawn = Connection && Connection->PlayerController
            ? Connection->PlayerController->Pawn
            : nullptr;

        if (IdentityMatches(State.Pawn, CurrentPawn))
            return;

        RestartBootstrap(Connection, State, NetDriver ? NetDriver->World : nullptr,
            NetworkTick, 2u, NowMs);
    }

    static void DiscoverCriticalActors(
        UWorld* World,
        UNetConnection* Connection,
        ConnectionBootstrapState& State,
        uint32_t NetworkTick,
        ULONGLONG NowMs
    ) {
        if (State.Phase != ConnectionBootstrapPhase::Bootstrapping)
            return;

        PruneCriticalActors(State);

        for (ReplicationCandidate& Candidate : ConsiderCache) {
            if (!Candidate.ReplicationState ||
                ResolveObject(Candidate.ReplicationState->Identity) != Candidate.Actor) {
                ConsiderCacheDirtyForNextConnection = true;
                ++ProfileCounters.SchedulerActorIdentityResets;
                continue;
            }

            if (!IsCachedActorStillReplicatable(Candidate.Actor))
                continue;

            InitializationActorRole Role{};
            uint8_t OwnerDepth = 0;
            if (!FindInitializationRole(World, Connection, Candidate.Actor, Role, OwnerDepth))
                continue;

            EnsureCriticalActor(Connection, State, Candidate.Actor, Role, OwnerDepth,
                NetworkTick, NowMs);
        }
    }

    static UrgentCandidateBatch BuildUrgentCandidateBatch(ULONGLONG NowMs) {
        UrgentCandidateBatch Batch{};
        size_t RetainedCount = 0;

        for (size_t Index = 0; Index < PendingUrgentDamageTargetCount; ++Index) {
            const UrgentDamageTarget& Pending = PendingUrgentDamageTargets[Index];
            UObject* Resolved = ResolveObject(Pending.Identity);
            if (!Resolved) {
                ++ProfileCounters.UrgentDamageTargetsInvalidated;
				++ProfileCounters.UrgentInvalidatedByReason[UrgentReasonIndex(Pending.Reason)];
                continue;
            }
            if (Pending.TargetConnection.Object && !ResolveObject(Pending.TargetConnection)) {
                ++ProfileCounters.UrgentDamageTargetsInvalidated;
				++ProfileCounters.UrgentInvalidatedByReason[UrgentReasonIndex(Pending.Reason)];
                continue;
            }
            if (NowMs - Pending.QueuedAtMs > UrgentDamageTargetMaximumAgeMs) {
                ++ProfileCounters.UrgentDamageTargetsExpired;
				++ProfileCounters.UrgentExpiredByReason[UrgentReasonIndex(Pending.Reason)];
                continue;
            }

            ReplicationCandidate* Found = nullptr;
            const auto CandidateIt = CandidateActorLookup.find(static_cast<AActor*>(Resolved));
            if (CandidateIt != CandidateActorLookup.end()) {
                ReplicationCandidate& Candidate = *CandidateIt->second;
                if (!Candidate.ReplicationState ||
                    ResolveObject(Candidate.ReplicationState->Identity) != Candidate.Actor) {
                    ConsiderCacheDirtyForNextConnection = true;
                    ++ProfileCounters.SchedulerActorIdentityResets;
                } else {
                    Found = &Candidate;
                }
            }

            if (!Found) {
                ConsiderCacheDirtyForNextConnection = true;
                PendingUrgentDamageTargets[RetainedCount++] = Pending;
                continue;
            }

            // Damage processing can destroy or retire the target before this
            // next networking pass. Urgency changes scheduling priority only;
            // it must never bypass the ordinary replication eligibility gate.
            UWorld* ExpectedWorld = NetDriver ? NetDriver->World : nullptr;
            if (!IsActorReplicationCandidate(ExpectedWorld, Found->Actor)) {
                ++ProfileCounters.UrgentDamageTargetsInvalidated;
				++ProfileCounters.UrgentInvalidatedByReason[UrgentReasonIndex(Pending.Reason)];
                continue;
            }

            if (Batch.Count < Batch.Entries.size()) {
                Batch.Entries[Batch.Count++] = {
                    Found,
                    Pending.Identity,
                    Pending.TargetConnection,
                    Pending.QueuedAtMs,
					Pending.SetupRetries,
					Pending.Reason
                };
            }
            else {
                ++ProfileCounters.UrgentDamageTargetsDropped;
				++ProfileCounters.UrgentDroppedByReason[UrgentReasonIndex(Pending.Reason)];
            }
        }

        PendingUrgentDamageTargetCount = RetainedCount;
        return Batch;
    }

    static void RetryUrgentCandidateForConnection(
        const UrgentCandidateEntry& Entry,
        UNetConnection* Connection
    ) {
        if (Entry.SetupRetries >= 1) {
            ++ProfileCounters.UrgentDamageSetupRetryExhausted;
            ++ProfileCounters.UrgentDamageTargetsDropped;
			++ProfileCounters.UrgentDroppedByReason[UrgentReasonIndex(Entry.Reason)];
            return;
        }

        const ObjectIdentity ConnectionIdentity = TrackObject(Connection);
        if (!IsStableIdentity(ConnectionIdentity, Connection)) {
            ++ProfileCounters.UrgentDamageTargetsInvalidated;
			++ProfileCounters.UrgentInvalidatedByReason[UrgentReasonIndex(Entry.Reason)];
            return;
        }

        for (size_t PendingIndex = 0;
            PendingIndex < PendingUrgentDamageTargetCount; ++PendingIndex) {
            const UrgentDamageTarget& Pending = PendingUrgentDamageTargets[PendingIndex];
            if (IdentitiesEqual(Pending.Identity, Entry.Identity) &&
                (!Pending.TargetConnection.Object ||
                    IdentitiesEqual(Pending.TargetConnection, ConnectionIdentity))) {
                return;
            }
        }
        if (PendingUrgentDamageTargetCount >= PendingUrgentDamageTargets.size()) {
            ++ProfileCounters.UrgentDamageTargetsDropped;
			++ProfileCounters.UrgentDroppedByReason[UrgentReasonIndex(Entry.Reason)];
            return;
        }

        PendingUrgentDamageTargets[PendingUrgentDamageTargetCount++] = {
            Entry.Identity,
            ConnectionIdentity,
            Entry.QueuedAtMs,
			static_cast<uint8_t>(Entry.SetupRetries + 1),
			Entry.Reason
        };
        ++ProfileCounters.UrgentDamageSetupRetries;
    }

    static bool IsUrgentCandidate(
        const UrgentCandidateBatch& Batch,
        const ReplicationCandidate* Candidate,
        UNetConnection* Connection
    ) {
        for (size_t Index = 0; Index < Batch.Count; ++Index) {
            const UrgentCandidateEntry& Entry = Batch.Entries[Index];
            if (Entry.Candidate == Candidate &&
                (!Entry.TargetConnection.Object ||
                    ResolveObject(Entry.TargetConnection) == Connection)) {
                return true;
            }
        }
        return false;
    }

    static bool IsChannelOpenAcknowledged(UActorChannel* Channel) {
        if (!Channel)
            return false;

        const uint32_t Flags = *reinterpret_cast<const uint32_t*>(
            reinterpret_cast<uintptr_t>(Channel) + OffsetChannelFlags);
        return (Flags & ChannelOpenAcknowledgedMask) == ChannelOpenAcknowledgedMask;
    }

    static void RefreshCriticalChannelAcknowledgements(
        UNetConnection* Connection,
        ConnectionBootstrapState& State,
        uint32_t NetworkTick,
        ULONGLONG NowMs
    ) {
        if (State.Phase != ConnectionBootstrapPhase::Bootstrapping)
            return;

        PruneCriticalActors(State);
        for (auto& [Actor, Critical] : State.CriticalActors) {
            if (!ResolveObject(Critical.Identity))
                continue;

            const auto ChannelIt = ScratchActorChannels.find(Actor);
            const bool IsAcknowledged = ChannelIt != ScratchActorChannels.end() &&
                IsChannelOpenAcknowledged(ChannelIt->second);
            if (IsAcknowledged && !Critical.ChannelAcknowledged) {
                ++ProfileCounters.CriticalChannelsAcknowledged;
                QueueConnectionEvent({ ConnectionEventType::CriticalChannelAcknowledged,
                    Connection, NetworkTick, static_cast<uint32_t>(Critical.Role),
                    Critical.OwnerDepth, NowMs - State.StartedAtMs });
            }
            if (IsAcknowledged)
                Critical.ChannelAcknowledged = true;
        }
    }

    static void TryCompleteBootstrap(
        UNetConnection* Connection,
        ConnectionBootstrapState& State,
        uint32_t NetworkTick,
        ULONGLONG NowMs
    ) {
        if (State.Phase != ConnectionBootstrapPhase::Bootstrapping)
            return;

        const ULONGLONG ElapsedMs = NowMs - State.StartedAtMs;
        if (ElapsedMs >= BootstrapMaximumDurationMs) {
            State.Phase = ConnectionBootstrapPhase::Active;
            ++ProfileCounters.BootstrapDeadlines;
            QueueConnectionEvent({ ConnectionEventType::BootstrapDeadline, Connection, NetworkTick,
                static_cast<uint32_t>(State.CriticalActors.size()),
                State.PossessionAcknowledged ? 1u : 0u, ElapsedMs });
            return;
        }

        bool HasController = false;
        bool HasPlayerState = false;
        bool HasPawn = false;
        bool AllCriticalChannelsAcknowledged = true;
        for (const auto& [Actor, Critical] : State.CriticalActors) {
            if (!ResolveObject(Critical.Identity))
                continue;
            HasController |= Critical.Role == InitializationActorRole::Controller;
            HasPlayerState |= Critical.Role == InitializationActorRole::PlayerState;
            HasPawn |= Critical.Role == InitializationActorRole::Pawn;
            AllCriticalChannelsAcknowledged &= Critical.ChannelAcknowledged;
        }

        const bool MinimumDurationElapsed = ElapsedMs >= BootstrapMinimumDurationMs;
        const bool Stable = NowMs - State.LastCriticalActorDiscoveredAtMs >= BootstrapStableMs;
        if (!MinimumDurationElapsed || !HasController || !HasPlayerState || !HasPawn ||
            !AllCriticalChannelsAcknowledged || !State.PossessionAcknowledged || !Stable)
            return;

        State.Phase = ConnectionBootstrapPhase::Active;
        ++ProfileCounters.BootstrapCompleted;
        ++ProfileCounters.BootstrapLatencySamples;
        ProfileCounters.BootstrapLatencyMilliseconds += ElapsedMs;
        QueueConnectionEvent({ ConnectionEventType::BootstrapCompleted, Connection, NetworkTick,
            static_cast<uint32_t>(State.CriticalActors.size()), 0, ElapsedMs });
    }

    static UNetConnection* FindConnectionForController(APlayerController* PlayerController) {
        if (!PlayerController || !NetDriver)
            return nullptr;

        for (UNetConnection* Connection : NetDriver->ClientConnections) {
            if (!IsOpenConnection(Connection) || Connection->PlayerController != PlayerController)
                continue;

            auto StateIt = ConnectionBootstrapStates.find(Connection);
            if (StateIt == ConnectionBootstrapStates.end()) {
                StateIt = ConnectionBootstrapStates.emplace(Connection,
                    MakeConnectionBootstrapState(Connection, NetDriver->World)).first;
                ++ProfileCounters.BootstrapStarts;
                QueueConnectionEvent({ ConnectionEventType::Open, Connection, CurrentNetworkTick(),
                    static_cast<uint32_t>(NetDriver->ClientConnections.Num()), 0, 0 });
                QueueConnectionEvent({ ConnectionEventType::BootstrapStarted, Connection,
                    CurrentNetworkTick(), 0, 0, 0 });
            }
            else if (!IdentityMatches(StateIt->second.Connection, Connection) ||
                !IdentityMatches(StateIt->second.World, NetDriver->World) ||
                !IdentityMatches(StateIt->second.Controller, PlayerController)) {
                RestartBootstrap(Connection, StateIt->second, NetDriver->World,
                    CurrentNetworkTick(), 1u, GetTickCount64());
            }
            return Connection;
        }
        return nullptr;
    }

    static ConnectionBootstrapState* FindStateForConnection(
        UNetConnection* Connection,
        APlayerController* PlayerController
    ) {
        if (!Connection || !PlayerController)
            return nullptr;

        auto StateIt = ConnectionBootstrapStates.find(Connection);
        if (StateIt == ConnectionBootstrapStates.end() ||
            ResolveObject(StateIt->second.Connection) != Connection ||
            ResolveObject(StateIt->second.Controller) != PlayerController) {
            return nullptr;
        }
        return &StateIt->second;
    }

    static FName ExpectedWorldPackageName() {
        if (NetDriver && NetDriver->WorldPackage && ResolveObject(TrackObject(NetDriver->WorldPackage)))
            return NetDriver->WorldPackage->Name;

        UObject* Outer = NetDriver ? NetDriver->World : nullptr;
        while (Outer && Outer->Outer)
            Outer = Outer->Outer;
        return Outer ? Outer->Name : FName{};
    }

    void Configure(uint32_t CacheMaxAgeMilliseconds) {
        ConsiderCacheMaxAgeMs = (std::clamp)(static_cast<ULONGLONG>(CacheMaxAgeMilliseconds), 50ull, 5000ull);
    }

    void NotifyDamageRpcObserved() {
        ++ProfileCounters.UrgentDamageRpcMatches;
    }

    void NotifyUrgentDamageTarget(int32_t ObjectIndex, int32_t ObjectSerialNumber) {
        ++ProfileCounters.UrgentDamageInterruptCorrelations;
        if (ObjectIndex < 0 || ObjectIndex >= UObject::GObjects->Num() ||
            ObjectSerialNumber == 0) {
            ++ProfileCounters.UrgentDamageWeakHandlesInvalid;
            return;
        }

        FUObjectItem* Item = UObject::GObjects->GetItemByIndex(ObjectIndex);
        if (!Item || !Item->Object || Item->SerialNumber != ObjectSerialNumber ||
            (static_cast<uint32_t>(Item->Flags) & 0x30000000u) != 0) {
            ++ProfileCounters.UrgentDamageWeakHandlesInvalid;
            return;
        }

        UObject* RawObject = Item->Object;
        if ((RawObject->Flags & EObjectFlags::BeginDestroyed) ||
            (RawObject->Flags & EObjectFlags::FinishDestroyed) ||
            !RawObject->IsA(AActor::StaticClass())) {
            ++ProfileCounters.UrgentDamageWeakHandlesInvalid;
            return;
        }

        AActor* Current = static_cast<AActor*>(RawObject);
        UWorld* ExpectedWorld = NetDriver ? NetDriver->World : nullptr;
        std::array<AActor*, MaximumOwnerChainDepth + 1> Visited{};
        ObjectIdentity BehemothIdentity{};
        uint32_t BehemothDepth = 0;

        for (size_t Depth = 0; Current && Depth <= MaximumOwnerChainDepth; ++Depth) {
            bool Cycle = false;
            for (size_t VisitedIndex = 0; VisitedIndex < Depth; ++VisitedIndex) {
                if (Visited[VisitedIndex] == Current) {
                    Cycle = true;
                    break;
                }
            }
            if (Cycle)
                break;
            Visited[Depth] = Current;

            const ObjectIdentity CurrentIdentity = TrackObject(Current);
            if (!IsStableIdentity(CurrentIdentity, Current) ||
                (ExpectedWorld && GetActorWorld(Current) != ExpectedWorld)) {
                ++ProfileCounters.UrgentDamageWeakHandlesInvalid;
                return;
            }
            if (Current->IsA(AArchonBehemoth::StaticClass())) {
                BehemothIdentity = CurrentIdentity;
                BehemothDepth = static_cast<uint32_t>(Depth);
                break;
            }

            AActor* Owner = Current->Owner;
            if (!Owner)
                break;
            const ObjectIdentity OwnerIdentity = TrackObject(Owner);
            if (!IsStableIdentity(OwnerIdentity, Owner)) {
                ++ProfileCounters.UrgentDamageWeakHandlesInvalid;
                return;
            }
            Current = Owner;
        }

        if (!BehemothIdentity.Object) {
            ++ProfileCounters.UrgentDamageTargetsWithoutBehemoth;
            return;
        }
        if (BehemothDepth == 0)
            ++ProfileCounters.UrgentDamageDirectBehemothTargets;
        else
            ++ProfileCounters.UrgentDamageOwnerChainTargets;

        for (size_t Index = 0; Index < PendingUrgentDamageTargetCount; ++Index) {
            const UrgentDamageTarget& Pending = PendingUrgentDamageTargets[Index];
            if (Pending.Reason == UrgentReplicationReason::Stagger &&
				IdentitiesEqual(Pending.Identity, BehemothIdentity) &&
                !Pending.TargetConnection.Object) {
                ++ProfileCounters.UrgentDamageTargetsDeduplicated;
				++ProfileCounters.UrgentDeduplicatedByReason[
					UrgentReasonIndex(UrgentReplicationReason::Stagger)];
                return;
            }
        }

        size_t RetainedPendingCount = 0;
        for (size_t Index = 0; Index < PendingUrgentDamageTargetCount; ++Index) {
            const UrgentDamageTarget& Pending = PendingUrgentDamageTargets[Index];
            // A fresh authoritative interrupt supersedes any connection-local
            // setup retry left from the previous interrupt for this behemoth.
            if (Pending.Reason == UrgentReplicationReason::Stagger &&
				IdentitiesEqual(Pending.Identity, BehemothIdentity))
                continue;
            PendingUrgentDamageTargets[RetainedPendingCount++] = Pending;
        }
        PendingUrgentDamageTargetCount = RetainedPendingCount;
        if (PendingUrgentDamageTargetCount >= PendingUrgentDamageTargets.size()) {
            ++ProfileCounters.UrgentDamageTargetsDropped;
            return;
        }

        PendingUrgentDamageTargets[PendingUrgentDamageTargetCount++] = {
            BehemothIdentity, {}, GetTickCount64(), 0,
			UrgentReplicationReason::Stagger
        };
        ++ProfileCounters.UrgentDamageTargetsQueued;
		++ProfileCounters.UrgentQueuedByReason[
			UrgentReasonIndex(UrgentReplicationReason::Stagger)];
    }

    void NotifyBehemothInterruptClientRpc() {
        ++ProfileCounters.BehemothInterruptClientNotifications;
    }

	void QueueUrgentActor(AActor* Actor, UrgentReplicationReason Reason,
		APlayerController* TargetController) {
		const size_t ReasonIndex = UrgentReasonIndex(Reason);
		const ObjectIdentity ActorIdentity = TrackObject(Actor);
		UWorld* ExpectedWorld = NetDriver ? NetDriver->World : nullptr;
		if (!ActorIdentity.Object || ResolveObject(ActorIdentity) != Actor ||
			(ExpectedWorld && GetActorWorld(Actor) != ExpectedWorld)) {
			++ProfileCounters.UrgentInvalidatedByReason[ReasonIndex];
			return;
		}

		ObjectIdentity ConnectionIdentity{};
		if (TargetController) {
			UNetConnection* Connection = FindConnectionForController(TargetController);
			ConnectionIdentity = TrackObject(Connection);
			if (!ConnectionIdentity.Object || ResolveObject(ConnectionIdentity) != Connection) {
				++ProfileCounters.UrgentInvalidatedByReason[ReasonIndex];
				return;
			}
		}

		for (size_t Index = 0; Index < PendingUrgentDamageTargetCount; ++Index) {
			const UrgentDamageTarget& Pending = PendingUrgentDamageTargets[Index];
			if (Pending.Reason == Reason &&
				IdentitiesEqual(Pending.Identity, ActorIdentity) &&
				IdentitiesEqual(Pending.TargetConnection, ConnectionIdentity)) {
				++ProfileCounters.UrgentDeduplicatedByReason[ReasonIndex];
				++ProfileCounters.UrgentDamageTargetsDeduplicated;
				return;
			}
		}

		if (PendingUrgentDamageTargetCount >= PendingUrgentDamageTargets.size()) {
			++ProfileCounters.UrgentDroppedByReason[ReasonIndex];
			++ProfileCounters.UrgentDamageTargetsDropped;
			return;
		}

		PendingUrgentDamageTargets[PendingUrgentDamageTargetCount++] = {
			ActorIdentity, ConnectionIdentity, GetTickCount64(), 0, Reason
		};
		++ProfileCounters.UrgentQueuedByReason[ReasonIndex];
		++ProfileCounters.UrgentDamageTargetsQueued;
	}

	void RecordCombatEvent(CombatEvent Event, bool Succeeded, uint32_t Amount) {
		const size_t Index = static_cast<size_t>(Event);
		if (Index >= CombatEventCount || Amount == 0)
			return;
		ProfileCounters.CombatEventCalls[Index] += Amount;
		if (Succeeded)
			ProfileCounters.CombatEventSuccesses[Index] += Amount;
	}

	void RecordCombatTextQueue(const FArchonMultitypeCombatTextEntry& Entry) {
		RecordCombatEvent(CombatEvent::CombatTextQueued, true);
		++ProfileCounters.CombatTextEntries;
		ProfileCounters.CombatTextEstimatedBytes += sizeof(Entry);
	}

	void RecordCombatTextMulticast(uint32_t EntryCount) {
		RecordCombatEvent(CombatEvent::CombatTextMulticast, true,
			EntryCount > 0 ? EntryCount : 1);
		ProfileCounters.CombatTextMulticastEntries += EntryCount;
		ProfileCounters.CombatTextMulticastEstimatedBytes +=
			static_cast<uint64_t>(EntryCount) * sizeof(FArchonMultitypeCombatTextEntry);
	}

    void NotifyClientLoadedWorld(APlayerController* PlayerController, FName WorldPackageName) {
        if (!PlayerController)
            return;

        UNetConnection* Connection = FindConnectionForController(PlayerController);
        ConnectionBootstrapState* State = FindStateForConnection(Connection, PlayerController);
        if (!Connection || !State)
            return;

        const FName ExpectedPackage = ExpectedWorldPackageName();
        const ULONGLONG NowMs = GetTickCount64();
        const ULONGLONG ElapsedMs = NowMs - State->StartedAtMs;
        if (ExpectedPackage.IsNone() || WorldPackageName != ExpectedPackage) {
            ++ProfileCounters.LoadedWorldMismatched;
            QueueConnectionEvent({ ConnectionEventType::LoadedWorldMismatch, Connection, CurrentNetworkTick(),
                static_cast<uint32_t>(WorldPackageName.ComparisonIndex),
                static_cast<uint32_t>(ExpectedPackage.ComparisonIndex), ElapsedMs });
            return;
        }

        if (State->LoadedWorldAtMs && State->LastLoadedWorldPackage == WorldPackageName)
            return;

        ++ProfileCounters.LoadedWorldAccepted;
        ++ProfileCounters.LoadedWorldLatencySamples;
        ProfileCounters.LoadedWorldLatencyMilliseconds += ElapsedMs;
        QueueConnectionEvent({ ConnectionEventType::LoadedWorldAccepted, Connection, CurrentNetworkTick(),
            static_cast<uint32_t>(WorldPackageName.ComparisonIndex), WorldPackageName.Number,
            ElapsedMs });

        // This RPC is a seamless-travel lifecycle hint in this build. It may
        // restart the bounded extra eligibility window, but never gates the
        // ordinary replication pass.
        RestartBootstrap(Connection, *State, NetDriver ? NetDriver->World : nullptr,
            CurrentNetworkTick(), 3u, NowMs);
        State->LoadedWorldAtMs = NowMs;
        State->LastLoadedWorldPackage = WorldPackageName;
    }

    void NotifyClientAcknowledgedPawn(APlayerController* PlayerController, APawn* Pawn) {
        if (!PlayerController || !Pawn || PlayerController->Pawn != Pawn)
            return;

        UNetConnection* Connection = FindConnectionForController(PlayerController);
        ConnectionBootstrapState* State = FindStateForConnection(Connection, PlayerController);
        if (!Connection || !State)
            return;

        const ULONGLONG NowMs = GetTickCount64();
        if (!IdentityMatches(State->Pawn, Pawn))
            RestartBootstrap(Connection, *State, NetDriver ? NetDriver->World : nullptr,
                CurrentNetworkTick(), 2u, NowMs);
        if (State->PossessionAcknowledged)
            return;

        State->PossessionAcknowledged = true;
        State->PossessionAcknowledgedAtMs = NowMs;
        ++ProfileCounters.PossessionAcknowledged;
        QueueConnectionEvent({ ConnectionEventType::PossessionAcknowledged, Connection, CurrentNetworkTick(),
            0, 0, NowMs - State->StartedAtMs });
}
