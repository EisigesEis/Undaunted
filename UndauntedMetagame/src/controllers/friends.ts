import { GetDb } from "../db";
import { GetRecentPlayerData } from "./undauntedapi";
import { IsSocialUserOnline } from "./social";
import { BuildCanonicalAccountIdentity } from "./accountProfile";

/**
 * TODO:
 * Currently we force everyone to be friends. Locally they can unfriend but that is stateless.
 */

const STABLE_FRIEND_CREATED_AT = "2020-01-01T00:00:00.000Z";
const FRESH_HEARTBEAT_MS = Number(process.env.SOCIAL_HEARTBEAT_ONLINE_MS || "90000");

export async function DoesUserExist(userId: string) {
    if(!IsAllowedSocialUser(userId)){
        return false;
    }

    return await GetDb().query.users.findFirst({
        where: (row, { eq }) => eq(row.userId, userId)
    }) != undefined;
}

export async function GetAcceptedFriendsForUser(userId: string) {
    const AllowedFriendIds = GetSocialFriendUserIds().filter((AllowedUserId) => AllowedUserId !== userId);
    const CandidateUsers = await GetDb().query.users.findMany();
    const FriendUsers = CandidateUsers.filter((User) => AllowedFriendIds.includes(User.userId));

    return Promise.all(FriendUsers.map((FriendUser) => BuildFriendPayload(FriendUser.userId)));
}

export async function GetFriendForUser(_userId: string, friendId: string) {
    if(!await DoesUserExist(friendId)){
        return undefined;
    }

    return BuildFriendPayload(friendId);
}

export async function BuildFriendPayload(accountId: string): Promise<Record<string, any>> {
    const Identity = await BuildCanonicalAccountIdentity(accountId);
    const Presence = await BuildPresencePayload(accountId);

    return {
        id: Identity.accountId,
        accountId: Identity.accountId,
        account_id: Identity.accountId,
        epicAccountId: Identity.accountId,
        userId: Identity.accountId,
        displayName: Identity.displayName,
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
        isOnline: Presence.isOnline,
        isPlaying: Presence.isPlaying,
        isJoinable: Presence.isJoinable,
        onlineStatus: Presence.status,
        presenceStatus: Presence.status,
        availability: Presence.availability,
        availabilityStatus: Presence.availabilityStatus,
        connectionStatus: Presence.connectionStatus,
        richPresence: Presence.richPresence,
        richPresenceString: Presence.richPresenceString,
        location: Presence.location,
        locationString: Presence.locationString,
        state: Presence.state,
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
        appId: Presence.appId,
        app_id: Presence.app_id,
        productId: Presence.productId,
        productName: Presence.productName,
        platform: Presence.platform,
        platformString: Presence.platformString,
        platformType: Presence.platformType,
        lastSeen: Presence.lastSeen
    };
}

export async function BuildPresenceResult(accountId: string) {
    const Identity = await BuildCanonicalAccountIdentity(accountId);
    const RecentData = (await GetRecentPlayerData()).find((Data) => Data.UserId === accountId);
    const OnlineFromSession = IsSocialUserOnline(accountId);
    const OnlineFromHeartbeat = IsFreshHeartbeat(RecentData?.LastHeartbeatAt);
    const OnlineFromMatchmaking = RecentData?.Matchmaking != undefined;
    const Online = OnlineFromSession || OnlineFromHeartbeat || OnlineFromMatchmaking;
    const ActivityText = Online ? BuildActivityText(RecentData?.Map, RecentData?.HuntId) : "Offline";
    const LastSeenAt = RecentData?.LastHeartbeatAt ?? RecentData?.Matchmaking?.UpdatedTime;
    const LastSeenIso = LastSeenAt != undefined ? new Date(LastSeenAt).toISOString() : null;
    const Status = Online ? "online" : "offline";
    const Availability = Online ? "ONLINE" : "OFFLINE";

    return {
        source: OnlineFromSession ? "social-session" : OnlineFromHeartbeat ? "heartbeat" : OnlineFromMatchmaking ? "matchmaking" : "offline",
        payload: {
            id: Identity.accountId,
            accountId: Identity.accountId,
            account_id: Identity.accountId,
            epicAccountId: Identity.accountId,
            userId: Identity.accountId,
            displayName: Identity.displayName,
            name: Identity.displayName,
            username: Identity.displayName,
            preferredLanguage: Identity.preferredLanguage,
            country: Identity.country,
            linkedAccounts: Identity.linkedAccounts,
            online: Online,
            isOnline: Online,
            isPlaying: Online,
            isPlayingThisGame: Online,
            isJoinable: Online,
            bIsOnline: Online,
            bIsPlaying: Online,
            bIsPlayingThisGame: Online,
            bIsJoinable: Online,
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
            richPresenceString: ActivityText,
            rich_presence: ActivityText,
            statusText: ActivityText,
            status_text: ActivityText,
            summary: ActivityText,
            state: Status,
            statusStr: ActivityText,
            statusString: ActivityText,
            appId: "Jackal",
            app_id: "Jackal",
            productId: "Jackal",
            productName: "Dauntless",
            platform: "WIN",
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
            properties: {
                Status: ActivityText,
                status: ActivityText,
                richPresence: ActivityText,
                rich_presence: ActivityText,
                map: RecentData?.Map ?? "",
                huntId: RecentData?.HuntId ?? "",
                gameMode: RecentData?.Matchmaking?.GameMode ?? ""
            }
        }
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
