#include "TrialsBrowserQueue.h"

#include <chrono>
#include <cwctype>
#include <iostream>
#include <mutex>
#include <windows.h>

using namespace SDK;

namespace Globals {
    extern bool AmServer;
    extern bool EnableLogging;
    extern const wchar_t* MapPath;
}

namespace TrialsBrowserOverlay {
    namespace {
        enum class PendingActionType {
            None,
            FindHunt,
        };

        struct PendingAction {
            PendingActionType Type = PendingActionType::None;
            std::wstring PlayerHuntId;
            bool SkipMatchmaking = true;
        };

        std::mutex PendingMutex;
        PendingAction Pending;
        std::mutex QueueMutex;
        std::wstring ActiveQueueHuntId;
        std::chrono::steady_clock::time_point ActiveQueueAt;
        constexpr auto kAcceptedQueueGrace = std::chrono::seconds(5);

        std::string WideToUtf8(const std::wstring& Value) {
            if (Value.empty())
                return "";

            const int Required = WideCharToMultiByte(CP_UTF8, 0, Value.c_str(), -1, nullptr, 0, nullptr, nullptr);
            if (Required <= 0)
                return "";

            std::string Result(static_cast<size_t>(Required), '\0');
            const int Written = WideCharToMultiByte(CP_UTF8, 0, Value.c_str(), -1, Result.data(), Required, nullptr, nullptr);
            if (Written <= 0)
                return "";

            Result.resize(static_cast<size_t>(Written - 1));
            return Result;
        }

        std::wstring Utf8ToWide(const std::string& Value) {
            if (Value.empty())
                return L"";

            const int Required = MultiByteToWideChar(CP_UTF8, 0, Value.c_str(), -1, nullptr, 0);
            if (Required <= 0)
                return L"";

            std::wstring Result(static_cast<size_t>(Required), L'\0');
            const int Written = MultiByteToWideChar(CP_UTF8, 0, Value.c_str(), -1, Result.data(), Required);
            if (Written <= 0)
                return L"";

            Result.resize(static_cast<size_t>(Written - 1));
            return Result;
        }

        std::wstring ToLower(std::wstring Value) {
            for (wchar_t& Character : Value)
                Character = static_cast<wchar_t>(std::towlower(Character));
            return Value;
        }

        bool Contains(const std::wstring& Value, const wchar_t* Needle) {
            return Value.find(Needle) != std::wstring::npos;
        }

        PendingAction TakePendingAction() {
            std::lock_guard<std::mutex> Lock(PendingMutex);
            PendingAction Action = Pending;
            Pending = {};
            return Action;
        }

        std::wstring CurrentMapContext() {
            if (Globals::MapPath != nullptr && Globals::MapPath[0] != L'\0')
                return ToLower(std::wstring(Globals::MapPath));

            UWorld* World = UWorld::GetWorld();
            if (World == nullptr)
                return L"";

            return ToLower(Utf8ToWide(World->GetName()));
        }

        bool IsAllowedTrialQueueContext(const std::wstring& Context) {
            if (Context.empty())
                return false;

            if (Contains(Context, L"arena") || Contains(Context, L"trial") || Contains(Context, L"escalation") || Contains(Context, L"esca"))
                return false;

            return Contains(Context, L"ramsgate")
                || Contains(Context, L"training")
                || Contains(Context, L"dojo")
                || Contains(Context, L"island");
        }

        AArchonPartyClient* GetPartyClient(UObject* WorldContextObject) {
            if (WorldContextObject == nullptr)
                return nullptr;

            AArchonPlayerController* PlayerController = UArchonGameplayStatics::GetArchonLocalPlayerController(WorldContextObject);
            return PlayerController != nullptr ? PlayerController->GetParty() : nullptr;
        }

        bool CanQueue(UObject* WorldContextObject, AArchonPartyClient* Party) {
            return WorldContextObject != nullptr
                && UWorld::GetWorld() != nullptr
                && Party != nullptr
                && IsAllowedTrialQueueContext(CurrentMapContext());
        }

        bool IsQueueBusy(AArchonPartyClient* Party) {
            const bool IsMatchmaking = Party != nullptr && Party->IsMatchmaking();
            const auto Now = std::chrono::steady_clock::now();

            std::lock_guard<std::mutex> Lock(QueueMutex);
            if (ActiveQueueHuntId.empty())
                return IsMatchmaking;

            if (!IsMatchmaking && Now - ActiveQueueAt >= kAcceptedQueueGrace) {
                ActiveQueueHuntId.clear();
                return false;
            }

            return true;
        }

        void MarkQueueStarted(const std::wstring& PlayerHuntId) {
            std::lock_guard<std::mutex> Lock(QueueMutex);
            ActiveQueueHuntId = PlayerHuntId;
            ActiveQueueAt = std::chrono::steady_clock::now();
        }

        void ExecuteFindHunt(UObject* WorldContextObject, const PendingAction& Action, StatusSink SetStatus, ButtonsSink EnableButtons) {
            AArchonPartyClient* Party = GetPartyClient(WorldContextObject);
            if (Party == nullptr) {
                EnableButtons(true);
                SetStatus(L"Party client not ready.");
                return;
            }

            if (!CanQueue(WorldContextObject, Party)) {
                EnableButtons(true);
                SetStatus(L"Load ramsgate/dojo/island before queue.");
                return;
            }

            const int PartyMemberCount = Party->CurrentParty.PartyMembers.Num();
            bool FoundLocalPartyMember = false;
            bool LocalPartyMemberIsLeader = false;
            for (int Index = 0; Index < PartyMemberCount; ++Index) {
                const FArchonPartyMember& Member = Party->CurrentParty.PartyMembers[Index];
                if (!Party->IsLocalPlayer(Member))
                    continue;

                FoundLocalPartyMember = true;
                LocalPartyMemberIsLeader = Party->IsPartyLeader(Member.UniqueId);
                break;
            }

            if (PartyMemberCount > 1 && (!FoundLocalPartyMember || !LocalPartyMemberIsLeader)) {
                EnableButtons(true);
                SetStatus(L"Only the party leader can queue.");
                return;
            }

            if (IsQueueBusy(Party)) {
                EnableButtons(true);
                SetStatus(L"Matchmaking already ongoing.\r\nAbandon that hunt first.");
                return;
            }

            const FName PlayerHuntId = BasicFilesImplUtils::StringToName(Action.PlayerHuntId.c_str());
            const bool Started = Party->FindHunt(PlayerHuntId, Action.SkipMatchmaking, FName());
            if (Started)
                MarkQueueStarted(Action.PlayerHuntId);

            EnableButtons(true);
            SetStatus(Started ? L"FindHunt accepted.\r\n" + Action.PlayerHuntId : L"FindHunt rejected.\r\n" + Action.PlayerHuntId);

            if (Globals::EnableLogging && !Globals::AmServer)
                std::cout << "[TrialsBrowserUI] FindHunt " << WideToUtf8(Action.PlayerHuntId) << " result=" << (Started ? 1 : 0) << std::endl;
        }
    }

    void SubmitFindHunt(const std::wstring& PlayerHuntId, bool SkipMatchmaking, StatusSink SetStatus, ButtonsSink EnableButtons) {
        if (PlayerHuntId.empty()) {
            SetStatus(L"Select a trial first.");
            return;
        }

        {
            std::lock_guard<std::mutex> Lock(PendingMutex);
            if (Pending.Type != PendingActionType::None) {
                SetStatus(L"Queue request already pending. No new request sent.");
                return;
            }

            Pending.Type = PendingActionType::FindHunt;
            Pending.PlayerHuntId = PlayerHuntId;
            Pending.SkipMatchmaking = SkipMatchmaking;
        }

        EnableButtons(false);
        SetStatus(L"Sending queue request...");

        if (Globals::EnableLogging && !Globals::AmServer) {
            std::cout << "[TrialsBrowserUI] pending FindHunt " << WideToUtf8(PlayerHuntId)
                << " skipMatchmaking=" << (SkipMatchmaking ? 1 : 0)
                << std::endl;
        }
    }

    void TickQueue(UObject* WorldContextObject, StatusSink SetStatus, ButtonsSink EnableButtons) {
        const PendingAction Action = TakePendingAction();
        if (Action.Type == PendingActionType::FindHunt)
            ExecuteFindHunt(WorldContextObject, Action, SetStatus, EnableButtons);
    }

    void ResetQueue() {
        {
            std::lock_guard<std::mutex> Lock(PendingMutex);
            Pending = {};
        }
        {
            std::lock_guard<std::mutex> Lock(QueueMutex);
            ActiveQueueHuntId.clear();
            ActiveQueueHuntId.shrink_to_fit();
            ActiveQueueAt = {};
        }
    }
}
