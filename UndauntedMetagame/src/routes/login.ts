import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { GetDb } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import { GetDisplayUsernameForUserId, GetUsernameForUserId } from "../controllers/login";
import { BuildCanonicalAccountIdentity } from "../controllers/accountProfile";
import { BuildLegacyArchonAccountData, BuildLegacyArchonFriendsSave } from "../controllers/friends";
import { ClearPlayerPartyForFreshLogin } from "../controllers/party";
import { CancelNonReadyMatchmakingForFreshLogin } from "../controllers/matchmaking";
import { GetUserIDForAPIKey, SignMetagameJWTForUid } from "../controllers/auth";

export const loginRouter = Router();

loginRouter.get("/features/platform/:platform", (req, res) => {
    logger.info("Features");

    res.send({
        "code" : null,
        "message" : "OK",
        "payload" : {
           "crossplay" : true,
           "crossprogression" : true
        }
    });
});

loginRouter.get("/account/link/epic/:AccId", (req, res) => {
    logger.info("Account Linking");

    res.json({
        "code" : null,
        "message" : "OK",
        "payload" : {
           "isLinked" : true
        }
    });
});

// The game exchanges the launcher API key for its session token here.
loginRouter.post("/game/login", async (req, res) => {
    const Password = req.body?.password;
    if(typeof Password !== "string" || Password.length === 0){
        logger.warn("Phoenix bootstrap login request had no API key");
        res.status(400).json({ error: "invalid_credentials" });
        return;
    }

    const UserId = await GetUserIDForAPIKey(Password);
    if(UserId == undefined){
        logger.warn("Phoenix bootstrap login request had an invalid API key");
        res.status(401).json({ error: "invalid_credentials" });
        return;
    }

    const DisplayName = await GetDisplayUsernameForUserId(UserId);
    res.json({
        displayName: DisplayName,
        accountId: UserId,
        token: SignMetagameJWTForUid(UserId)
    });
});

loginRouter.post("/login", HasUndauntedMetagameAuth, async (req: any, res) => {
    if(req.AuthData.userId !== req.body.email){
        res.status(400);
        res.send();

        logger.error(`UserID from Undaunted Auth ${req.AuthData.userId} didn't match UserID from token ${req.AuthData.email}`);

        return;
    }

    let UserRecord = await GetDb().query.users.findFirst({where: eq(users.userId, req.AuthData.userId)});

    if(UserRecord == undefined){
        res.status(400);
        res.send();

        logger.error(`UserID from Undaunted Auth ${req.AuthData.userId} had no database entry!`);

        return;
    }

    const PartyCleanup = ClearPlayerPartyForFreshLogin(req.AuthData.userId);
    const MatchmakingCleanup = await CancelNonReadyMatchmakingForFreshLogin(req.AuthData.userId);

    const CleanupLog = {
        userId: req.AuthData.userId,
        removedFromParty: PartyCleanup.removedFromParty,
        partyId: PartyCleanup.partyId,
        cancelledMatchmaking: MatchmakingCleanup.cancelled,
        candidateId: MatchmakingCleanup.candidateId,
        matchmakingPhase: MatchmakingCleanup.phase
    };
    if(PartyCleanup.removedFromParty || MatchmakingCleanup.cancelled){
        logger.info(CleanupLog, "Player login session cleanup");
    }
    else{
        logger.debug(CleanupLog, "Player login session cleanup");
    }

    res.json({
        "error_code": "TicketRateOk",
        "message": "",
        "state": "OPEN",
        "timeout": 8000,
        "title": ""
    });
});

loginRouter.get("/accountinfo", HasUndauntedMetagameAuth, async (req: any, res) => {
    logger.info("Account info")

    const Username = await GetUsernameForUserId(req.AuthData.userId);
    const LegacyData = await BuildLegacyArchonAccountData(req.AuthData.userId);

    res.json({
        "accountId" : req.AuthData.userId,
        "creationDate" : "2000-01-01 00:00:00",
        "createdDate" : "2000-01-01",
        "data": LegacyData,
        "email" : null,
        "id": req.AuthData.userId,
        "name": Username,
        "preferredLanguage" : null,
        "updateVersion": 0,
        "username" : Username,
        "verified" : true
    });
});

loginRouter.get("/tags", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info("Tags")

    res.json({
        "accountId" : req.AuthData.userId,
        "tags": []
    });
});

loginRouter.put("/gamesession/epic", HasUndauntedMetagameAuth, (req: any, res) => {
    const AuthHeader = req.headers.authorization;

    const Token = AuthHeader.slice("bearer ".length);

    // We reuse the launcher token for the game session.

    res.json({
        "code": null,
        "message": "OK",
        "payload": {
            "error_code": null,
            "sessionid": `undaunted-${req.AuthData.userId}`,
            "sessionToken": Token 
        }
    })
});

loginRouter.post("/accountinfo/public", HasUndauntedMetagameAuth, async (req: any, res) => {
    const AccountIdToLookupFromRequest = req.body.accountId;

    const Identity = await BuildCanonicalAccountIdentity(AccountIdToLookupFromRequest);
    const AuthUserId = typeof req.AuthData?.userId === "string" ? req.AuthData.userId : undefined;
    const AdditionalSelfIds = AuthUserId != undefined && AuthUserId !== Identity.accountId ? [AuthUserId] : [];
    const LegacyData = await BuildLegacyArchonAccountData(Identity.accountId, AdditionalSelfIds);
    const FriendsSave = await BuildLegacyArchonFriendsSave(Identity.accountId, AdditionalSelfIds);

    // Account names are public on this server.

    res.status(200);
    res.json({
        accountId: Identity.accountId,
        catalogDaoId: null,
        createdDate: "2000-01-01",
        data: LegacyData,
        Friends: FriendsSave,
        id: Identity.accountId,
        displayName: Identity.displayName,
        isSubscribed: true,
        language: Identity.preferredLanguage,
        lastModifiedDate: "2000-01-01",
        linkedAccounts: [
            ...Identity.linkedAccounts.map((Account) => ({
                accountId: Account.accountId,
                accountType: Account.identityProviderId,
                displayName: Account.displayName
            })),
            {
                accountId: Identity.accountId,
                accountType: "phoenix",
                displayName: Identity.displayName
            }
        ],
        name: Identity.displayName,
        updateVersion: 0,
        username: Identity.displayName
    });
});

loginRouter.post("/account/mapping", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestedIds: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const SourceAccountType = typeof req.body?.srcAccountType === "string" ? req.body.srcAccountType : "epic";
    const TargetAccountType = SourceAccountType.toLowerCase() === "phoenix" ? "epic" : "phoenix";

    const Entries = await Promise.all(RequestedIds
        .filter((AccountId): AccountId is string => typeof AccountId === "string" && AccountId.length > 0)
        .map(async (AccountId) => {
            const Identity = await BuildCanonicalAccountIdentity(AccountId);
            return [
                AccountId,
                {
                    accountId: Identity.accountId,
                    accountType: TargetAccountType,
                    displayName: Identity.displayName,
                    username: Identity.displayName,
                    externalAuthType: TargetAccountType,
                    externalDisplayName: Identity.displayName
                }
            ] as const;
        }));
    const AccountMappings = Object.fromEntries(Entries);

    logger.info(`Account mapping ${SourceAccountType} -> ${TargetAccountType} for ${Object.keys(AccountMappings).length} account(s)`);

    res.status(200);
    res.json({
        accountMappings: AccountMappings,
        sourceAccountType: SourceAccountType
    });
});
