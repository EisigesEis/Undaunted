import { app } from "./app";
import { DrainAndRegisterAPIKeys } from "./controllers/apikeys";
import { DrainAndRegisterUserAPIKeys } from "./controllers/auth";
import { GetDb } from "./db";
import { logger } from "./logger";
import http from "http";
import { AttachXmppServer } from "./xmpp/server";
import { AttachStompServer } from "./stomp/server";

const PORT = process.env.PORT;

GetDb(); // This runs migrations TODO make this more explicit

DrainAndRegisterAPIKeys().then(async () => {
  await DrainAndRegisterUserAPIKeys();

  const server = http.createServer(app);
  AttachXmppServer(server, { rejectUnknownPath: false });
  AttachStompServer(server);

  server.listen(PORT, () => {
    logger.info(`Undaunted Metagame on port ${PORT}`);
    logger.info(`Clear Skies, Slayer.`);
  });
});
