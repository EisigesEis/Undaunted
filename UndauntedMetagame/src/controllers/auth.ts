import jwt, {JwtPayload} from "jsonwebtoken";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { userapikeys, userapikeystoregister, userrefreshtokens } from "../db/schema";
import { logger } from "../logger";

const PRIVKEY = Buffer.from(process.env.AUTH_SIGNING_PRIVKEY_B64!, "base64").toString("utf-8");
const PUBKEY = Buffer.from(process.env.AUTH_SIGNING_PUBKEY_B64!, "base64").toString("utf-8");
const ACCESS_TOKEN_TTL_SECONDS = Number(process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS || "86400");
const REFRESH_TOKEN_TTL_SECONDS = Number(process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS || "2592000");

export type MetagameOAuthTokenResponse = {
    access_token: string,
    token_type: "bearer",
    expires_at: string,
    expires_in: number,
    refresh_token: string,
    refresh_expires_at: string,
    refresh_expires_in: number,
    account_id: string
};

export type EpicOAuthV2TokenResponse = {
    token: string,
    session_id: string,
    token_type: "bearer",
    client_id: string,
    internal_client: boolean,
    client_service: "prod-jackal",
    account_id: string,
    expires_in: number,
    expires_at: string,
    auth_method: "exchange_code",
    display_name: string,
    app: "prod-jackal",
    in_app_id: string,
    device_id: string,
    scope: string[],
    product_id: "prod-jackal",
    sandbox_id: "jackal",
    deployment_id: "53565ba467df4edbb6f5a3d939a8b4f2",
    application_id: "fghi4567rNJHv9pNoyczQXo6DDJ6RDeq",
    acr: "urn:epic:loa:aal1",
    auth_time: string
};

export function HashUserAPIKey(UserAPIKeyToHash: string){
    return crypto.createHash("sha256").update(UserAPIKeyToHash, "utf8").digest("hex");
}

function HashRefreshToken(RefreshTokenToHash: string){
    return crypto.createHash("sha256").update(RefreshTokenToHash, "utf8").digest("hex");
}

function GenerateRefreshToken(){
    return `URT_${crypto.randomBytes(32).toString("hex")}`;
}

function DateSecondsFromNow(Seconds: number){
    return new Date(Date.now() + Seconds * 1000);
}

export async function RegisterUserAPIKeyHash(userId: string, keyHash: string){
    await GetDb().insert(userapikeys).values({
        userId: userId,
        keyHash: keyHash
    });
}

export async function DrainAndRegisterUserAPIKeys(){
    const APIKeysToRegister = await GetDb().query.userapikeystoregister.findMany();

    await GetDb().delete(userapikeystoregister);

    for(const APIKey of APIKeysToRegister){
        await GetDb().insert(userapikeys).values({
            userId: APIKey.userId,
            keyHash: HashUserAPIKey(APIKey.key)
        });
    }

    logger.info(`Registered ${APIKeysToRegister.length} new User API Key(s) on boot!`);
}

export async function GetUserIDForAPIKey(UserAPIKey: string){
    const IncomingUserAPIKeyHash = HashUserAPIKey(UserAPIKey);
    const APIKeys = await GetDb().query.userapikeys.findMany({
        where: eq(userapikeys.keyHash, IncomingUserAPIKeyHash)
    });

    if(APIKeys.length === 0){
        return undefined;
    }

    if(APIKeys.length === 1){
        return APIKeys[0].userId;
    }

    const PreferredLocalUserId = process.env.LOCAL_USER_ID ?? process.env.DEFAULT_USER_ID;
    const PreferredAPIKey = APIKeys.find((APIKey) => APIKey.userId === PreferredLocalUserId);

    logger.warn(`Duplicate User API Key hash matched ${APIKeys.length} users; preferring ${PreferredAPIKey?.userId ?? APIKeys[0].userId}`);

    return PreferredAPIKey?.userId ?? APIKeys[0].userId;
}

async function IssueRefreshTokenForUid(userId: string){
    const RefreshToken = GenerateRefreshToken();
    const TokenHash = HashRefreshToken(RefreshToken);
    const IssuedAt = new Date();
    const ExpiresAt = DateSecondsFromNow(REFRESH_TOKEN_TTL_SECONDS);

    await GetDb().insert(userrefreshtokens).values({
        userId: userId,
        tokenHash: TokenHash,
        issuedAt: IssuedAt.toISOString(),
        expiresAt: ExpiresAt.toISOString()
    });

    return {
        refreshToken: RefreshToken,
        refreshTokenHash: TokenHash,
        refreshExpiresAt: ExpiresAt
    };
}

function BuildMetagameOAuthTokenResponseForUid(userId: string, RefreshToken: Awaited<ReturnType<typeof IssueRefreshTokenForUid>>): MetagameOAuthTokenResponse{
    const AccessExpiresAt = DateSecondsFromNow(ACCESS_TOKEN_TTL_SECONDS);

    return {
        access_token: SignMetagameJWTForUid(userId),
        token_type: "bearer",
        expires_at: AccessExpiresAt.toISOString(),
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: RefreshToken.refreshToken,
        refresh_expires_at: RefreshToken.refreshExpiresAt.toISOString(),
        refresh_expires_in: REFRESH_TOKEN_TTL_SECONDS,
        account_id: userId
    };
}

export async function CreateMetagameOAuthTokenResponseForUid(userId: string): Promise<MetagameOAuthTokenResponse>{
    return BuildMetagameOAuthTokenResponseForUid(userId, await IssueRefreshTokenForUid(userId));
}

export function CreateEpicOAuthV2TokenResponseForUid(userId: string, displayName: string): EpicOAuthV2TokenResponse {
    const AccessExpiresAt = DateSecondsFromNow(ACCESS_TOKEN_TTL_SECONDS);
    const IssuedAt = new Date();

    return {
        token: SignMetagameJWTForUid(userId),
        session_id: crypto.randomBytes(16).toString("hex"),
        token_type: "bearer",
        client_id: "12c4279862ab4460a25c2e9fa535fb7e",
        internal_client: false,
        client_service: "prod-jackal",
        account_id: userId,
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        expires_at: AccessExpiresAt.toISOString(),
        auth_method: "exchange_code",
        display_name: displayName,
        app: "prod-jackal",
        in_app_id: userId,
        device_id: crypto.randomBytes(16).toString("hex"),
        scope: ["basic_profile", "friends_list", "country", "openid", "presence"],
        product_id: "prod-jackal",
        sandbox_id: "jackal",
        deployment_id: "53565ba467df4edbb6f5a3d939a8b4f2",
        application_id: "fghi4567rNJHv9pNoyczQXo6DDJ6RDeq",
        acr: "urn:epic:loa:aal1",
        auth_time: IssuedAt.toISOString()
    };
}

export async function RotateRefreshToken(RefreshToken: string){
    const IncomingRefreshTokenHash = HashRefreshToken(RefreshToken);
    const ExistingRefreshToken = await GetDb().query.userrefreshtokens.findFirst({
        where: eq(userrefreshtokens.tokenHash, IncomingRefreshTokenHash)
    });

    if(ExistingRefreshToken == undefined){
        return undefined;
    }

    if(ExistingRefreshToken.revokedAt != undefined){
        return undefined;
    }

    if(new Date(ExistingRefreshToken.expiresAt).getTime() <= Date.now()){
        return undefined;
    }

    const NewRefreshToken = await IssueRefreshTokenForUid(ExistingRefreshToken.userId);

    await GetDb().update(userrefreshtokens).set({
        revokedAt: new Date().toISOString(),
        replacedByTokenHash: NewRefreshToken.refreshTokenHash
    }).where(eq(userrefreshtokens.tokenHash, IncomingRefreshTokenHash));

    return BuildMetagameOAuthTokenResponseForUid(ExistingRefreshToken.userId, NewRefreshToken);
}

export async function RevokeRefreshToken(RefreshToken: string){
    const IncomingRefreshTokenHash = HashRefreshToken(RefreshToken);

    await GetDb().update(userrefreshtokens).set({
        revokedAt: new Date().toISOString()
    }).where(eq(userrefreshtokens.tokenHash, IncomingRefreshTokenHash));
}

function SignMetagameJWTForUid(userId: string){
    return jwt.sign({
        userId: userId
    }, PRIVKEY, {
        algorithm: "RS256",
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        issuer: "undaunted-metagame",
        audience: "undaunted-metagame"
    });
}

function ValidateMetagameJWTAndGetPayload(token: string){
    return jwt.verify(token, PUBKEY, {
        algorithms: ["RS256"],
        issuer: "undaunted-metagame",
        audience: "undaunted-metagame"
    });
}

export { SignMetagameJWTForUid, ValidateMetagameJWTAndGetPayload }
