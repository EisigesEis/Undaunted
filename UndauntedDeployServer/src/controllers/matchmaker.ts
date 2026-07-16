import { logger } from "../logger";
import { GetOrStartTrainingDojoConnectionDetails, GetRamsgateConnectionDetails, StartupGameserverWithArgs, StartupGameserverWithHuntIdAndPlayers } from "./gameservers";

export async function HandleMatchmakingRequest(GameMode: string, GameArgs: string, HuntId: string, ExpectedPlayers: string[] | undefined, FreshInstance = false){
    const NormalizedHuntId = HuntId ?? "";
    const NormalizedExpectedPlayers = ExpectedPlayers ?? [];

    logger.info({
        gameMode: GameMode,
        huntId: NormalizedHuntId,
        gameArgs: GameArgs,
        expectedPlayers: NormalizedExpectedPlayers,
        freshInstance: FreshInstance
    }, "Handling matchmaking");

    if(GameMode === "CITY"){
        return GetRamsgateConnectionDetails();
    }
    else if(GameMode === "SHARED"){
        if(NormalizedHuntId === "ShatteredIsles_TrainingDojo"){
            return await GetOrStartTrainingDojoConnectionDetails("TRAINING_DOJO_LAZY");
        }
    }
    else if(GameMode === "ISLAND"){
        if(GameArgs != undefined && GameArgs.trim().length > 0){
            return await StartupGameserverWithArgs(GameArgs, ExpectedPlayers);
        }

        if(NormalizedHuntId.length > 0 && ExpectedPlayers != undefined){
            return await StartupGameserverWithHuntIdAndPlayers(NormalizedHuntId, ExpectedPlayers, FreshInstance);
        }
    }

    logger.error("Matchmaking failed, sending you to Ramsgate!");

    return GetRamsgateConnectionDetails();
}
