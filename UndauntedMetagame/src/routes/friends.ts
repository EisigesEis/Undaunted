import { Router } from "express";
import { BuildPresenceResult, DoesUserExist, GetAcceptedFriendsForUser, GetFriendForUser, GetSocialFriendUserIds } from "../controllers/friends";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";

export const friendsRouter = Router();

friendsRouter.get("/friends/api/public/friends/:accountId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountId = AuthorizedOwnerAccountId(req, res);
    if (AccountId == undefined) {
        return;
    }

    await SendFriendsList(req, res, AccountId, "public");
});

friendsRouter.get("/friends/api/v1/:accountId/friends", HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountId = AuthorizedOwnerAccountId(req, res);
    if (AccountId == undefined) {
        return;
    }

    await SendFriendsList(req, res, AccountId, "v1");
});

friendsRouter.get("/friends/api/v1/:accountId/summary", HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountId = AuthorizedOwnerAccountId(req, res);
    if (AccountId == undefined) {
        return;
    }

    const Friends = await GetAcceptedFriendsForUser(AccountId);
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
    if (AuthorizedOwnerAccountId(req, res) == undefined) {
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

friendsRouter.post("/slayerlink/availability", HasUndauntedMetagameAuth, async (req: any, res) => {
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

async function SendKnownFriendResponse(accountId: string, friendId: string, res: any) {
    if (!await DoesUserExist(friendId)) {
        res.status(404).json({ error: "unknown_friend" });
        return;
    }

    const Friend = await GetFriendForUser(accountId, friendId);
    res.json(Friend);
}

async function SendFriendsList(req: any, res: any, accountId: string, endpoint: string) {
    const Friends = await GetAcceptedFriendsForUser(accountId);
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
