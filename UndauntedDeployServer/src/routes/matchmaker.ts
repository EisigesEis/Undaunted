import { Router } from "express";
import { logger } from "../logger";
import { HandleMatchmakingRequest } from "../controllers/matchmaker";
import { GetGameserverStatusForPlayer, TouchGameserverForPlayer } from "../controllers/gameservers";
import express from "express";

export const matchmakingRouter = Router();

matchmakingRouter.post("/handle-matchmaking-for-player", express.json(), async (req, res) => {
    const GameMode = req.body.GameMode;
    const GameArgs = req.body.GameArgs;
    const HuntId = req.body.HuntId;
    const ExpectedPlayers = req.body.ExpectedPlayers;

    try{
        const MatchmakingResult = await HandleMatchmakingRequest(GameMode, GameArgs, HuntId, ExpectedPlayers);

        res.status(200);
        res.json(MatchmakingResult);
    }
    catch(Error){
        logger.error(Error, `Failed to handle matchmaking for GameMode ${GameMode} HuntId ${HuntId}`);

        res.status(503);
        res.json({
            error: "gameserver_startup_failed"
        });
    }
});

matchmakingRouter.post("/touch-player", express.json(), (req, res) => {
    const PlayerId = req.body.PlayerId;

    if(typeof PlayerId !== "string" || PlayerId.length === 0){
        res.status(400);
        res.json({touched: false});
        return;
    }

    const TouchedServer = TouchGameserverForPlayer(PlayerId);

    if(TouchedServer == undefined){
        res.status(404);
        res.json({touched: false});
        return;
    }

    res.status(200);
    res.json({
        touched: true,
        server: TouchedServer
    });
});

matchmakingRouter.post("/player-server-status", express.json(), async (req, res) => {
    const PlayerId = req.body.PlayerId;

    if(typeof PlayerId !== "string" || PlayerId.length === 0){
        res.status(400);
        res.json({
            found: false,
            joinable: false
        });
        return;
    }

    res.status(200);
    res.json(await GetGameserverStatusForPlayer(PlayerId));
});
