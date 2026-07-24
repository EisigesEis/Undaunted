#pragma once

#include "../SDK.hpp"

#include <optional>
#include <string>

namespace TrialsBrowserOverlay {
    struct QueueUiUpdate {
        std::wstring Status;
        bool ButtonsEnabled = true;
    };

    constexpr const wchar_t* kRamsgatePlayerHuntId = L"ShatteredIsles_ReturnToRamsgate";

    QueueUiUpdate SubmitFindHunt(const std::wstring& PlayerHuntId, bool SkipMatchmaking);
    std::optional<QueueUiUpdate> TickQueue(SDK::UObject* WorldContextObject);
    void ResetQueue();
}
