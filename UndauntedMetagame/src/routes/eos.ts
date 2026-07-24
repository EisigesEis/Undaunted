import { Router } from "express";
import { logger } from "../logger";
import { CreateMetagameOAuthTokenResponseForUid, GetUserIDForAPIKey, RevokeRefreshToken, RotateRefreshToken, ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { GetUsernameForUserId } from "../controllers/login";

export const eosRouter = Router();

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

eosRouter.get("/account/api/public/account/:AccId", (req, res) => {
    logger.info("EOS Account Info (stubbed)");

    res.json({});
});

eosRouter.get("/account/api/public/account/:AccId/externalAuths", (req, res) => {
    logger.info("External Auths (stubbed)");

    res.json({});
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

eosRouter.get("/account/api/public/account", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const Username = await GetUsernameForUserId(UserId);

    logger.info(`Account info for userId ${UserId}`);

    res.json({
        "id": UserId,
        "displayName": Username,
        "name": "",
        "lastName": "",
        "email": "",
        "failedLoginAttempts": 0,
        "lastLogin": new Date().toISOString(),
        "numberOfDisplayNameChanges": 0,
        "ageGroup": "ADULT",
        "headless": false,
        "country": "US",
        "lastNameChange": new Date().toISOString(),
        "preferredLanguage": "en",
        "canUpdateDisplayName": false,
        "tfaEnabled": false,
        "emailVerified": true,
        "minorVerified": false,
        "minorStatus": "NOT_MINOR"
    });
});
