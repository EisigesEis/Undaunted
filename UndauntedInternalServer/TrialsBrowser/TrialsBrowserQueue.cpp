#include "TrialsBrowserQueue.h"

#include <chrono>
#include <cwctype>
#include <iostream>
#include <mutex>
#include <utility>
#include <windows.h>

using namespace SDK;

namespace Globals {
    extern bool AmServer;
    extern bool EnableLogging;
    extern const wchar_t* MapPath;
}

namespace TrialsBrowserOverlay {
    namespace {
        struct PendingAction {
            std::wstring PlayerHuntId;
            bool SkipMatchmaking = true;
        };

        std::mutex PendingMutex;
        std::optional<PendingAction> Pending;
        std::mutex QueueMutex;
        std::optional<std::chrono::steady_clock::time_point> ActiveQueueAt;
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

        std::optional<PendingAction> TakePendingAction() {
            std::lock_guard<std::mutex> Lock(PendingMutex);
            return std::exchange(Pending, std::nullopt);
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
            if (!ActiveQueueAt.has_value())
                return IsMatchmaking;

            if (!IsMatchmaking && Now - *ActiveQueueAt >= kAcceptedQueueGrace) {
                ActiveQueueAt.reset();
                return false;
            }

            return true;
        }

        void MarkQueueStarted() {
            std::lock_guard<std::mutex> Lock(QueueMutex);
            ActiveQueueAt = std::chrono::steady_clock::now();
        }

        QueueUiUpdate ExecuteFindHunt(UObject* WorldContextObject, const PendingAction& Action) {
            AArchonPartyClient* Party = GetPartyClient(WorldContextObject);
            if (Party == nullptr)
                return { L"Party client not ready.", true };

            if (!CanQueue(WorldContextObject, Party))
                return { L"Load ramsgate/dojo/island before queue.", true };

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

            if (PartyMemberCount > 1 && (!FoundLocalPartyMember || !LocalPartyMemberIsLeader))
                return { L"Only the party leader can queue.", true };

            if (IsQueueBusy(Party))
                return { L"Matchmaking already ongoing.\r\nAbandon that hunt first.", true };

            const FName PlayerHuntId = BasicFilesImplUtils::StringToName(Action.PlayerHuntId.c_str());
            const bool Started = Party->FindHunt(PlayerHuntId, Action.SkipMatchmaking, FName());
            if (Started)
                MarkQueueStarted();

            if (Globals::EnableLogging && !Globals::AmServer)
                std::cout << "[TrialsBrowserUI] FindHunt " << WideToUtf8(Action.PlayerHuntId) << " result=" << (Started ? 1 : 0) << std::endl;

            return {
                Started ? L"FindHunt accepted.\r\n" + Action.PlayerHuntId : L"FindHunt rejected.\r\n" + Action.PlayerHuntId,
                true
            };
        }
    }

    QueueUiUpdate SubmitFindHunt(const std::wstring& PlayerHuntId, bool SkipMatchmaking) {
        if (PlayerHuntId.empty())
            return { L"Select a trial first.", true };

        {
            std::lock_guard<std::mutex> Lock(PendingMutex);
            if (Pending.has_value())
                return { L"Queue request already pending. No new request sent.", true };

            Pending.emplace(PendingAction{ PlayerHuntId, SkipMatchmaking });
        }

        if (Globals::EnableLogging && !Globals::AmServer) {
            std::cout << "[TrialsBrowserUI] pending FindHunt " << WideToUtf8(PlayerHuntId)
                << " skipMatchmaking=" << (SkipMatchmaking ? 1 : 0)
                << std::endl;
        }

        return { L"Sending queue request...", false };
    }

    std::optional<QueueUiUpdate> TickQueue(UObject* WorldContextObject) {
        std::optional<PendingAction> Action = TakePendingAction();
        if (!Action.has_value())
            return std::nullopt;
        return ExecuteFindHunt(WorldContextObject, *Action);
    }

    void ResetQueue() {
        std::scoped_lock Lock(PendingMutex, QueueMutex);
        Pending.reset();
        ActiveQueueAt.reset();
    }
}
