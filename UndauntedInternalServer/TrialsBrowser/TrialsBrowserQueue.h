#pragma once

#include "../SDK.hpp"

#include <string>

namespace TrialsBrowserOverlay {
    using StatusSink = void(*)(const std::wstring&);
    using ButtonsSink = void(*)(bool);

    constexpr const wchar_t* kRamsgatePlayerHuntId = L"ShatteredIsles_ReturnToRamsgate";

    void SubmitFindHunt(const std::wstring& PlayerHuntId, bool SkipMatchmaking, StatusSink SetStatus, ButtonsSink EnableButtons);
    void TickQueue(SDK::UObject* WorldContextObject, StatusSink SetStatus, ButtonsSink EnableButtons);
    void ResetQueue();
}
