import {GetDb} from "../db"
import { gameserverapikeys, gameserverapikeystoregister } from "../db/schema";
import crypto from "crypto";
import { logger } from "../logger";
import { eq } from "drizzle-orm";

function HashGameserverAPIKey(GameserverAPIKeyToHash: string){
    return crypto.createHash("sha256").update(GameserverAPIKeyToHash, "utf8").digest("hex");
}

export async function DrainAndRegisterAPIKeys(){
    const APIKeysToRegister = await GetDb().query.gameserverapikeystoregister.findMany();

    await GetDb().delete(gameserverapikeystoregister);

    for(const APIKey of APIKeysToRegister){
        await GetDb().insert(gameserverapikeys).values({
            keyHash: HashGameserverAPIKey(APIKey.key)
        });
    }

    logger.info(`Registered ${APIKeysToRegister.length} new Gameserver API Key(s) on boot!`);
}

export async function IsValidGameserverAPIKey(GameserverAPIKey: string){
    const IncomingGameserverAPIKeyHash = HashGameserverAPIKey(GameserverAPIKey);
    const APIKey = await GetDb().query.gameserverapikeys.findFirst({
        where: eq(gameserverapikeys.keyHash, IncomingGameserverAPIKeyHash)
    });

    return APIKey != undefined;
}
