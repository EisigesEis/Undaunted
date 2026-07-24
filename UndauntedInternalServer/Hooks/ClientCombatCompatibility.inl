namespace ClientCombatCompatibility {
    constexpr uint64_t ReviveIntentTimeoutMilliseconds = 1000;

    struct PendingReviveIntent {
        StableObjectIdentity Pawn{};
        StableObjectIdentity World{};
        ELoadoutQuickItemSlot Slot = ELoadoutQuickItemSlot::Slot_Flask_Revive;
        uint64_t QueuedAtMilliseconds = 0;
    };

    static PendingReviveIntent PendingRevive{};
    static StableObjectIdentity BleedoutAcknowledgedPawn{};
    static UFunction* TryUseQuickItemFunction = nullptr;
    static UFunction* ReviveFromBleedoutFunction = nullptr;
    static UFunction* ReviveFromBleedoutBlueprintFunction = nullptr;
    static UFunction* SetBleedoutStateFunction = nullptr;
    static UFunction* ClientBleedoutStartedFunction = nullptr;
    static UFunction* TickStaminaFunction = nullptr;
    static UFunction* EvaluateStaminaFunction = nullptr;
    static uint64_t LastFunctionResolveAttemptMilliseconds = 0;
    static bool ServerOnlyStaminaSuppressionEnabled = false;

    static bool AllFunctionsResolved() {
        return TryUseQuickItemFunction && ReviveFromBleedoutFunction &&
            ReviveFromBleedoutBlueprintFunction && SetBleedoutStateFunction &&
            ClientBleedoutStartedFunction && TickStaminaFunction && EvaluateStaminaFunction;
    }

    static void ResolveFunctions() {
        if (AllFunctionsResolved())
            return;
        const uint64_t NowMilliseconds = GetTickCount64();
        if (NowMilliseconds - LastFunctionResolveAttemptMilliseconds < 1000)
            return;
        LastFunctionResolveAttemptMilliseconds = NowMilliseconds;

        UClass* PlayerClass = ABP_PlayerCharacter_C::StaticClass();
        if (PlayerClass) {
            if (!TryUseQuickItemFunction)
                TryUseQuickItemFunction = PlayerClass->GetFunction(
                    "BP_PlayerCharacter_C", "TryUseQuickItem");
            if (!ReviveFromBleedoutBlueprintFunction)
                ReviveFromBleedoutBlueprintFunction = PlayerClass->GetFunction(
                    "BP_PlayerCharacter_C", "BP_ReviveFromBleedout");
            if (!SetBleedoutStateFunction)
                SetBleedoutStateFunction = PlayerClass->GetFunction(
                    "BP_PlayerCharacter_C", "Set Bleedout State");
            if (!TickStaminaFunction)
                TickStaminaFunction = PlayerClass->GetFunction(
                    "BP_PlayerCharacter_C", "TickStamina");
            if (!EvaluateStaminaFunction)
                EvaluateStaminaFunction = PlayerClass->GetFunction(
                    "BP_PlayerCharacter_C", "Evaluate Stamina System");
        }
        UClass* CharacterClass = AArchonCharacter::StaticClass();
        if (!ReviveFromBleedoutFunction && CharacterClass)
            ReviveFromBleedoutFunction = CharacterClass->GetFunction(
                "ArchonCharacter", "BP_ReviveFromBleedout");
        UClass* BleedoutClass = UArchonBleedoutComponent::StaticClass();
        if (!ClientBleedoutStartedFunction && BleedoutClass)
            ClientBleedoutStartedFunction = BleedoutClass->GetFunction(
                "ArchonBleedoutComponent", "ClientOnBleedoutStarted");
    }

    static void ClearPendingRevive(const char* Diagnostic = nullptr) {
        if (PendingRevive.Pawn.Object && Diagnostic)
            OutputDebugStringA(Diagnostic);
        PendingRevive = {};
    }

    static bool IsLocalPawn(APawn* Pawn) {
        if (!Pawn)
            return false;
        const StableObjectIdentity PawnIdentity = TrackStableObject(Pawn);
        if (ResolveStableObject(PawnIdentity) != Pawn)
            return false;
        AController* Controller = Pawn->Controller;
        const StableObjectIdentity ControllerIdentity = TrackStableObject(Controller);
        if (ResolveStableObject(ControllerIdentity) != Controller ||
            !Controller->IsA(APlayerController::StaticClass()))
            return false;
        APlayerController* PlayerController = static_cast<APlayerController*>(Controller);
        UPlayer* Player = PlayerController->Player;
        const StableObjectIdentity PlayerIdentity = TrackStableObject(Player);
        return ResolveStableObject(PlayerIdentity) == Player &&
            Player->IsA(ULocalPlayer::StaticClass()) && PlayerController->Pawn == Pawn;
    }

    static void BeginReviveIntent(ABP_PlayerCharacter_C* Pawn,
        ELoadoutQuickItemSlot Slot, UWorld* World) {
        if (PendingRevive.Pawn.Object)
            return;
        PendingRevive.Pawn = TrackStableObject(Pawn);
        PendingRevive.World = TrackStableObject(World);
        PendingRevive.Slot = Slot;
        PendingRevive.QueuedAtMilliseconds = GetTickCount64();
        OutputDebugStringA("[Undaunted] buffered early self-revive until bleedout acknowledgement\n");
    }

    static void AcknowledgeBleedout(APawn* Pawn) {
        if (!Pawn || !IsLocalPawn(Pawn))
            return;
        BleedoutAcknowledgedPawn = TrackStableObject(Pawn);
        if (!PendingRevive.Pawn.Object || ResolveStableObject(PendingRevive.Pawn) != Pawn ||
            !TryUseQuickItemFunction || !OrigProcessEvent)
            return;
        if (GetTickCount64() - PendingRevive.QueuedAtMilliseconds >
            ReviveIntentTimeoutMilliseconds) {
            ClearPendingRevive("[Undaunted] cancelled expired buffered self-revive\n");
            return;
        }

        Params::BP_PlayerCharacter_C_TryUseQuickItem ReplayParams{};
        ReplayParams.QuickItemIndex = PendingRevive.Slot;
        ClearPendingRevive();
        reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(
            Pawn, TryUseQuickItemFunction, &ReplayParams);
        OutputDebugStringA("[Undaunted] replayed self-revive after bleedout acknowledgement\n");
    }

    static void ClearBleedout(APawn* Pawn) {
        if (!Pawn || ResolveStableObject(BleedoutAcknowledgedPawn) == Pawn)
            BleedoutAcknowledgedPawn = {};
        if (!Pawn || ResolveStableObject(PendingRevive.Pawn) == Pawn)
            ClearPendingRevive();
    }

    static void HandleProcessEvent(UObject* Object, UFunction* Function, void* Parms) {
        const auto CallOriginal = [&]() {
            reinterpret_cast<void(*)(UObject*, UFunction*, void*)>(OrigProcessEvent)(
                Object, Function, Parms);
        };

        const bool IsPlayerCharacter = Object->IsA(ABP_PlayerCharacter_C::StaticClass());
        if (ServerOnlyStaminaSuppressionEnabled && IsPlayerCharacter &&
            (!TickStaminaFunction || !EvaluateStaminaFunction)) {
            const std::string IncomingName = Function->GetName();
            if (!TickStaminaFunction && IncomingName == "TickStamina")
                TickStaminaFunction = Function;
            else if (!EvaluateStaminaFunction && IncomingName == "Evaluate Stamina System")
                EvaluateStaminaFunction = Function;
        }
        if (ServerOnlyStaminaSuppressionEnabled && IsPlayerCharacter &&
            (Function == TickStaminaFunction || Function == EvaluateStaminaFunction)) {
            return;
        }

        if (Function == TryUseQuickItemFunction && IsPlayerCharacter && Parms) {
            APawn* Pawn = static_cast<APawn*>(Object);
            const auto* QuickItemParams =
                static_cast<Params::BP_PlayerCharacter_C_TryUseQuickItem*>(Parms);
            if (QuickItemParams->QuickItemIndex == ELoadoutQuickItemSlot::Slot_Flask_Revive &&
                IsLocalPawn(Pawn) && ResolveStableObject(BleedoutAcknowledgedPawn) != Pawn) {
                BeginReviveIntent(static_cast<ABP_PlayerCharacter_C*>(Object),
                    QuickItemParams->QuickItemIndex, UWorld::GetWorld());
                return;
            }
        }
        else if ((Function == ReviveFromBleedoutFunction ||
            Function == ReviveFromBleedoutBlueprintFunction) &&
            Object->IsA(AArchonCharacter::StaticClass())) {
            const StableObjectIdentity PawnIdentity = TrackStableObject(Object);
            CallOriginal();
            if (APawn* Pawn = static_cast<APawn*>(ResolveStableObject(PawnIdentity)))
                ClearBleedout(Pawn);
            return;
        }
        else if (Function == SetBleedoutStateFunction && IsPlayerCharacter && Parms) {
            const StableObjectIdentity PawnIdentity = TrackStableObject(Object);
            const bool BleedingOut =
                static_cast<Params::BP_PlayerCharacter_C_Set_Bleedout_State*>(
                    Parms)->Bleeding_Out_;
            CallOriginal();
            if (!BleedingOut) {
                if (APawn* Pawn = static_cast<APawn*>(ResolveStableObject(PawnIdentity)))
                    ClearBleedout(Pawn);
            }
            return;
        }
        else if (Function == ClientBleedoutStartedFunction &&
            Object->IsA(UArchonBleedoutComponent::StaticClass())) {
            const StableObjectIdentity OwnerIdentity =
                TrackStableObject(FindStableOwningActor(Object));
            CallOriginal();
            AActor* Owner = static_cast<AActor*>(ResolveStableObject(OwnerIdentity));
            if (Owner && Owner->IsA(APawn::StaticClass()))
                AcknowledgeBleedout(static_cast<APawn*>(Owner));
            return;
        }
        CallOriginal();
    }
}

static void PrepareClientCombatCompatibility() {
    if (ClientCombatCompatibility::ServerOnlyStaminaSuppressionEnabled)
        ClientCombatCompatibility::ResolveFunctions();
}

static void TickClientCombatCompatibility(UWorld* World) {
    using namespace ClientCombatCompatibility;
    ResolveFunctions();

    if (!PendingRevive.Pawn.Object)
        return;
    APawn* Pawn = static_cast<APawn*>(ResolveStableObject(PendingRevive.Pawn));
    if (!Pawn || ResolveStableObject(PendingRevive.World) != World || !IsLocalPawn(Pawn)) {
        ClearPendingRevive("[Undaunted] cancelled self-revive after pawn/world transition\n");
        return;
    }
    if (GetTickCount64() - PendingRevive.QueuedAtMilliseconds >
        ReviveIntentTimeoutMilliseconds) {
        ClearPendingRevive("[Undaunted] cancelled self-revive acknowledgement timeout\n");
    }
}
