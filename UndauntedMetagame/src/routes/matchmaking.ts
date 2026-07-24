import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import { BuildCandidateStatusResponse, CheckAndUpdateQueueStatus, HandlePlayerMatchmaking } from "../controllers/matchmaking";
import { GetPartyById, GetPartyForPlayer } from "../controllers/party";

export const matchmakingRouter = Router();

const QOS_TARGET_URL = process.env.QOS_TARGET_URL;
const TARGET_CHANGELIST = process.env.TARGET_CHANGELIST;
const MATCHMAKING_STATUS_PERIOD_MILLIS = Number(process.env.MATCHMAKING_STATUS_PERIOD_MILLIS || "500");
const TARGET_BUILD_ID = `${TARGET_CHANGELIST || "239827"}_1.4.4_shipping`;

matchmakingRouter.post("/candidate/player/register", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.debug({ userId: req.AuthData.userId }, "Player registered for matchmaking");

    res.status(200);
    res.json({});
});

matchmakingRouter.all("/candidate/player/alive", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.debug({ userId: req.AuthData.userId ?? "gameserver" }, "Player alive check");

    res.status(200);
    res.json({});
});

matchmakingRouter.get("/candidate/regions", HasUndauntedMetagameAuth, (req: any, res) => {
    logger.debug("Querying regions for QoS");

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
            logger.debug({
                userId: UserId,
                candidateId: MatchmakingSession.candidateId,
                host: MatchmakingSession.host,
                port: MatchmakingSession.port
            }, "Candidate status ready");
        }
        else if(MatchmakingSession.phase === "QUEUED" || MatchmakingSession.phase === "STARTING"){
            logger.debug({
                userId: UserId,
                candidateId: MatchmakingSession.candidateId,
                phase: MatchmakingSession.phase
            }, "Candidate status not ready");
        }
        else{
            logger.warn({
                userId: UserId,
                candidateId: MatchmakingSession.candidateId,
                phase: MatchmakingSession.phase,
                statusReason: MatchmakingSession.statusReason
            }, "Candidate status failed");
        }

        res.status(200);
        res.json(BuildCandidateStatusResponse(MatchmakingSession, MATCHMAKING_STATUS_PERIOD_MILLIS, TARGET_BUILD_ID));
    }
    else{
        logger.debug({ userId: UserId }, "Candidate status requested without active matchmaking session");

        res.status(404);
        res.send();
    }
});

matchmakingRouter.post("/candidate/join", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const GameMode = req.body.gameMode;
    const GameArgs = req.body.gameArgs;
    const HuntId = req.body.playerHuntId;
    const PartyId = typeof req.body.partyId === "string" ? req.body.partyId : undefined;
    const PrivateMatch = req.body.privateMatch === true || req.body.isPrivate === true;

    logger.debug({
        userId: UserId,
        gameMode: GameMode,
        gameArgs: GameArgs,
        huntId: HuntId,
        partyId: PartyId,
        privateMatch: PrivateMatch
    }, "Candidate join requested");

    const RequestedParty = GetPartyById(PartyId);
    const Party = RequestedParty?.members.has(UserId) === true ? RequestedParty : GetPartyForPlayer(UserId);
    if(Party != undefined && Party.leaderPlayerId !== UserId){
        logger.warn({
            userId: UserId,
            partyId: Party.partyId,
            leaderPlayerId: Party.leaderPlayerId,
            huntId: HuntId
        }, "Rejected matchmaking from non-leader");
        res.status(403).json({error: "not_party_leader"});
        return;
    }

    // TODO: We put a LOT of faith in our authenticated users not abusing the matchmaking system right now
    // A reasonable addition would be checks on frequency of MM/server spinup
    // Best scenario is 1-1 for server session<->player and a new server cooldown

    const MatchmakingResult = await HandlePlayerMatchmaking(GameMode, GameArgs, HuntId, UserId, {
        partyId: PartyId,
        privateMatch: PrivateMatch
    });

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
        status: MatchmakingResult.phase === "READY" ? "IN_PROGRESS" : MatchmakingResult.phase === "QUEUED" ? "QUEUED_FOR_START" : "MATCHING",
        statusReason: null
    };

    if(MatchmakingResult.phase === "READY"){
        ResponseBody.serverInfo = {
            buildId: TARGET_BUILD_ID,
            gameSessionId: MatchmakingResult.candidateId,
            host: MatchmakingResult.host,
            port: MatchmakingResult.port
        };
    }

    res.json(ResponseBody);
});

matchmakingRouter.get("/QoS", (req, res) => {
    logger.debug("QoS ping");

    res.status(200);
    res.send("<!DOCTYPE html><html><body>pong</body></html>");
})
