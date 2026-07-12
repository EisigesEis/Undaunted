import { logger } from "../logger";
import crypto from "node:crypto";
import { UpdatePlayerLocation, UpdatePlayerMatchmakingActivity } from "./undauntedapi";

const MATCHMAKING_MODE = process.env.MATCHMAKING_MODE;
const DEPLOYSERVER_URL = process.env.DEPLOYSERVER_URL;
const DEPLOYSERVER_MATCHMAKING_PATH = "/api/matchmaker/handle-matchmaking-for-player";
const DEPLOYSERVER_TOUCH_PLAYER_PATH = "/api/matchmaker/touch-player";
const DEPLOYSERVER_STATUS_PATH = "/api/matchmaker/player-server-status";
const DEPLOYSERVER_MATCHMAKING_TIMEOUT_MS = Number(process.env.DEPLOYSERVER_MATCHMAKING_TIMEOUT_MS || "90000");
const DEPLOYSERVER_TOUCH_TIMEOUT_MS = Number(process.env.DEPLOYSERVER_TOUCH_TIMEOUT_MS || "1000");
const DEPLOYSERVER_STATUS_TIMEOUT_MS = Number(process.env.DEPLOYSERVER_STATUS_TIMEOUT_MS || "1000");
const MATCHMAKING_QUEUE_WAIT_MS = Number(process.env.MATCHMAKING_QUEUE_WAIT_SECONDS || "3") * 1000;
const MATCHMAKING_RECONNECT_WINDOW_MS = Number(process.env.MATCHMAKING_RECONNECT_WINDOW_SECONDS || "120") * 1000;
const MATCHMAKING_SESSION_TTL_MS = Number(process.env.MATCHMAKING_SESSION_TTL_SECONDS || "300") * 1000;

export type MatchmakingPhase = "QUEUED" | "STARTING" | "READY" | "FAILED" | "EXPIRED";

type MatchmakingQueueData = {
    Players: string[],
    LastPlayerAddedTime: Date,
    Resolved: boolean
};

export type MatchmakingSession = {
    candidateId: string,
    userId: string,
    gameMode: string,
    gameArgs: string,
    huntId: string,
    host: string,
    port: number,
    phase: MatchmakingPhase,
    statusReason: string | undefined,
    createdAt: Date,
    updatedAt: Date,
    readyAt: Date | undefined,
    lastHeartbeatAt: Date | undefined,
    serverId: string | undefined
};

type LaunchGameResult = {
    succeeded: boolean,
    host: string,
    port: number,
    serverId: string | undefined,
    statusReason: string | undefined
};

type DeployserverPlayerStatus = {
    found: boolean,
    joinable: boolean,
    server?: {
        host: string,
        port: number,
        id: string,
        lastTouchedTime?: string
    }
};

let MatchmakingQueueMap: Map<string, MatchmakingQueueData> = new Map<string, MatchmakingQueueData>(); // Key is HuntID
let MatchmakingSessionMap: Map<string, MatchmakingSession> = new Map<string, MatchmakingSession>(); // Key is PlayerID

function HuntIdRequiresMatchmaking(HuntId: string | undefined){
    return HuntId != undefined && !HuntId.includes("Ramsgate") && !HuntId.includes("Dojo");
}

function CreateMatchmakingSession(PlayerId: string, GameMode: string, GameArgs: string, HuntId: string, Phase: MatchmakingPhase): MatchmakingSession{
    const Now = new Date();

    return {
        candidateId: crypto.randomUUID(),
        userId: PlayerId,
        gameMode: GameMode,
        gameArgs: GameArgs,
        huntId: HuntId,
        host: "",
        port: 0,
        phase: Phase,
        statusReason: undefined,
        createdAt: Now,
        updatedAt: Now,
        readyAt: undefined,
        lastHeartbeatAt: undefined,
        serverId: undefined
    };
}

async function SyncMatchmakingActivity(Session: MatchmakingSession){
    await UpdatePlayerMatchmakingActivity(Session.userId, {
        CandidateId: Session.candidateId,
        GameMode: Session.gameMode,
        HuntId: Session.huntId,
        Phase: Session.phase,
        StatusReason: Session.statusReason,
        Host: Session.host || undefined,
        Port: Session.port || undefined,
        ServerId: Session.serverId,
        ReadyTime: Session.readyAt?.getTime()
    });

    if(Session.phase === "READY"){
        await UpdatePlayerLocation(Session.userId, Session.huntId);
    }
}

function MarkSessionUpdated(Session: MatchmakingSession){
    Session.updatedAt = new Date();
}

function MarkSessionReady(Session: MatchmakingSession, GameOnDeployServer: LaunchGameResult){
    Session.host = GameOnDeployServer.host;
    Session.port = GameOnDeployServer.port;
    Session.serverId = GameOnDeployServer.serverId;
    Session.phase = "READY";
    Session.statusReason = undefined;
    Session.readyAt = new Date();
    MarkSessionUpdated(Session);
}

function MarkSessionFailed(Session: MatchmakingSession, Reason: string){
    Session.phase = "FAILED";
    Session.statusReason = Reason;
    MarkSessionUpdated(Session);
}

function MarkSessionExpired(Session: MatchmakingSession, Reason: string){
    Session.phase = "EXPIRED";
    Session.statusReason = Reason;
    MarkSessionUpdated(Session);
}

function ExpireStaleSession(Session: MatchmakingSession){
    if(Session.phase === "FAILED" || Session.phase === "EXPIRED"){
        return;
    }

    const LastMeaningfulUpdate = Session.lastHeartbeatAt ?? Session.readyAt ?? Session.updatedAt;
    if(Date.now() - LastMeaningfulUpdate.getTime() > MATCHMAKING_SESSION_TTL_MS){
        MarkSessionExpired(Session, "matchmaking_session_expired");
    }
}

async function LaunchGameOnDeployserver(GameMode: string, GameArgs: string, HuntId: string, ExpectedPlayers: string[] | undefined): Promise<LaunchGameResult>{
    logger.info(`Querying DeployServer for GameMode: ${GameMode} HuntId ${HuntId} with ${ExpectedPlayers?.length} Expected Players!`);

    const URL = "http://" + DEPLOYSERVER_URL + DEPLOYSERVER_MATCHMAKING_PATH;

    let MatchmakingResult: Response;

    try{
        MatchmakingResult = await fetch(URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                GameMode: GameMode,
                GameArgs: GameArgs,
                HuntId: HuntId,
                ExpectedPlayers: ExpectedPlayers
            }),
            signal: AbortSignal.timeout(DEPLOYSERVER_MATCHMAKING_TIMEOUT_MS)
        });
    }
    catch(Error){
        logger.error(Error, `DeployServer matchmaking request timed out or failed for HuntId ${HuntId}`);

        return {
            succeeded: false,
            host: "",
            port: 0,
            serverId: undefined,
            statusReason: "deployserver_request_failed"
        };
    }

    if(MatchmakingResult.status === 200){
        const MatchmakingData = await MatchmakingResult.json();

        logger.info(`DeployServer returned gameserver ${MatchmakingData.host}:${MatchmakingData.port}`);

        return {
            succeeded: true,
            host: MatchmakingData.host,
            port: MatchmakingData.port,
            serverId: MatchmakingData.id,
            statusReason: undefined
        }
    }

    logger.error(`DeployServer returned status ${MatchmakingResult.status}`);

    return {
        succeeded: false,
        host: "",
        port: 0,
        serverId: undefined,
        statusReason: `deployserver_status_${MatchmakingResult.status}`
    };
}

async function QueryDeployserverForPlayerStatus(PlayerId: string): Promise<DeployserverPlayerStatus>{
    if(MATCHMAKING_MODE !== "DEPLOYSERVER"){
        return {
            found: false,
            joinable: false
        };
    }

    const URL = "http://" + DEPLOYSERVER_URL + DEPLOYSERVER_STATUS_PATH;

    try{
        const StatusResult = await fetch(URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                PlayerId: PlayerId
            }),
            signal: AbortSignal.timeout(DEPLOYSERVER_STATUS_TIMEOUT_MS)
        });

        if(StatusResult.status !== 200){
            return {
                found: false,
                joinable: false
            };
        }

        return await StatusResult.json() as DeployserverPlayerStatus;
    }
    catch(Error){
        logger.warn(Error, `Failed to get active gameserver status for player ${PlayerId}`);
        return {
            found: false,
            joinable: false
        };
    }
}

export async function TouchDeployserverForPlayerActivity(PlayerId: string){
    if(MATCHMAKING_MODE !== "DEPLOYSERVER"){
        return false;
    }

    const URL = "http://" + DEPLOYSERVER_URL + DEPLOYSERVER_TOUCH_PLAYER_PATH;

    try{
        const TouchResult = await fetch(URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                PlayerId: PlayerId
            }),
            signal: AbortSignal.timeout(DEPLOYSERVER_TOUCH_TIMEOUT_MS)
        });

        return TouchResult.status === 200;
    }
    catch(Error){
        logger.warn(Error, `Failed to touch active gameserver for player ${PlayerId}`);
        return false;
    }
}

async function PopQueue(HuntId: string){
    const MatchmakingQueue = MatchmakingQueueMap.get(HuntId);

    if(MatchmakingQueue == undefined || MatchmakingQueue.Resolved){
        return;
    }

    MatchmakingQueue.Resolved = true;

    for(const Player of MatchmakingQueue.Players){
        const Session = MatchmakingSessionMap.get(Player);

        if(Session != undefined){
            Session.phase = "STARTING";
            MarkSessionUpdated(Session);
            await SyncMatchmakingActivity(Session);
        }
    }
    
    const GameOnDeployServer = await LaunchGameOnDeployserver("ISLAND", "", HuntId, MatchmakingQueue.Players);

    for(const Player of MatchmakingQueue.Players){
        const Session = MatchmakingSessionMap.get(Player);

        if(Session == undefined){
            continue;
        }

        if(GameOnDeployServer.succeeded){
            MarkSessionReady(Session, GameOnDeployServer);
        }
        else{
            MarkSessionFailed(Session, GameOnDeployServer.statusReason ?? "gameserver_startup_failed");
        }

        await SyncMatchmakingActivity(Session);
    }

    if(MatchmakingQueueMap.get(HuntId) === MatchmakingQueue){
        MatchmakingQueueMap.delete(HuntId);
    }
}

async function TryReuseReadySession(PlayerId: string, GameMode: string, HuntId: string){
    const ExistingSession = MatchmakingSessionMap.get(PlayerId);

    if(ExistingSession == undefined){
        return undefined;
    }

    ExpireStaleSession(ExistingSession);

    if(ExistingSession.phase !== "READY" || ExistingSession.gameMode !== GameMode || ExistingSession.huntId !== HuntId){
        return undefined;
    }

    if(ExistingSession.readyAt == undefined || Date.now() - ExistingSession.readyAt.getTime() > MATCHMAKING_RECONNECT_WINDOW_MS){
        MarkSessionExpired(ExistingSession, "reconnect_window_expired");
        await SyncMatchmakingActivity(ExistingSession);
        return undefined;
    }

    const DeployserverStatus = await QueryDeployserverForPlayerStatus(PlayerId);

    if(DeployserverStatus.joinable && DeployserverStatus.server != undefined){
        ExistingSession.host = DeployserverStatus.server.host;
        ExistingSession.port = DeployserverStatus.server.port;
        ExistingSession.serverId = DeployserverStatus.server.id;
        MarkSessionUpdated(ExistingSession);
        await SyncMatchmakingActivity(ExistingSession);

        return ExistingSession;
    }

    MarkSessionExpired(ExistingSession, "assigned_gameserver_not_joinable");
    await SyncMatchmakingActivity(ExistingSession);
    return undefined;
}

export async function CheckAndUpdateQueueStatus(PlayerId: string){
    const Session = MatchmakingSessionMap.get(PlayerId);

    if(Session == undefined){
        return undefined;
    }

    ExpireStaleSession(Session);

    if(Session.phase === "QUEUED" || Session.phase === "STARTING"){
        const MatchmakingQueue = MatchmakingQueueMap.get(Session.huntId);

        if(MatchmakingQueue != undefined && (new Date()).getTime() - MatchmakingQueue.LastPlayerAddedTime.getTime() > MATCHMAKING_QUEUE_WAIT_MS){
            await PopQueue(Session.huntId);
        }
    }

    await SyncMatchmakingActivity(Session);

    return Session;
}

function CreateQueue(HuntId: string, PlayerId: string){
    const Queue = {
        Players: [PlayerId],
        LastPlayerAddedTime: new Date(),
        Resolved: false
    };

    MatchmakingQueueMap.set(HuntId, Queue);

    return Queue;
}

async function QueuePlayer(HuntId: string, PlayerId: string){
    const ExistingQueue = MatchmakingQueueMap.get(HuntId);

    const Session = CreateMatchmakingSession(PlayerId, "ISLAND", "", HuntId, "QUEUED");
    MatchmakingSessionMap.set(PlayerId, Session);
    let ActiveQueue = ExistingQueue;

    if(ActiveQueue != undefined && ActiveQueue.Resolved){
        logger.info(`Existing queue for HuntId ${HuntId} is already starting; creating a fresh queue for ${PlayerId}`);
        ActiveQueue = undefined;
    }

    if(ActiveQueue != undefined){
        ActiveQueue.Players.push(PlayerId);
        ActiveQueue.LastPlayerAddedTime = new Date();

        if(ActiveQueue.Players.length >= 4 || MATCHMAKING_QUEUE_WAIT_MS <= 0){
            await PopQueue(HuntId);
        }
    }
    else{
        CreateQueue(HuntId, PlayerId);

        if(MATCHMAKING_QUEUE_WAIT_MS <= 0){
            await PopQueue(HuntId);
        }
    }

    await SyncMatchmakingActivity(Session);

    return Session;
}

export async function HandlePlayerMatchmaking(GameMode: string, GameArgs: string, HuntId: string, PlayerId: string){
    if(MATCHMAKING_MODE === "DISABLED"){
        logger.warn("Matchmaking is disabled, refusing MM!");

        return undefined;
    }

    if(MATCHMAKING_MODE !== "DEPLOYSERVER"){
        logger.fatal("Unsupported MATCHMAKING_MODE!");

        return undefined;
    }

    const NormalizedHuntId = HuntId ?? "";
    const NormalizedGameArgs = GameArgs ?? "";
    const ReusableSession = await TryReuseReadySession(PlayerId, GameMode, NormalizedHuntId);

    if(ReusableSession != undefined){
        logger.info(`Reusing ready matchmaking session ${ReusableSession.candidateId} for ${PlayerId}`);
        return ReusableSession;
    }

    if(!HuntIdRequiresMatchmaking(NormalizedHuntId)){
        const Session = CreateMatchmakingSession(PlayerId, GameMode, NormalizedGameArgs, NormalizedHuntId, "STARTING");
        MatchmakingSessionMap.set(PlayerId, Session);
        await SyncMatchmakingActivity(Session);

        const GameOnDeployServer = await LaunchGameOnDeployserver(GameMode, NormalizedGameArgs, NormalizedHuntId, [PlayerId]);

        if(GameOnDeployServer.succeeded){
            MarkSessionReady(Session, GameOnDeployServer);
        }
        else{
            MarkSessionFailed(Session, GameOnDeployServer.statusReason ?? "gameserver_startup_failed");
        }

        await SyncMatchmakingActivity(Session);

        return GameOnDeployServer.succeeded ? Session : undefined;
    }

    return await QueuePlayer(NormalizedHuntId, PlayerId);
}

export async function MarkMatchmakingHeartbeat(PlayerId: string){
    const Session = MatchmakingSessionMap.get(PlayerId);

    if(Session == undefined){
        return;
    }

    Session.lastHeartbeatAt = new Date();
    MarkSessionUpdated(Session);
    await SyncMatchmakingActivity(Session);
}

function SerializeSession(Session: MatchmakingSession){
    return {
        candidateId: Session.candidateId,
        userId: Session.userId,
        gameMode: Session.gameMode,
        huntId: Session.huntId,
        host: Session.host || undefined,
        port: Session.port || undefined,
        phase: Session.phase,
        statusReason: Session.statusReason,
        createdAt: Session.createdAt.toISOString(),
        updatedAt: Session.updatedAt.toISOString(),
        readyAt: Session.readyAt?.toISOString(),
        lastHeartbeatAt: Session.lastHeartbeatAt?.toISOString(),
        serverId: Session.serverId
    };
}

export function GetMatchmakingDebugData(){
    return {
        sessions: [...MatchmakingSessionMap.values()].map(SerializeSession),
        queues: [...MatchmakingQueueMap.entries()].map(([HuntId, Queue]) => ({
            huntId: HuntId,
            players: Queue.Players,
            lastPlayerAddedTime: Queue.LastPlayerAddedTime.toISOString(),
            resolved: Queue.Resolved
        }))
    };
}
