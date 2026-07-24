void* OrigProcessEvent = nullptr;

struct PendingInterruptDamageContext {
    PendingInterruptDamageContext* Previous = nullptr;
    int32_t TargetIndex = -1;
    int32_t TargetSerial = 0;
    bool InterruptObserved = false;
};

thread_local PendingInterruptDamageContext* ActiveInterruptDamageContext = nullptr;

void ProcessEventHook(UObject* Object, UFunction* Function, void* Parms) {
    static UFunction* ServerTryActivateAbilityWithEventData = nullptr;
    static UFunction* ServerTryActivateAbility = nullptr;
    static UFunction* ServerNotifyLoadedWorld = nullptr;
    static UFunction* ServerAcknowledgePossession = nullptr;
    static UFunction* ServerTryDoDamage = nullptr;
    static UFunction* ClientOnBehemothInterrupted = nullptr;
    static bool AttemptedInterruptClientFunctionResolution = false;

    const auto CallOriginal = [&]() {
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(Object, Function, Parms);
    };

    if (!Object || !Function) {
        ServerPerformance::RecordProcessEvent(false, true);
        CallOriginal();
        return;
    }

    // Gameplay interception only concerns server RPCs. The one passive client
    // notification below uses an exact UFunction pointer resolved once from its
    // already-loaded class, avoiding name work on the global ProcessEvent path.
    constexpr uint32_t NetServerFunctionFlag = static_cast<uint32_t>(EFunctionFlags::NetServer);
    const bool IsNetServerFunction = (Function->FunctionFlags & NetServerFunctionFlag) != 0;
    if (!IsNetServerFunction) {
        constexpr uint32_t NetClientFunctionFlag = static_cast<uint32_t>(EFunctionFlags::NetClient);
        if (Globals::AmServer &&
            (Function->FunctionFlags & NetClientFunctionFlag) != 0 &&
            Object->IsA(Aplayer_state_bp_C::StaticClass())) {
            if (!AttemptedInterruptClientFunctionResolution) {
                AttemptedInterruptClientFunctionResolution = true;
                ClientOnBehemothInterrupted = Aplayer_state_bp_C::StaticClass()->GetFunction(
                    "player_state_bp_C", "ClientOnBehemothInterrupted");
            }
            if (Function == ClientOnBehemothInterrupted) {
                Networking::NotifyBehemothInterruptClientRpc();
                if (ActiveInterruptDamageContext)
                    ActiveInterruptDamageContext->InterruptObserved = true;
            }
        }
        ServerPerformance::RecordProcessEvent(false, true);
        CallOriginal();
        return;
    }

    const bool IsAbilityRpc = Object->IsA(UAbilitySystemComponent::StaticClass());
    const bool IsPlayerControllerRpc = Globals::AmServer && Object->IsA(APlayerController::StaticClass());
    const bool IsDamageRpc = Globals::AmServer && Object->IsA(UDamageComponent::StaticClass());
    if (!IsAbilityRpc && !IsPlayerControllerRpc && !IsDamageRpc) {
        ServerPerformance::RecordProcessEvent(true, true);
        CallOriginal();
        return;
    }

    std::string FunctionName;
    auto MatchesFunction = [&](UFunction*& CachedFunction, const char* ExpectedName) {
        if (Function == CachedFunction) {
            ServerPerformance::RecordProcessEventFunctionMatch();
            return true;
        }
        if (CachedFunction)
            return false;
        if (FunctionName.empty()) {
            FunctionName = Function->GetName();
            ServerPerformance::RecordProcessEventNameLookup(true);
        }
        if (FunctionName != ExpectedName)
            return false;
        CachedFunction = Function;
        ServerPerformance::RecordProcessEventFunctionMatch();
        return true;
    };

    if (IsAbilityRpc && MatchesFunction(ServerTryActivateAbilityWithEventData,
        "ServerTryActivateAbilityWithEventData")) {
        Params::AbilitySystemComponent_ServerTryActivateAbilityWithEventData* ActivateAbilityParams = (Params::AbilitySystemComponent_ServerTryActivateAbilityWithEventData*)Parms;

        if (ActivateAbilityParams && ServerTryActivateAbilityInternal((UAbilitySystemComponent*)Object, ActivateAbilityParams->AbilityToActivate, ActivateAbilityParams->InputPressed, ActivateAbilityParams->PredictionKey, &ActivateAbilityParams->TriggerEventData)) {
            ServerPerformance::RecordAbilityRpc(true, false);
            ServerPerformance::RecordProcessEvent(true, false);
            return;
        }
        ServerPerformance::RecordAbilityRpc(false, true);
    }
    else if (IsAbilityRpc && MatchesFunction(ServerTryActivateAbility, "ServerTryActivateAbility")) {
        Params::AbilitySystemComponent_ServerTryActivateAbility* ActivateAbilityParams = (Params::AbilitySystemComponent_ServerTryActivateAbility*)Parms;

        if (ActivateAbilityParams && ServerTryActivateAbilityInternal((UAbilitySystemComponent*)Object, ActivateAbilityParams->AbilityToActivate, ActivateAbilityParams->InputPressed, ActivateAbilityParams->PredictionKey, nullptr)) {
            ServerPerformance::RecordAbilityRpc(true, false);
            ServerPerformance::RecordProcessEvent(true, false);
            return;
        }
        ServerPerformance::RecordAbilityRpc(false, true);
    }

    const bool IsLoadedWorldNotification = IsPlayerControllerRpc && MatchesFunction(
        ServerNotifyLoadedWorld, "ServerNotifyLoadedWorld");
    const bool IsPossessionAcknowledgement = IsPlayerControllerRpc && MatchesFunction(
        ServerAcknowledgePossession, "ServerAcknowledgePossession");
    const bool IsDamageRpcMatch = IsDamageRpc && MatchesFunction(
        ServerTryDoDamage, "ServerTryDoDamage");
    if (IsDamageRpcMatch)
        Networking::NotifyDamageRpcObserved();
    const bool IsDamageNotification = IsDamageRpcMatch && Parms;
    int32_t DamageTargetIndex = -1;
    int32_t DamageTargetSerial = 0;
    if (IsDamageNotification) {
        const auto* DamageParams = static_cast<Params::DamageComponent_ServerTryDoDamage*>(Parms);
        // Copy the weak identity while the incoming parameter block is valid.
        // Networking deliberately resolves index+serial itself after native
        // validation/execution; generated FWeakObjectPtr::Get ignores serials.
        DamageTargetIndex = DamageParams->Payload.Hit.Actor.ObjectIndex;
        DamageTargetSerial = DamageParams->Payload.Hit.Actor.ObjectSerialNumber;
    }

    ServerPerformance::RecordProcessEvent(true, true);
    PendingInterruptDamageContext DamageContext{
        ActiveInterruptDamageContext,
        DamageTargetIndex,
        DamageTargetSerial,
        false
    };
    if (IsDamageNotification)
        ActiveInterruptDamageContext = &DamageContext;
    CallOriginal();
    if (IsDamageNotification) {
        ActiveInterruptDamageContext = DamageContext.Previous;
        if (DamageContext.InterruptObserved) {
            Networking::NotifyUrgentDamageTarget(
                DamageContext.TargetIndex, DamageContext.TargetSerial);
        }
    }

    if (!IsPlayerControllerRpc)
        return;

    APlayerController* PlayerController = static_cast<APlayerController*>(Object);
    if (IsLoadedWorldNotification && Parms) {
        const auto* LoadedWorldParams = static_cast<Params::PlayerController_ServerNotifyLoadedWorld*>(Parms);
        Networking::NotifyClientLoadedWorld(PlayerController, LoadedWorldParams->WorldPackageName);
    }
    else if (IsPossessionAcknowledgement && Parms) {
        const auto* PossessionParams = static_cast<Params::PlayerController_ServerAcknowledgePossession*>(Parms);
        Networking::NotifyClientAcknowledgedPawn(PlayerController, PossessionParams->P);
    }

}
