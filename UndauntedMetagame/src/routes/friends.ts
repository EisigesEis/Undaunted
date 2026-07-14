import { Router } from "express";
import { BuildEpicBlockListPayload, BuildEpicFriendsPayload, BuildPresenceResult, DoesUserExist, GetAcceptedFriendsForUser, GetFriendForUser, GetSocialFriendUserIds } from "../controllers/friends";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import { UpdateSocialPresenceState } from "../controllers/social";

export const friendsRouter = Router();

friendsRouter.get("/epic/friends/v1/:accountId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountId = AuthorizedAuthenticatedAccountId(req);
    if (AccountId == undefined) {
        res.status(400).json({ error: "missing_account_id" });
        return;
    }

    const AuthUserId = typeof req.AuthData?.userId === "string" ? req.AuthData.userId : undefined;
    const Payload = await BuildEpicFriendsPayload(AccountId, AuthUserId != undefined && AuthUserId !== AccountId ? [AuthUserId] : []);
    logger.info({
        endpoint: "epic.friends",
        authUserId: req.AuthData?.userId,
        pathUserId: AccountId,
        allowlist: GetSocialFriendUserIds(),
        friends: Payload.friends.map((Friend) => Friend.accountId),
        responseCount: Payload.friends.length
    }, "Epic friends response");

    res.json(Payload);
});

friendsRouter.get("/epic/friends/v1/:accountId/blocklist", HasUndauntedMetagameAuth, (req: any, res) => {
    const AccountId = AuthorizedAuthenticatedAccountId(req);
    if (AccountId == undefined) {
        res.status(400).json({ error: "missing_account_id" });
        return;
    }

    const BlockList = BuildEpicBlockListPayload();
    logger.info({
        endpoint: "epic.friends.blocklist",
        authUserId: req.AuthData?.userId,
        pathUserId: AccountId,
        responseCount: BlockList.length
    }, "Epic friends blocklist response");

    res.json(BlockList);
});

friendsRouter.patch("/epic/presence/v1/:namespace/:accountId/presence/:connectionId", HasUndauntedMetagameAuth, (req: any, res) => {
    const AccountId = AuthorizedAuthenticatedAccountId(req);
    if (AccountId == undefined) {
        res.status(400).json({ error: "missing_account_id" });
        return;
    }

    const ActivityValue = typeof req.body?.activity?.value === "string" ? req.body.activity.value : "";
    const Status = typeof req.body?.status === "string" ? req.body.status : "online";
    const Props = IsRecord(req.body?.props) ? req.body.props : {};
    const ConnProps = IsRecord(req.body?.conn?.props) ? req.body.conn.props : {};

    UpdateSocialPresenceState(AccountId, {
        status: ActivityValue || Status,
        richPresence: ActivityValue || Status,
        properties: Props,
        bIsPlaying: Status === "online",
        bIsJoinable: Status === "online",
        bHasVoiceSupport: false,
        sessionId: typeof Props.EOS_Session === "string" ? Props.EOS_Session : ""
    });

    logger.info({
        endpoint: "epic.presence.patch",
        authUserId: req.AuthData?.userId,
        pathUserId: AccountId,
        namespace: req.params.namespace,
        connectionId: req.params.connectionId,
        status: Status,
        activity: ActivityValue
    }, "Epic presence update response");

    res.json({
        own: {
            accountId: AccountId,
            status: Status,
            perNs: [
                {
                    productId: "prod-jackal",
                    appId: "fghi4567rNJHv9pNoyczQXo6DDJ6RDeq",
                    status: Status,
                    activity: {
                        value: ActivityValue
                    },
                    ns: req.params.namespace,
                    props: Props,
                    conns: [
                        {
                            id: req.params.connectionId,
                            props: ConnProps
                        }
                    ]
                }
            ]
        }
    });
});

friendsRouter.get("/friends/api/public/friends/:accountId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountId = AuthorizedFriendsReadAccountId(req);
    if (AccountId == undefined) {
        res.status(400).json({ error: "missing_account_id" });
        return;
    }

    await SendFriendsList(req, res, AccountId, "public");
});

friendsRouter.get("/friends/api/v1/:accountId/friends", HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountId = AuthorizedFriendsReadAccountId(req);
    if (AccountId == undefined) {
        res.status(400).json({ error: "missing_account_id" });
        return;
    }

    await SendFriendsList(req, res, AccountId, "v1");
});

friendsRouter.get("/friends/api/v1/:accountId/summary", HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountId = AuthorizedFriendsReadAccountId(req);
    if (AccountId == undefined) {
        res.status(400).json({ error: "missing_account_id" });
        return;
    }

    const Friends = await GetAcceptedFriendsForRequest(req, AccountId);
    logger.info({
        endpoint: "friends.summary",
        authUserId: req.AuthData?.userId,
        pathUserId: AccountId,
        allowlist: GetSocialFriendUserIds(),
        responseCount: Friends.length
    }, "Friends summary response");

    res.json({
        friends: Friends,
        incoming: [],
        outgoing: [],
        suggested: [],
        blocklist: [],
        settings: {
            acceptInvites: "public",
            mutualPrivacy: "public"
        }
    });
});

friendsRouter.get([
    "/friends/api/public/blocklist/:accountId",
    "/friends/api/public/blocks/:accountId",
    "/friends/api/public/incoming/:accountId",
    "/friends/api/public/outgoing/:accountId",
    "/friends/api/public/recent/players/:accountId",
    "/friends/api/v1/:accountId/blocklist",
    "/friends/api/v1/:accountId/blocks",
    "/friends/api/v1/:accountId/incoming",
    "/friends/api/v1/:accountId/outgoing",
    "/friends/api/v1/:accountId/suggested",
    "/friends/api/v1/:accountId/recent/players"
], HasUndauntedMetagameAuth, (req: any, res) => {
    if (AuthorizedFriendsReadAccountId(req) == undefined) {
        res.status(400).json({ error: "missing_account_id" });
        return;
    }

    res.json([]);
});

friendsRouter.get("/present/:accountId", HasUndauntedMetagameAuth, async (req: any, res) => {
    await SendPresence(req, res, req.params.accountId, "presence.present");
});

friendsRouter.get([
    "/presence/api/v1/_/:accountId/status",
    "/presence/api/v1/:namespace/:accountId/status",
    "/presence/api/public/account/:accountId",
    "/presence/api/public/accounts/:accountId",
    "/presence/api/public/account/:accountId/status",
    "/presence/api/public/accounts/:accountId/status"
], HasUndauntedMetagameAuth, async (req: any, res) => {
    await SendPresence(req, res, req.params.accountId, "presence.mcp");
});

friendsRouter.post([
    "/presence/api/v1/_/status",
    "/presence/api/v1/:namespace/status",
    "/presence/api/public/account/status",
    "/presence/api/public/accounts/status",
    "/presence/api/public/account/:accountId/status"
], HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestedAccountIds = ExtractPresenceAccountIds(req);
    if (RequestedAccountIds.length > 1) {
        const PresenceEntries = await Promise.all(RequestedAccountIds.map(async (AccountId) => {
            const Presence = await BuildPresenceResult(AccountId);
            return [AccountId, Presence.payload] as const;
        }));

        logger.info({
            endpoint: "presence.batch",
            authUserId: req.AuthData?.userId,
            requestedUserIds: RequestedAccountIds,
            onlineStates: PresenceEntries.map(([AccountId, Presence]) => ({
                accountId: AccountId,
                online: Presence.online,
                presenceStatus: Presence.presenceStatus
            }))
        }, "Presence batch response");

        res.json({
            accounts: Object.fromEntries(PresenceEntries),
            presence: PresenceEntries.map(([, Presence]) => Presence)
        });
        return;
    }

    const AccountId = RequestedAccountIds[0] ?? req.AuthData?.userId;
    await SendPresence(req, res, AccountId, "presence.post");
});

async function SendPresence(req: any, res: any, accountId: string, endpoint: string) {
    const Presence = await BuildPresenceResult(accountId);
    logger.info({
        endpoint,
        authUserId: req.AuthData?.userId,
        requestedUserId: accountId,
        source: Presence.source,
        online: Presence.payload.online
    }, "Presence response");

    res.json(Presence.payload);
}

function ExtractPresenceAccountIds(req: any) {
    const BodyIds = req.body?.accountIds ?? req.body?.account_ids ?? req.body?.accounts ?? req.body?.ids;
    if (Array.isArray(BodyIds)) {
        return BodyIds.filter((AccountId: unknown): AccountId is string => typeof AccountId === "string" && AccountId.length > 0);
    }

    const BodyId = req.body?.accountId ?? req.body?.account_id;
    if (typeof BodyId === "string" && BodyId.length > 0) {
        return [BodyId];
    }

    if (typeof req.params.accountId === "string" && req.params.accountId.length > 0) {
        return [req.params.accountId];
    }

    return [];
}

function IsRecord(value: unknown): value is Record<string, any> {
    return value != undefined && typeof value === "object" && !Array.isArray(value);
}

friendsRouter.get("/slayerlink/status_good", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info({
        endpoint: "slayerlink.status_good",
        authUserId: req.AuthData?.userId
    }, "Slayer Link status compatibility response");

    res.json({
        code: null,
        message: "OK",
        payload: {
            invites: [],
            links: [],
            config: {
                link_duration_hours: 168,
                invite_expiry_hours: 48
            }
        }
    });
});

friendsRouter.post("/slayerlink/availability", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestedAccountIds: string[] = Array.isArray(req.body?.account_ids)
        ? req.body.account_ids.filter((AccountId: unknown): AccountId is string => typeof AccountId === "string" && AccountId.length > 0)
        : [];
    const Availability = RequestedAccountIds.map((AccountId) => ({
        account_id: AccountId,
        available: false
    }));

    logger.info({
        endpoint: "slayerlink.availability",
        authUserId: req.AuthData?.userId,
        requestedAccountIds: RequestedAccountIds,
        availability: Availability
    }, "Slayer Link availability compatibility response");

    res.json({
        code: null,
        message: "OK",
        payload: {
            availability: Availability
        }
    });
});

friendsRouter.post([
    "/friends/api/v1/:accountId/friends/:friendId",
    "/friends/api/v1/:accountId/friends/:friendId/accept",
    "/friends/api/public/friends/:accountId/:friendId"
], HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountId = AuthorizedOwnerAccountId(req, res);
    if (AccountId == undefined) {
        return;
    }

    await SendKnownFriendResponse(AccountId, req.params.friendId, res);
});

friendsRouter.put([
    "/friends/api/v1/:accountId/friends/:friendId",
    "/friends/api/public/friends/:accountId/:friendId"
], HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountId = AuthorizedOwnerAccountId(req, res);
    if (AccountId == undefined) {
        return;
    }

    await SendKnownFriendResponse(AccountId, req.params.friendId, res);
});

friendsRouter.delete([
    "/friends/api/v1/:accountId/friends/:friendId",
    "/friends/api/v1/:accountId/friends/:friendId/reject",
    "/friends/api/public/friends/:accountId/:friendId"
], HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountId = AuthorizedOwnerAccountId(req, res);
    if (AccountId == undefined) {
        return;
    }

    if (!await DoesUserExist(req.params.friendId)) {
        res.status(404).json({ error: "unknown_friend" });
        return;
    }

    res.status(204).send();
});

function AuthorizedOwnerAccountId(req: any, res: any) {
    const AccountId = req.params.accountId;
    if (req.AuthData?.IsGameserver === true) {
        return AccountId;
    }

    if (req.AuthData?.userId !== AccountId) {
        logger.warn(`Rejected non-owner friends access from ${req.AuthData?.userId ?? "unknown"} to ${AccountId}`);
        res.status(403).send();
        return undefined;
    }

    return AccountId;
}

function AuthorizedAuthenticatedAccountId(req: any) {
    const AccountId = req.params.accountId;
    const AuthUserId = req.AuthData?.userId;

    if (AuthUserId != undefined && AuthUserId !== AccountId && req.AuthData?.IsGameserver !== true) {
        logger.info({
            authUserId: AuthUserId,
            pathUserId: AccountId
        }, "Allowing authenticated social access with differing route account ID");
    }

    return typeof AccountId === "string" && AccountId.length > 0 ? AccountId : undefined;
}

function AuthorizedFriendsReadAccountId(req: any) {
    const AccountId = AuthorizedAuthenticatedAccountId(req);
    if (AccountId == undefined) {
        return undefined;
    }

    if (req.AuthData?.userId !== AccountId && req.AuthData?.IsGameserver !== true) {
        logger.info({
            authUserId: req.AuthData?.userId,
            pathUserId: AccountId
        }, "Allowing authenticated legacy friends read with differing route account ID");
    }

    return AccountId;
}

async function SendKnownFriendResponse(accountId: string, friendId: string, res: any) {
    if (!await DoesUserExist(friendId)) {
        res.status(404).json({ error: "unknown_friend" });
        return;
    }

    const Friend = await GetFriendForUser(accountId, friendId);
    res.json(Friend);
}

async function SendFriendsList(req: any, res: any, accountId: string, endpoint: string) {
    const Friends = await GetAcceptedFriendsForRequest(req, accountId);
    logger.info({
        endpoint: `friends.${endpoint}`,
        authUserId: req.AuthData?.userId,
        pathUserId: accountId,
        candidateCount: GetSocialFriendUserIds().length,
        filteredIds: Friends.map((Friend) => Friend.accountId),
        onlineStates: Friends.map((Friend) => ({
            accountId: Friend.accountId,
            online: Friend.online,
            presenceStatus: Friend.presenceStatus,
            presence: Friend.presence
        })),
        responseCount: Friends.length
    }, "Friends list response");

    res.json(Friends);
}

function GetAcceptedFriendsForRequest(req: any, accountId: string) {
    const AuthUserId = typeof req.AuthData?.userId === "string" ? req.AuthData.userId : undefined;
    return GetAcceptedFriendsForUser(accountId, AuthUserId != undefined && AuthUserId !== accountId ? [AuthUserId] : []);
}
