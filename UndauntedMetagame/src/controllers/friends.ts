import { GetRecentPlayerData } from "./undauntedapi";
import { GetSocialPresenceState, IsSocialUserOnline } from "./social";
import { BuildCanonicalAccountIdentity } from "./accountProfile";

/**
 * TODO:
 * Currently we force everyone to be friends. Locally they can unfriend but that is stateless.
 */

const STABLE_FRIEND_CREATED_AT = "2020-01-01T00:00:00.000Z";
const FRESH_HEARTBEAT_MS = Number(process.env.SOCIAL_HEARTBEAT_ONLINE_MS || "90000");
const ARCHON_PRESENCE_ONLINE = 0;
const ARCHON_PRESENCE_OFFLINE = 1;

export async function DoesUserExist(userId: string) {
    return IsAllowedSocialUser(userId);
}

export async function GetAcceptedFriendsForUser(userId: string, additionalSelfIds: string[] = []) {
    const FriendIds = GetConfiguredFriendIdsForUser(userId, additionalSelfIds);
    return Promise.all(FriendIds.map(BuildFriendPayload));
}

export async function GetFriendForUser(_userId: string, friendId: string) {
    if(!await DoesUserExist(friendId)){
        return undefined;
    }

    return BuildFriendPayload(friendId);
}

export async function BuildEpicFriendsPayload(userId: string, additionalSelfIds: string[] = []) {
    return {
        friends: GetConfiguredFriendIdsForUser(userId, additionalSelfIds).map(BuildEpicFriendEntry),
        blockList: BuildEpicBlockListPayload()
    };
}

export async function BuildLegacyArchonAccountData(userId: string, additionalSelfIds: string[] = []) {
    return JSON.stringify({
        Friends: JSON.stringify(await BuildLegacyArchonFriendsSave(userId, additionalSelfIds))
    });
}

export async function BuildLegacyArchonFriendsSave(userId: string, additionalSelfIds: string[] = []) {
    const FriendIds = GetConfiguredFriendIdsForUser(userId, additionalSelfIds);
    const Friends = await Promise.all(FriendIds.map(async (FriendId) => {
        const Identity = await BuildCanonicalAccountIdentity(FriendId);

        return {
            UniqueId: Identity.accountId,
            DisplayName: Identity.displayName
        };
    }));

    return {
        Friends,
        PendingFriends: [],
        LastNameQuery: STABLE_FRIEND_CREATED_AT,
        Version: 0
    };
}

export function BuildEpicBlockListPayload() {
    return [];
}

function BuildEpicFriendEntry(accountId: string) {
    return {
        accountId,
        created: STABLE_FRIEND_CREATED_AT,
        favorite: false
    };
}

// TODO: extra fields here mess things up for us with loadouts
// corrupting memory (just how?)
export async function BuildFriendPayload(accountId: string): Promise<Record<string, any>> {
    const Identity = await BuildCanonicalAccountIdentity(accountId);
    const Presence = await BuildPresencePayload(accountId);

    return {
        id: Identity.accountId,
        accountId: Identity.accountId,
        AccountId: Identity.accountId,
        account_id: Identity.accountId,
        epicAccountId: Identity.accountId,
        userId: Identity.accountId,
        UserId: Identity.accountId,
        displayName: Identity.displayName,
        DisplayName: Identity.displayName,
        name: Identity.displayName,
        username: Identity.displayName,
        preferredLanguage: Identity.preferredLanguage,
        country: Identity.country,
        linkedAccounts: Identity.linkedAccounts,
        status: "ACCEPTED",
        direction: "BOTH",
        created: STABLE_FRIEND_CREATED_AT,
        alias: null,
        note: null,
        favorite: false,
        groups: [],
        mutual: 0,
        presence: Presence,
        online: Presence.online,
        Online: Presence.online,
        IsOnline: Presence.IsOnline,
        isOnline: Presence.isOnline,
        IsPlaying: Presence.IsPlaying,
        isPlaying: Presence.isPlaying,
        IsJoinable: Presence.IsJoinable,
        isJoinable: Presence.isJoinable,
        onlineStatus: Presence.status,
        presenceStatus: Presence.status,
        availability: Presence.availability,
        availabilityStatus: Presence.availabilityStatus,
        connectionStatus: Presence.connectionStatus,
        richPresence: Presence.richPresence,
        richPresenceString: Presence.richPresenceString,
        RichPresence: Presence.richPresence,
        location: Presence.location,
        locationString: Presence.locationString,
        State: Presence.State,
        PresenceState: Presence.PresenceState,
        stateCode: Presence.stateCode,
        state: Presence.state,
        StatusStr: Presence.StatusStr,
        Status: Presence.Status,
        statusStr: Presence.statusStr,
        statusString: Presence.statusString,
        statusText: Presence.statusText,
        activity: Presence.activity,
        activityText: Presence.activityText,
        currentStatus: Presence.currentStatus,
        currentStatusText: Presence.currentStatusText,
        isPlayingThisGame: Presence.isPlayingThisGame,
        bIsOnline: Presence.bIsOnline,
        bIsPlaying: Presence.bIsPlaying,
        bIsPlayingThisGame: Presence.bIsPlayingThisGame,
        bIsJoinable: Presence.bIsJoinable,
        bHasVoiceSupport: Presence.bHasVoiceSupport,
        AppId: Presence.AppId,
        appId: Presence.appId,
        app_id: Presence.app_id,
        productId: Presence.productId,
        productName: Presence.productName,
        platform: Presence.platform,
        PlatformString: Presence.PlatformString,
        platformString: Presence.platformString,
        platformType: Presence.platformType,
        lastSeen: Presence.lastSeen
    };
}

export async function BuildPresenceResult(accountId: string) {
    const Identity = await BuildCanonicalAccountIdentity(accountId);
    const RecentData = (await GetRecentPlayerData()).find((Data) => Data.UserId === accountId);
    const LivePresence = GetSocialPresenceState(accountId);
    const OnlineFromSession = IsSocialUserOnline(accountId);
    const OnlineFromHeartbeat = IsFreshHeartbeat(RecentData?.LastHeartbeatAt);
    const OnlineFromMatchmaking = RecentData?.Matchmaking != undefined;
    const OnlineFromConfiguredFriend = IsAllowedSocialUser(accountId);
    const Online = OnlineFromSession || OnlineFromHeartbeat || OnlineFromMatchmaking || OnlineFromConfiguredFriend;
    const ActivityText = Online ? LivePresence?.richPresence ?? BuildActivityText(RecentData?.Map, RecentData?.HuntId) : "Offline";
    const LastSeenAt = RecentData?.LastHeartbeatAt ?? RecentData?.Matchmaking?.UpdatedTime;
    const LastSeenIso = LivePresence?.updatedAt ?? (LastSeenAt != undefined ? new Date(LastSeenAt).toISOString() : null);
    const Status = Online ? "online" : "offline";
    const Availability = Online ? "ONLINE" : "OFFLINE";
    const IsPlaying = LivePresence?.bIsPlaying ?? Online;
    const IsJoinable = LivePresence?.bIsJoinable ?? Online;
    const ArchonState = Online ? ARCHON_PRESENCE_ONLINE : ARCHON_PRESENCE_OFFLINE;
    const PresenceProperties = LivePresence != undefined
        ? {
            ...LivePresence.properties,
            Status: LivePresence.status,
            richPresence: LivePresence.richPresence,
            rich_presence: LivePresence.richPresence,
            sessionId: LivePresence.sessionId,
            updatedAt: LivePresence.updatedAt
        }
        : {
            Status: ActivityText,
            status: ActivityText,
            richPresence: ActivityText,
            rich_presence: ActivityText,
            map: RecentData?.Map ?? "",
            huntId: RecentData?.HuntId ?? "",
            gameMode: RecentData?.Matchmaking?.GameMode ?? ""
        };

    return {
        source: LivePresence != undefined ? "xmpp" : OnlineFromSession ? "social-session" : OnlineFromHeartbeat ? "heartbeat" : OnlineFromMatchmaking ? "matchmaking" : OnlineFromConfiguredFriend ? "configured-friend" : "offline",
        payload: {
            id: Identity.accountId,
            accountId: Identity.accountId,
            AccountId: Identity.accountId,
            account_id: Identity.accountId,
            epicAccountId: Identity.accountId,
            userId: Identity.accountId,
            UserId: Identity.accountId,
            displayName: Identity.displayName,
            DisplayName: Identity.displayName,
            name: Identity.displayName,
            username: Identity.displayName,
            preferredLanguage: Identity.preferredLanguage,
            country: Identity.country,
            linkedAccounts: Identity.linkedAccounts,
            online: Online,
            Online,
            IsOnline: Online,
            isOnline: Online,
            IsPlaying,
            isPlaying: IsPlaying,
            isPlayingThisGame: Online,
            IsJoinable,
            isJoinable: IsJoinable,
            bIsOnline: Online,
            bIsPlaying: IsPlaying,
            bIsPlayingThisGame: Online,
            bIsJoinable: IsJoinable,
            bHasVoiceSupport: LivePresence?.bHasVoiceSupport ?? false,
            status: Status,
            onlineStatus: Status,
            presenceStatus: Status,
            availability: Availability,
            availabilityStatus: Availability,
            connectionStatus: Availability,
            activity: ActivityText,
            activityText: ActivityText,
            currentStatus: ActivityText,
            currentStatusText: ActivityText,
            richPresence: ActivityText,
            RichPresence: ActivityText,
            richPresenceString: ActivityText,
            rich_presence: ActivityText,
            statusText: ActivityText,
            status_text: ActivityText,
            summary: ActivityText,
            State: ArchonState,
            PresenceState: ArchonState,
            stateCode: ArchonState,
            state: Status,
            stateString: Status,
            StatusStr: ActivityText,
            Status: ActivityText,
            statusStr: ActivityText,
            statusString: ActivityText,
            AppId: "Jackal",
            appId: "Jackal",
            app_id: "Jackal",
            productId: "Jackal",
            productName: "Dauntless",
            platform: "WIN",
            PlatformString: "WIN",
            platformString: "WIN",
            platformType: "WIN",
            lastSeen: LastSeenIso,
            last_seen: LastSeenIso,
            lastOnline: LastSeenIso,
            last_online: LastSeenIso,
            map: RecentData?.Map ?? null,
            location: RecentData?.Map ?? null,
            locationString: ActivityText,
            huntId: RecentData?.HuntId ?? null,
            matchmaking: RecentData?.Matchmaking ?? null,
            properties: PresenceProperties
        }
    };
}

export async function BuildPresenceEventPayload(event: Record<string, any>) {
    const UserId = typeof event.userId === "string"
        ? event.userId
        : typeof event.accountId === "string"
            ? event.accountId
            : undefined;
    if(UserId == undefined){
        return event;
    }

    const Presence = await BuildPresenceResult(UserId);

    return {
        ...event,
        ...Presence.payload,
        accountId: UserId,
        account_id: UserId,
        userId: UserId,
        online: Presence.payload.online,
        source: Presence.source,
        presence: Presence.payload
    };
}

function IsFreshHeartbeat(lastHeartbeatAt: number | undefined) {
    return lastHeartbeatAt != undefined && Date.now() - lastHeartbeatAt <= FRESH_HEARTBEAT_MS;
}

export async function BuildPresencePayload(accountId: string) {
    return (await BuildPresenceResult(accountId)).payload;
}

export function GetSocialFriendUserIds() {
    return (process.env.SOCIAL_FRIEND_USER_IDS ?? "")
        .split(",")
        .map((UserId) => UserId.trim())
        .filter((UserId, Index, UserIds) => UserId.length > 0 && UserIds.indexOf(UserId) === Index);
}

export function GetConfiguredFriendIdsForUser(userId: string | undefined, additionalSelfIds: string[] = []) {
    const SelfIds = new Set([userId, ...additionalSelfIds].filter((SelfId): SelfId is string => typeof SelfId === "string" && SelfId.length > 0));
    return GetSocialFriendUserIds().filter((FriendId) => !SelfIds.has(FriendId));
}

export function IsAllowedSocialUser(userId: string) {
    return GetSocialFriendUserIds().includes(userId);
}

function BuildActivityText(map: string | undefined, huntId: string | undefined) {
    const Text = `${map ?? ""} ${huntId ?? ""}`.toLowerCase();

    if(Text.includes("ramsgate") || Text.includes("city")){
        return "In Ramsgate";
    }

    if(Text.includes("dojo")){
        return "In Training Grounds";
    }

    if(huntId != undefined && huntId.length > 0){
        return "In Hunt";
    }

    return "Online";
}
