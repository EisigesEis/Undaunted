import { app } from "./app";
import { Startup } from "./controllers/gameservers";
import { RunWatchdog } from "./controllers/watchdog";
import { logger } from "./logger";
import { StartPerformanceMonitoring } from "./performance";

const PORT = process.env.PORT;

app.listen(PORT, async () => {
  try{
    StartPerformanceMonitoring();
    await Startup();

    setInterval(RunWatchdog, 5 * 1000);

    logger.info(`Undaunted DeployServer on port ${PORT}`);
    logger.info(`Clear Skies, Slayer.`);
  }
  catch(Error){
    logger.fatal(Error, "Undaunted DeployServer startup failed");
    process.exitCode = 1;
  }
});
