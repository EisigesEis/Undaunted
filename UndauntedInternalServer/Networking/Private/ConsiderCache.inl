    static void RebuildConsiderCache(
        UWorld* World,
        UNetDriver* Driver,
        const ReplicationClassCache& ClassCache,
        CacheRebuildReason Reason
    ) {
        const int64_t TimingStartedAt = PerformanceTimestamp();
        const bool CaptureActorPropertyDistribution = ActorPropertyDistributionDirty;
        ++ProfileCounters.CacheRebuilds;
        ++ProfileCounters.CacheRebuildsByReason[static_cast<size_t>(Reason)];
        if (!World || !Driver) {
            ResetConsiderCache();
            ProfileCounters.CacheRebuildMicroseconds += ElapsedMicroseconds(TimingStartedAt);
            ++ProfileCounters.CacheRebuildTimingSamples;
            return;
        }

        int TotalActorCount = CountWorldActors(World);

        ConsiderCache.clear();
        CandidateActorLookup.clear();
        CachedLevelActorCounts.clear();
        ConsiderCache.reserve(TotalActorCount);
        CandidateActorLookup.reserve(static_cast<size_t>(TotalActorCount));
        if (PriorityScratch.capacity() < static_cast<size_t>(TotalActorCount))
            PriorityScratch.reserve(TotalActorCount);
        if (InitialDeliveryScratch.capacity() < static_cast<size_t>(TotalActorCount))
            InitialDeliveryScratch.reserve(TotalActorCount);
        ActorReplicationStates.reserve(TotalActorCount);
        CachedLevelActorCounts.reserve(World->Levels.Num());
        PruneReplicationState(World);
        PruneSchedulerState(World);
        for (auto& [Connection, Schedule] : ConnectionScheduleStates) {
            if (Schedule.Actors.bucket_count() < ConsiderCache.capacity())
                Schedule.Actors.reserve((std::min)(
                    MaximumScheduledActorsPerConnection, ConsiderCache.capacity()));
        }

        for (ULevel* Level : World->Levels) {
            CachedLevelActorCounts.push_back(Level ? Level->Actors.Num() : -1);

            if (!Level)
                continue;

            for (AActor* Actor : Level->Actors) {
                if (!Actor || !Actor->Class)
                    continue;
                if (CaptureActorPropertyDistribution) {
                    const size_t LocalRole = (std::min)(
                        static_cast<size_t>(Actor->Role), NetRoleCount - 1);
                    const size_t RemoteRole = (std::min)(
                        static_cast<size_t>(Actor->RemoteRole), NetRoleCount - 1);
                    ++ProfileCounters.NetRoleMatrix[
                        LocalRole * NetRoleCount + RemoteRole];
                }
                if (!Actor->bReplicates) {
                    if (CaptureActorPropertyDistribution)
                        ++ProfileCounters.ExcludedNotReplicated;
                    continue;
                }
                if (Actor->RemoteRole == ENetRole::ROLE_None) {
                    if (CaptureActorPropertyDistribution)
                        ++ProfileCounters.ExcludedRemoteRoleNone;
                    continue;
                }
                if (Actor->Role == ENetRole::ROLE_None) {
                    if (CaptureActorPropertyDistribution)
                        ++ProfileCounters.ExcludedLocalRoleNone;
                    continue;
                }
                if (CaptureActorPropertyDistribution &&
                    Actor->Role != ENetRole::ROLE_Authority)
                    ++ProfileCounters.UnexpectedLocalRole;
                if (Actor->bActorIsBeingDestroyed) {
                    if (CaptureActorPropertyDistribution)
                        ++ProfileCounters.ExcludedDestroying;
                    continue;
                }
                if (GetActorWorld(Actor) != World) {
                    if (CaptureActorPropertyDistribution)
                        ++ProfileCounters.ExcludedWrongWorld;
                    continue;
                }
                if (!Actor->NetDriverName.IsNone() &&
                    Actor->NetDriverName != Driver->NetDriverName) {
                    ++ProfileCounters.LivePolicyDriverMismatches;
                    continue;
                }

                TransformSample Sample = SampleActorTransform(Actor);
                const uint32_t ClassFlags =
                    ClassifyReplicationClass(Actor, ClassCache);
                const bool IsPlayerController =
                    (ClassFlags & ClassPlayerController) != 0;
                ReplicationBucket Bucket =
                    ClassifyReplicationBucket(Actor, ClassFlags, Sample);
                const bool IsCritical =
                    IsCriticalReplicationActor(ClassFlags);
                if (CaptureActorPropertyDistribution)
                    RecordActorPropertyDistribution(Actor, Bucket, IsCritical);
                const ObjectIdentity ActorIdentity = TrackObject(Actor);
                if (ResolveObject(ActorIdentity) != Actor) {
                    ++ProfileCounters.SchedulerActorIdentityResets;
                    ConsiderCacheDirtyForNextConnection = true;
                    continue;
                }
                auto [StateIt, StateInserted] = ActorReplicationStates.try_emplace(Actor);
                ActorReplicationState& State = StateIt->second;
                if (!StateInserted && (!IsStableIdentity(ActorIdentity, Actor) ||
                    !IdentitiesEqual(State.Identity, ActorIdentity))) {
                    State = {};
                    ++ProfileCounters.SchedulerActorIdentityResets;
                }
                State.Identity = ActorIdentity;

                ConsiderCache.push_back({ Actor, Bucket, ClassFlags, IsPlayerController,
                    IsCritical, &State });
                CandidateActorLookup[Actor] = &ConsiderCache.back();
            }
        }

        CachedWorld = World;
        CachedWorldIdentity = TrackObject(World);
        // Rebuild after the vector is complete; vector growth invalidates the
        // addresses stored in the urgent candidate lookup.
        CandidateActorLookup.clear();
        CandidateActorLookup.reserve(ConsiderCache.size());
        for (ReplicationCandidate& Candidate : ConsiderCache)
            CandidateActorLookup[Candidate.Actor] = &Candidate;
        LastConsiderCacheBuildMs = GetTickCount64();
        ProfileCounters.CurrentCandidates = static_cast<uint32_t>(ConsiderCache.size());
        ProfileCounters.MaximumCandidates = (std::max)(ProfileCounters.MaximumCandidates,
            ProfileCounters.CurrentCandidates);
        ProfileCounters.CacheRebuildMicroseconds += ElapsedMicroseconds(TimingStartedAt);
        ++ProfileCounters.CacheRebuildTimingSamples;
        ActorPropertyDistributionDirty = false;
    }

    static void BuildReplicateList(uint32_t CurrentTick) {
        for (ReplicationCandidate& Candidate : ConsiderCache) {
            AActor* Actor = Candidate.Actor;

            if (!Candidate.ReplicationState ||
                ResolveObject(Candidate.ReplicationState->Identity) != Actor) {
                ConsiderCacheDirtyForNextConnection = true;
                ++ProfileCounters.SchedulerActorIdentityResets;
                continue;
            }
            if (!IsCachedActorStillReplicatable(Actor))
                continue;

            Candidate.Bucket = ClassifyReplicationBucket(
                Actor, Candidate.ClassFlags, SampleActorTransform(Actor));
            if (Candidate.Bucket == ReplicationBucket::Immediate) {
                ActorReplicationState& State = *Candidate.ReplicationState;
                if (State.ImmediatePassNetworkTick != CurrentTick) {
                    State.ImmediatePassNetworkTick = CurrentTick;
                    State.ImmediatePassAttempts = 0;
                    State.ImmediatePassSuccesses = 0;
                }
            }

        }
    }

    static void FinalizeImmediatePassMetrics(uint32_t CurrentTick) {
        for (ReplicationCandidate& Candidate : ConsiderCache) {
            if (Candidate.Bucket != ReplicationBucket::Immediate || !Candidate.ReplicationState)
                continue;

            ActorReplicationState& State = *Candidate.ReplicationState;
            if (State.ImmediatePassNetworkTick != CurrentTick ||
                State.ImmediatePassFinalizedTick == CurrentTick ||
                State.ImmediatePassAttempts == 0) {
                continue;
            }

            uint16_t MetricSlot = ResolveImmediateMetricSlot(
                Candidate.Actor, Candidate.ReplicationState);
            if (MetricSlot >= ProfileCounters.ImmediateClasses.size())
                MetricSlot = ImmediateMetricInvalidSlot;
            ImmediateClassCounters& Counters = ProfileCounters.ImmediateClasses[MetricSlot];
            ++Counters.ActorPasses;
            Counters.ActorPassAttempts += State.ImmediatePassAttempts;
            Counters.ActorPassSuccesses += State.ImmediatePassSuccesses;

            if (State.ImmediatePassSuccesses > 0) {
                ++Counters.ActorPassesWithAnyData;
                State.ConsecutiveImmediateNoDataPasses = 0;
            }
            else {
                ++Counters.ActorPassesWithNoData;
                if (State.ConsecutiveImmediateNoDataPasses <
                    (std::numeric_limits<uint16_t>::max)()) {
                    ++State.ConsecutiveImmediateNoDataPasses;
                }
                ++Counters.NoDataPassStreaks[
                    ImmediateNoDataBand(State.ConsecutiveImmediateNoDataPasses)];
            }
            State.ImmediatePassFinalizedTick = CurrentTick;
        }
    }

    static UNetDriver* FindNetDriverByName(UEngine* Engine, UWorld* World,
        const FName& DriverName) {
        if (!Engine || !World || BaseAddress == 0)
            return nullptr;
        FindNamedNetDriverFn FindNamedNetDriver =
            reinterpret_cast<FindNamedNetDriverFn>(BaseAddress + OffsetFindNamedNetDriver);
        return FindNamedNetDriver(Engine, World, DriverName);
    }

    static bool IsOwnedByConnection(
        UWorld* World,
        UNetConnection* Connection,
        AActor* Actor
    ) {
        if (!World || !Connection || !Actor)
            return false;

        APlayerController* Controller = Connection->PlayerController;
        AActor* Pawn = Controller ? Controller->Pawn : nullptr;
        AActor* PlayerState = Controller ? Controller->PlayerState : nullptr;
        AActor* Current = Actor;
        for (size_t Depth = 0; Current && Depth <= MaximumOwnerChainDepth; ++Depth) {
            if (Current == Connection->OwningActor || Current == Connection->ViewTarget ||
                Current == Controller || Current == Pawn || Current == PlayerState) {
                return true;
            }

            const ObjectIdentity Identity = TrackObject(Current);
            if (ResolveObject(Identity) != Current ||
                Current->bActorIsBeingDestroyed ||
                GetActorWorld(Current) != World) {
                return false;
            }
            Current = Current->Owner;
        }
        return false;
    }

    static bool IsDirectConnectionActor(
        UNetConnection* Connection,
        AActor* Actor
    ) {
        if (!Connection || !Actor)
            return false;
        APlayerController* Controller = Connection->PlayerController;
        return Actor == Connection->OwningActor ||
            Actor == Connection->ViewTarget ||
            Actor == Controller ||
            (Controller &&
                (Actor == Controller->Pawn || Actor == Controller->PlayerState));
    }

    static ActorScheduleState* ResolveSchedulingState(
        UWorld* World,
        UNetConnection* Connection,
        AActor* Actor,
        ActorReplicationState* ReplicationState
    ) {
        if (!World || !Connection || !Actor || !ReplicationState ||
            ResolveObject(ReplicationState->Identity) != Actor) {
            ++ProfileCounters.LivePolicyActorIdentityFallbacks;
            return nullptr;
        }

        auto ConnectionIt = ConnectionScheduleStates.find(Connection);
        if (ConnectionIt == ConnectionScheduleStates.end() ||
            !IsStableIdentity(ConnectionIt->second.Connection, Connection) ||
            !IsStableIdentity(ConnectionIt->second.World, World)) {
            ++ProfileCounters.LivePolicyConnectionIdentityFallbacks;
            return nullptr;
        }

        AActor* const Owner = Actor->Owner;
        const ObjectIdentity OwnerIdentity = TrackObject(Owner);
        const bool OwnerTrackable = !Owner ||
            ResolveObject(OwnerIdentity) == Owner;
        if (!OwnerTrackable) {
            ++ProfileCounters.LivePolicyUntrackableOwners;
            const uint16_t Slot = ResolveImmediateMetricSlot(
                Actor, ReplicationState);
            ++ProfileCounters.ImmediateClasses[Slot].UntrackableOwnerCalls;
        }

        auto& ActorStates = ConnectionIt->second.Actors;
        auto ActorIt = ActorStates.find(Actor);
        if (ActorIt == ActorStates.end()) {
            if (ActorStates.size() >= MaximumScheduledActorsPerConnection) {
                ++ProfileCounters.LivePolicyStateCapacityFallbacks;
                ++ProfileCounters.SchedulerStateCapacityDrops;
                return nullptr;
            }
            ActorScheduleState NewState{};
            NewState.Actor = ReplicationState->Identity;
            NewState.OwnerPointer = Owner;
            NewState.OwnerTrackable = OwnerTrackable;
            NewState.Owner = OwnerTrackable ? OwnerIdentity : ObjectIdentity{};
            ActorIt = ActorStates.emplace(Actor, NewState).first;
            ++CurrentSchedulerActorStates;
            ++ProfileCounters.SchedulerStateInsertions;
            ProfileCounters.MaximumSchedulerStates = (std::max)(
                ProfileCounters.MaximumSchedulerStates,
                CurrentSchedulerActorStates);
        }
        else if (!IdentitiesEqual(ActorIt->second.Actor, ReplicationState->Identity)) {
            ActorIt->second = {};
            ActorIt->second.Actor = ReplicationState->Identity;
            ActorIt->second.OwnerPointer = Owner;
            ActorIt->second.OwnerTrackable = OwnerTrackable;
            ActorIt->second.Owner =
                OwnerTrackable ? OwnerIdentity : ObjectIdentity{};
            ++ProfileCounters.SchedulerActorIdentityResets;
        }
        else if (ActorIt->second.OwnerPointer != Owner ||
            ActorIt->second.OwnerTrackable != OwnerTrackable ||
            (OwnerTrackable &&
                !IdentitiesEqual(ActorIt->second.Owner, OwnerIdentity))) {
            ActorIt->second = {};
            ActorIt->second.Actor = ReplicationState->Identity;
            ActorIt->second.OwnerPointer = Owner;
            ActorIt->second.OwnerTrackable = OwnerTrackable;
            ActorIt->second.Owner =
                OwnerTrackable ? OwnerIdentity : ObjectIdentity{};
            ++ProfileCounters.SchedulerOwnerChanges;
        }
        return &ActorIt->second;
    }

    static FVector ViewerLocation(UNetConnection* Connection) {
        AActor* ViewTarget = Connection ? Connection->ViewTarget : nullptr;
        if (!ViewTarget && Connection)
            ViewTarget = Connection->PlayerController;
        if (!ViewTarget)
            return {};
        if (ViewTarget->RootComponent)
            return ViewTarget->RootComponent->RelativeLocation;
        return ViewTarget->ReplicatedMovement.Location;
    }

    static bool IsRelevantForConnection(
        UWorld* World,
        UNetConnection* Connection,
        AActor* Actor
    ) {
        if (!World || !Connection || !Actor)
            return false;
        if (Actor->bAlwaysRelevant)
            return true;

        AActor* RealViewer = Connection->PlayerController
            ? static_cast<AActor*>(Connection->PlayerController)
            : Connection->OwningActor;
        AActor* ViewTarget = Connection->ViewTarget ? Connection->ViewTarget : RealViewer;

        // Login can briefly precede controller/view-target creation. Omitting
        // actors in that interval is less safe than one conservative pass.
        if (!RealViewer || !ViewTarget) {
            ++ProfileCounters.LivePolicyNativeRelevancyFallbacks;
            return !Actor->bOnlyRelevantToOwner ||
                IsOwnedByConnection(World, Connection, Actor);
        }

        const ObjectIdentity RealViewerIdentity = TrackObject(RealViewer);
        const ObjectIdentity ViewTargetIdentity = TrackObject(ViewTarget);
        if (ResolveObject(RealViewerIdentity) != RealViewer ||
            ResolveObject(ViewTargetIdentity) != ViewTarget) {
            ++ProfileCounters.LivePolicyNativeRelevancyFallbacks;
            return true;
        }

        if (NativeIsNetRelevantFor) {
            const FVector SourceLocation = ViewerLocation(Connection);
            ++ProfileCounters.LivePolicyNativeRelevancyCalls;
            return NativeIsNetRelevantFor(
                Actor, RealViewer, ViewTarget, &SourceLocation);
        }

        ++ProfileCounters.LivePolicyNativeRelevancyFallbacks;
        if (Actor->bOnlyRelevantToOwner || Actor->bNetUseOwnerRelevancy)
            return IsOwnedByConnection(World, Connection, Actor);
        return true;
    }

    static float EffectiveFrequency(
        const AActor* Actor,
        uint8_t NoDataCalls,
        float AdaptiveFloorHz = 0.0f
    ) {
        float Frequency = Actor ? Actor->NetUpdateFrequency : SchedulerMaximumFrequencyHz;
        if (!std::isfinite(Frequency) || Frequency <= 0.0f)
            Frequency = SchedulerMaximumFrequencyHz;
        Frequency = (std::clamp)(
            Frequency, 0.1f, SchedulerMaximumFrequencyHz);

        if (Actor && NoDataCalls >= AdaptiveNoDataThreshold &&
            std::isfinite(Actor->MinNetUpdateFrequency) &&
            Actor->MinNetUpdateFrequency > 0.0f) {
            const float Minimum = (std::clamp)(
                Actor->MinNetUpdateFrequency,
                0.1f,
                SchedulerMaximumFrequencyHz);
            const float BoundedMinimum = AdaptiveFloorHz > 0.0f
                ? (std::max)(Minimum, AdaptiveFloorHz)
                : Minimum;
            Frequency = (std::min)(Frequency, BoundedMinimum);
        }
        return Frequency;
    }

    static void RecordInitialDeliveryMetric(
        AActor* Actor,
        ActorReplicationState* ReplicationState,
        InitialDeliveryMetric Metric
    ) {
        uint16_t Slot = ResolveImmediateMetricSlot(Actor, ReplicationState);
        if (Slot >= ProfileCounters.ImmediateClasses.size())
            Slot = ImmediateMetricInvalidSlot;
        ImmediateClassCounters& ClassCounters =
            ProfileCounters.ImmediateClasses[Slot];

        switch (Metric) {
        case InitialDeliveryMetric::Pending:
            ++ProfileCounters.InitialDeliveryPending;
            ++ClassCounters.InitialDeliveryPending;
            break;
        case InitialDeliveryMetric::Attempted:
            ++ProfileCounters.InitialDeliveryAttempts;
            ++ClassCounters.InitialDeliveryAttempts;
            break;
        case InitialDeliveryMetric::Produced:
            ++ProfileCounters.InitialDeliveryProduced;
            ++ClassCounters.InitialDeliveryProduced;
            break;
        case InitialDeliveryMetric::Acknowledged:
            ++ProfileCounters.InitialDeliveryAcknowledged;
            ++ClassCounters.InitialDeliveryAcknowledged;
            break;
        case InitialDeliveryMetric::Retried:
            ++ProfileCounters.InitialDeliveryRetries;
            ++ClassCounters.InitialDeliveryRetries;
            break;
        case InitialDeliveryMetric::BudgetDeferred:
            ++ProfileCounters.InitialDeliveryBudgetDeferred;
            ++ClassCounters.InitialDeliveryBudgetDeferred;
            break;
        }
    }

    static bool IsDormantForReplication(const AActor* Actor) {
        return Actor &&
            Actor->NetDormancy != ENetDormancy::DORM_Awake &&
            Actor->NetDormancy != ENetDormancy::DORM_Never;
    }

    static bool RequiresExplicitInitialDelivery(const AActor* Actor) {
        return Actor && (!Actor->bNetStartup || !Actor->bNetLoadOnClient);
    }

    static void RefreshInitialDeliveryState(
        AActor* Actor,
        ActorReplicationState* ReplicationState,
        UActorChannel* ExistingChannel,
        ActorScheduleState* State
    ) {
        if (!Actor || !ReplicationState || !State)
            return;

        if (State->InitialDelivery == InitialDeliveryState::NotApplicable) {
            if (!IsDormantForReplication(Actor) ||
                !RequiresExplicitInitialDelivery(Actor)) {
                return;
            }
            State->InitialDelivery = InitialDeliveryState::Pending;
            State->InitialDeliveryPendingSinceMs = State->LastConsideredAtMs;
            RecordInitialDeliveryMetric(
                Actor, ReplicationState, InitialDeliveryMetric::Pending);
        }

        if (ExistingChannel) {
            if (IsChannelOpenAcknowledged(ExistingChannel)) {
                if (State->InitialDelivery != InitialDeliveryState::Acknowledged) {
                    State->InitialDelivery = InitialDeliveryState::Acknowledged;
                    RecordInitialDeliveryMetric(
                        Actor, ReplicationState,
                        InitialDeliveryMetric::Acknowledged);
                }
            }
            else if (State->InitialDelivery != InitialDeliveryState::Acknowledged) {
                State->InitialDelivery =
                    InitialDeliveryState::OpenUnacknowledged;
            }
        }
        else if (State->InitialDelivery ==
            InitialDeliveryState::OpenUnacknowledged) {
            // The open bunch was not acknowledged before its channel vanished.
            // Put the same actor back into the oldest-first queue. The retry is
            // counted when an actual replication attempt is made.
            State->InitialDelivery = InitialDeliveryState::Pending;
        }
    }

    static void FinishInitialDelivery(
        AActor* Actor,
        ActorReplicationState* ReplicationState,
        UActorChannel* Channel,
        ActorScheduleState* State,
        bool Attempted,
        bool ProducedData
    ) {
        if (!Actor || !ReplicationState || !State || !Attempted)
            return;

        if (State->InitialDeliveryAttempts != 0) {
            RecordInitialDeliveryMetric(
                Actor, ReplicationState, InitialDeliveryMetric::Retried);
        }
        if (State->InitialDeliveryAttempts <
            (std::numeric_limits<uint32_t>::max)()) {
            ++State->InitialDeliveryAttempts;
        }
        RecordInitialDeliveryMetric(
            Actor, ReplicationState, InitialDeliveryMetric::Attempted);
        if (ProducedData) {
            RecordInitialDeliveryMetric(
                Actor, ReplicationState, InitialDeliveryMetric::Produced);
        }

        if (!Channel) {
            State->InitialDelivery = InitialDeliveryState::Pending;
            return;
        }
        if (IsChannelOpenAcknowledged(Channel)) {
            if (State->InitialDelivery != InitialDeliveryState::Acknowledged) {
                State->InitialDelivery = InitialDeliveryState::Acknowledged;
                RecordInitialDeliveryMetric(
                    Actor, ReplicationState,
                    InitialDeliveryMetric::Acknowledged);
            }
        }
        else {
            State->InitialDelivery = InitialDeliveryState::OpenUnacknowledged;
        }
    }

    static LivePolicyResult EvaluateLivePolicy(
        UWorld* World,
        UNetConnection* Connection,
        AActor* Actor,
        ActorReplicationState* ReplicationState,
        UActorChannel* ExistingChannel,
        bool BypassFrequency,
        bool AllowInitialDelivery
    ) {
        LivePolicyResult Result{};
        ActorScheduleState* State = ResolveSchedulingState(
            World, Connection, Actor, ReplicationState);
        if (!State) {
            // Identity/capacity uncertainty must never turn into a stale-history
            // skip. Replicate conservatively when the live actor itself is valid.
            ++ProfileCounters.LivePolicyIdentityFallbacks;
            Result.Decision = LivePolicyDecision::Eligible;
            return Result;
        }
        Result.State = State;
        State->LastConsideredAtMs = GetTickCount64();

        if (!Actor->NetDriverName.IsNone() &&
            Actor->NetDriverName != NetDriver->NetDriverName) {
            ++ProfileCounters.LivePolicyDriverMismatches;
            Result.Decision = LivePolicyDecision::DriverMismatch;
            return Result;
        }
        if (State->TemporaryRetired) {
            Result.Decision = LivePolicyDecision::TemporaryRetired;
            return Result;
        }
        if (State->TearOffRetired) {
            Result.Decision = LivePolicyDecision::TearOffRetired;
            return Result;
        }

        RefreshInitialDeliveryState(
            Actor, ReplicationState, ExistingChannel, State);
        const bool Dormant = IsDormantForReplication(Actor);
        if (Dormant &&
            State->InitialDelivery == InitialDeliveryState::Acknowledged) {
            ++ProfileCounters.LivePolicyDormantDeferrals;
            Result.Decision = LivePolicyDecision::Dormant;
            return Result;
        }
        if (Dormant && RequiresExplicitInitialDelivery(Actor) &&
            State->InitialDelivery != InitialDeliveryState::NotApplicable) {
            if (State->InitialDelivery ==
                InitialDeliveryState::OpenUnacknowledged) {
                Result.Decision = LivePolicyDecision::InitialDeliveryWaiting;
                return Result;
            }
            if (!AllowInitialDelivery) {
                Result.Decision = LivePolicyDecision::InitialDeliveryPending;
                return Result;
            }
            Result.IsInitialDelivery = true;
        }
        else if (!ExistingChannel && Dormant) {
            ++ProfileCounters.LivePolicyDormantDeferrals;
            Result.Decision = LivePolicyDecision::Dormant;
            return Result;
        }

        const bool OwnerSensitive =
            Actor->bOnlyRelevantToOwner || Actor->bNetUseOwnerRelevancy;
        if (OwnerSensitive && Actor->Owner && !State->OwnerTrackable &&
            !ExistingChannel && !IsDirectConnectionActor(Connection, Actor)) {
            ++ProfileCounters.LivePolicyOwnerSensitiveDeferrals;
            const uint16_t Slot = ResolveImmediateMetricSlot(
                Actor, ReplicationState);
            ++ProfileCounters.ImmediateClasses[Slot].OwnerSensitiveDeferrals;
            Result.Decision = LivePolicyDecision::NotRelevant;
            return Result;
        }
        if (!ExistingChannel && (Actor->bNetStartup || Actor->bNetLoadOnClient))
            ++ProfileCounters.LivePolicyLevelInitializationUnavailable;

        const TransformSample CurrentSample = SampleActorTransform(Actor);
        const bool DormancyChanged = State->LastDormancy != Actor->NetDormancy;
        Result.Moved = Actor->bReplicateMovement &&
            (!State->LastSample.Valid ||
                VectorDistanceSquared(CurrentSample.Location, State->LastSample.Location) > 0.01f ||
                RotationDelta(CurrentSample.Rotation, State->LastSample.Rotation) > 0.01f);
        if (DormancyChanged || Result.Moved) {
            State->ConsecutiveNoDataCalls = 0;
            State->NextFrequencyDeadlineMs = 0;
            State->NextRelevancyCheckMs = 0;
        }
        State->LastDormancy = Actor->NetDormancy;
        State->LastSample = CurrentSample;

        const ULONGLONG NowMs = State->LastConsideredAtMs;
        if (!BypassFrequency && State->RelevancyKnown && !State->LastRelevant &&
            NowMs < State->NextRelevancyCheckMs) {
            ++ProfileCounters.LivePolicyIrrelevantSkips;
            const uint16_t Slot = ResolveImmediateMetricSlot(
                Actor, ReplicationState);
            ++ProfileCounters.ImmediateClasses[Slot].IrrelevantSkips;
            Result.Decision = LivePolicyDecision::NotRelevant;
            return Result;
        }
        if (!BypassFrequency && !Result.IsInitialDelivery && ExistingChannel &&
            State->NextFrequencyDeadlineMs != 0 &&
            NowMs < State->NextFrequencyDeadlineMs) {
            ++ProfileCounters.LivePolicyNotDue;
            Result.Decision = LivePolicyDecision::NotDue;
            return Result;
        }
        if (!BypassFrequency && !Result.IsInitialDelivery && ExistingChannel)
            ++ProfileCounters.LivePolicyDue;

        const bool MustCheckRelevancy =
            BypassFrequency || Result.IsInitialDelivery || !ExistingChannel || OwnerSensitive ||
            Actor->bReplicateMovement || !State->RelevancyKnown ||
            NowMs >= State->NextRelevancyCheckMs;
        if (MustCheckRelevancy) {
            ++ProfileCounters.LivePolicyRelevancyAudits;
            if (State->RelevancyKnown && !State->LastRelevant &&
                State->LastRelevancyCheckMs && NowMs >= State->LastRelevancyCheckMs) {
                ProfileCounters.LivePolicyRelevancyRecheckMilliseconds +=
                    NowMs - State->LastRelevancyCheckMs;
                ++ProfileCounters.LivePolicyRelevancyRecheckSamples;
            }
            const bool Relevant =
                OwnerSensitive && Actor->Owner && !State->OwnerTrackable
                    ? true
                    : IsRelevantForConnection(World, Connection, Actor);
            if (OwnerSensitive && Actor->Owner && !State->OwnerTrackable)
                ++ProfileCounters.LivePolicyNativeRelevancyFallbacks;
            State->RelevancyKnown = true;
            State->LastRelevant = Relevant;
            State->LastRelevancyCheckMs = NowMs;
            State->NextRelevancyCheckMs = NowMs +
                (Relevant && !OwnerSensitive && !Actor->bReplicateMovement
                    ? StaticRelevancyAuditMs
                    : IrrelevantRecheckMs);
            if (!Relevant) {
                ++ProfileCounters.LivePolicyNotRelevant;
                Result.Decision = LivePolicyDecision::NotRelevant;
                return Result;
            }
            ++ProfileCounters.LivePolicyRelevant;
        }

        ++ProfileCounters.LivePolicyEligible;
        Result.Decision = LivePolicyDecision::Eligible;
        return Result;
    }

    static void FinishLivePolicy(
        AActor* Actor,
        UActorChannel* Channel,
        ActorScheduleState* State,
        bool Attempted,
        bool ProducedData,
        float AdaptiveFloorHz = 0.0f
    ) {
        if (!Actor || !State || !Attempted)
            return;

        const ULONGLONG NowMs = GetTickCount64();
        State->LastAttemptAtMs = NowMs;
        if (ProducedData) {
            State->LastSuccessfulDataAtMs = NowMs;
            State->ConsecutiveNoDataCalls = 0;
            if (Actor->bTearOff) {
                State->TearOffRetired = true;
                ++ProfileCounters.LivePolicyTearOffRetirements;
            }
        }
        else if (State->ConsecutiveNoDataCalls <
            (std::numeric_limits<uint8_t>::max)()) {
            ++State->ConsecutiveNoDataCalls;
        }

        if (Actor->bNetTemporary && Channel &&
            IsChannelOpenAcknowledged(Channel)) {
            State->TemporaryRetired = true;
            ++ProfileCounters.LivePolicyTemporaryRetirements;
        }

        const float Frequency = EffectiveFrequency(
            Actor, State->ConsecutiveNoDataCalls, AdaptiveFloorHz);
        State->NextFrequencyDeadlineMs = NowMs + static_cast<ULONGLONG>(
            std::ceil(1000.0f / Frequency));
    }

    static float ComputeLivePriority(
        UNetConnection* Connection,
        AActor* Actor,
        ActorScheduleState* State,
        UActorChannel* ExistingChannel
    ) {
        float BasePriority = Actor && std::isfinite(Actor->NetPriority)
            ? (std::clamp)(Actor->NetPriority, 0.1f, 100.0f)
            : 1.0f;
        const ULONGLONG NowMs = GetTickCount64();
        const ULONGLONG LastSuccess = State ? State->LastSuccessfulDataAtMs : 0;
        const float AgeSeconds = LastSuccess && NowMs > LastSuccess
            ? static_cast<float>(NowMs - LastSuccess) / 1000.0f
            : 1.0f;
        float Priority = BasePriority * (1.0f + (std::min)(AgeSeconds, 4.0f));
        if (!ExistingChannel) Priority += 1000.0f;
        if (Actor && Actor->bReplicateMovement) Priority += 100.0f;
        if (Actor && (IsDirectConnectionActor(Connection, Actor) ||
            (State && State->OwnerTrackable &&
                IsOwnedByConnection(NetDriver->World, Connection, Actor))))
            Priority += 500.0f;
        return Priority;
    }

    static size_t PriorityBand(float Priority) {
        if (!std::isfinite(Priority) || Priority <= 1.0f) return 0;
        if (Priority <= 10.0f) return 1;
        if (Priority <= 100.0f) return 2;
        if (Priority <= 1000.0f) return 3;
        return 4;
    }

    static bool ReplicateActorForConnection(
        UNetConnection* Connection,
        AActor* Actor,
        bool IsPlayerController,
        FName& ChannelName,
        CreateChannelByNameFn CreateChannelByName,
        SetChannelActorFn SetChannelActor,
        ReplicateActorFn ReplicateActor,
        UpdateCameraFn UpdateCamera,
        ReplicationBucket Bucket,
        bool IsBootstrapReplication,
        ActorReplicationState* ReplicationState,
        bool* ReplicationAttempted = nullptr
    ) {
        if (ReplicationAttempted)
            *ReplicationAttempted = false;
        if (!Connection || !Actor || !ReplicationState ||
            ResolveObject(ReplicationState->Identity) != Actor) {
            ConsiderCacheDirtyForNextConnection = true;
            return false;
        }

        const uint32_t NetworkTick = CurrentNetworkTick();
        if (ReplicationState->LastPreReplicationTick != NetworkTick) {
            if (!NativeCallActorPreReplication || !NetDriver) {
                ++ProfileCounters.PreReplicationUnavailable;
                return false;
            }

            NativeCallActorPreReplication(Actor, NetDriver);
            ReplicationState->LastPreReplicationTick = NetworkTick;
            ++ProfileCounters.PreReplicationCalls;

            // PreReplication is arbitrary native/game code. Match Unreal's
            // safety boundary by revalidating the actor before touching a
            // channel after the callback returns.
            if (ResolveObject(ReplicationState->Identity) != Actor ||
                Actor->bActorIsBeingDestroyed || !Actor->bReplicates) {
                ++ProfileCounters.PreReplicationInvalidatedActors;
                ConsiderCacheDirtyForNextConnection = true;
                return false;
            }
        }

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
            ++ProfileCounters.ActorChannelsReused;
        }
        else {
            ActorChannel = CreateChannelByName(Connection, &ChannelName, OpenChannelFlag, -1);

            if (ActorChannel) {
                SetChannelActor(ActorChannel, Actor, 0);
                ScratchActorChannels[Actor] = ActorChannel;
                ++ProfileCounters.ActorChannelsCreated;
            }
        }

        if (!ActorChannel || !ActorChannel->Actor)
            return false;

        int& ReplicationFlags = *reinterpret_cast<int*>((uintptr_t)ActorChannel + OffsetActorChannelReplicationFlags);

        if (!(ReplicationFlags & ReplicationFlagNeedsTick))
            ReplicationFlags |= ReplicationFlagNeedsTick;

        ++ProfileCounters.ChannelStateSamples;
        if (IsChannelOpenAcknowledged(ActorChannel))
            ++ProfileCounters.ChannelOpenAcknowledgedSamples;
        else
            ++ProfileCounters.ChannelNotOpenAcknowledgedSamples;

        ++ProfileCounters.ReplicationAttempts;
        ++ProfileCounters.ReplicationAttemptsByBucket[static_cast<size_t>(Bucket)];
        if (IsBootstrapReplication)
            ++ProfileCounters.BootstrapReplicationAttempts;
        if (ReplicationAttempted)
            *ReplicationAttempted = true;
        const bool ProducedData = ReplicateActor(ActorChannel);
        RecordClassReplicationResult(Actor, ReplicationState, Bucket, ProducedData);
        if (ProducedData) {
            ++ProfileCounters.ReplicationSuccesses;
            ++ProfileCounters.ReplicationSuccessesByBucket[static_cast<size_t>(Bucket)];
            if (IsBootstrapReplication)
                ++ProfileCounters.BootstrapReplicationSuccesses;
        }

        return ProducedData;
}
