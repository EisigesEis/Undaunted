import express from "express";
import { loginRouter } from "./routes/login.js";
import { eosRouter } from "./routes/eos.js";
import { systemRouter } from "./routes/system.js";
import { characterRouter } from "./routes/character.js";
import { inventoryRouter } from "./routes/inventory.js";
import { storeRouter } from "./routes/store.js";
import { guildRouter } from "./routes/guild.js";
import { tuningRouter } from "./routes/tuning.js";
import { matchmakingRouter } from "./routes/matchmaking.js";
import { partyRouter } from "./routes/party.js";
import { progressionRouter } from "./routes/progression.js";
import { loadoutRouter } from "./routes/loadout.js";
import { undauntedApiRouter } from "./routes/undauntedapi.js";
import { friendsRouter } from "./routes/friends.js";
import { escalationRouter } from "./routes/escalation.js";
import { LogFullAttempt } from "./requestLogger.js";

export const app = express();

app.use(express.json({ limit: "50mb", strict: false }));

app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/", loginRouter);
app.use("/", eosRouter);
app.use("/", systemRouter);
app.use("/", characterRouter);
app.use("/", inventoryRouter);
app.use("/", storeRouter);
app.use("/", guildRouter);
app.use("/", tuningRouter);
app.use("/", matchmakingRouter);
app.use("/", partyRouter);
app.use("/", progressionRouter);
app.use("/", loadoutRouter);
app.use("/", friendsRouter);
app.use("/", escalationRouter);
app.use("/undaunted/api", undauntedApiRouter); // Everything that I/we add to help manage undaunted that doesn't belong to the game proper belongs here

// Invalid JSON cannot reach the fallback route.
app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof SyntaxError && "body" in error) {
        LogFullAttempt(req, "Unstubbed route full request", error);
        res.status(400).send();
        return;
    }

    next(error);
});

app.use((req, res) => {
    LogFullAttempt(req);

    res.status(404);
    res.send();
});
