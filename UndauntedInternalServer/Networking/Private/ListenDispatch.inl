    bool Listen(UEngine* Engine, int Port) {
        return Listen(Engine, UWorld::GetWorld(), Port);
    }

    const std::string& GetLastListenError() {
        return LastListenError;
    }

    bool Listen(UEngine* Engine, UWorld* World, int Port) {
        BaseAddress = (uintptr_t)GetModuleHandleA(nullptr);
        LastListenError.clear();
        NativeDispatchOwnershipMismatchLogged = false;

        const auto FailListen = [](const std::string& Reason) {
            LastListenError = Reason;
            std::cout << "Listen failed: " << Reason << std::endl;
            return false;
        };

        if (!Engine || !World)
            return FailListen("engine or world missing");

        constexpr uint8_t IsNetRelevantForSignature[] = {
            0x48, 0x89, 0x5C, 0x24, 0x18, 0x56, 0x57, 0x41,
            0x56, 0x48, 0x83, 0xEC, 0x70, 0x48, 0x8B, 0xF2
        };
        constexpr uint8_t CallPreReplicationSignature[] = {
            0x48, 0x85, 0xD2, 0x0F, 0x84, 0xB1, 0x01, 0x00,
            0x00, 0x53, 0x55, 0x48, 0x83, 0xEC, 0x38
        };
        const uintptr_t IsNetRelevantForAddress =
            BaseAddress + OffsetActorIsNetRelevantFor;
        MEMORY_BASIC_INFORMATION RelevancyMemory{};
        const bool RelevancyExecutable =
            VirtualQuery(reinterpret_cast<void*>(IsNetRelevantForAddress),
                &RelevancyMemory, sizeof(RelevancyMemory)) == sizeof(RelevancyMemory) &&
            RelevancyMemory.State == MEM_COMMIT &&
            (RelevancyMemory.Protect & (
                PAGE_EXECUTE | PAGE_EXECUTE_READ |
                PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) != 0;
        NativeRelevancySignatureValid = RelevancyExecutable &&
            std::memcmp(reinterpret_cast<const void*>(IsNetRelevantForAddress),
                IsNetRelevantForSignature,
                sizeof(IsNetRelevantForSignature)) == 0;
        NativeIsNetRelevantFor = NativeRelevancySignatureValid
            ? reinterpret_cast<IsNetRelevantForFn>(IsNetRelevantForAddress)
            : nullptr;
        std::cout << "Native actor relevancy: "
            << (NativeIsNetRelevantFor ? "AActor::IsNetRelevantFor" :
                "conservative custom fallback")
            << std::endl;

        const uintptr_t CallPreReplicationAddress =
            BaseAddress + OffsetActorCallPreReplication;
        MEMORY_BASIC_INFORMATION PreReplicationMemory{};
        const bool PreReplicationExecutable =
            VirtualQuery(reinterpret_cast<void*>(CallPreReplicationAddress),
                &PreReplicationMemory, sizeof(PreReplicationMemory)) ==
                    sizeof(PreReplicationMemory) &&
            PreReplicationMemory.State == MEM_COMMIT &&
            (PreReplicationMemory.Protect & (
                PAGE_EXECUTE | PAGE_EXECUTE_READ |
                PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)) != 0;
        NativePreReplicationSignatureValid = PreReplicationExecutable &&
            std::memcmp(reinterpret_cast<const void*>(CallPreReplicationAddress),
                CallPreReplicationSignature,
                sizeof(CallPreReplicationSignature)) == 0;
        NativeCallActorPreReplication = NativePreReplicationSignatureValid
            ? reinterpret_cast<CallActorPreReplicationFn>(
                CallPreReplicationAddress)
            : nullptr;
        std::cout << "Native actor pre-replication: "
            << (NativeCallActorPreReplication
                ? "AActor::CallPreReplication"
                : "signature mismatch")
            << std::endl;
        if (!NativeCallActorPreReplication)
            return FailListen(
                "AActor::CallPreReplication signature validation failed");

        FName GameNetDriver = UKismetStringLibrary::Conv_StringToName(L"GameNetDriver");
        NativeGameNetDriverName = GameNetDriver;
        NativeOwnershipConflictLogged = false;
        CreateNamedNetDriverFn CreateNamedNetDriver = reinterpret_cast<CreateNamedNetDriverFn>(BaseAddress + OffsetCreateNamedNetDriver);

        const bool NetDriverCreated = CreateNamedNetDriver(
            Engine, World, GameNetDriver, GameNetDriver) != 0;
        std::cout << "Net driver create: " << static_cast<int>(NetDriverCreated) << std::endl;
        if (!NetDriverCreated)
            return FailListen("CreateNamedNetDriver failed for GameNetDriver");

        NetDriver = FindNetDriverByName(Engine, World, GameNetDriver);

        if (!NetDriver)
            return FailListen("created GameNetDriver is absent from the active world context");

        const ObjectIdentity NetDriverIdentity = TrackObject(NetDriver);
        if (ResolveObject(NetDriverIdentity) != NetDriver ||
            !NetDriver->IsA(UIpNetDriver::StaticClass())) {
            return FailListen("GameNetDriver identity or IpNetDriver class validation failed");
        }

        std::cout << NetDriver->GetFullName() << std::endl;

        ResetConsiderCache();

        // Match Unreal's native listen ordering. SetReplicationDriver calls
        // InitializeActorsInWorld from inside InitListen, so the world's
        // authoritative NetDriver pointer must already be visible then.
        World->NetDriver = NetDriver;
        SetNetDriverWorldFn SetNetDriverWorld = reinterpret_cast<SetNetDriverWorldFn>(BaseAddress + OffsetSetNetDriverWorld);
        SetNetDriverWorld(NetDriver, World);

        // The synthetic dedicated server uses UIpNetDriver for transport and
        // the scheduler below for actor selection. The client-cooked Archon
        // graph cannot be initialized faithfully here.
        NetDriver->ReplicationDriverClass = nullptr;

        FURL url = FURL();
        url.Port = Port;

        FString empty = FString();
        InitListenFn InitListen = *(reinterpret_cast<InitListenFn*>(
            *reinterpret_cast<uintptr_t*>(NetDriver) + OffsetNetDriverInitListen));
        // UWorld implements FNetworkNotify as an embedded secondary base at
        // World+0x28. InitListen expects the address of that subobject, not the
        // vtable value stored in its first field.
        void* const ExpectedNetworkNotify = static_cast<void*>(&World->NetworkNotify);
        bool ListenStatus = InitListen(NetDriver, ExpectedNetworkNotify,
            &url, false, &empty);

        std::cout << "Listen Status: " << ListenStatus << std::endl;

        if (!ListenStatus)
            return FailListen("UIpNetDriver::InitListen returned false");

        void* const InstalledNetworkNotify = *reinterpret_cast<void**>(
            reinterpret_cast<uintptr_t>(NetDriver) + OffsetNetDriverNotify);
        std::cout << "Native network notify validation: installed=" << InstalledNetworkNotify
            << " expected=" << ExpectedNetworkNotify
            << " world=" << World
            << " worldNetDriver=" << World->NetDriver
            << " driverWorld=" << NetDriver->World << std::endl;
        if (InstalledNetworkNotify != ExpectedNetworkNotify ||
            World->NetDriver != NetDriver || NetDriver->World != World) {
            return FailListen("native NetDriver world/network-notify validation failed");
        }

        if (NetDriver->ReplicationDriver)
            return FailListen("unexpected native replication driver with custom scheduler");
        std::cout << "Native network transport: " << NetDriver->GetFullName()
            << " (optimized actor scheduler)" << std::endl;
        return true;
    }

    static bool IsAuthoritativeNativeOwnership(UNetDriver* Driver, UWorld* World,
        bool RequireReciprocal) {
        if (!Driver || Driver != NetDriver || !World)
            return false;
        const ObjectIdentity DriverIdentity = TrackObject(Driver);
        const ObjectIdentity WorldIdentity = TrackObject(World);
        if (ResolveObject(DriverIdentity) != Driver || ResolveObject(WorldIdentity) != World ||
            !Driver->IsA(UIpNetDriver::StaticClass()))
            return false;
        UEngine* Engine = UEngine::GetEngine();
        if (!Engine || FindNetDriverByName(Engine, World, NativeGameNetDriverName) != Driver)
            return false;
        void* const ExpectedNotify = static_cast<void*>(&World->NetworkNotify);
        void* const InstalledNotify = *reinterpret_cast<void**>(
            reinterpret_cast<uintptr_t>(Driver) + OffsetNetDriverNotify);
        return Driver->World == World && InstalledNotify == ExpectedNotify &&
            (!RequireReciprocal || World->NetDriver == Driver);
    }

    static bool EnsureNativeReciprocalOwnership(UNetDriver* Driver, const char* Stage) {
        UWorld* World = UWorld::GetWorld();
        if (IsAuthoritativeNativeOwnership(Driver, World, true))
            return true;
        if (!IsAuthoritativeNativeOwnership(Driver, World, false)) {
            ++ProfileCounters.NativeDispatchBlocked;
            if (World && World->NetDriver && World->NetDriver != Driver) {
                ++ProfileCounters.NativeDispatchConflicts;
                if (!NativeOwnershipConflictLogged) {
                    NativeOwnershipConflictLogged = true;
                    std::cout << "Native network ownership conflict at " << Stage
                        << ": expected=" << Driver << " actual=" << World->NetDriver << std::endl;
                    QueueConnectionEvent({ ConnectionEventType::NativeDispatchConflict, nullptr,
                        CurrentNetworkTick(), 0, 0, 0 });
                }
            }
            return false;
        }
        if (World->NetDriver != nullptr)
            return false;

        World->NetDriver = Driver;
        if (World->NetDriver != Driver) {
            ++ProfileCounters.NativeDispatchBlocked;
            return false;
        }
        ++ProfileCounters.NativeReciprocalRepairs;
        if (!NativeDispatchOwnershipMismatchLogged) {
            NativeDispatchOwnershipMismatchLogged = true;
            std::cout << "Native reciprocal ownership restored at " << Stage
                << ": driver=" << Driver << " world=" << World << std::endl;
            QueueConnectionEvent({ ConnectionEventType::NativeReciprocalRepair, nullptr,
                CurrentNetworkTick(), 0, 0, 0 });
        }
        return true;
    }

    bool PrepareNativeNetworkDispatch(UNetDriver* Driver) {
        if (!Driver || Driver != NetDriver)
            return true;
        const bool OwnershipValidAtEntry =
            IsAuthoritativeNativeOwnership(Driver, UWorld::GetWorld(), true);
        if (OwnershipValidAtEntry)
            ++ProfileCounters.NativeDispatchOwnershipValidBefore;
        const bool Ready = EnsureNativeReciprocalOwnership(Driver, "before TickDispatch");
        return Ready;
    }

    void NotifyNativeNetworkDispatchCompleted(UNetDriver* Driver) {
        if (!Driver || Driver != NetDriver)
            return;
        ++ProfileCounters.NativeDispatchCalls;
        const bool ValidAfter =
            IsAuthoritativeNativeOwnership(Driver, UWorld::GetWorld(), true);
        if (ValidAfter)
            ++ProfileCounters.NativeDispatchOwnershipValidAfter;
        else {
            ++ProfileCounters.NativeDispatchOwnershipLostInside;
            EnsureNativeReciprocalOwnership(Driver, "after TickDispatch");
        }
    }

    bool PrepareNativeNetworkFlush(UNetDriver* Driver) {
        if (!Driver || Driver != NetDriver)
            return true;
        const bool OwnershipValidAtEntry =
            IsAuthoritativeNativeOwnership(Driver, UWorld::GetWorld(), true);
        if (OwnershipValidAtEntry)
            ++ProfileCounters.NativeFlushOwnershipValidBefore;
        const bool Ready = EnsureNativeReciprocalOwnership(Driver, "before TickFlush");
        return Ready;
    }

    void NotifyNativeNetworkFlushCompleted(UNetDriver* Driver) {
        if (!Driver || Driver != NetDriver)
            return;
        ++ProfileCounters.NativeFlushCalls;
        const bool ValidAfter =
            IsAuthoritativeNativeOwnership(Driver, UWorld::GetWorld(), true);
        if (ValidAfter)
            ++ProfileCounters.NativeFlushOwnershipValidAfter;
        else
            ++ProfileCounters.NativeFlushOwnershipLostInside;
    }

    void NotifyNativeEngineTickCompleted(UWorld* World) {
        if (!NetDriver || !World)
            return;
        if (!IsAuthoritativeNativeOwnership(NetDriver, World, true))
            ++ProfileCounters.NativeOwnershipMissingAfterEngineTick;
    }

    void NotifyNativePostLogin(APlayerController* PlayerController) {
        const ObjectIdentity ControllerIdentity = TrackObject(PlayerController);
        if (!PlayerController || ResolveObject(ControllerIdentity) != PlayerController)
            return;

        UNetConnection* Connection =
            FindConnectionForController(PlayerController);
        ++ProfileCounters.NativePostLogins;
        QueueConnectionEvent({ ConnectionEventType::NativePostLogin, Connection,
            CurrentNetworkTick(), static_cast<uint32_t>(ControllerIdentity.Index),
            Connection ? 1u : 0u, 0 });
    }

    void TickNetworking() {
        TickNetworking(UWorld::GetWorld());
    }


    void TickNetworking(UWorld* World) {
        ProfileCounters.LastCompletedPhase = 1;
        if (!World || !NetDriver) {
            if (!ConnectionBootstrapStates.empty() || !ActorReplicationStates.empty() || CachedWorld)
                ResetConsiderCache();
            CurrentConnections.clear();
            LiveConnections.clear();
            return;
        }

        if (CachedWorld && CachedWorld != World)
            ResetConsiderCache();

        World->NetDriver = NetDriver;
        NetDriver->World = World;

        static FName ChannelName = UKismetStringLibrary::Conv_StringToName(L"Actor");
        static UClass* ActorChannelClass = UActorChannel::StaticClass();
        static ReplicationClassCache ClassCache = {
            APlayerController::StaticClass(),
            AArchonCharacter::StaticClass(),
            AArchonBehemoth::StaticClass(),
            AArchonLantern::StaticClass(),
            AArchonEquipment::StaticClass(),
            Aprojectile_base_bp_C::StaticClass(),
            APawn::StaticClass(),
            APlayerState::StaticClass(),
            AArchonLoadout::StaticClass(),
            AArchonInventory::StaticClass(),
            AArchonBuff::StaticClass(),
            AArchonAoe::StaticClass(),
            AArchonBeam::StaticClass(),
            AAbilityActor::StaticClass(),
            AMonsterPartActor::StaticClass()
        };
        static CreateChannelByNameFn CreateChannelByName = reinterpret_cast<CreateChannelByNameFn>(BaseAddress + OffsetCreateChannelByName);
        static SetChannelActorFn SetChannelActor = reinterpret_cast<SetChannelActorFn>(BaseAddress + OffsetSetChannelActor);
        static ReplicateActorFn ReplicateActor = reinterpret_cast<ReplicateActorFn>(BaseAddress + OffsetActorChannelReplicateActor);
        static UpdateCameraFn UpdateCamera = reinterpret_cast<UpdateCameraFn>(BaseAddress + OffsetPlayerControllerUpdateCamera);

        uint32_t& NetworkTick = *reinterpret_cast<uint32_t*>((uintptr_t)NetDriver + OffsetNetDriverTickCount);
        ++NetworkTick;
        RefreshConnectionState(NetDriver, NetworkTick);
        ProfileCounters.LastCompletedPhase = 2;
        ++ProfileCounters.SchedulerTickCalls;
        ++ProfileCounters.ConnectionSamples;
        ProfileCounters.ConnectionTotal += LiveConnections.size();
        ProfileCounters.MaximumConnections = (std::max)(ProfileCounters.MaximumConnections,
            static_cast<uint32_t>(LiveConnections.size()));

        // There is no useful actor-channel work without a client. Preserve the
        // driver/world bookkeeping above, then force a fresh candidate snapshot
        // as soon as the first connection arrives.
        if (LiveConnections.empty()) {
            ++ProfileCounters.ZeroConnectionTicks;
            ConsiderCacheDirtyForNextConnection = true;
            EmitPendingConnectionEvents();
            ProfileCounters.BootstrapPhaseConnections.fill(0);
            ProfileCounters.LastCompletedPhase = 6;
            return;
        }

        UrgentCandidateBatch UrgentCandidates{};
        CacheRebuildReason RebuildReason = CacheRebuildReason::Forced;
        if (ConsiderCacheDirtyForNextConnection ||
            GetCacheRebuildReason(World, RebuildReason)) {
            RebuildConsiderCache(World, NetDriver, ClassCache, RebuildReason);
            ConsiderCacheDirtyForNextConnection = false;
        }
        const int64_t CandidateSelectionStartedAt = PerformanceTimestamp();
        BuildReplicateList(NetworkTick);
        ProfileCounters.CandidateSelectionMicroseconds +=
            ElapsedMicroseconds(CandidateSelectionStartedAt);
        ++ProfileCounters.CandidateSelectionTimingSamples;
        UrgentCandidates = BuildUrgentCandidateBatch(GetTickCount64());
        ProfileCounters.LastCompletedPhase = 3;

        for (UNetConnection* Connection : LiveConnections) {
            const int64_t ChannelScanStartedAt = PerformanceTimestamp();
            BuildActorChannelScratchMap(Connection, ActorChannelClass);
            ProfileCounters.ChannelScanMicroseconds += ElapsedMicroseconds(ChannelScanStartedAt);
            ++ProfileCounters.ChannelScanTimingSamples;

            if (Connection->PlayerController)
                Connection->ViewTarget = Connection->PlayerController->GetViewTarget();

            auto StateIt = ConnectionBootstrapStates.find(Connection);
            ConnectionBootstrapState* Bootstrap = StateIt != ConnectionBootstrapStates.end()
                ? &StateIt->second
                : nullptr;
            const ULONGLONG NowMs = GetTickCount64();
            if (Bootstrap)
                RefreshPawnState(Connection, *Bootstrap, NetworkTick, NowMs);
            const bool IsBootstrapping = Bootstrap &&
                Bootstrap->Phase == ConnectionBootstrapPhase::Bootstrapping;
			if (++CurrentConnectionPass == 0)
				++CurrentConnectionPass;
			const uint64_t ConnectionPass = CurrentConnectionPass;

            if (IsBootstrapping) {
                const int64_t BootstrapSelectionStartedAt = PerformanceTimestamp();
                DiscoverCriticalActors(World, Connection, *Bootstrap, NetworkTick, NowMs);
                ProfileCounters.CandidateSelectionMicroseconds +=
                    ElapsedMicroseconds(BootstrapSelectionStartedAt);
                ++ProfileCounters.CandidateSelectionTimingSamples;
            }

            const int64_t ReplicationStartedAt = PerformanceTimestamp();
            const auto TryCandidate = [&](ReplicationCandidate& Candidate,
                    bool BypassFrequency, bool BootstrapReplication,
                    bool MovementPrepass, float AdaptiveFloorHz = 0.0f,
                    bool* OutAttempted = nullptr) {
                    if (OutAttempted)
                        *OutAttempted = false;
                    if (Candidate.LastReplicatedConnectionPass == ConnectionPass) {
                        ++ProfileCounters.LivePolicyDuplicateSkips;
                        return false;
                    }

                    AActor* Actor = Candidate.Actor;
                    if (!Candidate.ReplicationState ||
                        ResolveObject(Candidate.ReplicationState->Identity) != Actor ||
                        !IsActorReplicationCandidate(World, Actor)) {
                        ConsiderCacheDirtyForNextConnection = true;
                        ++ProfileCounters.SchedulerActorIdentityResets;
                        return false;
                    }

                    UActorChannel* ExistingChannel = nullptr;
                    const auto ExistingIt = ScratchActorChannels.find(Actor);
                    if (ExistingIt != ScratchActorChannels.end())
                        ExistingChannel = ExistingIt->second;

                    const LivePolicyResult Policy = EvaluateLivePolicy(
                        World, Connection, Actor, Candidate.ReplicationState,
                        ExistingChannel, BypassFrequency);
                    Candidate.LastReplicatedConnectionPass = ConnectionPass;
                    if (Policy.Decision != LivePolicyDecision::Eligible) {
                        if (BypassFrequency)
                            ++ProfileCounters.LivePolicyCriticalRejected;
                        return false;
                    }

                    bool ReplicationAttempted = false;
                    const bool ProducedData = ReplicateActorForConnection(
                        Connection, Actor, Candidate.IsPlayerController,
                        ChannelName, CreateChannelByName, SetChannelActor,
                        ReplicateActor, UpdateCamera, Candidate.Bucket,
                        BootstrapReplication, Candidate.ReplicationState,
                        &ReplicationAttempted);
                    UActorChannel* ResultingChannel = nullptr;
                    const auto ResultingIt = ScratchActorChannels.find(Actor);
                    if (ResultingIt != ScratchActorChannels.end())
                        ResultingChannel = ResultingIt->second;
                    FinishLivePolicy(Actor, ResultingChannel, Policy.State,
                        ReplicationAttempted, ProducedData, AdaptiveFloorHz);

                    if (MovementPrepass && ReplicationAttempted) {
                        ++ProfileCounters.LivePolicyMovementPrepassAttempts;
                        if (ProducedData)
                            ++ProfileCounters.LivePolicyMovementPrepassSuccesses;
                    }
                    if (OutAttempted)
                        *OutAttempted = ReplicationAttempted;
                    return ProducedData;
                };

                for (size_t UrgentIndex = 0; UrgentIndex < UrgentCandidates.Count; ++UrgentIndex) {
                    UrgentCandidateEntry& Urgent = UrgentCandidates.Entries[UrgentIndex];
                    ReplicationCandidate* Candidate = Urgent.Candidate;
                    if (!Candidate || (Urgent.TargetConnection.Object &&
                        ResolveObject(Urgent.TargetConnection) != Connection)) {
                        continue;
                    }
					// Multiple outcomes can promote the same actor in one engine pass.
					// Preserve each reason's queued metrics without replicating the actor twice.
                    if (Candidate->LastReplicatedConnectionPass == ConnectionPass)
                        continue;

                    bool ReplicationAttempted = false;
					const bool ProducedData = TryCandidate(*Candidate, true, false,
                        false, 0.0f, &ReplicationAttempted);
					const size_t ReasonIndex = UrgentReasonIndex(Urgent.Reason);
					if (ProducedData) {
                        ++ProfileCounters.UrgentDamageReplicationSuccesses;
						++ProfileCounters.UrgentSuccessesByReason[ReasonIndex];
                    }
                    if (ReplicationAttempted) {
						Candidate->LastReplicatedConnectionPass = ConnectionPass;
                        ++ProfileCounters.UrgentDamageReplicationAttempts;
						++ProfileCounters.UrgentAttemptsByReason[ReasonIndex];
                        ++ProfileCounters.UrgentDamageLatencySamples;
                        ProfileCounters.UrgentDamageLatencyMilliseconds +=
                            NowMs - Urgent.QueuedAtMs;
						++ProfileCounters.UrgentLatencySamplesByReason[ReasonIndex];
						ProfileCounters.UrgentLatencyMillisecondsByReason[ReasonIndex] +=
							NowMs - Urgent.QueuedAtMs;
                    }
                    else {
                        RetryUrgentCandidateForConnection(Urgent, Connection);
                    }
                }

				// Critical and connection-owned actors are considered first on every
                // 30 Hz pass. Native relevancy still prevents owner-only leakage.
				for (ReplicationCandidate& Candidate : ConsiderCache) {
					AActor* Actor = Candidate.Actor;
					if (Candidate.LastReplicatedConnectionPass == ConnectionPass ||
						IsUrgentCandidate(UrgentCandidates, &Candidate, Connection)) {
						continue;
					}
					if (!Candidate.ReplicationState ||
						ResolveObject(Candidate.ReplicationState->Identity) != Actor) {
						ConsiderCacheDirtyForNextConnection = true;
						++ProfileCounters.SchedulerActorIdentityResets;
						continue;
					}
					if (!IsActorReplicationCandidate(World, Actor))
						continue;

					InitializationActorRole Role{};
					uint8_t OwnerDepth = 0;
					const bool ConnectionCritical =
                        FindInitializationRole(World, Connection, Actor, Role, OwnerDepth);
                    if (!ConnectionCritical && !Candidate.IsCritical)
						continue;

					++ProfileCounters.CriticalPrepassCandidates;
					bool ReplicationAttempted = false;
                    const bool CoreConnectionActor =
                        ConnectionCritical &&
                        Role != InitializationActorRole::OwnedActor;
                    const bool LatencySensitiveOwned =
                        ConnectionCritical &&
                        IsLatencySensitiveOwnedActor(Candidate.ClassFlags);
                    const bool ForceEveryPass =
                        IsBootstrapping || Candidate.IsCritical ||
                        CoreConnectionActor || LatencySensitiveOwned;
                    const float AdaptiveFloorHz =
                        ConnectionCritical && !ForceEveryPass
                            ? OwnedCriticalAdaptiveFloorHz
                            : 0.0f;
                    if (AdaptiveFloorHz > 0.0f)
                        ++ProfileCounters.CriticalOwnedFrequencyLimited;
					const bool ProducedData = TryCandidate(
                        Candidate, ForceEveryPass,
                        IsBootstrapping && ConnectionCritical, false,
                        AdaptiveFloorHz, &ReplicationAttempted);
					if (ReplicationAttempted) {
						++ProfileCounters.CriticalPrepassAttempts;
						if (ProducedData)
							++ProfileCounters.CriticalPrepassSuccesses;
					}
					else {
						++ProfileCounters.CriticalPrepassSetupFallbacks;
					}
				}

                // Movement-sensitive gameplay actors are next. Their live
                // NetUpdateFrequency remains authoritative; observed movement
                // merely cancels an adaptive idle deadline.
                for (ReplicationCandidate& Candidate : ConsiderCache) {
                    AActor* Actor = Candidate.Actor;
                    if (!Actor || Candidate.LastReplicatedConnectionPass == ConnectionPass)
                        continue;
                    if (!Actor->bReplicateMovement &&
                        Candidate.Bucket == ReplicationBucket::Immediate)
                        continue;
                    TryCandidate(Candidate, false, false, true);
                }

                PriorityScratch.clear();
                if (PriorityScratch.capacity() < ConsiderCache.size())
                    PriorityScratch.reserve(ConsiderCache.size());
                for (ReplicationCandidate& Candidate : ConsiderCache) {
                    AActor* Actor = Candidate.Actor;
                    if (!Actor || Candidate.LastReplicatedConnectionPass == ConnectionPass)
                        continue;
                    if (!Candidate.ReplicationState ||
                        ResolveObject(Candidate.ReplicationState->Identity) != Actor ||
                        !IsActorReplicationCandidate(World, Actor)) {
                        ConsiderCacheDirtyForNextConnection = true;
                        ++ProfileCounters.SchedulerActorIdentityResets;
                        continue;
                    }
                    UActorChannel* ExistingChannel = nullptr;
                    const auto ExistingIt = ScratchActorChannels.find(Actor);
                    if (ExistingIt != ScratchActorChannels.end())
                        ExistingChannel = ExistingIt->second;
                    const LivePolicyResult Policy = EvaluateLivePolicy(
                        World, Connection, Actor, Candidate.ReplicationState,
                        ExistingChannel, false);
                    Candidate.LastReplicatedConnectionPass = ConnectionPass;
                    if (Policy.Decision != LivePolicyDecision::Eligible)
                        continue;
                    const float Priority = ComputeLivePriority(
                        Connection, Actor, Policy.State, ExistingChannel);
                    ++ProfileCounters.LivePolicyPriorityBands[
                        PriorityBand(Priority)];
                    PriorityScratch.push_back({
                        &Candidate, Priority, Policy.State
                    });
                }
                std::sort(PriorityScratch.begin(), PriorityScratch.end(),
                    [](const PrioritizedCandidate& Left,
                        const PrioritizedCandidate& Right) {
                        if (Left.Priority != Right.Priority)
                            return Left.Priority > Right.Priority;
                        const int32_t LeftIndex =
                            Left.Candidate && Left.Candidate->ReplicationState
                            ? Left.Candidate->ReplicationState->Identity.Index : -1;
                        const int32_t RightIndex =
                            Right.Candidate && Right.Candidate->ReplicationState
                            ? Right.Candidate->ReplicationState->Identity.Index : -1;
                        return LeftIndex < RightIndex;
                    });
                ++ProfileCounters.LivePolicyPrioritySorts;
                ProfileCounters.LivePolicyPriorityCandidates += PriorityScratch.size();
                for (const PrioritizedCandidate& Prioritized : PriorityScratch) {
                    if (!Prioritized.Candidate)
                        continue;
                    ReplicationCandidate& Candidate = *Prioritized.Candidate;
                    bool ReplicationAttempted = false;
                    const bool ProducedData = ReplicateActorForConnection(
                        Connection, Candidate.Actor, Candidate.IsPlayerController,
                        ChannelName, CreateChannelByName, SetChannelActor,
                        ReplicateActor, UpdateCamera, Candidate.Bucket, false,
                        Candidate.ReplicationState, &ReplicationAttempted);
                    UActorChannel* ResultingChannel = nullptr;
                    const auto ResultingIt =
                        ScratchActorChannels.find(Candidate.Actor);
                    if (ResultingIt != ScratchActorChannels.end())
                        ResultingChannel = ResultingIt->second;
                    FinishLivePolicy(Candidate.Actor, ResultingChannel,
                        Prioritized.State, ReplicationAttempted, ProducedData);
                }
                ProfileCounters.ReplicationMicroseconds += ElapsedMicroseconds(ReplicationStartedAt);
                ++ProfileCounters.ReplicationTimingSamples;

                if (IsBootstrapping) {
                    RefreshCriticalChannelAcknowledgements(Connection, *Bootstrap, NetworkTick, NowMs);
                    TryCompleteBootstrap(Connection, *Bootstrap, NetworkTick, NowMs);
                }
            ProfileCounters.LastCompletedPhase = 4;
        }
        FinalizeImmediatePassMetrics(NetworkTick);
        EmitPendingConnectionEvents();
        ProfileCounters.BootstrapPhaseConnections.fill(0);
        for (const auto& [Connection, Bootstrap] : ConnectionBootstrapStates) {
            const size_t PhaseIndex = static_cast<size_t>(Bootstrap.Phase);
            if (PhaseIndex < ProfileCounters.BootstrapPhaseConnections.size())
                ++ProfileCounters.BootstrapPhaseConnections[PhaseIndex];
        }
        ProfileCounters.LastCompletedPhase = 6;
    }

    const std::vector<UNetConnection*>& GetLiveConnections() {
        return LiveConnections;
    }

    ProfilingCounters TakeProfilingCounters() {
        ProfileCounters.CurrentSchedulerStates = CurrentSchedulerActorStates;
        ProfileCounters.MaximumSchedulerStates = (std::max)(
            ProfileCounters.MaximumSchedulerStates, CurrentSchedulerActorStates);
        ProfilingCounters Snapshot = ProfileCounters;
        PopulateImmediateClassNames(Snapshot);
        ProfileCounters = {};
        ProfileCounters.LastCompletedPhase = Snapshot.LastCompletedPhase;
        ProfileCounters.CurrentCandidates = static_cast<uint32_t>(ConsiderCache.size());
        ProfileCounters.CurrentSchedulerStates = CurrentSchedulerActorStates;
        ProfileCounters.MaximumSchedulerStates = CurrentSchedulerActorStates;
        ProfileCounters.BootstrapPhaseConnections = Snapshot.BootstrapPhaseConnections;
        ResetImmediateClassRegistry();
        ActorPropertyDistributionDirty = true;
        return Snapshot;
    }

    void ResetWorldState(UWorld* World) {
        (void)World;
        ResetConsiderCache();
        CachedWorld = nullptr;
        CachedWorldIdentity = {};
        NativeDispatchOwnershipMismatchLogged = false;
        NativeOwnershipConflictLogged = false;
    }

    void ResetDriverState(UNetDriver* Driver) {
        if (Driver == NetDriver)
            NetDriver = nullptr;
        ResetConsiderCache();
        NativeDispatchOwnershipMismatchLogged = false;
        NativeOwnershipConflictLogged = false;
    }

    void BeginFrameNetworkLifecycle(UWorld* World) {
        if (CachedWorld != nullptr && CachedWorld != World)
            ResetWorldState(World);
        if (NetDriver != nullptr && NetDriver->World != World)
            ResetDriverState(NetDriver);
    }

    void EndFrameNetworkLifecycle(UWorld* World) {
        if (World == nullptr)
            ResetWorldState(nullptr);
    }
}
