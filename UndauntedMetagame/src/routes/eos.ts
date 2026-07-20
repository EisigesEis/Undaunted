import { Router } from "express";
import { logger } from "../logger";
import { CreateEpicOAuthV2TokenResponseForUid, CreateMetagameOAuthTokenResponseForUid, GetUserIDForAPIKey, RevokeRefreshToken, RotateRefreshToken, ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { BuildExternalAuths, BuildPublicAccountPayload, BuildSdkAccountPayload, DoesCanonicalAccountExist, FindCanonicalAccountIdByDisplayName, GetCanonicalDisplayNameForAccountId } from "../controllers/accountProfile";

export const eosRouter = Router();

eosRouter.get("/epic/oauth/v2/exchange", async (req, res) => {
    const UserId = await ResolveOAuthUserId(req.query.exchange_code ?? req.query.code ?? req.query.user_id);
    if (UserId == undefined) {
        logger.warn({
            query: req.query
        }, "Epic OAuth exchange request could not resolve user");
        res.status(400).json({ error: "invalid_exchange_code" });
        return;
    }

    logger.info({
        userId: UserId,
        consumingClientId: req.query.consumingClientId
    }, "Epic OAuth exchange response");

    res.json({
        code: UserId
    });
});

eosRouter.post("/epic/oauth/v2/token", async (req, res) => {
    const UserId = await ResolveOAuthUserId(req.body?.exchange_code ?? req.body?.code ?? req.body?.refresh_token);
    if (UserId == undefined) {
        logger.warn({
            grantType: req.body?.grant_type
        }, "Epic OAuth v2 token request could not resolve user");
        res.status(400).json({ error: "invalid_grant" });
        return;
    }

    const DisplayName = await GetCanonicalDisplayNameForAccountId(UserId);
    const TokenResponse = CreateEpicOAuthV2TokenResponseForUid(UserId, DisplayName);

    logger.info({
        userId: UserId,
        displayName: DisplayName,
        grantType: req.body?.grant_type
    }, "Epic OAuth v2 token response");

    res.json(TokenResponse);
});

eosRouter.post("/account/api/oauth/token", async (req, res) => {
    if(req.body.grant_type === "refresh_token"){
        const RefreshToken = req.body.refresh_token;

        if(typeof RefreshToken !== "string" || RefreshToken.length === 0){
            res.status(400);
            res.json({
                error: "invalid_refresh_token"
            });
            return;
        }

        const TokenResponse = await RotateRefreshToken(RefreshToken);

        if(TokenResponse == undefined){
            res.status(400);
            res.json({
                error: "invalid_refresh_token"
            });
            return;
        }

        res.json({
            ...TokenResponse,
            "features": ["Achievements", "AntiCheat", "Ecom", "Voice"],
            "organization_id": "o-krlzxj88qrtb69fredeuaf887bl5az",
            "product_id": "prod-jackal",
            "sandbox_id": "jackal",
            "deployment_id": "53565ba467df4edbb6f5a3d939a8b4f2",
            "account_id": TokenResponse.account_id
        });

        return;
    }

    if(process.env.AUTH_MODE === "NONE" && process.env.NODE_ENV !== "production"){
        const UserId = req.body.exchange_code;

        logger.info(`Logging in ${UserId}!`);

        const TokenResponse = await CreateMetagameOAuthTokenResponseForUid(UserId);

        res.json({
            ...TokenResponse,
            "features": ["Achievements", "AntiCheat", "Ecom", "Voice"],
            "organization_id": "o-krlzxj88qrtb69fredeuaf887bl5az",
            "product_id": "prod-jackal",
            "sandbox_id": "jackal",
            "deployment_id": "53565ba467df4edbb6f5a3d939a8b4f2",
            "account_id": UserId
        });
    }
    else if(process.env.AUTH_MODE === "APIKEY"){
        const ApiKey = req.body.exchange_code;

        const UserId = await GetUserIDForAPIKey(ApiKey);

        if(UserId != undefined){
            logger.info(`Logging in ${UserId}!`);

            const TokenResponse = await CreateMetagameOAuthTokenResponseForUid(UserId);

            res.json({
                ...TokenResponse,
                "features": ["Achievements", "AntiCheat", "Ecom", "Voice"],
                "organization_id": "o-krlzxj88qrtb69fredeuaf887bl5az",
                "product_id": "prod-jackal",
                "sandbox_id": "jackal",
                "deployment_id": "53565ba467df4edbb6f5a3d939a8b4f2",
                "account_id": UserId
            });
        }
        else{
            logger.error(`Invalid API key auth!`);

            res.status(400);
            res.send();
        }
    }
    else{
        logger.fatal("No login method configured!");
    }
});

async function ResolveOAuthUserId(value: unknown) {
    if (typeof value === "string" && value.length > 0) {
        const UserIdFromApiKey = await GetUserIDForAPIKey(value);
        if(UserIdFromApiKey != undefined){
            return UserIdFromApiKey;
        }

        const IsDevBypassEnabled = process.env.AUTH_MODE === "NONE" && process.env.NODE_ENV !== "production";
        if(IsDevBypassEnabled){
            return value;
        }
    }

    return undefined;
}

eosRouter.get("/account/api/oauth/verify", (req, res) => {
    logger.info("Verifying token");

    const AuthHeader = req.headers.authorization;

    if(AuthHeader == undefined || !AuthHeader.toLowerCase().startsWith("bearer ")){
        res.status(401);
        res.send();
        return;
    }

    try{
        const Payload = ValidateMetagameJWTAndGetPayload(AuthHeader.slice("bearer ".length)) as any;
        const ExpiresAt = new Date(Payload.exp * 1000);
        const ExpiresIn = Math.max(0, Math.floor((ExpiresAt.getTime() - Date.now()) / 1000));

        res.json({
          "active": true,
          "scope": "basic_profile friends_list presence",
          "token_type": "bearer",
          "expires_in": ExpiresIn,
          "expires_at": ExpiresAt.toISOString(),
          "account_id": Payload.userId,
          "client_id": "xyza7891lhxMVYGCON7LgnKZZ8HQGD5H",
          "application_id": "fghi4567O03HROxEjwbn7kgXpBhnhWwv"
        });
    }
    catch{
        res.status(401);
        res.send();
    }
});

eosRouter.get("/account/api/public/account/displayName/:DisplayName", async (req, res) => {
    const RawDisplayName = req.params.DisplayName;
    let DisplayName: string;
    try {
        DisplayName = decodeURIComponent(RawDisplayName);
    }
    catch {
        res.status(400).json({ errorCode: "errors.com.epicgames.account.invalid_display_name" });
        return;
    }

    const AccountId = await FindCanonicalAccountIdByDisplayName(DisplayName);
    logger.info({ rawDisplayName: RawDisplayName, displayName: DisplayName, accountId: AccountId }, "EOS account display-name lookup");
    if (AccountId == undefined) {
        res.status(404).json({ errorCode: "errors.com.epicgames.account.account_not_found" });
        return;
    }

    res.json(await BuildPublicAccountPayload(AccountId));
});

eosRouter.get("/account/api/public/account/:AccId", async (req, res) => {
    const AccountId = req.params.AccId;

    logger.info(`EOS Account Info for ${AccountId}`);

    if (!await DoesCanonicalAccountExist(AccountId)) {
        res.status(404).json({ errorCode: "errors.com.epicgames.account.account_not_found" });
        return;
    }

    res.json(await BuildPublicAccountPayload(AccountId));
});

eosRouter.get("/account/api/public/account/:AccId/externalAuths", async (req, res) => {
    const AccountId = req.params.AccId;
    if (!await DoesCanonicalAccountExist(AccountId)) {
        res.status(404).json({ errorCode: "errors.com.epicgames.account.account_not_found" });
        return;
    }
    const DisplayName = await GetCanonicalDisplayNameForAccountId(AccountId);

    logger.info({
        accountId: AccountId,
        displayName: DisplayName
    }, "EOS external auths");

    res.json(BuildExternalAuths(AccountId, DisplayName));
});

eosRouter.get("/epic/id/v2/sdk/accounts", async (req, res) => {
    const AccountIds = Array.isArray(req.query.accountId)
        ? req.query.accountId
        : req.query.accountId != undefined
            ? [req.query.accountId]
            : [];

    logger.info(`EOS SDK account lookup for ${AccountIds.length} account(s)`);

    const ExistingAccountIds = (await Promise.all(AccountIds
        .filter((AccountId): AccountId is string => typeof AccountId === "string" && AccountId.length > 0)
        .map(async (AccountId) => await DoesCanonicalAccountExist(AccountId) ? AccountId : undefined)))
        .filter((AccountId): AccountId is string => AccountId != undefined);
    const Accounts = await Promise.all(ExistingAccountIds
        .map((AccountId) => BuildSdkAccountPayload(AccountId)));

    res.json(Accounts);
});

eosRouter.delete("/account/api/oauth/sessions/kill", async (req, res) => {
    logger.info("Session kill (stubbed)");

    if(typeof req.body?.refresh_token === "string"){
        await RevokeRefreshToken(req.body.refresh_token);
    }

    res.json({});
})

eosRouter.delete("/account/api/oauth/sessions/kill/:AuthToken", async (req, res) => {
    logger.info("Session kill (stubbed)");

    await RevokeRefreshToken(req.params.AuthToken);

    res.json({});
})

eosRouter.get("/account/api/public/account", async (req: any, res) => {
    const AccountIds = ExtractAccountIds(req.query.accountId);

    if (AccountIds.length > 0) {
        const ExistingAccountIds = (await Promise.all(AccountIds.map(async (AccountId) =>
            await DoesCanonicalAccountExist(AccountId) ? AccountId : undefined
        ))).filter((AccountId): AccountId is string => AccountId != undefined);
        const Accounts = await Promise.all(ExistingAccountIds.map((AccountId) => BuildPublicAccountPayload(AccountId)));
        logger.info({ requestedAccountIds: AccountIds, resolvedAccountIds: ExistingAccountIds }, "EOS public bulk account lookup");
        res.json(Accounts);
        return;
    }

    const UserId = GetUserIdFromBearer(req.headers.authorization);
    if (UserId == undefined) {
        res.status(400).json({ error: "missing_account_id" });
        return;
    }

    logger.info(`Account info for userId ${UserId}`);

    res.json(await BuildPublicAccountPayload(UserId));
});

function ExtractAccountIds(accountIdQuery: unknown) {
    if (Array.isArray(accountIdQuery)) {
        return accountIdQuery.filter((AccountId): AccountId is string => typeof AccountId === "string" && AccountId.length > 0);
    }

    if (typeof accountIdQuery === "string" && accountIdQuery.length > 0) {
        return [accountIdQuery];
    }

    return [];
}

function GetUserIdFromBearer(authHeader: unknown) {
    if (typeof authHeader !== "string" || !authHeader.toLowerCase().startsWith("bearer ")) {
        return undefined;
    }

    try {
        const Payload = ValidateMetagameJWTAndGetPayload(authHeader.slice("bearer ".length)) as any;
        return typeof Payload.userId === "string" ? Payload.userId : undefined;
    }
    catch {
        return undefined;
    }
}
