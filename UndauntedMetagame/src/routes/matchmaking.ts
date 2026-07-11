import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import { CheckAndUpdateQueueStatus, HandlePlayerMatchmaking } from "../controllers/matchmaking";

export const matchmakingRouter = Router();

const QOS_TARGET_URL = process.env.QOS_TARGET_URL;
const TARGET_CHANGELIST = process.env.TARGET_CHANGELIST;
const MATCHMAKING_STATUS_PERIOD_MILLIS = Number(process.env.MATCHMAKING_STATUS_PERIOD_MILLIS || "1000");

matchmakingRouter.post("/candidate/player/register", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info(`userId ${req.AuthData.userId} is registering for matchmaking!`);

    res.status(200);
    res.json({});
});

matchmakingRouter.all("/candidate/player/alive", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info(`Player alive check from ${req.AuthData.userId ?? "gameserver"}`);

    res.status(200);
    res.json({});
});

matchmakingRouter.delete("/party/member", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info(`Clear party (stubbed)`);

    res.status(200);
    res.json({});
});

matchmakingRouter.get("/candidate/regions", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.info(`Querying regions for QoS`);

    res.status(200);
    res.json({
        code: 200,
        message: "success",
        payload: {
            maxPingingStepTime: 3,
            pingCount: 5,
            pingFrequency: 0.25,
            regionUrls: [
                QOS_TARGET_URL
            ]
        }
    });
});

matchmakingRouter.post("/key/generate", HasUndauntedMetagameAuth, async (req: any, res) => {
    res.status(400);
    res.send();
});

matchmakingRouter.get("/candidate/status", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;

    const MatchmakingSession = await CheckAndUpdateQueueStatus(UserId);

    if(MatchmakingSession != undefined){
        if(MatchmakingSession.phase === "READY"){
            logger.info(`Telling client to travel to ${MatchmakingSession.host}:${MatchmakingSession.port}`);

            res.status(200);
            res.json({
                candidateId: MatchmakingSession.candidateId,
                candidateStatusPeriodMillis: MATCHMAKING_STATUS_PERIOD_MILLIS,
                gameMode: MatchmakingSession.gameMode,
                huntId: MatchmakingSession.huntId,
                playerStates: {
                  [UserId]: {}
                },
                serverInfo: {
                    buildId: TARGET_CHANGELIST + "_1.4.4_shipping", // TODO: pull the end of the buildstring from somewhere nonstatic
                    gameSessionId: MatchmakingSession.candidateId,
                    host: MatchmakingSession.host,
                    port: MatchmakingSession.port
                },
                status: "IN_PROGRESS",
                statusDuration: 0.0,
                statusReason: null
            });
        }
        else if(MatchmakingSession.phase === "QUEUED" || MatchmakingSession.phase === "STARTING"){
            logger.info(`MM not ready yet!`);

            res.status(200);
            res.json({
                candidateId: MatchmakingSession.candidateId,
                candidateStatusPeriodMillis: MATCHMAKING_STATUS_PERIOD_MILLIS,
                gameMode: MatchmakingSession.gameMode,
                huntId: MatchmakingSession.huntId,
                playerStates: {
                  [UserId] : {}
                },
                status : "MATCHING",
                statusDuration : 0.0,
                statusReason : null
            })
        }
        else{
            logger.warn(`MM failed for ${UserId}: ${MatchmakingSession.statusReason}`);

            res.status(200);
            res.json({
                candidateId: MatchmakingSession.candidateId,
                candidateStatusPeriodMillis: MATCHMAKING_STATUS_PERIOD_MILLIS,
                gameMode: MatchmakingSession.gameMode,
                huntId: MatchmakingSession.huntId,
                playerStates: {
                  [UserId] : {}
                },
                status : "FAILED",
                statusDuration : 0.0,
                statusReason : MatchmakingSession.statusReason
            })
        }
    }
    else{
        logger.error(`UserId ${UserId} was not found in the MatchmakingMap`);

        res.status(404);
        res.send();
    }
});

matchmakingRouter.post("/candidate/join", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const GameMode = req.body.gameMode;
    const GameArgs = req.body.gameArgs;
    const HuntId = req.body.playerHuntId;

    logger.info(`UserId ${UserId} wants to join a game with GameMode ${GameMode} & GameArgs ${GameArgs} & HuntId ${HuntId}`);

    // TODO: We put a LOT of faith in our authenticated users not abusing the matchmaking system right now
    // A reasonable addition would be checks on frequency of MM/server spinup
    // Best scenario is 1-1 for server session<->player and a new server cooldown

    const MatchmakingResult = await HandlePlayerMatchmaking(GameMode, GameArgs, HuntId, UserId);

    if(!MatchmakingResult){
        res.status(503);
        res.json({
            error: "matchmaking_failed"
        });
        return;
    }

    res.status(200);
    const ResponseBody: any = {
        candidateId: MatchmakingResult.candidateId,
        gameMode: GameMode,
        huntId: HuntId,
        status: MatchmakingResult.phase === "READY" ? "IN_PROGRESS" : "MATCHING",
        statusReason: null
    };

    if(MatchmakingResult.phase === "READY"){
        ResponseBody.serverInfo = {
            buildId: TARGET_CHANGELIST + "_1.4.4_shipping",
            gameSessionId: MatchmakingResult.candidateId,
            host: MatchmakingResult.host,
            port: MatchmakingResult.port
        };
    }

    res.json(ResponseBody);
});

matchmakingRouter.get("/QoS", (req, res) => {
    logger.info(`QoS Ping`);

    res.status(200);
    res.send("<!DOCTYPE html><html><body>pong</body></html>");
})
