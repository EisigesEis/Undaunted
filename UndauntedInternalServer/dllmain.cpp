#include <windows.h>
#include <shellapi.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <string>
#include <vector>
#include <utility>
#include <iostream>
#include <ranges>
#include <cwchar>
#include <cwctype>
#include <map>
#include <winhttp.h>

#pragma comment(lib, "winhttp.lib")

#include "framework.h"
#include "SDK.hpp"
#include "MinHook/MinHook.h"
#include "constants.h"
#include "AssetOptimization.h"
#include "Networking.h"
#include "Networking/NetworkLifecycle.h"
#include "ServerPerformance.h"
#include "ServerPacing.h"
#include "Hooks/NativeNameCleanup.h"

#include "SDK/GameplayAbilities_parameters.hpp"
#include "SDK/Archon_parameters.hpp"
#include "SDK/Engine_parameters.hpp"

using namespace SDK;

namespace {
    char ModuleLifetimeAnchor = 0;

    void PinInjectedModule() {
        HMODULE PinnedModule = nullptr;
        if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
            reinterpret_cast<LPCWSTR>(&ModuleLifetimeAnchor), &PinnedModule)) {
            OutputDebugStringA("[Undaunted] WARNING: failed to pin injected module; dynamic unload is unsafe\n");
        }
    }
}

namespace Globals {
    bool AmServer = false;
    uintptr_t BaseAddress = 0x0;
    bool Listening = false;
    bool DoListen = false;
    const wchar_t* ServerAPIKey = nullptr;
    const wchar_t* MapPath = nullptr;
    const wchar_t* BehemothPath = nullptr;
    const wchar_t* MatchmakerHuntId = nullptr;
    const wchar_t* ExpectedPlayerString = nullptr;
    int Port = 0;
    const wchar_t* MyIpAndPort = nullptr;
    std::wstring GameserverId;
    std::wstring ReadyCallbackUrl;
    std::wstring ReadyCallbackToken;
    std::wstring LifecycleCallbackUrl;
    std::wstring MetagameAddress;
    std::wstring ServerAPIKeyValue;
    std::wstring MapPathValue;
    std::wstring BehemothPathValue;
    std::wstring MatchmakerHuntIdValue;
    std::wstring ExpectedPlayerStringValue;
    std::wstring MyIpAndPortValue;

    bool EnableLogging = false;
    AssetOptimization::Mode AssetStrippingMode = AssetOptimization::Mode::Aggressive;
    bool StripInactiveMapPackages = true;
    bool AssetStrippingLogDetails = false;
    uint32_t AssetGcWaitSeconds = 15;
    bool ProfilingEnabled = false;
    uint32_t ProfileIntervalSeconds = 30;
    std::wstring ProfileOutputDirectory;
    uint32_t ProfileMaximumBytes = 64u * 1024u * 1024u;
    uint32_t ConsiderCacheMaxAgeMilliseconds = 250;
}

static std::wstring GetNamedArgument(wchar_t** Args, int NumArgs, const std::wstring& Prefix,
    const std::wstring& Fallback) {
    for (int Index = 1; Index < NumArgs; ++Index) {
        const std::wstring Argument = Args[Index];
        if (Argument.starts_with(Prefix)) return Argument.substr(Prefix.length());
    }
    return Fallback;
}

static bool GetNamedBooleanArgument(wchar_t** Args, int NumArgs, const std::wstring& Prefix, bool Fallback) {
    for (int Index = 1; Index < NumArgs; ++Index) {
        const std::wstring Argument = Args[Index];
        if (!Argument.starts_with(Prefix)) continue;
        const std::wstring Value = Argument.substr(Prefix.length());
        if (Value == L"true" || Value == L"1") return true;
        if (Value == L"false" || Value == L"0") return false;
        return Fallback;
    }
    return Fallback;
}

static uint32_t GetNamedUnsignedArgument(wchar_t** Args, int NumArgs, const std::wstring& Prefix,
    uint32_t Fallback, uint32_t Minimum, uint32_t Maximum) {
    const std::wstring Value = GetNamedArgument(Args, NumArgs, Prefix, L"");
    if (Value.empty()) return Fallback;
    try {
        const unsigned long Parsed = std::stoul(Value);
        if (Parsed < Minimum || Parsed > Maximum) return Fallback;
        return static_cast<uint32_t>(Parsed);
    }
    catch (...) {
        return Fallback;
    }
}

namespace ClientHookConfig {
    constexpr bool kEnableNativeNameCleanup = true;
}

std::map<std::wstring, std::wstring> EndpointMap = {};

// TODO: ConfigCacheIni::GetString called for every INI setting during startup.
bool WideContains(const wchar_t* Value, const wchar_t* Needle) {
    return Value != nullptr && Needle != nullptr && wcsstr(Value, Needle) != nullptr;
}

bool WideContainsInsensitive(const wchar_t* Value, const wchar_t* Needle) {
    if (Value == nullptr || Needle == nullptr)
        return false;

    const size_t NeedleLength = wcslen(Needle);
    if (NeedleLength == 0)
        return true;

    for (const wchar_t* Candidate = Value; *Candidate != L'\0'; ++Candidate) {
        size_t Index = 0;
        while (Index < NeedleLength && Candidate[Index] != L'\0' &&
               towlower(Candidate[Index]) == towlower(Needle[Index])) {
            ++Index;
        }

        if (Index == NeedleLength)
            return true;
    }

    return false;
}

bool MayBeMappedEndpointKey(const wchar_t* Key) {
    return WideContains(Key, L"Endpoint") ||
        (Key != nullptr && wcscmp(Key, L"StoreReconcileUrl") == 0);
}

std::wstring FindClientMetagameAddress(wchar_t** Args, int NumArgs) {
    for (int Index = 1; Index < NumArgs; ++Index) {
        if (!Args[Index] || Args[Index][0] == L'\0' || Args[Index][0] == L'-')
            continue;

        return Args[Index];
    }

    return L"";
}

void EvalEndpointMap() {
    static bool DidEvalEndpointMap = false;

    if (DidEvalEndpointMap || Globals::MetagameAddress.size() == 0)
        return;

    DidEvalEndpointMap = true;

    EndpointMap = {
        {L"AuthEndpoint", L"http://" + Globals::MetagameAddress + L"/game/login"},
        {L"AuthAvailableEndpoint", L"http://" + Globals::MetagameAddress + L"/checkavailable"},
        {L"AuthTagsEndpoint", L"http://" + Globals::MetagameAddress + L"/tags"},
        {L"AccountInfoEndpoint", L"http://" + Globals::MetagameAddress + L"/accountinfo"},
        {L"DauntlessSessionTokenEndpoint", L"http://" + Globals::MetagameAddress + L"/gamesession/{linkedaccountservice}"},
        // TODO: CreatePhoenixAccountEndpoint likely responsible for /account127.0.0.1
        // but why?
        {L"CreatePhoenixAccountEndpoint", L"http://" + Globals::MetagameAddress + L"/account"},
        {L"LinkAccountEndpoint", L"http://" + Globals::MetagameAddress + L"/account/link"},
        {L"IsAccountLinkedEndpoint", L"http://" + Globals::MetagameAddress + L"/account/link/{service}/{accountid}"},
        {L"LinkPhoenixToServicePinGenerationEndpoint", L"http://" + Globals::MetagameAddress + L"/account/link/pin/{service}/generate"},
        {L"LinkPhoenixToServicePinStatusEndpoint", L"http://" + Globals::MetagameAddress + L"/account/link/pin/{service}/status"},
        {L"QueryLoginQueueEndpoint", L"http://" + Globals::MetagameAddress + L"/login"},
        {L"PublicAccountInfoEndpoint", L"http://" + Globals::MetagameAddress + L"/accountinfo/public"},
        {L"QueryAccountMappingsEndpoint", L"http://" + Globals::MetagameAddress + L"/account/mapping"},
        {L"PlayerDataMigrationEndpoint", L"http://" + Globals::MetagameAddress + L"/account/migrate"},
        {L"PhoenixEventsEndpoint", L"http://" + Globals::MetagameAddress + L"/event?id={environment}"},
        {L"PhoenixEventsMessageEndpoint", L"http://" + Globals::MetagameAddress + L"/services/T02H74TGF/B8GG4RATX/EGSR335K7as3GFBq4dPCm7js"},
        {L"CharacterEndpoint", L"http://" + Globals::MetagameAddress + L"/character"},
        {L"FindCharacterEndpoint", L"http://" + Globals::MetagameAddress + L"/character/{characterid}"},
        {L"CharacterNameEndpoint", L"http://" + Globals::MetagameAddress + L"/character/name"},
        {L"FindCharactersEndpoint", L"http://" + Globals::MetagameAddress + L"/character/batch/account"},
        {L"ResetCharacterEndpoint", L"http://" + Globals::MetagameAddress + L"/character"},
        {L"InventoryEndpoint", L"http://" + Globals::MetagameAddress + L"/inventory"},
        {L"InventoryGetAllEndpoint", L"http://" + Globals::MetagameAddress + L"/inventory/{accountid}/{characterid}"},
        {L"InventoryGetInstanceItemsEndpoint", L"http://" + Globals::MetagameAddress + L"/inventory/instanceditemsbyaccount"},
        {L"InventoryUpdateInstanceEndpoint", L"http://" + Globals::MetagameAddress + L"/inventory/instanceditem"},
        {L"InventoryMigrateEndpoint", L"http://" + Globals::MetagameAddress + L"/inventory/{characterid}/{gameversion}"},
        {L"DeleteProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}/{progressionid}"},
        {L"ProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/progression"},
        {L"ProgressionConfigEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/config"},
        {L"FindProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}"},
        {L"FindProgressionTrackEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}/{progressionid}"},
        {L"FindObjectiveEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/objectives/{accountid}/{objectiveid}"},
        {L"FindObjectivesEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/objectives/{accountid}"},
        {L"GrantProgressionWithObjectives", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}"},
        {L"GrantProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}/{progressionid}/{amount}"},
        {L"ConfirmProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/progression/{accountid}/{progressionid}/{rank}/confirm/{kind}"},
        {L"GetBountiesConfigEndpoint", L"http://" + Globals::MetagameAddress + L"/bounty/game-data"},
        {L"GetBountiesEndpoint", L"http://" + Globals::MetagameAddress + L"/bounty/{accountid}"},
        {L"SetBountiesEndpoint", L"http://" + Globals::MetagameAddress + L"/bounty/{accountid}"},
        {L"GetPlayerJourneyEndpointServer", L"http://" + Globals::MetagameAddress + L"/pjm/{accountid}"},
        {L"GetPlayerJourneyEndpointClient", L"http://" + Globals::MetagameAddress + L"/pjm"},
        {L"SetPlayerJourneyEndpoint", L"http://" + Globals::MetagameAddress + L"/pjm/{accountid}"},
        {L"DeleteBountiesEndpoint", L"http://" + Globals::MetagameAddress + L"/bounty/delete/{accountid}"},
        {L"GetCooldownEndpoint", L"http://" + Globals::MetagameAddress + L"/cooldown/{accountid}"},
        {L"StartCooldownEndpoint", L"http://" + Globals::MetagameAddress + L"/cooldown/{accountid}/{cooldownid}"},
        {L"SetCooldownEndpoint", L"http://" + Globals::MetagameAddress + L"/cooldown/{accountid}"},
        {L"SetCooldownBatchEndpoint", L"http://" + Globals::MetagameAddress + L"/cooldown/batch/{accountid}"},
        {L"GetSeasonalEscalationEndpoint", L"http://" + Globals::MetagameAddress + L"/escalation/{season_id}/{account_id}"},
        {L"UpdateSeasonalEscalationEndpoint", L"http://" + Globals::MetagameAddress + L"/escalation/{season_id}/{account_id}"},
        {L"GameTuningEndpoint", L"http://" + Globals::MetagameAddress + L"/game_tuning/{blobid}"},
        {L"SelectedHuntPassEndpoint", L"http://" + Globals::MetagameAddress + L"/huntpass/{accountid}"},
        {L"TitleNewsEndpoint", L"http://" + Globals::MetagameAddress + L"/patcher-news/{environment}.json"},
        {L"LoginNewsEndpoint", L"http://" + Globals::MetagameAddress + L"/motd/"},
        {L"AfterHuntNewsEndpoint", L"http://" + Globals::MetagameAddress + L"/motd/trigger?event_name={eventname}"},
        {L"MailboxQueryEndpoint", L"http://" + Globals::MetagameAddress + L"/all/"},
        {L"MailboxQuerySurveyEndpoint", L"http://" + Globals::MetagameAddress + L"/survey/{surveyid}"},
        {L"MessageInboxReadEndpoint", L"http://" + Globals::MetagameAddress + L"/mailbox/markAsRead"},
        {L"MessageInboxDeletedEndpoint", L"http://" + Globals::MetagameAddress + L"/mailbox/markAsDeleted"},
        {L"MessageInboxClaimItemEndpoint", L"http://" + Globals::MetagameAddress + L"/mailbox/redeemParcel"},
        {L"MailboxSubmitSurveyEndpoint", L"http://" + Globals::MetagameAddress + L"/survey/responses"},
        {L"MailboxClaimSurveyRewardEndpoint", L"http://" + Globals::MetagameAddress + L"/survey/redeemReward"},
        {L"MailboxSurveyEndpoint", L"http://" + Globals::MetagameAddress + L"/survey"},
        {L"ExperimentalRealmValidationEndpoint", L"http://" + Globals::MetagameAddress + L"/experiment/validate"},
        {L"SanitizeEndpoint", L"http://" + Globals::MetagameAddress + L"/check"},
        {L"GuildEndpoint", L"http://" + Globals::MetagameAddress + L"/guild"},
        {L"GuildInvitesEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/invites"},
        {L"FindGuildEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/{guildid}"},
        {L"FindCharactersGuildEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/member/{characterid}"},
        {L"GuildMemberEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/member"},
        {L"GuildInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/invite"},
        {L"GuildViewCharacterInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/invite/member/{characterid}"},
        {L"GuildAcceptInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/invite/accept"},
        {L"GuildViewGuildInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/invite/guild"},
        {L"GuildLeaderEndpoint", L"http://" + Globals::MetagameAddress + L"/guild/leader"},
        {L"GuildCreateValidateEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/validate"},
        {L"GuildEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild"},
        {L"GuildDisbandEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/{guildId}"},
        {L"GuildViewInvitesEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/invite/player"},
        {L"GuildInviteEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/invite/{accountId}"},
        {L"GuildInviteAcceptEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/invite/accept/{guild_invite_id}"},
        {L"GuildInviteDeclineEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/invite/{guild_invite_id}"},
        {L"GuildLeaveEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/player"},
        {L"GuildKickEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/player/{accountId}"},
        {L"GuildChangeRankEndpoint_v2", L"http://" + Globals::MetagameAddress + L"/guild/rank/{accountId}/{rank}"},
        {L"PartyEndpoint", L"http://" + Globals::MetagameAddress + L"/party"},
        {L"PartyStatusEndpoint", L"http://" + Globals::MetagameAddress + L"/party/status"},
        {L"PartyMemberEndpoint", L"http://" + Globals::MetagameAddress + L"/party/member"},
        {L"PartyKickMemberEndpoint", L"http://" + Globals::MetagameAddress + L"/party/member/{memberid}"},
        {L"PartyRemoveOfflineLeaderEndpoint", L"http://" + Globals::MetagameAddress + L"/party/leader/{leaderid}"},
        {L"PartyPromoteEndpoint", L"http://" + Globals::MetagameAddress + L"/party/member/promote/{memberId}"},
        {L"PartyInvitesEndpoint", L"http://" + Globals::MetagameAddress + L"/party/invites"},
        {L"PartyInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/party/invite"},
        {L"PartyAcceptInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/party/invite/accept/{inviteId}"},
        {L"PartyMemberSetConsoleSessionEndpoint", L"http://" + Globals::MetagameAddress + L"/party/console_session"},
        {L"PartyFinderCreateEndpoint", L"http://" + Globals::MetagameAddress + L"/party/finder/entry/create"},
        {L"PartyFinderEntryEndpoint", L"http://" + Globals::MetagameAddress + L"/party/finder/entry/{partyId}"},
        {L"PartyFinderJoinEndpoint", L"http://" + Globals::MetagameAddress + L"/party/finder/join/{partyId}"},
        {L"PartyFinderListEntriesEndpoint", L"http://" + Globals::MetagameAddress + L"/party/finder/entries"},
        {L"ExpectedPlayerStatusEndpoint", L"http://" + Globals::MetagameAddress + L"/candidate/player/alive"},
        {L"KeepAlivePlayerStatusEndpoint", L"http://" + Globals::MetagameAddress + L"/candidate/player/alive"},
        {L"StoreEndpointDev", L"http://" + Globals::MetagameAddress + L"/{tracking}#{path}"},
        {L"StoreEndpoint", L"http://" + Globals::MetagameAddress + L"/{tracking}#{path}"},
        {L"StoreInternationalEndpointDev", L"http://" + Globals::MetagameAddress + L"/{locale}/{tracking}#{path}"},
        {L"StoreInternationalEndpoint", L"http://" + Globals::MetagameAddress + L"/{locale}/{tracking}#{path}"},
        {L"StoreGetItemByTagEndpoint", L"http://" + Globals::MetagameAddress + L"/product/skus/public?requiredTags={tag}"},
        {L"StoreGetItemByIdEndpoint", L"http://" + Globals::MetagameAddress + L"/product/sku/{sku_id}"},
        {L"StorePurchaseItemEndpoint", L"http://" + Globals::MetagameAddress + L"/token/{currency}/{sku_id}"},
        {L"StorePurchaseItemConfirmEndpoint", L"http://" + Globals::MetagameAddress + L"/notification/{currency}?token={purchase_token}"},
        {L"StoreReconcileUrl", L"http://" + Globals::MetagameAddress + L"/reconcile"},
        {L"StoreBalancesEndpoint", L"http://" + Globals::MetagameAddress + L"/balance"},
        {L"SupportACreatorEndpoint", L"http://" + Globals::MetagameAddress + L"/creator"},
        {L"EntitlementsEndpoint", L"http://" + Globals::MetagameAddress + L"/entitlementsv2"},
        {L"GrantEntitlementEndpoint", L"http://" + Globals::MetagameAddress + L"/entitlementv2/{accountid}"},
        {L"RevokeEntitlementEndpoint", L"http://" + Globals::MetagameAddress + L"/entitlement/{accountid}/{entitlement}"},
        {L"ServiceSessionEndpoint", L"ws://" + Globals::MetagameAddress + L"/xmpp"},
        {L"QueryUserPresenceEndpoint", L"http://" + Globals::MetagameAddress + L"/present/{accountid}"},
        {L"MatchmakingEndpoint", L"http://" + Globals::MetagameAddress},
        {L"TrackingEndpoint", L"http://" + Globals::MetagameAddress},
        {L"VoiceChatLoginEndpoint", L"http://" + Globals::MetagameAddress + L"/vivox/login"},
        {L"VoiceChatJoinPartyEndpoint", L"http://" + Globals::MetagameAddress + L"/vivox/join/party/{channel_type}"},
        {L"VoiceChatJoinGameEndpoint", L"http://" + Globals::MetagameAddress + L"/vivox/join/game/{game_id}/{channel_type}"},
        {L"VoiceChatJoinDebugEndpoint", L"http://" + Globals::MetagameAddress + L"/vivox/join/channel/{channel_id}/{channel_type}"},
        {L"PlatformPoolRegistrationEndpoint", L"http://" + Globals::MetagameAddress + L"/candidate/player/register"},
        {L"CheckCrossPlayProgressionEndpoint", L"http://" + Globals::MetagameAddress + L"/features/platform/{platform}"},
        {L"LeaderboardDisplayNameRefreshEndpoint", L"http://" + Globals::MetagameAddress + L"/profile/update"},
        {L"PhoenixStatusMessageEndpoint", L"http://" + Globals::MetagameAddress + L"/dauntless-status"},
        {L"TrialsLeaderboardsEndpoint", L"http://" + Globals::MetagameAddress + L"/trials/leaderboards"},
        {L"TrialsSoloLeaderboardsEndpoint", L"http://" + Globals::MetagameAddress + L"/trials/leaderboards/solo"},
        {L"TrialsSoloEntryEndpoint", L"http://" + Globals::MetagameAddress + L"/trials/leaderboards/solo/individual"},
        {L"TrialsGroupLeaderboardsEndpoint", L"http://" + Globals::MetagameAddress + L"/trials/leaderboards/group"},
        {L"TrialsGroupEntryEndpoint", L"http://" + Globals::MetagameAddress + L"/trials/leaderboards/group/individual"},
        {L"GetActiveLoadoutEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}"},
        {L"GetAllLoadoutsEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/all"},
        {L"UpdateLoadoutSlotEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/{index}"},
        {L"UpdateLoadoutSlotSetActiveEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/active/{index}"},
        {L"UpdateLoadoutPersistentEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/persistent"},
        {L"UpdateActiveLoadoutSlotEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/active/{index}"},
        {L"UnlockAccountSlotEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/unlock/{num_slots}"},
        {L"UnlockCharacterSlotEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/unlock/{num_slots}"},
        {L"GetAccountSlotCountEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/slotcount"},
        {L"GetCharacterSlotCountEndpoint", L"http://" + Globals::MetagameAddress + L"/loadout/{account_id}/{character_id}/slotcount"},
        {L"PlayerInboxMessageEndpoint", L"http://" + Globals::MetagameAddress + L"/subscription"},
        {L"PlayerNewsletterSubscribeEndpoint", L"http://" + Globals::MetagameAddress + L"/subscription"},
        {L"PlayerNewsletterResendEndpoint", L"http://" + Globals::MetagameAddress + L"/subscription/verify/resend"},
        {L"BreadcrumbPlayerEndpoint", L"http://" + Globals::MetagameAddress + L"/breadcrumbs/{character_id}"},
        {L"EncounteredContentGetEndpoint", L"http://" + Globals::MetagameAddress + L"/encountered-content/{character_id}/{content_type}"},
        {L"EncounteredContentQueryEndpoint", L"http://" + Globals::MetagameAddress + L"/encountered-content/query/{character_id}"},
        {L"EncounteredContentUpdateEndpoint", L"http://" + Globals::MetagameAddress + L"/encountered-content/{character_id}"},
        {L"CohortsEndpoint", L"http://" + Globals::MetagameAddress + L"/playertreatments/{account_id}"},
        {L"GetEventStatsEndpoint", L"http://" + Globals::MetagameAddress + L"/eventstats/"},
        {L"IncrementEventStatsEndpoint", L"http://" + Globals::MetagameAddress + L"/eventstats/increment"},
        {L"LinkedSlayersInviteEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/invite"},
        {L"LinkedSlayersAllInvitesEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/invites"},
        {L"LinkedSlayersInviteAcceptDeclineEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/invite"},
        {L"LinkedSlayersInviteCancelEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/invite"},
        {L"LinkedSlayersDeleteAllInvitesEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/invites/{account_id}"},
        {L"LinkedSlayersAllLinksProgressEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/progress"},
        {L"LinkedSlayersAddLinkProgressEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/progress"},
        {L"LinkedSlayersAllLinkSlotsDataEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/links"},
        {L"LinkedSlayersDeleteInviteDataEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/link"},
        {L"LinkedSlayersSendRewardsEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/links/rewards"},
        {L"LinkedSlayersGetFriendsAvailabilityEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/availability"},
        {L"LinkedSlayersGetRewardsGrantEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/links/rewards/{account_id}/{slot}"},
        {L"LinkedSlayersSetEndTimeEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/links/endtime"},
        {L"LinkedSlayersSetRemainingTimeEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/links/timeleft"},
        {L"LinkedSlayersStatusEndpoint", L"http://" + Globals::MetagameAddress + L"/slayerlink/status_good"},
        {L"AccountCheckpointDebugEndpoint", L"http://" + Globals::MetagameAddress + L"/checkpoint/account/save"},
    };
}


__declspec(dllexport) const char* DummyLinkFunc() {
    return "mrow :3";
}

static std::string WideToUtf8(const std::wstring& Value) {
    if (Value.empty())
        return "";

    int Size = WideCharToMultiByte(CP_UTF8, 0, Value.c_str(), -1, nullptr, 0, nullptr, nullptr);

    if (Size <= 0)
        return "";

    std::string Result(Size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, Value.c_str(), -1, Result.data(), Size, nullptr, nullptr);
    Result.pop_back();

    return Result;
}

static std::string ServerPacingReadyJson() {
    const ServerPacing::Snapshot Snapshot = ServerPacing::GetSnapshot();
    const auto Boolean = [](bool Value) { return Value ? "true" : "false"; };
    const auto Number = [](double Value) {
        return std::to_string(std::isfinite(Value) ? Value : 0.0);
    };
    return std::string("{\"state\":") +
        ServerPerformance::JsonString(ServerPacing::CorrectionStateName(Snapshot.state)) +
        ",\"installFailure\":" +
        ServerPerformance::JsonString(ServerPacing::InstallFailureName(Snapshot.installFailure)) +
        ",\"fallbackReason\":" +
        ServerPerformance::JsonString(ServerPacing::FallbackReasonName(Snapshot.fallbackReason)) +
        ",\"executableBuildValid\":" + Boolean(Snapshot.executableBuildValid) +
        ",\"signaturesValid\":" + Boolean(Snapshot.signaturesValid) +
        ",\"hookEnabled\":" + Boolean(Snapshot.hookEnabled) +
        ",\"highResolutionApiAvailable\":" + Boolean(Snapshot.highResolutionApiAvailable) +
        ",\"timerCreated\":" + Boolean(Snapshot.timerCreated) +
        ",\"correctionEverActivated\":" + Boolean(Snapshot.correctionEverActivated) +
        ",\"observedFrames\":" + std::to_string(Snapshot.observedFrames) +
        ",\"cvarMaxFps\":" + Number(Snapshot.cvarMaxFps) +
        ",\"cachedMaxFps\":" + Number(Snapshot.cachedMaxFps) +
        ",\"virtualMaxFps\":" + Number(Snapshot.virtualMaxFps) +
        ",\"rollingMedianCadenceHz\":" + Number(Snapshot.rollingMedianCadenceHz) +
        ",\"rollingMedianCoarseOvershootMs\":" +
        Number(Snapshot.rollingMedianCoarseOvershootMilliseconds) + "}";
}

static bool PostJsonCallback(const std::wstring& Url, const std::wstring& TokenHeader,
    const std::wstring& Token, const std::string& Body) {
    URL_COMPONENTS UrlComponents = {};
    wchar_t HostName[256] = {};
    wchar_t UrlPath[1024] = {};
    wchar_t ExtraInfo[1024] = {};

    UrlComponents.dwStructSize = sizeof(UrlComponents);
    UrlComponents.lpszHostName = HostName;
    UrlComponents.dwHostNameLength = ARRAYSIZE(HostName);
    UrlComponents.lpszUrlPath = UrlPath;
    UrlComponents.dwUrlPathLength = ARRAYSIZE(UrlPath);
    UrlComponents.lpszExtraInfo = ExtraInfo;
    UrlComponents.dwExtraInfoLength = ARRAYSIZE(ExtraInfo);

    if (!WinHttpCrackUrl(Url.c_str(), 0, 0, &UrlComponents))
        return false;

    DWORD RequestFlags = UrlComponents.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0;

    HINTERNET Session = WinHttpOpen(L"UndauntedInternalServer/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);

    if (!Session)
        return false;
    WinHttpSetTimeouts(Session, 2000, 2000, 2000, 2000);

    HINTERNET Connect = WinHttpConnect(Session, HostName, UrlComponents.nPort, 0);

    if (!Connect) {
        WinHttpCloseHandle(Session);
        return false;
    }

    std::wstring RequestPath = std::wstring(UrlPath) + std::wstring(ExtraInfo);

    HINTERNET Request = WinHttpOpenRequest(Connect, L"POST", RequestPath.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, RequestFlags);

    if (!Request) {
        WinHttpCloseHandle(Connect);
        WinHttpCloseHandle(Session);
        return false;
    }

    const std::wstring Headers = L"Content-Type: application/json\r\n" +
        TokenHeader + L": " + Token + L"\r\n";

    BOOL Sent = WinHttpSendRequest(Request, Headers.c_str(), (DWORD)-1L, (LPVOID)Body.data(), (DWORD)Body.size(), (DWORD)Body.size(), 0);
    BOOL Received = Sent ? WinHttpReceiveResponse(Request, nullptr) : FALSE;
    DWORD StatusCode = 0;
    DWORD StatusCodeSize = sizeof(StatusCode);

    if (Received) {
        WinHttpQueryHeaders(Request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &StatusCode, &StatusCodeSize, WINHTTP_NO_HEADER_INDEX);
    }

    WinHttpCloseHandle(Request);
    WinHttpCloseHandle(Connect);
    WinHttpCloseHandle(Session);

    return Received && StatusCode >= 200 && StatusCode < 300;
}

static bool SendReadyCallback(const AssetOptimization::Metrics& Metrics, bool Ready = true,
    const std::string& Error = "") {
    if (Globals::GameserverId.empty() || Globals::ReadyCallbackUrl.empty() || Globals::ReadyCallbackToken.empty())
        return true;

    const std::string Body = "{\"id\":\"" + WideToUtf8(Globals::GameserverId) +
        "\",\"port\":" + std::to_string(Globals::Port) +
        ",\"pid\":" + std::to_string(GetCurrentProcessId()) +
        ",\"ready\":" + std::string(Ready ? "true" : "false") +
        (Error.empty() ? "" : ",\"error\":" + ServerPerformance::JsonString(Error)) +
        ",\"optimization\":" + AssetOptimization::MetricsJson(Metrics) +
        ",\"profiling\":" + ServerPerformance::StatusJson() +
        ",\"pacing\":" + ServerPacingReadyJson() + "}";
    return PostJsonCallback(Globals::ReadyCallbackUrl,
        L"x-undaunted-ready-token", Globals::ReadyCallbackToken, Body);
}

static bool StartLifecycleHeartbeat() {
    Networking::Lifecycle::LifecycleConfig Config{};
    Config.callbackUrl = Globals::LifecycleCallbackUrl;
    Config.callbackToken = Globals::ReadyCallbackToken;
    Config.serverId = Globals::GameserverId;
    Config.port = static_cast<uint16_t>((std::max)(0, Globals::Port));
    Config.callback = PostJsonCallback;
    return Networking::Lifecycle::Start(Config);
}

static void ObserveLifecycleConnections(uint32_t Tracked, uint32_t Raw, SDK::UWorld* World) {
    Networking::Lifecycle::ObserveConnections(Tracked, Raw, World);
}

void MainThread() {
    // UI and profiling workers contain callbacks into this DLL. Until the
    // injector has an explicit out-of-loader-lock shutdown/join protocol,
    // pinning is safer than allowing FreeLibrary to unmap live callback code.
    PinInjectedModule();

    while (!SDK::UWorld::GetWorld()) {
        if (Globals::AmServer) {
            Sleep(1000);
        }
        else {
            Sleep(1);
        }
    }

    if (!Globals::AmServer) {
        Sleep(3 * 1000);

        UEngine* Engine = UEngine::GetEngine();

        UInputSettings::GetDefaultObj()->ConsoleKeys[0].KeyName = UKismetStringLibrary::Conv_StringToName(L"F2");

        if (Engine && Engine->GameViewport && Engine->ConsoleClass) {
            UObject* NewObject = UGameplayStatics::SpawnObject(Engine->ConsoleClass, Engine->GameViewport);

            Engine->GameViewport->ViewportConsole = static_cast<UConsole*>(NewObject);

            if (Globals::EnableLogging)
            std::cout << "Spawned UConsole!" << std::endl;
        }
    }
    else {
        if (Globals::EnableLogging)
        std::cout << "UWorld is live!" << std::endl;

        Globals::DoListen = true;
    }
}

void* OrigGetDefaultMap = nullptr;

FString* GetGameDefaultMap(FString* a1) {
    FString* Ret = reinterpret_cast<FString*(*)(FString*)>(OrigGetDefaultMap)(a1);

    std::wstring FinalURL(Globals::MapPath);

    std::wstring BehemothPath(Globals::BehemothPath);

    if (!BehemothPath.contains(L"NO_BEHEMOTH")) {
        FinalURL += std::wstring(L"?MonsterClass=");
        FinalURL += std::wstring(BehemothPath);
    }

    std::wstring MatchmakerHuntId(Globals::MatchmakerHuntId);

    if (!MatchmakerHuntId.contains(L"NO_MM_HUNTID")) {
        FinalURL += std::wstring(L"?HuntId=");
        FinalURL += std::wstring(MatchmakerHuntId);
    }

    std::wstring ExpectedPlayers(Globals::ExpectedPlayerString);

    if (!ExpectedPlayers.contains(L"NO_EXPECTED_PLAYERS")) {
        FinalURL += std::wstring(L"?PlayerHuntIds=");
        FinalURL += std::wstring(ExpectedPlayers);
    }

    *Ret = FinalURL.c_str();

    //*Ret = L"ramsgate_01_persistent?game=/Game/Blueprints/BPGM_Archon_Prototype.BPGM_Archon_Prototype_C?MonsterClass=/Game/Monsters/mcrollin/mcbeaver_tutorial_bp.mcbeaver_tutorial_bp_C";

    //*Ret = L"/Game/Maps/islands/1705/dia_moss_triforce?MonsterClass=/Game/Monsters/mcrollin/mcbeaver_tutorial_bp.mcbeaver_tutorial_bp_C";
    //*Ret = L"/Game/Maps/islands/1705/dia_snow_big?MonsterClass=/Game/Monsters/mcrollin/mcbeaver_tutorial_bp.mcbeaver_tutorial_bp_C?HuntId=CR19_MatchmakerHunt_Beaver?PlayerHuntIds=GWOG-UID-1:CR19_PlayerHunt_Expedition_Island04,GWOG-UID-2:CR19_PlayerHunt_Expedition_Island04,GWOG-UID-3:CR19_PlayerHunt_Expedition_Island04?ZonePreset=0";
    //*Ret = L"/Game/Maps/ramsgate/ramsgate_01_persistent";
    //*Ret = L"/Game/Maps/islands/dojo/training_dojo_persistent";
    //*Ret = L"/Game/Maps/islands/1705/dia_moss_triforce?MonsterClass=/Game/Monsters/mcrollin/mcbeaver_tutorial_bp.mcbeaver_tutorial_bp_C";

    return Ret;
}

void* OrigGetCommandLine = nullptr;

const wchar_t* GetCommandLineHook() {
    if (!Globals::AmServer) {
        return reinterpret_cast<const wchar_t*(*)()>(OrigGetCommandLine)();
    }

    return L"Dauntless-Win64-Shipping.exe -server -unattended -nullrhi -nosound -EpicPortal -RepDriverDisable";
}

void* OrigServerBootCrash = nullptr;

void ServerBootCrash() {
    return;
}

void* OrigEncounterableSetup = nullptr;

void EncounterableSetupHook() {
    return;
}

float TotalNoPlayersTime = 0.0f;

bool EnableWatchdog = true;

void* OrigGameEngineTick = nullptr;

static float ListenReadinessElapsed = 0.0f;
static int ListenReadinessStableTicks = 0;
static bool ListenReadinessFallbackLogged = false;

static bool IsServerReadyToListen() {
    SDK::UWorld* World = SDK::UWorld::GetWorld();
    UEngine* Engine = UEngine::GetEngine();

    if (!World || !Engine || !World->NetworkNotify)
        return false;

    if (World->Levels.Num() <= 0)
        return false;

    for (ULevel* Level : World->Levels) {
        if (Level)
            return true;
    }

    return false;
}

static bool ShouldAttemptListen(float DeltaTime) {
    ListenReadinessElapsed += DeltaTime;

    if (IsServerReadyToListen()) {
        ListenReadinessStableTicks++;

        if (ListenReadinessStableTicks >= 2)
            return true;
    }
    else {
        ListenReadinessStableTicks = 0;
    }

    if (ListenReadinessElapsed >= 10.0f) {
        if (!ListenReadinessFallbackLogged && Globals::EnableLogging) {
            ListenReadinessFallbackLogged = true;
            std::cout << "Server readiness fallback elapsed; attempting listen" << std::endl;
        }

        return true;
    }

    return false;
}

static bool ShouldTickStaminaForServer() {
    static bool Initialized = false;
    static bool ShouldTick = true;

    if (!Initialized) {
        const std::wstring MapPath = Globals::MapPath != nullptr ? std::wstring(Globals::MapPath) : L"";
        ShouldTick = !MapPath.contains(L"/Maps/ramsgate/");
        Initialized = true;
    }

    return ShouldTick;
}

namespace DedicatedServerFrameCap {
    constexpr float MaximumFps = 30.0f;
    constexpr uintptr_t RegistrationRva = 0x07121D0;
    constexpr uintptr_t ConsoleVariablePointerRva = 0x601AC28;
    constexpr uintptr_t ConsoleVariableDataPointerRva = 0x601AC30;
    constexpr uintptr_t FloatConsoleVariableVTableRva = 0x4A04F88;
    constexpr uintptr_t ConsoleVariableSetRva = 0x1C5A9E0;
    constexpr uintptr_t ConsoleVariableSetVTableOffset = 0x80;
    constexpr uintptr_t GameEngineGetMaxTickRateVTableOffset = 0x2B0;
    constexpr uintptr_t GameEngineGetMaxTickRateRva = 0x3722590;
    constexpr uintptr_t EngineFrameRateFlagsOffset = 0x7B8;
    constexpr uint8_t UseFixedFrameRateMask = 1u << 6;
    constexpr uint32_t SetByCode = 0x08000000;
    constexpr uint32_t ExpectedExecutableTimestamp = 0x5F9A37D4;
    constexpr uint32_t ExpectedExecutableImageSize = 0x066CB000;
    constexpr uint64_t BootstrapMinimumMilliseconds = 3000;
    constexpr uint64_t BootstrapMaximumMilliseconds = 5000;

    constexpr uint8_t ExpectedRegistrationSignature[] = {
        0x48, 0x83, 0xEC, 0x38, 0x48, 0x8B, 0x0D, 0x25,
        0x83, 0x6E, 0x05, 0x48, 0x85, 0xC9, 0x75, 0x0C
    };
    constexpr uint8_t ExpectedSetterSignature[] = {
        0x48, 0x89, 0x6C, 0x24, 0x10, 0x48, 0x89, 0x74,
        0x24, 0x18, 0x57, 0x48, 0x83, 0xEC, 0x20, 0x48,
        0x8B, 0xEA, 0x41, 0x8B, 0xF0, 0x41, 0x8B, 0xD0,
        0x48, 0x8B, 0xF9, 0xE8, 0x30, 0xF1, 0xFE, 0xFF
    };

    enum class State {
        Pending,
        AwaitingSecondReadback,
        Verified,
        Failed
    };

    struct Status {
        State state = State::Pending;
        bool signatureValid = false;
        bool resolved = false;
        bool applied = false;
        double observed = 0.0;
        std::string error;
    };

    static Status Current{};

    static bool IsReadableMemory(const void* Address, size_t Size) {
        if (!Address || Size == 0)
            return false;

        MEMORY_BASIC_INFORMATION Information{};
        if (VirtualQuery(Address, &Information, sizeof(Information)) != sizeof(Information) ||
            Information.State != MEM_COMMIT || (Information.Protect & PAGE_GUARD) != 0 ||
            (Information.Protect & 0xFF) == PAGE_NOACCESS) {
            return false;
        }

        const uintptr_t Start = reinterpret_cast<uintptr_t>(Address);
        const uintptr_t RegionEnd = reinterpret_cast<uintptr_t>(Information.BaseAddress) + Information.RegionSize;
        return Start <= RegionEnd && Size <= RegionEnd - Start;
    }

    template <size_t Size>
    static bool MatchesSignature(uintptr_t Address, const uint8_t (&Expected)[Size]) {
        const auto* Bytes = reinterpret_cast<const uint8_t*>(Address);
        return IsReadableMemory(Bytes, Size) && std::equal(Expected, Expected + Size, Bytes);
    }

    static double ReadObservedMaxFps() {
        return static_cast<double>(UKismetSystemLibrary::GetConsoleVariableFloatValue(FString(L"t.MaxFPS")));
    }

    static double ReadCachedMaxFps() {
        float** DataStorage = reinterpret_cast<float**>(Globals::BaseAddress + ConsoleVariableDataPointerRva);
        if (!IsReadableMemory(DataStorage, sizeof(*DataStorage)) || !*DataStorage ||
            !IsReadableMemory(*DataStorage, sizeof(**DataStorage))) {
            return 0.0;
        }
        return static_cast<double>(**DataStorage);
    }

    static double ReadVirtualMaxFps(UGameEngine* GameEngine, float DeltaTime) {
        if (!GameEngine || !IsReadableMemory(GameEngine, sizeof(void*)))
            return 0.0;

        const uintptr_t VTable = *reinterpret_cast<const uintptr_t*>(GameEngine);
        if (!IsReadableMemory(reinterpret_cast<const void*>(
            VTable + GameEngineGetMaxTickRateVTableOffset), sizeof(uintptr_t))) {
            return 0.0;
        }

        const uintptr_t Function = *reinterpret_cast<const uintptr_t*>(
            VTable + GameEngineGetMaxTickRateVTableOffset);
        // UArchonGameEngine may override or thunk this virtual. The previous
        // exact-address check rejected the live slot and kept pacing correction
        // disabled. The executable build is already signature checked, so
        // accept only executable code inside this exact image.
        if (Function < Globals::BaseAddress ||
            Function >= Globals::BaseAddress + ExpectedExecutableImageSize) {
            return 0.0;
        }

        MEMORY_BASIC_INFORMATION Information{};
        if (VirtualQuery(reinterpret_cast<const void*>(Function), &Information,
            sizeof(Information)) != sizeof(Information) ||
            Information.State != MEM_COMMIT || (Information.Protect & PAGE_GUARD) != 0) {
            return 0.0;
        }
        const DWORD Protection = Information.Protect & 0xFF;
        if (Protection != PAGE_EXECUTE && Protection != PAGE_EXECUTE_READ &&
            Protection != PAGE_EXECUTE_READWRITE && Protection != PAGE_EXECUTE_WRITECOPY) {
            return 0.0;
        }

        using GetMaxTickRateFn = float(*)(UGameEngine*, float, bool);
        return static_cast<double>(reinterpret_cast<GetMaxTickRateFn>(Function)(
            // Match the native frame-pacer call. Passing false asks a different
            // policy question and can hide the exact rate Unreal is enforcing.
            GameEngine, DeltaTime, true));
    }

    static bool UsesFixedFrameRate(UGameEngine* GameEngine) {
        if (!GameEngine)
            return false;
        const auto* Flags = reinterpret_cast<const uint8_t*>(
            reinterpret_cast<uintptr_t>(GameEngine) + EngineFrameRateFlagsOffset);
        return IsReadableMemory(Flags, sizeof(*Flags)) &&
            (*Flags & UseFixedFrameRateMask) != 0;
    }

    static void Fail(const std::string& Reason) {
        Current.state = State::Failed;
        Current.error = Reason;
        OutputDebugStringA(("[Undaunted] ERROR: " + Reason + "\n").c_str());
    }

    static bool Tick() {
        if (Current.state == State::Verified)
            return true;
        if (Current.state == State::Failed)
            return false;

        if (Current.state == State::AwaitingSecondReadback) {
            Current.observed = ReadObservedMaxFps();
            if (std::abs(Current.observed - MaximumFps) > 0.5) {
                Fail("t.MaxFPS changed before the second gameserver cap readback");
                return false;
            }
            Current.state = State::Verified;
            return true;
        }

        const uintptr_t BaseAddress = Globals::BaseAddress;
        const auto* DosHeader = reinterpret_cast<const IMAGE_DOS_HEADER*>(BaseAddress);
        if (!IsReadableMemory(DosHeader, sizeof(*DosHeader)) || DosHeader->e_magic != IMAGE_DOS_SIGNATURE ||
            DosHeader->e_lfanew <= 0 || DosHeader->e_lfanew > 0x1000) {
            Fail("gameserver executable DOS header validation failed");
            return false;
        }
        const auto* NtHeaders = reinterpret_cast<const IMAGE_NT_HEADERS64*>(BaseAddress + DosHeader->e_lfanew);
        if (!IsReadableMemory(NtHeaders, sizeof(*NtHeaders)) || NtHeaders->Signature != IMAGE_NT_SIGNATURE ||
            NtHeaders->FileHeader.TimeDateStamp != ExpectedExecutableTimestamp ||
            NtHeaders->OptionalHeader.SizeOfImage != ExpectedExecutableImageSize) {
            Fail("gameserver executable build validation failed");
            return false;
        }
        const uintptr_t RegistrationAddress = BaseAddress + RegistrationRva;
        const uintptr_t SetterAddress = BaseAddress + ConsoleVariableSetRva;
        Current.signatureValid = MatchesSignature(RegistrationAddress, ExpectedRegistrationSignature) &&
            MatchesSignature(SetterAddress, ExpectedSetterSignature);
        if (!Current.signatureValid) {
            Fail("native t.MaxFPS signature verification failed");
            return false;
        }

        void** ConsoleVariableStorage = reinterpret_cast<void**>(BaseAddress + ConsoleVariablePointerRva);
        void** DataStorage = reinterpret_cast<void**>(BaseAddress + ConsoleVariableDataPointerRva);
        if (!IsReadableMemory(ConsoleVariableStorage, sizeof(void*)) ||
            !IsReadableMemory(DataStorage, sizeof(void*)) || !*ConsoleVariableStorage || !*DataStorage) {
            Fail("native t.MaxFPS storage was not initialized");
            return false;
        }

        void* ConsoleVariable = *ConsoleVariableStorage;
        if (!IsReadableMemory(ConsoleVariable, sizeof(void*))) {
            Fail("native t.MaxFPS console variable was unreadable");
            return false;
        }

        const uintptr_t VTable = *reinterpret_cast<const uintptr_t*>(ConsoleVariable);
        if (VTable != BaseAddress + FloatConsoleVariableVTableRva ||
            !IsReadableMemory(reinterpret_cast<const void*>(VTable + ConsoleVariableSetVTableOffset), sizeof(void*))) {
            Fail("native t.MaxFPS console variable vtable did not match this build");
            return false;
        }

        const uintptr_t ResolvedSetter = *reinterpret_cast<const uintptr_t*>(VTable + ConsoleVariableSetVTableOffset);
        if (ResolvedSetter != SetterAddress) {
            Fail("native t.MaxFPS setter did not match this build");
            return false;
        }

        Current.resolved = true;
        using SetConsoleVariableFn = void(*)(void*, const wchar_t*, uint32_t);
        reinterpret_cast<SetConsoleVariableFn>(ResolvedSetter)(ConsoleVariable, L"30", SetByCode);
        Current.applied = true;
        Current.observed = ReadObservedMaxFps();
        if (std::abs(Current.observed - MaximumFps) > 0.5) {
            Fail("native t.MaxFPS setter did not produce a 30 FPS readback");
            return false;
        }

        Current.state = State::AwaitingSecondReadback;
        return false;
    }

    static bool Failed() {
        return Current.state == State::Failed;
    }

    static bool Verified() {
        return Current.state == State::Verified;
    }

    static const Status& GetStatus() {
        return Current;
    }
}

static bool PreReadyOptimizationCompleted = false;
static bool StartupRejected = false;
static std::chrono::steady_clock::time_point ListenStartedAt{};
static AssetOptimization::Metrics OptimizationMetrics{};
static uint64_t PreReadyNetworkingPasses = 0;

static double ReadObservedMaxFps() {
    return DedicatedServerFrameCap::ReadObservedMaxFps();
}

static void PopulateStartupMetrics(AssetOptimization::Metrics& Metrics) {
    const DedicatedServerFrameCap::Status& Cap = DedicatedServerFrameCap::GetStatus();
    Metrics.configuredMaxFps = static_cast<uint64_t>(DedicatedServerFrameCap::MaximumFps);
    Metrics.observedMaxFps = ReadObservedMaxFps();
    Metrics.capSignatureValid = Cap.signatureValid;
    Metrics.capResolved = Cap.resolved;
    Metrics.capApplied = Cap.applied;
    Metrics.capVerified = DedicatedServerFrameCap::Verified() &&
        std::abs(Metrics.observedMaxFps - DedicatedServerFrameCap::MaximumFps) <= 0.5;
    Metrics.preReadyNetworkingPasses = PreReadyNetworkingPasses;
    Metrics.profilingEnabled = Globals::ProfilingEnabled;
    Metrics.bootstrapMinimumMilliseconds = DedicatedServerFrameCap::BootstrapMinimumMilliseconds;
    Metrics.bootstrapMaximumMilliseconds = DedicatedServerFrameCap::BootstrapMaximumMilliseconds;
    Metrics.considerCacheMaxAgeMilliseconds = Globals::ConsiderCacheMaxAgeMilliseconds;
    if (Networking::NetDriver) {
        Metrics.netServerMaxTickRate = static_cast<uint64_t>((std::max)(0, Networking::NetDriver->NetServerMaxTickRate));
        Metrics.maxNetTickRate = static_cast<uint64_t>((std::max)(0, Networking::NetDriver->MaxNetTickRate));
    }
}

static void RejectServerStartup(AssetOptimization::Metrics Metrics, const std::string& Reason) {
    if (StartupRejected)
        return;

    StartupRejected = true;
    PreReadyOptimizationCompleted = true;
    Globals::DoListen = false;
    Metrics.failed = true;
    if (!Reason.empty()) {
        if (!Metrics.error.empty()) Metrics.error += "; ";
        Metrics.error += Reason;
    }
    PopulateStartupMetrics(Metrics);
    Metrics.capVerified = false;
    OptimizationMetrics = std::move(Metrics);
    ServerPerformance::Start(OptimizationMetrics);
    SendReadyCallback(OptimizationMetrics, false, Reason);
}

static void FinishPreReadyOptimization(AssetOptimization::Metrics Metrics) {
    if (PreReadyOptimizationCompleted)
        return;

    PopulateStartupMetrics(Metrics);

    if (!Metrics.capVerified) {
        RejectServerStartup(std::move(Metrics), "gameserver t.MaxFPS was not verified at 30 before readiness");
        return;
    }
    if (PreReadyNetworkingPasses == 0) {
        if (!Metrics.error.empty()) Metrics.error += "; ";
        Metrics.error += "readiness reached without a pre-ready networking pass";
        OutputDebugStringA("[Undaunted] ERROR: readiness reached without a pre-ready networking pass\n");
    }

    OptimizationMetrics = std::move(Metrics);
    PreReadyOptimizationCompleted = true;
    ServerPerformance::Start(OptimizationMetrics);
    if (SendReadyCallback(OptimizationMetrics)) {
        if (!StartLifecycleHeartbeat()) {
            OutputDebugStringA(
                "[Undaunted] WARNING: lifecycle heartbeat did not start; idle shutdown will remain disabled\n");
        }
    }
}

static void TickPreReadyOptimization() {
    if (PreReadyOptimizationCompleted || PreReadyNetworkingPasses == 0)
        return;

    if (Globals::AssetStrippingMode == AssetOptimization::Mode::Off) {
        FinishPreReadyOptimization(AssetOptimization::MakeSkipped(
            Globals::AssetStrippingMode, AssetOptimization::SafetyGate::NotRequired, ""));
        return;
    }

    const bool HasTrackedConnections = !Networking::GetLiveConnections().empty();
    const bool HasRawConnections = Networking::NetDriver && Networking::NetDriver->ClientConnections.Num() > 0;
    if (HasTrackedConnections || HasRawConnections) {
        FinishPreReadyOptimization(AssetOptimization::MakeSkipped(
            Globals::AssetStrippingMode, AssetOptimization::SafetyGate::ConnectionsPresent,
            "asset cleanup skipped because a connection appeared before readiness"));
        return;
    }

    if (AssetOptimization::IsInitialLoadComplete()) {
        FinishPreReadyOptimization(AssetOptimization::Run(
            Globals::AssetStrippingMode,
            Globals::StripInactiveMapPackages,
            Globals::AssetStrippingLogDetails,
            WideToUtf8(Globals::MapPathValue)));
        return;
    }

    const double WaitedSeconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - ListenStartedAt).count();
    if (WaitedSeconds >= Globals::AssetGcWaitSeconds) {
        FinishPreReadyOptimization(AssetOptimization::MakeSkipped(
            Globals::AssetStrippingMode, AssetOptimization::SafetyGate::Timeout,
            "initial-load safety flag did not clear before the cleanup deadline"));
    }
}

void GameEngineTickHook(UGameEngine* GameEngine, float DeltaTime, char CanRender) {
    const auto OriginalTickStarted = std::chrono::steady_clock::now();
    reinterpret_cast<void(*)(UGameEngine*, float, char)>(OrigGameEngineTick)(GameEngine, DeltaTime, CanRender);
    const double OriginalTickMilliseconds = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - OriginalTickStarted).count();

    SDK::UWorld* World = SDK::UWorld::GetWorld();

    if (Globals::AmServer && !DedicatedServerFrameCap::Tick()) {
        if (DedicatedServerFrameCap::Failed()) {
            AssetOptimization::Metrics Metrics = AssetOptimization::MakeSkipped(
                Globals::AssetStrippingMode, AssetOptimization::SafetyGate::Failed,
                "");
            RejectServerStartup(std::move(Metrics), DedicatedServerFrameCap::GetStatus().error);
        }
        return;
    }

    if (StartupRejected)
        return;

    // Do not feed the evidence window the guaranteed pre-cap first frame. The
    // cap path above has now passed both native readbacks, so every recorded
    // sample represents the invariant the pacing correction is evaluating.
    if (Globals::AmServer) {
        const DedicatedServerFrameCap::Status& CapStatus = DedicatedServerFrameCap::GetStatus();
        const double CachedMaxFps = DedicatedServerFrameCap::ReadCachedMaxFps();
        ServerPacing::ObserveFrame({
            CapStatus.observed,
            CachedMaxFps,
            CapStatus.resolved && CachedMaxFps > 0.0
                ? DedicatedServerFrameCap::ReadVirtualMaxFps(GameEngine, DeltaTime)
                : 0.0,
            OriginalTickMilliseconds,
            static_cast<double>(DeltaTime) * 1000.0,
            DedicatedServerFrameCap::UsesFixedFrameRate(GameEngine)
        });
    }

    if (Globals::DoListen && ShouldAttemptListen(DeltaTime)) {
        Globals::DoListen = false;
        Globals::Listening = Networking::Listen(UEngine::GetEngine(), World, Globals::Port);

        if (Globals::Listening)
            ListenStartedAt = std::chrono::steady_clock::now();
    }

    if (Globals::Listening && Networking::NetDriver) {
        const auto NetworkingStarted = std::chrono::steady_clock::now();
        Networking::TickNetworking(World);
        const double NetworkingMilliseconds = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - NetworkingStarted).count();
        if (!PreReadyOptimizationCompleted)
            ++PreReadyNetworkingPasses;

        TickPreReadyOptimization();
        if (!PreReadyOptimizationCompleted)
            return;

        ServerPerformance::RecordEngineTick(DeltaTime, OriginalTickMilliseconds);
        ServerPerformance::RecordNetworking(NetworkingMilliseconds);
        ServerPerformance::Tick();

        const auto& LiveConnections = Networking::GetLiveConnections();
        ObserveLifecycleConnections(
            static_cast<uint32_t>(LiveConnections.size()),
            Networking::NetDriver != nullptr
                ? static_cast<uint32_t>((std::max)(0,
                    Networking::NetDriver->ClientConnections.Num()))
                : 0,
            World);
        if (!LiveConnections.empty())
            TotalNoPlayersTime = 0.0f;

        if (ShouldTickStaminaForServer()) {
            for (UNetConnection* Conn : LiveConnections) {
                if (Conn->PlayerController && Conn->PlayerController->Pawn) {
                    APawn* Pawn = Conn->PlayerController->Pawn;
                    if (!Pawn->IsA(ABP_PlayerCharacter_C::StaticClass()))
                        continue;
                    static_cast<ABP_PlayerCharacter_C*>(Pawn)->TickStamina(ECityExecFilter::Both, ERemoteExecFilter::All);
                }
            }
        }
    }
}

void* OrigFixupNetworkNotify = nullptr;

void* FixupNetworkNotifyHook(void* a1) {
    if(SDK::UWorld::GetWorld())
        *(void**)((uintptr_t)a1 + 0x208) = &SDK::UWorld::GetWorld()->NetworkNotify;

    return reinterpret_cast<void* (*)(void*)>(OrigFixupNetworkNotify)(a1);
}

void* OrigProcessRequest = nullptr;

char ProcessRequest(void* Request) {
    FString APIHeader(L"x-undaunted-gameserver-apikey");
    FString APIKey(Globals::ServerAPIKey);

    reinterpret_cast<void(*)(void*, FString*, FString*)>(Globals::BaseAddress + 0x28AAAA0)(Request, &APIHeader, &APIKey);

    return reinterpret_cast<char(*)(void*)>(OrigProcessRequest)(Request);
}

enum EFunctionCallspace : uint32_t
{
    /** This function call should be absorbed (ie client side with no authority) */
    Absorbed = 0x0,
    /** This function call should be called remotely via its net driver */
    Remote = 0x1,
    /** This function call should be called locally */
    Local = 0x2
};

void* OrigGetActorCallspace = nullptr;

EFunctionCallspace GetActorCallspace(AActor* Actor, UFunction* Function, void* Stack) {
    return reinterpret_cast<EFunctionCallspace(*)(AActor*, UFunction*, void*)>(OrigGetActorCallspace)(Actor, Function, Stack);
}

void* OrigPostLogin = nullptr;

void PostLoginHook(void* a1, AArchonPlayerController* a2) {
    reinterpret_cast<void(*)(void*, void*)>(OrigPostLogin)(a1, a2);
}

void* OrigHasFinishedLoading = nullptr;

bool HasFinishedLoadingHook(UObject* a1) {
    bool Ret = reinterpret_cast<bool(*)(UObject*)>(OrigHasFinishedLoading)(a1);

    if (!Ret) {
        if (Globals::EnableLogging)
            std::cout << "[FORCEREADY] " << a1->GetFullName() << std::endl;
        return true;
    }

    return Ret;
}

void* OrigIsNetReady = nullptr;

bool IsNetReadyHook() {
    return true;
}

void* OrigSetReplicationDriver = nullptr;

void SetReplicationDriverHook(UNetDriver* NetDriver, UReplicationDriver* RepDriver) {
    return reinterpret_cast<void(*)(UNetDriver*, UReplicationDriver*)>(OrigSetReplicationDriver)(NetDriver, nullptr);
}

void* OrigGetNetDriverInternal = nullptr;

UNetDriver* GetNetDriverInternalHook(void* a1, void* a2) {
    UNetDriver* NetDriver = reinterpret_cast<UNetDriver* (*)(void*, void*)>(OrigGetNetDriverInternal)(a1, a2);

    if (!NetDriver) {
        NetDriver = Networking::NetDriver;
    }

    return NetDriver;
}

void* OrigIsLevelInitForActor = nullptr;

bool IsLevelInitForActorHook(void* a1, char a2) {
    bool NetDriver = reinterpret_cast<bool (*)(void*, char)>(OrigIsLevelInitForActor)(a1, a2);

    if (!NetDriver) {
        return true;
    }

    return NetDriver;
}

void* OrigGetStartSpot = nullptr;

APlayerStart* GetStartSpotHook(void* a1, void* a2, void* a3) {
    for (int i = 0; i < SDK::UObject::GObjects->Num(); i++)
    {
        SDK::UObject* Obj = SDK::UObject::GObjects->GetByIndex(i);

        if (!Obj)
            continue;

        if (Obj->IsDefaultObject())
            continue;

        if (Obj->IsA(SDK::APlayerStart::StaticClass()))
        {
            return (APlayerStart*)Obj;
        }
    }

    if (Globals::EnableLogging)
    std::cout << "No startspot found!" << std::endl;

    return nullptr;
}

bool ServerTryActivateAbilityInternal(UAbilitySystemComponent* Component, FGameplayAbilitySpecHandle& AbilityHandle, bool InputPressed, FPredictionKey& PredictionKey, FGameplayEventData* TriggerEventData) {
    if(InputPressed)
        Component->ServerSetInputPressed(AbilityHandle);

    void* InstancedAbility = nullptr;

    bool Activated = reinterpret_cast<bool(*)(UAbilitySystemComponent*, uint32_t, FPredictionKey*, void**, void*, FGameplayEventData*)>(Globals::BaseAddress + 0x10C8C80)(Component, AbilityHandle.Handle, &PredictionKey, &InstancedAbility, nullptr, TriggerEventData);

    if (!Activated && InputPressed)
        Component->ServerSetInputReleased(AbilityHandle);

    return Activated;
}

void* OrigMakeDoDamage = nullptr;

bool MakeDoDamageHook(void* a1, void* a2, void* a3) {
    *(uint8_t*)((uintptr_t)a1 + 0x57C) = 1;

    return true;
}

static int NumTimesOnAirshipUpdated = 0;
bool DidDoTravelReset = false;

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
// TODO: Temporary workaround for CreatePhoenixAccountEndpoint and GET 127.0.0.1//
bool IsMalformedLocalEndpoint(const std::wstring& Value) {
    const size_t SchemeEnd = Value.find(L"://");
    const size_t PathStart = SchemeEnd == std::wstring::npos ? 0 : Value.find(L'/', SchemeEnd + 3);
    if (PathStart != std::wstring::npos && Value.compare(PathStart, 2, L"//") == 0)
        return true;
    return Value.find(L"/account127.0.0.1") != std::wstring::npos ||
        Value.find(L"/accountlocalhost") != std::wstring::npos;
}

void* OrigConfigCacheIniGetString = nullptr;

bool ConfigCacheInitGetStringHook(void* a1, const wchar_t* Section, const wchar_t* Key, FString* Value, FString* Filename) {
    if (Globals::MetagameAddress.empty())
        return reinterpret_cast<bool(*)(void* a1, const wchar_t* Section, const wchar_t* Key, FString * Value, FString * Filename)>(OrigConfigCacheIniGetString)(a1, Section, Key, Value, Filename);

    if (WideContainsInsensitive(Section, L"StompServiceMcp") &&
        Key != nullptr && WideContainsInsensitive(Key, L"ServiceSessionEndpoint")) {
        *Value = FString((L"ws://" + Globals::MetagameAddress + L"/ws/{accountid}").c_str());
        return true;
    }

    if (MayBeMappedEndpointKey(Key)) {
        EvalEndpointMap();
        const std::wstring KeyName(Key);
        const auto Endpoint = EndpointMap.find(KeyName);

        if (Endpoint != EndpointMap.end()) {
            const std::wstring& MappedValue = Endpoint->second;

            if (Globals::EnableLogging) {
                FString RawValue;
                const bool HadRawValue = reinterpret_cast<bool(*)(void*, const wchar_t*, const wchar_t*, FString*, FString*)>(OrigConfigCacheIniGetString)(a1, Section, Key, &RawValue, Filename);
                const std::string RawUtf8 = HadRawValue ? RawValue.ToString() : std::string();
                const std::wstring RawValueWide(RawUtf8.begin(), RawUtf8.end());
                if (IsMalformedLocalEndpoint(RawValueWide) || IsMalformedLocalEndpoint(MappedValue)) {
                    std::wcout << L"Malformed endpoint config section=" << (Section ? Section : L"<null>")
                        << L" key=" << (Key ? Key : L"<null>") << L" raw=" << RawValueWide
                        << L" mapped=" << MappedValue << std::endl;
                }
            }

            *Value = FString(MappedValue.c_str());

            return true;
        }
    }

    if (WideContainsInsensitive(Section, L"Mcp") && Key != nullptr) {
        const bool IsStompSection = WideContainsInsensitive(Section, L"StompServiceMcp");
        const bool IsXmppSection = WideContainsInsensitive(Section, L"Xmpp");

        if (IsStompSection && (WideContainsInsensitive(Key, L"path") ||
                               WideContainsInsensitive(Key, L"url") ||
                               WideContainsInsensitive(Key, L"endpoint"))) {
            *Value = FString(L"/stomp");
            return true;
        }

        if (WideContainsInsensitive(Key, L"protocol") || WideContainsInsensitive(Key, L"scheme")) {
            *Value = FString((IsStompSection || IsXmppSection) ? L"ws" : L"http");

            return true;
        }

        if (WideContainsInsensitive(Key, L"Domain")) {
            if (IsXmppSection) {
                constexpr const wchar_t* XmppIdentityDomain = L"prod.ol.epicgames.com";
                *Value = FString(XmppIdentityDomain);
                return true;
            }
            if (IsStompSection) {
                *Value = FString(Globals::MetagameAddress.c_str());
                return true;
            }
        }
    }
    
    return reinterpret_cast<bool(*)(void* a1, const wchar_t* Section, const wchar_t* Key, FString * Value, FString * Filename)>(OrigConfigCacheIniGetString)(a1, Section, Key, Value, Filename);
}

void* OrigGetEscalationSeason = nullptr;

bool GetEscalationSeason(UHuntCatalog* a1, FString* HuntID, FHunt_UnlockInfo* UnlockInfo, FHunt_UnlockInfo* AltUnlockInfo, AArchonPlayerController* PC) { // TODO: Fixup scheduling & Player leveling so this hack isn't necessary
    if (HuntID->ToString().contains("Arena") || (HuntID->ToString().contains("Esca") && !HuntID->ToString().contains("Mint"))) {
        return true;
    }

    return reinterpret_cast<bool(*)(UHuntCatalog * a1, FString * HuntID, FHunt_UnlockInfo * UnlockInfo, FHunt_UnlockInfo * AltUnlockInfo, AArchonPlayerController * PC)>(OrigGetEscalationSeason)(a1, HuntID, UnlockInfo, AltUnlockInfo, PC);
}

void* OrigGetTrackProgress = nullptr;

__int64 GetTrackProgress(void* a1, FName* a2, void* a3) {
    return 9999999;
}

//__int64 *__fastcall sub_141428060(__int64 a1, __int64 *a2, unsigned __int8 a3, char a4)

void InitClientHooks() {
    MH_Initialize();

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1528000), HasFinishedLoadingHook, &OrigHasFinishedLoading);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1528000));

    if (!Globals::MetagameAddress.empty()) {
        MH_CreateHook((void*)(Globals::BaseAddress + 0x1D09D50), ConfigCacheInitGetStringHook, &OrigConfigCacheIniGetString);

        MH_EnableHook((void*)(Globals::BaseAddress + 0x1D09D50));
    }

    MH_CreateHook((void*)(Globals::BaseAddress + 0x14F2A30), GetEscalationSeason, &OrigGetEscalationSeason);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x14F2A30));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x3307100), GameEngineTickHook, &OrigGameEngineTick);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x3307100));

    //

    //1469E00

    //MH_CreateHook((void*)(Globals::BaseAddress + 0x1469E00), GetTrackProgress, &OrigGetTrackProgress);

    //MH_EnableHook((void*)(Globals::BaseAddress + 0x1469E00));


    //MH_CreateHook((void*)(Globals::BaseAddress + 0x347E110), IsNetReadyHook, &OrigIsNetReady);

    //MH_EnableHook((void*)(Globals::BaseAddress + 0x347E110));

    if constexpr (ClientHookConfig::kEnableNativeNameCleanup) {
        NativeNameCleanup::Init();
    }

   // MH_CreateHook((void*)(Globals::BaseAddress + 0x3077710), GetActorCallspace, &OrigGetActorCallspace);

   // MH_EnableHook((void*)(Globals::BaseAddress + 0x3077710));
}

void* OrigSprint = nullptr;

bool SprintHook(uintptr_t a1, uintptr_t a2) { //char __fastcall UArchonStaminaComponent_TryConsumeStamina_Native(__int64 a1, __int64 a2, char a3, char a4)    
    return true;
}

void* OrigNetModeHook = nullptr;

int NetModeHook(void* a1) { //char __fastcall UArchonStaminaComponent_TryConsumeStamina_Native(__int64 a1, __int64 a2, char a3, char a4)   
    return 1;
}

void InitServerHooks() {
    MH_Initialize();

    // This hook is build/signature checked and remains pass-through unless the
    // native 30 FPS pacer is demonstrably losing time in its coarse Sleep call.
    ServerPacing::Install(Globals::BaseAddress, Globals::AmServer);

    MH_CreateHook((void*)(Globals::BaseAddress + 0x25A37C0), GetGameDefaultMap, &OrigGetDefaultMap);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x25A37C0));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1D06D40), GetCommandLineHook, &OrigGetCommandLine);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1D06D40));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x2E4D7F0), ServerBootCrash, &OrigServerBootCrash);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x2E4D7F0));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1658f90), EncounterableSetupHook, &OrigEncounterableSetup);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1658f90));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x3307100), GameEngineTickHook, &OrigGameEngineTick);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x3307100));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x820120), FixupNetworkNotifyHook, &OrigFixupNetworkNotify);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x820120));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x28A76C0), ProcessRequest, &OrigProcessRequest);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x28A76C0));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1390300), EncounterableSetupHook, &OrigEncounterableSetup); // TODO: Rename to combat text

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1390300));

    //MH_CreateHook((void*)(Globals::BaseAddress + 0x3077710), GetActorCallspace, &OrigGetActorCallspace);

    //MH_EnableHook((void*)(Globals::BaseAddress + 0x3077710));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x14B7460), PostLoginHook, &OrigPostLogin);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x14B7460));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1528000), HasFinishedLoadingHook, &OrigHasFinishedLoading);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1528000));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x347E110), IsNetReadyHook, &OrigIsNetReady);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x347E110));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x3491720), SetReplicationDriverHook, &OrigSetReplicationDriver);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x3491720));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x3078AF0), GetNetDriverInternalHook, &OrigGetNetDriverInternal);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x3078AF0));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x3458780), IsLevelInitForActorHook, &OrigIsLevelInitForActor);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x3458780));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1368660), GetStartSpotHook, &OrigGetStartSpot);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1368660));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x1F61820), ProcessEventHook, &OrigProcessEvent);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x1F61820));

    //MH_CreateHook((void*)(Globals::BaseAddress + 0x35996D0), MakeDoDamageHook, &OrigMakeDoDamage);

    //MH_EnableHook((void*)(Globals::BaseAddress + 0x35996D0));

    //MH_CreateHook((void*)(Globals::BaseAddress + 0x137A800), SprintHook, &OrigSprint);

    //MH_EnableHook((void*)(Globals::BaseAddress + 0x137A800));

    MH_CreateHook((void*)(Globals::BaseAddress + 0x378BDA0), NetModeHook, &OrigNetModeHook);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x378BDA0));

    //MH_CreateHook((void*)(Globals::BaseAddress + 0x1469E00), GetTrackProgress, &OrigGetTrackProgress);

   // MH_EnableHook((void*)(Globals::BaseAddress + 0x1469E00));

    
    MH_CreateHook((void*)(Globals::BaseAddress + 0x14F2A30), GetEscalationSeason, &OrigGetEscalationSeason);

    MH_EnableHook((void*)(Globals::BaseAddress + 0x14F2A30));

    //

    //13CA280

    //GetStartSpotHook

    // Fixup Listen failure
    DWORD oldProtect;
    VirtualProtect((void*)(Globals::BaseAddress + 0x372E746), 0x5, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x372E746 + 0x0) = 0xB0;
    *(uint8_t*)(Globals::BaseAddress + 0x372E746 + 0x1) = 0x01;
    *(uint8_t*)(Globals::BaseAddress + 0x372E746 + 0x2) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x372E746 + 0x3) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x372E746 + 0x4) = 0x90;

    VirtualProtect((void*)(Globals::BaseAddress + 0x372E746), 0x5, oldProtect, &oldProtect);

    // Fixup Ramsgate Crash
    VirtualProtect((void*)(Globals::BaseAddress + 0x1346A98), 0x7, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x0) = 0x33;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x1) = 0xF6;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x2) = 0x33;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x3) = 0xC0;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x4) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x5) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x1346A98 + 0x6) = 0x90;

    VirtualProtect((void*)(Globals::BaseAddress + 0x1346A98), 0x7, oldProtect, &oldProtect);

    //GIsServer and GIsClient
    VirtualProtect((void*)(Globals::BaseAddress + 0x7961AE), 0x9, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x0) = 0xC6;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x1) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x2) = 0x84;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x3) = 0x5A;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x4) = 0x6B;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x5) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x6) = 0x00;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x7) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x7961AE + 0x8) = 0x90;

    VirtualProtect((void*)(Globals::BaseAddress + 0x7961AE), 0x9, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x7961BB), 0x9, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x0) = 0xC6;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x1) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x2) = 0x78;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x3) = 0x5A;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x4) = 0x6B;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x5) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x6) = 0x01;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x7) = 0x90;
    *(uint8_t*)(Globals::BaseAddress + 0x7961BB + 0x8) = 0x90;

    VirtualProtect((void*)(Globals::BaseAddress + 0x7961BB), 0x9, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A81B), 0x7, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x0) = 0xC6;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x1) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x2) = 0x17;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x3) = 0x14;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x4) = 0x6B;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x5) = 0x05;
    *(uint8_t*)(Globals::BaseAddress + 0x79A81B + 0x6) = 0x00;

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A81B), 0x7, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A680), 0x1, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x79A680 + 0x0) = 0x00;

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A680), 0x1, oldProtect, &oldProtect);

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A815), 0x1, PAGE_READWRITE, &oldProtect);

    *(uint8_t*)(Globals::BaseAddress + 0x79A815 + 0x0) = 0x01;

    VirtualProtect((void*)(Globals::BaseAddress + 0x79A815), 0x1, oldProtect, &oldProtect);
}

void Init() {

    Globals::AmServer = std::string(GetCommandLineA()).contains("-server");
    Globals::BaseAddress = (uintptr_t)GetModuleHandleA(nullptr);

    if (Globals::AmServer) {
        *(uint8_t*)(Globals::BaseAddress + 0x5E4BC3A) = 0x1; // GIsServer
        *(uint8_t*)(Globals::BaseAddress + 0x5E4BC39) = 0x0; // GIsClient
    }

    UC::FMemory::Init((void*)(Globals::BaseAddress + 0x1C8EE00));

    if (Globals::AmServer) {
        int NumArgs = 0;

        wchar_t** Args = CommandLineToArgvW(GetCommandLineW(), &NumArgs);

        if (NumArgs > 8) {
            Globals::ServerAPIKeyValue = Args[1];
            Globals::Port = std::stoi(std::wstring(Args[2]));
            Globals::MapPathValue = Args[3];
            Globals::BehemothPathValue = Args[4];
            Globals::MatchmakerHuntIdValue = Args[5];
            Globals::ExpectedPlayerStringValue = Args[6];
            Globals::MyIpAndPortValue = Args[7];
            Globals::ServerAPIKey = Globals::ServerAPIKeyValue.c_str();
            Globals::MapPath = Globals::MapPathValue.c_str();
            Globals::BehemothPath = Globals::BehemothPathValue.c_str();
            Globals::MatchmakerHuntId = Globals::MatchmakerHuntIdValue.c_str();
            Globals::ExpectedPlayerString = Globals::ExpectedPlayerStringValue.c_str();
            Globals::MyIpAndPort = Globals::MyIpAndPortValue.c_str();
            if (NumArgs > 11 && Args[8][0] != L'-') {
                Globals::GameserverId = Args[8];
                Globals::ReadyCallbackUrl = Args[9];
                Globals::ReadyCallbackToken = Args[10];
            }

            Globals::EnableLogging = GetNamedBooleanArgument(
                Args, NumArgs, L"-undauntedConsoleLog=", false);
            Globals::AssetStrippingMode = AssetOptimization::ParseMode(GetNamedArgument(
                Args, NumArgs, L"-undauntedAssetStrippingMode=", L"aggressive"));
            Globals::StripInactiveMapPackages = GetNamedBooleanArgument(
                Args, NumArgs, L"-undauntedStripInactiveMapPackages=", true);
            Globals::AssetStrippingLogDetails = GetNamedBooleanArgument(
                Args, NumArgs, L"-undauntedAssetStrippingLogDetails=", false);
            Globals::AssetGcWaitSeconds = GetNamedUnsignedArgument(
                Args, NumArgs, L"-undauntedAssetGcWaitSeconds=", 15, 1, 15);
            Globals::ProfilingEnabled = GetNamedBooleanArgument(
                Args, NumArgs, L"-undauntedProfiling=", false);
            Globals::ProfileIntervalSeconds = GetNamedUnsignedArgument(
                Args, NumArgs, L"-undauntedProfileIntervalSeconds=", 30, 10, 3600);
            Globals::ProfileOutputDirectory = GetNamedArgument(
                Args, NumArgs, L"-undauntedProfileOutputDirectory=", L"");
            Globals::ProfileMaximumBytes = GetNamedUnsignedArgument(
                Args, NumArgs, L"-undauntedProfileMaxBytes=",
                64u * 1024u * 1024u, 1024u * 1024u, 1024u * 1024u * 1024u);
            Globals::ConsiderCacheMaxAgeMilliseconds = GetNamedUnsignedArgument(
                Args, NumArgs, L"-undauntedConsiderCacheMaxAgeMs=", 250, 50, 5000);
            Globals::LifecycleCallbackUrl = GetNamedArgument(
                Args, NumArgs, L"-undauntedLifecycleCallbackUrl=", L"");
            Networking::Configure(Globals::ConsiderCacheMaxAgeMilliseconds);
            ServerPerformance::Configure(
                Globals::ProfilingEnabled,
                Globals::ProfileIntervalSeconds,
                WideToUtf8(Globals::GameserverId),
                WideToUtf8(Globals::MapPathValue),
                Globals::ProfileOutputDirectory,
                Globals::ProfileMaximumBytes);
            Networking::ConfigureLifecycleEventSink(
                Globals::ProfilingEnabled && !Globals::ProfileOutputDirectory.empty()
                    ? ServerPerformance::RecordLifecycleEvent
                    : nullptr);

            if (Globals::Port >= 8776) {
                EnableWatchdog = false;
            }

            LocalFree(Args);
        }
        else {
            if (Args != nullptr)
                LocalFree(Args);
            MessageBoxA(nullptr, "INVALID GAMESERVER ARGS", "INVALID GAMESERVER ARGS", 0);
            exit(0);
            return;
        }

        if (Globals::EnableLogging) {
            AllocConsole();
            FILE* Dummy;
            freopen_s(&Dummy, "CONOUT$", "w", stdout);
            freopen_s(&Dummy, "CONIN$", "r", stdin);

            std::cout << "Welcome to Undaunted v" << UNDAUNTED_INTERNAL_VERSION << "!" << std::endl;
            std::cout << "prod. gwog :3" << std::endl;
            std::cout << "thanks to all who contributed in any way, you know who you are, dm me on discord if you want a named shoutout here :3" << std::endl;

            std::cout << "Running as a server!" << std::endl;
        }

        InitServerHooks();
    }
    else {
        Globals::EnableLogging = true;

        if (Globals::EnableLogging) {
            AllocConsole();
            FILE* Dummy;
            freopen_s(&Dummy, "CONOUT$", "w", stdout);
            freopen_s(&Dummy, "CONIN$", "r", stdin);

            std::cout << "Welcome to Undaunted v" << UNDAUNTED_INTERNAL_VERSION << "!" << std::endl;
            std::cout << "prod. gwog :3" << std::endl;
            std::cout << "thanks to all who contributed in any way, you know who you are, dm me on discord if you want a named shoutout here :3" << std::endl;

            std::cout << "Running as a debug-enabled client!" << std::endl;
        }

        int NumArgs = 0;

        wchar_t** Args = CommandLineToArgvW(GetCommandLineW(), &NumArgs);

        Globals::MetagameAddress = FindClientMetagameAddress(Args, NumArgs);
        if (Args != nullptr)
            LocalFree(Args);

        InitClientHooks();
    }

    DWORD threadId;
    HANDLE Thread = CreateThread(nullptr, 0x1000, (LPTHREAD_START_ROUTINE)MainThread, nullptr, 0, &threadId);
    if (Thread != nullptr)
        CloseHandle(Thread);
}

BOOL APIENTRY DllMain( HMODULE hModule,
                       DWORD  ul_reason_for_call,
                       LPVOID lpReserved
                     )
{
    switch (ul_reason_for_call)
    {
    case DLL_PROCESS_ATTACH:
        DisableThreadLibraryCalls(hModule);
        Init();
    case DLL_THREAD_ATTACH:
    case DLL_THREAD_DETACH:
    case DLL_PROCESS_DETACH:
        break;
    }
    return TRUE;
}

