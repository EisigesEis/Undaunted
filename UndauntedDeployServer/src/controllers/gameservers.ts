import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import dgram from "node:dgram";
import { setTimeout } from "node:timers/promises";

import crypto from "node:crypto";

import PlayerHuntTable from "../vendor/player_hunts_table.json";
import MatchmakerHuntTable from "../vendor/matchmaker_hunts_table.json";
import TrialsHardHuntTable from "../vendor/trials_hard_table.json";
import TrialsEliteHuntTable from "../vendor/trials_elite_table.json";
import { logger } from "../logger";
import { kill } from "node:process";

const RAMSGATE_MAP_PATH = "/Game/Maps/ramsgate/ramsgate_01_persistent";
const TRAINING_DOJO_MAP_PATH = "/Game/Maps/islands/dojo/training_dojo_persistent";
const TRIALS_MAP_PATH = "/Game/Maps/islands/arenas/arena_ramsgate_00";

export type Gameserver = {
    id: string,
    port: number,
    map: string,
    behemoth: string | undefined,
    matchmakerHuntId: string | undefined,
    expectedPlayers: ExpectedPlayer[] | undefined,
    isRamsgate: boolean,
    isTrainingDojo: boolean,
    origin: GameserverOrigin,
    trigger: string,
    processId: number,
    startTime: Date,
    lastTouchedTime: Date,
    shutdownAfterSeconds: number | undefined,
    expectedShutdownReason: string | undefined
};

type ExpectedPlayer = {
    playerUid: string,
    playerHuntId: string
};

export type GameserverOrigin = "RAMSGATE_PREWARM" | "TRAINING_DOJO_PREWARM" | "TRAINING_DOJO_LAZY" | "HUNT_ARGS" | "HUNT_MATCHMAKER";

export let Gameservers: Gameserver[] = [];
let FreePorts: number[] = [];

let RamsgateServer : Gameserver;
let TrainingDojoServer : Gameserver | undefined;
let TrainingDojoStartup: Promise<Gameserver> | undefined;

const PORT_RANGE_BEGIN = Number(process.env.PORT_RANGE_BEGIN!);
const PORT_RANGE_END = Number(process.env.PORT_RANGE_END!);
const RAMSGATE_PORT = PORT_RANGE_END;
const TRAINING_DOJO_PORT = PORT_RANGE_END - 1;
const GAMESERVER_BINARY_PATH = process.env.GAMESERVER_BINARY_PATH!.replace(/^"|"$/g, "");
const STANDARD_GAMESERVER_ARGS = ["-EpicPortal", "-server", "-nullrhi"];
const METAGAME_API_KEY = process.env.METAGAME_API_KEY!;
const MY_IP = process.env.MY_IP!;
const SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP = Number(process.env.SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP!);
const GAMESERVER_STARTUP_TIMEOUT_SECONDS = Number(process.env.GAMESERVER_STARTUP_TIMEOUT_SECONDS || "60");
const PREWARM_TRAINING_DOJO = process.env.PREWARM_TRAINING_DOJO === "true";
const TRAINING_DOJO_IDLE_SHUTDOWN_SECONDS = Number(process.env.TRAINING_DOJO_IDLE_SHUTDOWN_SECONDS || "300");
const HUNT_IDLE_SHUTDOWN_SECONDS = Number(process.env.HUNT_IDLE_SHUTDOWN_SECONDS || "90");

async function IsUdpPortInUse(Port: number){
    return await new Promise<boolean>((resolve) => {
        const Socket = dgram.createSocket("udp4");
        let Settled = false;

        const Finish = (Result: boolean) => {
            if(Settled){
                return;
            }

            Settled = true;
            Socket.removeAllListeners();
            try{
                Socket.close();
            }
            catch{
            }
            resolve(Result);
        };

        Socket.once("error", (Error: NodeJS.ErrnoException) => {
            Finish(Error.code === "EADDRINUSE");
        });

        Socket.once("listening", () => Finish(false));
        Socket.bind(Port, "0.0.0.0");
    });
}

function GetUdpPortOwnerPid(Port: number){
    try{
        const NetstatOutput = execFileSync("netstat", ["-ano"], {encoding: "utf8"});
        const PortPattern = new RegExp(`^\\s*UDP\\s+\\S+:${Port}\\s+\\S+\\s+(\\d+)\\s*$`, "mi");
        const Match = NetstatOutput.match(PortPattern);

        if(Match == undefined){
            return undefined;
        }

        return Number(Match[1]);
    }
    catch(Error){
        logger.warn(Error, `Failed to query owner for UDP port ${Port}`);
        return undefined;
    }
}

function CreateAdoptedFixedPortServer(Options: StartServerOptions, Port: number, ProcessId: number): Gameserver{
    const AdoptedServer: Gameserver = {
        id: crypto.randomUUID(),
        port: Port,
        map: Options.map,
        behemoth: Options.behemoth,
        matchmakerHuntId: Options.matchmakerHuntId,
        expectedPlayers: Options.expectedPlayers,
        isRamsgate: Options.isRamsgate,
        isTrainingDojo: Options.isTrainingDojo,
        origin: Options.origin,
        trigger: `adopted_existing:${Options.trigger}`,
        processId: ProcessId,
        startTime: new Date(),
        lastTouchedTime: new Date(),
        shutdownAfterSeconds: Options.shutdownAfterSeconds,
        expectedShutdownReason: undefined
    };

    Gameservers.push(AdoptedServer);
    logger.warn(`Adopted existing gameserver process ${ProcessId} on ${MY_IP}:${Port} origin=${Options.origin} map=${Options.map}`);

    return AdoptedServer;
}

async function WaitForGameserverReady(Child: ChildProcess, Port: number){
    const Deadline = Date.now() + GAMESERVER_STARTUP_TIMEOUT_SECONDS * 1000;

    let ExitReason: string | undefined;
    Child.once("exit", (Code, Signal) => {
        ExitReason = `exit code ${Code ?? "null"} signal ${Signal ?? "null"}`;
    });

    Child.once("error", (Error) => {
        ExitReason = `spawn error: ${Error.message}`;
    });

    while(Date.now() < Deadline){
        if(ExitReason != undefined){
            throw new Error(`Gameserver on port ${Port} stopped during startup: ${ExitReason}`);
        }

        if(await IsUdpPortInUse(Port)){
            return;
        }

        await setTimeout(250);
    }

    throw new Error(`Gameserver on port ${Port} did not bind UDP within ${GAMESERVER_STARTUP_TIMEOUT_SECONDS}s`);
}

function TransformExpectedPlayerArgs(ExpectedPlayers: ExpectedPlayer[]){
    let ToReturn = "";

    for(const Player of ExpectedPlayers){
        ToReturn = ToReturn + Player.playerUid + ":" + Player.playerHuntId + ",";
    }

    if(ToReturn.length > 0){
        ToReturn = ToReturn.slice(0, -1); // Remove trailing ','
    }

    return ToReturn;
}

export async function CleanupServer(ServerToShutdown: Gameserver){
    Gameservers = Gameservers.filter(Server => Server !== ServerToShutdown);

    if(ServerToShutdown.isRamsgate){
        logger.warn("RAMSGATE HAS FALLEN! Restarting!");

        RamsgateServer = await StartServer({
            map: RAMSGATE_MAP_PATH,
            behemoth: undefined,
            matchmakerHuntId: undefined,
            expectedPlayers: undefined,
            isRamsgate: true,
            isTrainingDojo: false,
            origin: "RAMSGATE_PREWARM",
            trigger: "watchdog_restart",
            shutdownAfterSeconds: undefined
        });
    }
    else if(ServerToShutdown.isTrainingDojo){
        logger.warn("Training Dojo cleaned up; it will lazy-start on the next request");

        if(TrainingDojoServer === ServerToShutdown){
            TrainingDojoServer = undefined;
        }

        TrainingDojoStartup = undefined;
    }
    else{
        FreePorts.push(ServerToShutdown.port);
    }
}

export async function ShutdownServer(ServerToShutdown: Gameserver, Reason: string){
    logger.info(`Shutting down gameserver ${ServerToShutdown.processId} on port ${ServerToShutdown.port} (${ServerToShutdown.origin}) due to ${Reason}`);
    ServerToShutdown.expectedShutdownReason = Reason;

    try{
        kill(ServerToShutdown.processId);
    }
    catch(Error){
        logger.warn(Error, `Failed to signal gameserver ${ServerToShutdown.processId} on port ${ServerToShutdown.port}`);
    }

    await CleanupServer(ServerToShutdown);
}

let ServerLaunchQueue: Promise<void> = Promise.resolve();

type StartServerOptions = {
    map: string,
    behemoth: string | undefined,
    matchmakerHuntId: string | undefined,
    expectedPlayers: ExpectedPlayer[] | undefined,
    isRamsgate: boolean,
    isTrainingDojo: boolean,
    origin: GameserverOrigin,
    trigger: string,
    shutdownAfterSeconds: number | undefined
};

async function StartServer(Options: StartServerOptions){
    const LaunchProc = ServerLaunchQueue;

    ServerLaunchQueue = ServerLaunchQueue.catch(() => {}).then(async () => await setTimeout(SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP * 1000));

    await LaunchProc;
    
    let Port: number | undefined;

    if(Options.isRamsgate){
        Port = RAMSGATE_PORT;
    }
    else if(Options.isTrainingDojo){
        Port = TRAINING_DOJO_PORT;
    }
    else{
        while(Port == undefined && FreePorts.length > 0){
            const CandidatePort = FreePorts.pop()!;

            if(await IsUdpPortInUse(CandidatePort)){
                logger.warn(`Skipping port ${CandidatePort} because it is already in use before gameserver startup`);
                continue;
            }

            Port = CandidatePort;
        }
    }

    const Id = crypto.randomUUID();

    if(Port == undefined){
        throw new Error("No free ports left!");
    }

    if((Options.isRamsgate || Options.isTrainingDojo) && await IsUdpPortInUse(Port)){
        const OwnerPid = GetUdpPortOwnerPid(Port);

        if(OwnerPid != undefined){
            return CreateAdoptedFixedPortServer(Options, Port, OwnerPid);
        }

        throw new Error(`Fixed gameserver port ${Port} is already in use before startup and its owner could not be identified`);
    }

    const Child = spawn(GAMESERVER_BINARY_PATH, [
        METAGAME_API_KEY,
        Port.toString(),
        Options.map,
        Options.behemoth != undefined ? Options.behemoth : "NO_BEHEMOTH",
        Options.matchmakerHuntId != undefined ? Options.matchmakerHuntId : "NO_MM_HUNTID",
        Options.expectedPlayers != undefined ? TransformExpectedPlayerArgs(Options.expectedPlayers) : "NO_EXPECTED_PLAYERS",
        MY_IP + ":" + Port.toString(),
        ...STANDARD_GAMESERVER_ARGS
    ], {
        stdio: "ignore"
    });

    Child.unref();
    Child.on("error", (Error) => {
        logger.error(Error, `Gameserver process failed to start for port ${Port}`);
    });
    const NewGameserver: Gameserver = {
        id: Id,
        port: Port,
        map: Options.map,
        behemoth: Options.behemoth,
        matchmakerHuntId: Options.matchmakerHuntId,
        expectedPlayers: Options.expectedPlayers,
        isRamsgate: Options.isRamsgate,
        isTrainingDojo: Options.isTrainingDojo,
        origin: Options.origin,
        trigger: Options.trigger,
        processId: Child.pid!,
        startTime: new Date(),
        lastTouchedTime: new Date(),
        shutdownAfterSeconds: Options.shutdownAfterSeconds,
        expectedShutdownReason: undefined
    };

    Child.on("exit", (Code, Signal) => {
        const ExitMessage = `Gameserver process ${Child.pid ?? "unknown"} on port ${Port} exited with code ${Code ?? "null"} signal ${Signal ?? "null"}`;

        if(NewGameserver.expectedShutdownReason != undefined){
            logger.info(`${ExitMessage} after expected shutdown: ${NewGameserver.expectedShutdownReason}`);
            return;
        }

        logger.warn(ExitMessage);
    });

    Gameservers.push(NewGameserver);

    try{
        await WaitForGameserverReady(Child, Port);
    }
    catch(Error){
        Gameservers = Gameservers.filter(Server => Server !== NewGameserver);

        if(!Options.isRamsgate && !Options.isTrainingDojo){
            FreePorts.push(Port);
        }

        throw Error;
    }

    logger.info(`Gameserver ${Child.pid} is ready on ${MY_IP}:${Port} origin=${Options.origin} trigger=${Options.trigger} map=${Options.map}`);

    return NewGameserver;
}

export function GetRamsgateConnectionDetails(){
    return {
        host: MY_IP,
        port: RamsgateServer.port
    };
}

export function GetTrainingDojoConnectionDetails(){
    if(TrainingDojoServer == undefined){
        throw new Error("Training Dojo server has not started");
    }

    TrainingDojoServer.lastTouchedTime = new Date();

    return {
        host: MY_IP,
        port: TrainingDojoServer.port
    };
}

export function TouchGameserverForPlayer(PlayerId: string){
    const Server = Gameservers.find((Candidate) => Candidate.expectedPlayers?.some((Player) => Player.playerUid === PlayerId));

    if(Server == undefined){
        return undefined;
    }

    Server.lastTouchedTime = new Date();

    return {
        host: MY_IP,
        port: Server.port,
        id: Server.id,
        origin: Server.origin,
        lastTouchedTime: Server.lastTouchedTime.toISOString()
    };
}

export async function GetOrStartTrainingDojoConnectionDetails(Origin: GameserverOrigin){
    if(TrainingDojoServer != undefined){
        return GetTrainingDojoConnectionDetails();
    }

    if(TrainingDojoStartup == undefined){
        TrainingDojoStartup = StartServer({
            map: TRAINING_DOJO_MAP_PATH,
            behemoth: undefined,
            matchmakerHuntId: undefined,
            expectedPlayers: undefined,
            isRamsgate: false,
            isTrainingDojo: true,
            origin: Origin,
            trigger: "training_dojo_matchmaking",
            shutdownAfterSeconds: TRAINING_DOJO_IDLE_SHUTDOWN_SECONDS
        }).then((Server) => {
            TrainingDojoServer = Server;
            return Server;
        }).finally(() => {
            TrainingDojoStartup = undefined;
        });
    }

    const Server = await TrainingDojoStartup;
    Server.lastTouchedTime = new Date();

    return {
        host: MY_IP,
        port: Server.port
    };
}

function TransformExpectedPlayers(HuntId: string | undefined, ExpectedPlayers: string[] | undefined){
    return ExpectedPlayers?.map((PlayerId) => ({
        playerUid: PlayerId,
        playerHuntId: HuntId ?? "UNKNOWN_HUNT"
    }));
}

export async function StartupGameserverWithArgs(GameArgs: string, ExpectedPlayers: string[] | undefined){
    const Map = GameArgs.split("?")[0];
    const Behemoth = GameArgs.split("?")[2].split("=")[1];

    const GameServerToReturn = await StartServer({
        map: Map,
        behemoth: Behemoth,
        matchmakerHuntId: undefined,
        expectedPlayers: TransformExpectedPlayers(undefined, ExpectedPlayers),
        isRamsgate: false,
        isTrainingDojo: false,
        origin: "HUNT_ARGS",
        trigger: GameArgs,
        shutdownAfterSeconds: HUNT_IDLE_SHUTDOWN_SECONDS
    });

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    };
}

function GetMatchmakerHuntIdFromPlayerHuntId(PlayerHuntId: string){
    const MatchmakerHuntIDs = (PlayerHuntTable[0].Rows as any)[PlayerHuntId].MatchmakerHuntIDs;

    let MatchmakerHuntObject;

    if(MatchmakerHuntIDs.length !== 0){
        MatchmakerHuntObject = MatchmakerHuntIDs[crypto.randomInt(0, MatchmakerHuntIDs.length)];
    }

    return MatchmakerHuntObject?.RowName;
}

function GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    return MatchmakerHuntObject.SpecificBehemoth.BehemothAsset.AssetPathName;
}

function GetMapPathFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    const MapList = MatchmakerHuntObject.MapList;

    return MapList[crypto.randomInt(0, MapList.length)].MapAssetName.split(".")[0];
}

function GetGameModeOverrideFromMatchmakerHuntId(MatchmakerHuntId: string): string{
    const MatchmakerHuntObject = (MatchmakerHuntTable[0].Rows as any)[MatchmakerHuntId];

    return MatchmakerHuntObject.GameModeOverride.replaceAll("Archon/Content", "/Game");
}

type TrialsData = {
    Behemoth: string;
    TrialsHuntId: string;
}

function RandomlyGenTrialsData(IsElite: boolean): TrialsData{
    const RandomTrialNum = String(crypto.randomInt(1, 89)).padStart(3, "0");

    const Difficulty = IsElite ? "Elite" : "Hard";

    const TrialsHuntId = `Arena_MatchmakerHunt_${Difficulty}_${RandomTrialNum}`;

    const Row = IsElite ? (TrialsEliteHuntTable[0].Rows as any)[TrialsHuntId] : (TrialsHardHuntTable[0].Rows as any)[TrialsHuntId];

    const Behemoth = Row.SpecificBehemoth.BehemothAsset.AssetPathName;

    return {
        Behemoth: Behemoth,
        TrialsHuntId: TrialsHuntId
    };
}

export async function StartupGameserverWithHuntIdAndPlayers(HuntId: string, ExpectedPlayers: string[]){
    const TrialsData = HuntId.includes("Arena") ? RandomlyGenTrialsData(HuntId.includes("Elite")) : undefined;
    const MatchmakerHuntId = TrialsData == undefined ? GetMatchmakerHuntIdFromPlayerHuntId(HuntId) : TrialsData.TrialsHuntId;
    let BehemothPath = TrialsData == undefined ? GetBehemothPathFromMatchmakerHuntId(MatchmakerHuntId!) : TrialsData.Behemoth;
    let MapPath = TrialsData == undefined ? GetMapPathFromMatchmakerHuntId(MatchmakerHuntId!) : TRIALS_MAP_PATH;

    if(MatchmakerHuntId != undefined && !MatchmakerHuntId.includes("Arena")){
        const OverrideGameMode = GetGameModeOverrideFromMatchmakerHuntId(MatchmakerHuntId);

        if(OverrideGameMode != undefined && OverrideGameMode.includes("_C")){
            logger.info(`Overriding gamemode to ${OverrideGameMode}`);
            MapPath = `${MapPath}?game=${OverrideGameMode}`;
        }
    }

    const GameServerToReturn = await StartServer({
        map: MapPath,
        behemoth: BehemothPath,
        matchmakerHuntId: MatchmakerHuntId,
        expectedPlayers: TransformExpectedPlayers(HuntId, ExpectedPlayers),
        isRamsgate: false,
        isTrainingDojo: false,
        origin: "HUNT_MATCHMAKER",
        trigger: HuntId,
        shutdownAfterSeconds: HUNT_IDLE_SHUTDOWN_SECONDS
    });

    return {
        host: MY_IP,
        port: GameServerToReturn.port
    }
}

export async function Startup(){
    for(let i = PORT_RANGE_BEGIN; i <= PORT_RANGE_END - 2; i++){
        FreePorts.push(i);
    }

    RamsgateServer = await StartServer({
        map: RAMSGATE_MAP_PATH,
        behemoth: undefined,
        matchmakerHuntId: undefined,
        expectedPlayers: undefined,
        isRamsgate: true,
        isTrainingDojo: false,
        origin: "RAMSGATE_PREWARM",
        trigger: "deploy_startup",
        shutdownAfterSeconds: undefined
    });

    if(PREWARM_TRAINING_DOJO){
        await GetOrStartTrainingDojoConnectionDetails("TRAINING_DOJO_PREWARM");
    }
}
