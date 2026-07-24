import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { users } from "../db/schema";

const UsernameByUserId = new Map<string, string>();

export function RememberUsernameForUserId(userId: string, username: string){
    UsernameByUserId.set(userId, username);
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
