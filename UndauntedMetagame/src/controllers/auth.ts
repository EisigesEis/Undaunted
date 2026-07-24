import jwt, {JwtPayload} from "jsonwebtoken";
import crypto from "crypto";
import { and, eq, isNotNull, lt, or } from "drizzle-orm";
import { GetDb } from "../db";
import { userapikeys, userapikeystoregister, userrefreshtokens } from "../db/schema";
import { logger } from "../logger";

const PRIVKEY = Buffer.from(process.env.AUTH_SIGNING_PRIVKEY_B64!, "base64").toString("utf-8");
const PUBKEY = Buffer.from(process.env.AUTH_SIGNING_PUBKEY_B64!, "base64").toString("utf-8");
const ACCESS_TOKEN_TTL_SECONDS = Number(process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS || "86400");
const REFRESH_TOKEN_TTL_SECONDS = Number(process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS || "2592000");
const REFRESH_TOKEN_RETENTION_SECONDS = Number(process.env.AUTH_REFRESH_TOKEN_RETENTION_SECONDS || "86400");
const KEY_LOOKUP = process.env.KEY_LOOKUP || "CONST";
const REFRESH_TOKEN_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

type CachedUserAPIKey = {
    userId: string,
    keyHash: Buffer
};

let UserAPIKeyCache: CachedUserAPIKey[] | undefined;
let LastRefreshTokenCleanupAt = 0;

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

export function HashUserAPIKey(UserAPIKeyToHash: string){
    return crypto.createHash("sha256").update(UserAPIKeyToHash, "utf8").digest("hex");
}

async function RefreshUserAPIKeyCache(){
    const APIKeys = await GetDb().query.userapikeys.findMany();
    UserAPIKeyCache = APIKeys.map((APIKey) => ({
        userId: APIKey.userId,
        keyHash: Buffer.from(APIKey.keyHash, "hex")
    })).filter((APIKey) => APIKey.keyHash.length === 32);
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

    if(UserAPIKeyCache != undefined){
        await RefreshUserAPIKeyCache();
    }
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

    await RefreshUserAPIKeyCache();
    logger.info(`Registered ${APIKeysToRegister.length} new User API Key(s) on boot!`);
}

function SelectDuplicateAPIKeyMatch(UserIds: string[]){
    if(UserIds.length === 0){
        return undefined;
    }

    if(UserIds.length === 1){
        return UserIds[0];
    }

    const PreferredLocalUserId = process.env.LOCAL_USER_ID ?? process.env.DEFAULT_USER_ID;
    const PreferredUserId = UserIds.find((UserId) => UserId === PreferredLocalUserId);

    logger.warn(`Duplicate User API Key hash matched ${UserIds.length} users; preferring ${PreferredUserId ?? UserIds[0]}`);
    return PreferredUserId ?? UserIds[0];
}

async function GetUserIDForAPIKeyFromDatabase(IncomingUserAPIKeyHash: string){
    const APIKeys = await GetDb().query.userapikeys.findMany({
        where: eq(userapikeys.keyHash, IncomingUserAPIKeyHash)
    });

    return SelectDuplicateAPIKeyMatch(APIKeys.map((APIKey) => APIKey.userId));
}

async function GetUserIDForAPIKeyConstantTime(IncomingUserAPIKeyHash: string){
    if(UserAPIKeyCache == undefined){
        await RefreshUserAPIKeyCache();
    }

    const IncomingHash = Buffer.from(IncomingUserAPIKeyHash, "hex");
    const MatchingUserIds: string[] = [];
    for(const APIKey of UserAPIKeyCache!){
        if(APIKey.keyHash.length === IncomingHash.length &&
            crypto.timingSafeEqual(IncomingHash, APIKey.keyHash)){
            MatchingUserIds.push(APIKey.userId);
        }
    }

    return SelectDuplicateAPIKeyMatch(MatchingUserIds);
}

export async function GetUserIDForAPIKey(UserAPIKey: string){
    const IncomingUserAPIKeyHash = HashUserAPIKey(UserAPIKey);
    if(KEY_LOOKUP === "DIRECT"){
        return GetUserIDForAPIKeyFromDatabase(IncomingUserAPIKeyHash);
    }

    return GetUserIDForAPIKeyConstantTime(IncomingUserAPIKeyHash);
}

export async function CleanupRefreshTokens(Force = false){
    const Now = Date.now();
    if(!Force && Now - LastRefreshTokenCleanupAt < REFRESH_TOKEN_CLEANUP_INTERVAL_MS){
        return;
    }

    LastRefreshTokenCleanupAt = Now;
    const NowIso = new Date(Now).toISOString();
    const RevokedBeforeIso = new Date(Now - REFRESH_TOKEN_RETENTION_SECONDS * 1000).toISOString();
    await GetDb().delete(userrefreshtokens).where(or(
        lt(userrefreshtokens.expiresAt, NowIso),
        and(
            isNotNull(userrefreshtokens.revokedAt),
            lt(userrefreshtokens.revokedAt, RevokedBeforeIso)
        )
    ));
}

async function IssueRefreshTokenForUid(userId: string){
    await CleanupRefreshTokens();
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
