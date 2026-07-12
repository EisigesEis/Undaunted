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

type GameserverReadyPayload = {
    id: string,
    port: number,
    pid: number
};

type PendingGameserverReady = {
    port: number,
    token: string,
    resolve: (Payload: GameserverReadyPayload) => void
};

type StartedGameserverProcess = {
    processId: number,
    child: ChildProcess | undefined
};

export type GameserverOrigin = "RAMSGATE_PREWARM" | "TRAINING_DOJO_PREWARM" | "TRAINING_DOJO_LAZY" | "HUNT_ARGS" | "HUNT_MATCHMAKER";

export let Gameservers: Gameserver[] = [];
let FreePorts: number[] = [];
const PendingGameserverReadyById = new Map<string, PendingGameserverReady>();

let RamsgateServer : Gameserver | undefined;
let TrainingDojoServer : Gameserver | undefined;
let TrainingDojoStartup: Promise<Gameserver> | undefined;
let RamsgateRestart: Promise<void> | undefined;

const PORT_RANGE_BEGIN = Number(process.env.PORT_RANGE_BEGIN!);
const PORT_RANGE_END = Number(process.env.PORT_RANGE_END!);
const RAMSGATE_PORT = PORT_RANGE_END;
const TRAINING_DOJO_PORT = PORT_RANGE_END - 1;
const GAMESERVER_BINARY_PATH = process.env.GAMESERVER_BINARY_PATH!.replace(/^"|"$/g, "");
const STANDARD_GAMESERVER_ARGS = ["-EpicPortal", "-server", "-nullrhi"];
const METAGAME_API_KEY = process.env.METAGAME_API_KEY!;
const MY_IP = process.env.MY_IP!;
const DEPLOYSERVER_PORT = process.env.PORT!;
const GAMESERVER_READY_CALLBACK_URL = process.env.GAMESERVER_READY_CALLBACK_URL || `http://127.0.0.1:${DEPLOYSERVER_PORT}/api/gameservers/ready`;
const SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP = Number(process.env.SECONDS_TO_WAIT_BETWEEN_GAMESERVER_STARTUP!);
const GAMESERVER_STARTUP_TIMEOUT_SECONDS = Number(process.env.GAMESERVER_STARTUP_TIMEOUT_SECONDS || "60");
const RAMSGATE_RESTART_RETRY_SECONDS = Number(process.env.RAMSGATE_RESTART_RETRY_SECONDS || "5");
const PREWARM_TRAINING_DOJO = process.env.PREWARM_TRAINING_DOJO === "true";
const TRAINING_DOJO_IDLE_SHUTDOWN_SECONDS = Number(process.env.TRAINING_DOJO_IDLE_SHUTDOWN_SECONDS || "300");
const HUNT_IDLE_SHUTDOWN_SECONDS = Number(process.env.HUNT_IDLE_SHUTDOWN_SECONDS || "90");
const ESCALATION_IDLE_SHUTDOWN_SECONDS = ParseOptionalPositiveSeconds(process.env.ESCALATION_IDLE_SHUTDOWN_SECONDS);

function ParseOptionalPositiveSeconds(Value: string | undefined){
    if(Value == undefined || Value.trim().length === 0){
        return undefined;
    }

    const ParsedValue = Number(Value);

    if(!Number.isFinite(ParsedValue) || ParsedValue <= 0){
        return undefined;
    }

    return ParsedValue;
}

function IsEscalationServer(HuntId: string | undefined, MatchmakerHuntId: string | undefined, MapPath: string | undefined){
    return [HuntId, MatchmakerHuntId, MapPath]
        .some((Value) => Value?.toLowerCase().includes("escalation"));
}

function GetHuntIdleShutdownSeconds(HuntId: string | undefined, MatchmakerHuntId: string | undefined, MapPath: string | undefined){
    if(IsEscalationServer(HuntId, MatchmakerHuntId, MapPath)){
        return ESCALATION_IDLE_SHUTDOWN_SECONDS;
    }

    return HUNT_IDLE_SHUTDOWN_SECONDS;
}

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

function IsProcessAlive(ProcessId: number){
    try{
        kill(ProcessId, 0);
        return true;
    }
    catch{
        return false;
    }
}

function IsGameserverProcessAlive(GameserverToCheck: Gameserver){
    return IsProcessAlive(GameserverToCheck.processId);
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

function RegisterPendingGameserverReady(Id: string, Port: number, Token: string){
    return new Promise<GameserverReadyPayload>((resolve) => {
        PendingGameserverReadyById.set(Id, {
            port: Port,
            token: Token,
            resolve: resolve
        });
    });
}

export function HandleGameserverReadyCallback(Token: string | undefined, Body: unknown){
    if(typeof Body !== "object" || Body == undefined){
        return {
            status: 400,
            body: {ready: false, error: "invalid_body"}
        };
    }

    const Payload = Body as Partial<GameserverReadyPayload>;

    if(typeof Payload.id !== "string" || typeof Payload.port !== "number" || typeof Payload.pid !== "number"){
        return {
            status: 400,
            body: {ready: false, error: "invalid_payload"}
        };
    }

    const PendingReady = PendingGameserverReadyById.get(Payload.id);

    if(PendingReady == undefined){
        return {
            status: 404,
            body: {ready: false, error: "unknown_gameserver"}
        };
    }

    if(Token !== PendingReady.token){
        return {
            status: 403,
            body: {ready: false, error: "invalid_token"}
        };
    }

    if(Payload.port !== PendingReady.port){
        return {
            status: 409,
            body: {ready: false, error: "port_mismatch"}
        };
    }

    PendingReady.resolve({
        id: Payload.id,
        port: Payload.port,
        pid: Payload.pid
    });

    return {
        status: 200,
        body: {ready: true}
    };
}

async function WaitForProcessExit(ProcessId: number, Port: number, ShouldStop: () => boolean): Promise<never>{
    while(!ShouldStop()){
        if(!IsProcessAlive(ProcessId)){
            throw new Error(`Gameserver on port ${Port} stopped during startup: process ${ProcessId} exited`);
        }

        await setTimeout(250);
    }

    return await new Promise<never>(() => {});
}

async function WaitForGameserverReady(StartedProcess: StartedGameserverProcess, Id: string, Port: number, ReadyPromise: Promise<GameserverReadyPayload>){
    let StopPollingProcess = false;
    const StartupFailurePromise = StartedProcess.child != undefined
        ? new Promise<never>((_, reject) => {
            StartedProcess.child!.once("exit", (Code, Signal) => {
                reject(new Error(`Gameserver on port ${Port} stopped during startup: exit code ${Code ?? "null"} signal ${Signal ?? "null"}`));
            });

            StartedProcess.child!.once("error", (SpawnError) => {
                reject(new Error(`Gameserver on port ${Port} stopped during startup: spawn error: ${SpawnError.message}`));
            });
        })
        : WaitForProcessExit(StartedProcess.processId, Port, () => StopPollingProcess);

    try{
        return await Promise.race([
            ReadyPromise,
            StartupFailurePromise,
            setTimeout(GAMESERVER_STARTUP_TIMEOUT_SECONDS * 1000).then(() => {
                throw new Error(`Gameserver on port ${Port} did not report ready within ${GAMESERVER_STARTUP_TIMEOUT_SECONDS}s`);
            })
        ]);
    }
    finally{
        StopPollingProcess = true;
        PendingGameserverReadyById.delete(Id);
    }
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

function StartWindowsGameserverMinimized(Args: string[]): StartedGameserverProcess{
    const ProcessIdOutput = execFileSync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "(Start-Process -FilePath $args[0] -ArgumentList $args[1..($args.Length - 1)] -WindowStyle Minimized -PassThru).Id",
        GAMESERVER_BINARY_PATH,
        ...Args
    ], {encoding: "utf8"}).trim();
    const ProcessId = Number(ProcessIdOutput);

    if(!Number.isInteger(ProcessId) || ProcessId <= 0){
        throw new Error(`Failed to start minimized gameserver process; got PID output "${ProcessIdOutput}"`);
    }

    return {
        processId: ProcessId,
        child: undefined
    };
}

function StartGameserverProcess(Args: string[]): StartedGameserverProcess{
    if(process.platform === "win32"){
        return StartWindowsGameserverMinimized(Args);
    }

    const Child = spawn(GAMESERVER_BINARY_PATH, Args, {
        detached: true,
        stdio: "ignore"
    });

    Child.unref();

    return {
        processId: Child.pid!,
        child: Child
    };
}

export async function CleanupServer(ServerToShutdown: Gameserver){
    const WasTracked = Gameservers.includes(ServerToShutdown);
    Gameservers = Gameservers.filter(Server => Server !== ServerToShutdown);

    if(!WasTracked && RamsgateServer !== ServerToShutdown && TrainingDojoServer !== ServerToShutdown){
        logger.warn(`Skipping cleanup for already removed gameserver ${ServerToShutdown.processId} on port ${ServerToShutdown.port}`);
        return;
    }

    if(ServerToShutdown.isRamsgate){
        logger.warn("RAMSGATE HAS FALLEN! Scheduling restart!");

        if(RamsgateServer === ServerToShutdown){
            RamsgateServer = undefined;
        }

        ScheduleRamsgateRestart("watchdog_restart");
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

async function CleanupFailedStartup(NewGameserver: Gameserver, Options: StartServerOptions){
    NewGameserver.expectedShutdownReason = "startup_failed";

    try{
        kill(NewGameserver.processId);
    }
    catch(Error){
        logger.warn(Error, `Failed to signal failed gameserver startup ${NewGameserver.processId} on port ${NewGameserver.port}`);
    }

    Gameservers = Gameservers.filter(Server => Server !== NewGameserver);

    if(Options.isRamsgate){
        if(RamsgateServer === NewGameserver){
            RamsgateServer = undefined;
        }

        ScheduleRamsgateRestart("startup_retry");
        return;
    }

    if(Options.isTrainingDojo){
        if(TrainingDojoServer === NewGameserver){
            TrainingDojoServer = undefined;
        }

        TrainingDojoStartup = undefined;
        return;
    }

    FreePorts.push(NewGameserver.port);
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

    const ReadyCallbackToken = crypto.randomBytes(32).toString("hex");
    const ReadyPromise = RegisterPendingGameserverReady(Id, Port, ReadyCallbackToken);

    const GameserverArgs = [
        METAGAME_API_KEY,
        Port.toString(),
        Options.map,
        Options.behemoth != undefined ? Options.behemoth : "NO_BEHEMOTH",
        Options.matchmakerHuntId != undefined ? Options.matchmakerHuntId : "NO_MM_HUNTID",
        Options.expectedPlayers != undefined ? TransformExpectedPlayerArgs(Options.expectedPlayers) : "NO_EXPECTED_PLAYERS",
        MY_IP + ":" + Port.toString(),
        Id,
        GAMESERVER_READY_CALLBACK_URL,
        ReadyCallbackToken,
        ...STANDARD_GAMESERVER_ARGS
    ];

    const StartedProcess = StartGameserverProcess(GameserverArgs);

    StartedProcess.child?.on("error", (Error) => {
        logger.error(Error, `Gameserver process failed to start for port ${Port}`);
    });
    let StartupCompleted = false;
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
        processId: StartedProcess.processId,
        startTime: new Date(),
        lastTouchedTime: new Date(),
        shutdownAfterSeconds: Options.shutdownAfterSeconds,
        expectedShutdownReason: undefined
    };

    StartedProcess.child?.on("exit", (Code, Signal) => {
        const ExitMessage = `Gameserver process ${StartedProcess.processId} on port ${Port} exited with code ${Code ?? "null"} signal ${Signal ?? "null"}`;

        if(NewGameserver.expectedShutdownReason != undefined){
            logger.info(`${ExitMessage} after expected shutdown: ${NewGameserver.expectedShutdownReason}`);
            return;
        }

        logger.warn(ExitMessage);

        if(!StartupCompleted){
            return;
        }

        void CleanupServer(NewGameserver).catch((Error) => {
            logger.error(Error, `Failed to cleanup gameserver ${StartedProcess.processId} on port ${Port} after unexpected exit`);
        });
    });

    Gameservers.push(NewGameserver);

    try{
        const ReadyPayload = await WaitForGameserverReady(StartedProcess, Id, Port, ReadyPromise);
        NewGameserver.processId = ReadyPayload.pid;
    }
    catch(Error){
        await CleanupFailedStartup(NewGameserver, Options);
        throw Error;
    }

    StartupCompleted = true;

    logger.info(`Gameserver ${NewGameserver.processId} is ready on ${MY_IP}:${Port} origin=${Options.origin} trigger=${Options.trigger} map=${Options.map}`);

    return NewGameserver;
}

async function StartRamsgateServer(Trigger: string){
    return await StartServer({
        map: RAMSGATE_MAP_PATH,
        behemoth: undefined,
        matchmakerHuntId: undefined,
        expectedPlayers: undefined,
        isRamsgate: true,
        isTrainingDojo: false,
        origin: "RAMSGATE_PREWARM",
        trigger: Trigger,
        shutdownAfterSeconds: undefined
    });
}

function ScheduleRamsgateRestart(Trigger: string){
    if(RamsgateRestart != undefined){
        logger.warn(`Ramsgate restart already in progress; ignoring duplicate trigger ${Trigger}`);
        return;
    }

    RamsgateRestart = (async () => {
        while(RamsgateServer == undefined){
            try{
                RamsgateServer = await StartRamsgateServer(Trigger);
                logger.info(`Ramsgate restarted on ${MY_IP}:${RamsgateServer.port}`);
                return;
            }
            catch(Error){
                logger.error(Error, `Failed to restart Ramsgate; retrying in ${RAMSGATE_RESTART_RETRY_SECONDS}s`);
                await setTimeout(RAMSGATE_RESTART_RETRY_SECONDS * 1000);
            }
        }
    })().finally(() => {
        RamsgateRestart = undefined;
    });
}

export function GetRamsgateConnectionDetails(){
    if(RamsgateServer == undefined){
        throw new Error("Ramsgate server has not started");
    }

    return {
        id: RamsgateServer.id,
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
        id: TrainingDojoServer.id,
        host: MY_IP,
        port: TrainingDojoServer.port
    };
}

function FindGameserverForPlayer(PlayerId: string){
    return Gameservers.find((Candidate) => Candidate.expectedPlayers?.some((Player) => Player.playerUid === PlayerId));
}

export async function GetGameserverStatusForPlayer(PlayerId: string){
    const Server = FindGameserverForPlayer(PlayerId);

    if(Server == undefined){
        return {
            found: false,
            joinable: false
        };
    }

    const ProcessAlive = IsGameserverProcessAlive(Server);
    const PortBound = await IsUdpPortInUse(Server.port);
    const Joinable = ProcessAlive && PortBound && Server.expectedShutdownReason == undefined;

    return {
        found: true,
        joinable: Joinable,
        server: {
            host: MY_IP,
            port: Server.port,
            id: Server.id,
            origin: Server.origin,
            map: Server.map,
            matchmakerHuntId: Server.matchmakerHuntId,
            expectedPlayers: Server.expectedPlayers,
            processAlive: ProcessAlive,
            portBound: PortBound,
            lastTouchedTime: Server.lastTouchedTime.toISOString()
        }
    };
}

export function TouchGameserverForPlayer(PlayerId: string){
    const Server = FindGameserverForPlayer(PlayerId);

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
        id: Server.id,
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
    const ShutdownAfterSeconds = GetHuntIdleShutdownSeconds(undefined, undefined, GameArgs);

    const GameServerToReturn = await StartServer({
        map: Map,
        behemoth: Behemoth,
        matchmakerHuntId: undefined,
        expectedPlayers: TransformExpectedPlayers(undefined, ExpectedPlayers),
        isRamsgate: false,
        isTrainingDojo: false,
        origin: "HUNT_ARGS",
        trigger: GameArgs,
        shutdownAfterSeconds: ShutdownAfterSeconds
    });

    return {
        id: GameServerToReturn.id,
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
        shutdownAfterSeconds: GetHuntIdleShutdownSeconds(HuntId, MatchmakerHuntId, MapPath)
    });

    return {
        id: GameServerToReturn.id,
        host: MY_IP,
        port: GameServerToReturn.port
    }
}

export async function Startup(){
    for(let i = PORT_RANGE_BEGIN; i <= PORT_RANGE_END - 2; i++){
        FreePorts.push(i);
    }

    RamsgateServer = await StartRamsgateServer("deploy_startup");

    if(PREWARM_TRAINING_DOJO){
        await GetOrStartTrainingDojoConnectionDetails("TRAINING_DOJO_PREWARM");
    }
}
