import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { users } from "../db/schema";

const UsernameByUserId = new Map<string, string>();

export function RememberUsernameForUserId(userId: string, username: string){
    UsernameByUserId.set(userId, username);
}

export function GetRememberedUsernameForUserId(userId: string){
    return UsernameByUserId.get(userId);
}

export async function GetUsernameForUserId(userId: string){
    const CachedUsername = UsernameByUserId.get(userId);
    if(CachedUsername != undefined){
        return CachedUsername;
    }

    let UserFromDb = await GetDb().query.users.findFirst({where: eq(users.userId, userId)});

    if(UserFromDb == undefined){
        throw new Error(`No user found for userId ${userId}`);
    }

    RememberUsernameForUserId(userId, UserFromDb.name);

    return UserFromDb.name;
}

export async function GetDisplayUsernameForUserId(userId: string){
    const Username = await GetUsernameForUserId(userId);
    if(!IsGeneratedDisplayUsername(Username, userId)){
        return Username;
    }

    for(const LocalUserId of [process.env.LOCAL_USER_ID, process.env.DEFAULT_USER_ID]){
        if(LocalUserId == undefined || LocalUserId.length === 0 || LocalUserId === userId){
            continue;
        }

        try{
            const LocalUsername = await GetUsernameForUserId(LocalUserId);
            if(!IsGeneratedDisplayUsername(LocalUsername, LocalUserId)){
                return LocalUsername;
            }
        }
        catch{
        }
    }

    return Username;
}

function IsGeneratedDisplayUsername(username: string, userId: string){
    const NormalizedUsername = username.trim().toLowerCase();
    const NormalizedUserId = userId.trim().toLowerCase();

    return NormalizedUsername.length === 0
        || NormalizedUsername === NormalizedUserId
        || /^(uid[-_]|local-\d+$|uuk_)/i.test(username);
}
