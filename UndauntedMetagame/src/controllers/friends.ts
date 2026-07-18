import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { users } from "../db/schema";
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
    return await GetDb().query.users.findFirst({where: eq(users.userId, userId)}) != undefined;
}

export async function GetAcceptedFriendsForUser(userId: string, additionalSelfIds: string[] = []) {
    const FriendIds = await GetConfiguredFriendIdsForUser(userId, additionalSelfIds);
    return Promise.all(FriendIds.map(BuildFriendPayload));
}

export async function GetFriendForUser(_userId: string, friendId: string) {
    if(!await DoesUserExist(friendId)){
        return undefined;
    }

    return BuildFriendPayload(friendId);
}

export async function BuildEpicFriendsPayload(userId: string, additionalSelfIds: string[] = []) {
    const FriendIds = await GetConfiguredFriendIdsForUser(userId, additionalSelfIds);
    return {
        friends: await Promise.all(FriendIds.map(BuildEpicFriendEntry)),
        blockList: BuildEpicBlockListPayload()
    };
}

export async function BuildLegacyArchonAccountData(userId: string, additionalSelfIds: string[] = []) {
    return JSON.stringify({
        Friends: JSON.stringify(await BuildLegacyArchonFriendsSave(userId, additionalSelfIds))
    });
}

export async function BuildLegacyArchonFriendsSave(userId: string, additionalSelfIds: string[] = []) {
    const FriendIds = await GetConfiguredFriendIdsForUser(userId, additionalSelfIds);
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

async function BuildEpicFriendEntry(accountId: string) {
    const Identity = await BuildCanonicalAccountIdentity(accountId);
    return {
        accountId: Identity.accountId,
        displayName: Identity.displayName,
        created: STABLE_FRIEND_CREATED_AT,
        favorite: false
    };
}

export async function BuildFriendPayload(accountId: string): Promise<Record<string, any>> {
    const Identity = await BuildCanonicalAccountIdentity(accountId);
    const { accountId: _presenceAccountId, displayName: _presenceDisplayName, ...PresenceFields } = await BuildPresencePayload(accountId);

    return {
        id: Identity.accountId,
        accountId: Identity.accountId,
        displayName: Identity.displayName,
        name: Identity.displayName,
        username: Identity.displayName,
        status: "ACCEPTED",
        direction: "BOTH",
        created: STABLE_FRIEND_CREATED_AT,
        ...PresenceFields
    };
}

export async function BuildPresenceResult(accountId: string) {
    const Identity = await BuildCanonicalAccountIdentity(accountId);
    const RecentData = (await GetRecentPlayerData()).find((Data) => Data.UserId === accountId);
    const LivePresence = GetSocialPresenceState(accountId);
    const OnlineFromLivePresence = LivePresence != undefined && LivePresence.status.toLowerCase() !== "offline";
    const OnlineFromSession = IsSocialUserOnline(accountId);
    const OnlineFromHeartbeat = IsFreshHeartbeat(RecentData?.LastHeartbeatAt);
    const OnlineFromMatchmaking = RecentData?.Matchmaking != undefined;
    const Online = OnlineFromLivePresence || OnlineFromSession || OnlineFromHeartbeat || OnlineFromMatchmaking;
    const ActivityText = Online ? LivePresence?.richPresence ?? BuildActivityText(RecentData?.Map, RecentData?.HuntId) : "Offline";
    const IsPlaying = LivePresence?.bIsPlaying ?? Online;
    const IsJoinable = LivePresence?.bIsJoinable ?? Online;
    const ArchonState = Online ? ARCHON_PRESENCE_ONLINE : ARCHON_PRESENCE_OFFLINE;

    return {
        source: LivePresence != undefined ? "xmpp" : OnlineFromSession ? "social-session" : OnlineFromHeartbeat ? "heartbeat" : OnlineFromMatchmaking ? "matchmaking" : "offline",
        payload: {
            accountId: Identity.accountId,
            displayName: Identity.displayName,
            IsOnline: Online,
            IsPlaying,
            IsJoinable,
            State: ArchonState,
            StatusStr: ActivityText,
            AppId: "Jackal",
            PlatformString: "WIN",
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

export async function GetSocialFriendUserIds() {
    const Rows = await GetDb().select({userId: users.userId}).from(users).orderBy(users.userId);
    return Rows.map((Row) => Row.userId);
}

export async function GetConfiguredFriendIdsForUser(userId: string | undefined, additionalSelfIds: string[] = []) {
    const SelfIds = new Set([userId, ...additionalSelfIds].filter((SelfId): SelfId is string => typeof SelfId === "string" && SelfId.length > 0));
    return (await GetSocialFriendUserIds()).filter((FriendId) => !SelfIds.has(FriendId));
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
