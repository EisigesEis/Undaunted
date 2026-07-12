import { Router } from "express";
import { HandleGameserverReadyCallback } from "../controllers/gameservers";

export const gameserverRouter = Router();

gameserverRouter.post("/ready", (req, res) => {
    const Result = HandleGameserverReadyCallback(req.header("x-undaunted-ready-token"), req.body);

    res.status(Result.status);
    res.json(Result.body);
});
