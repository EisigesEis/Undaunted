import { kill } from "node:process";
import { logger } from "../logger";
import { Gameserver, Gameservers, CleanupServer, ShutdownServer } from "./gameservers";

/**
 * TODO:
 * This watchdog is SUPER basic rn, only releases resources, the server itself handles cleaning itself up
 */

function IsGameserverStillAlive(GameserverToCheck: Gameserver){
    try{
        kill(GameserverToCheck.processId, 0);

        return true;
    } catch(err) {
        return false;
    }
}

export async function RunWatchdog(){
    logger.info(`Running Gameserver Watchdog!`);

    for(const Gameserver of [...Gameservers]){
        if(!IsGameserverStillAlive(Gameserver)){
            logger.info(`Cleaning up dead gameserver on port ${Gameserver.port}`);

            await CleanupServer(Gameserver);

            continue;
        }

        if(Gameserver.shutdownAfterSeconds != undefined && Gameserver.shutdownAfterSeconds > 0){
            const IdleSeconds = (Date.now() - Gameserver.lastTouchedTime.getTime()) / 1000;

            if(IdleSeconds >= Gameserver.shutdownAfterSeconds){
                await ShutdownServer(Gameserver, `idle for ${Math.floor(IdleSeconds)}s`);
            }
        }
    }
}
