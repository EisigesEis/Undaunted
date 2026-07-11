import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { GetDb } from "../db";
import { GetUserIDForAPIKey, HashUserAPIKey } from "./auth";
import { GetUsernameForUserId } from "./login";
import { invitecodes, userapikeys, users } from "../db/schema";
import { eq } from "drizzle-orm";

const AUTH_MODE = process.env.AUTH_MODE;
const NODE_ENV = process.env.NODE_ENV;

export let REGISTRATION_MODE = process.env.REGISTRATION_MODE!; // In memory only for now, might wanna move to DB at some point

export type UserInfo = {
    UserId: string;
    Username: string;
    IsAdmin: boolean;
}

type PlayerActivity = { // TODO: Track more stuff from the game's native telemetry here
    Map: string;
    LastUpdatedTime: number
}

type PlayerLocation = { // TODO: Track more stuff from our matchmaking telemetry here
    HuntId: string,
    EnteredTime: number
}

export type PlayerData = {
    UserId: string,
    Map: string,
    HuntId: string | undefined,
    EnteredHuntAt: number | undefined
};

let PlayerActivityMap: Map<string, PlayerActivity> = new Map<string, PlayerActivity>();
let PlayerLocationMap: Map<string, PlayerLocation> = new Map<string, PlayerLocation>();

export function SetRegistrationMode(RegistrationMode: string){
    REGISTRATION_MODE = RegistrationMode;
}

export async function GetInviteCodes(){
    return await GetDb().query.invitecodes.findMany();
}

export async function GetAllUserIds(){
    const UsersFromDb = await GetDb().query.users.findMany();

    return UsersFromDb.map((user) => {
        Username: user.name;
        UserId: user.userId;
    });
}

export async function RegisterInviteCode(NewInviteCode: string, Uses: number, InfiniteUses: boolean){
    if(NewInviteCode.trim().length > 0){
        await GetDb().insert(invitecodes).values({
            inviteCode: NewInviteCode,
            usesRemaining: Uses,
            infiniteUses: InfiniteUses
        });
    }
}

export async function DeleteInviteCode(InviteCodeToDelete: string){
    await GetDb().delete(invitecodes).where(eq(
        invitecodes.inviteCode, InviteCodeToDelete
    ));
}

export async function IsUserIdAdmin(UserId: string){
    const UserFromDb = await GetDb().query.users.findFirst({where: eq(users.userId, UserId)});

    return UserFromDb != undefined && UserFromDb.isAdmin;
}

export async function RegisterUser(Username: string){
    const UID = `UID-${randomUUID()}`;
    const UUK = `UUK_${randomBytes(24).toString("hex")}`;

    const UUKHash = HashUserAPIKey(UUK);

    await GetDb().insert(users).values({
        userId: UID,
        name: Username,
        notes: 0
    });

    await GetDb().insert(userapikeys).values({
        userId: UID,
        keyHash: UUKHash
    });

    return UUK;
}

export async function ValidateAndConsumeInviteCode(InviteCode: string){ // TODO: Might have some TOCTOU, review when not sleepy
    const InviteCodes: any[] = await GetDb().query.invitecodes.findMany();

    for(const CmpInviteCode of InviteCodes){
        if(CmpInviteCode.inviteCode.length === InviteCode.length && timingSafeEqual(Buffer.from(CmpInviteCode.inviteCode), Buffer.from(InviteCode))){
            if(CmpInviteCode.usesRemaining > 0 || CmpInviteCode.infiniteUses){
                if(!CmpInviteCode.infiniteUses){
                    await GetDb().update(invitecodes).set({usesRemaining: CmpInviteCode.usesRemaining - 1}).where(eq(invitecodes.inviteCode, InviteCode));
                }

                return true;
            }
            else{
                return false;
            }
        }
    }

    return false;
}

export async function UpdatePlayerActivity(UserId: string, Map: string){
    PlayerActivityMap.set(UserId, {
        Map: Map,
        LastUpdatedTime: Date.now()
    });
}

export async function UpdatePlayerLocation(UserId: string, HuntId: string){
    PlayerLocationMap.set(UserId, {
        HuntId: HuntId,
        EnteredTime: Date.now()
    });
}

export async function GetRecentPlayerData(){
    let PlayerDataToReturn: PlayerData[] = [];

    PlayerActivityMap.forEach((value, key, map) => {
        if(Date.now() - value.LastUpdatedTime <= 90 * 60){ // If entry is < 90s old
            const PlayerLocationData: PlayerLocation | undefined = PlayerLocationMap.get(key);

            PlayerDataToReturn.push({
                UserId: key,
                Map: value.Map,
                HuntId: PlayerLocationData?.HuntId,
                EnteredHuntAt: PlayerLocationData?.EnteredTime
            });
        }
    });

    return PlayerDataToReturn;
}

export async function GetUserInfoForApiKey(UserApiKey: string): Promise<UserInfo | undefined>{
    let UserId;
    if(AUTH_MODE === "NONE" && NODE_ENV !== "production"){
        UserId = UserApiKey;
    }
    else if(AUTH_MODE === "APIKEY"){
        UserId = await GetUserIDForAPIKey(UserApiKey);
    }
    else{
        throw new Error("Unsupported Auth Mode!");
    }

    if(UserId == undefined){
        return undefined;
    }

    const Username = await GetUsernameForUserId(UserId);
    const IsAdmin = await IsUserIdAdmin(UserId);

    return {
        UserId: UserId,
        Username: Username,
        IsAdmin: IsAdmin
    };
}