import { logger } from "../logger";
import crypto from "node:crypto";
import { UpdatePlayerLocation, UpdatePlayerMatchmakingActivity } from "./undauntedapi";
import { GetPartyById, GetPartyForPlayer } from "./party";

const DEPLOYSERVER_MATCHMAKING_PATH = "/api/matchmaker/handle-matchmaking-for-player";
const DEPLOYSERVER_TOUCH_PLAYER_PATH = "/api/matchmaker/touch-player";
const DEPLOYSERVER_STATUS_PATH = "/api/matchmaker/player-server-status";
const DEPLOYSERVER_MATCHMAKING_TIMEOUT_MS = Number(process.env.DEPLOYSERVER_MATCHMAKING_TIMEOUT_MS || "90000");
const DEPLOYSERVER_TOUCH_TIMEOUT_MS = Number(process.env.DEPLOYSERVER_TOUCH_TIMEOUT_MS || "1000");
const DEPLOYSERVER_STATUS_TIMEOUT_MS = Number(process.env.DEPLOYSERVER_STATUS_TIMEOUT_MS || "1000");
const MATCHMAKING_QUEUE_WAIT_MS = Number(process.env.MATCHMAKING_QUEUE_WAIT_SECONDS || "3") * 1000;
const MATCHMAKING_RECONNECT_WINDOW_MS = Number(process.env.MATCHMAKING_RECONNECT_WINDOW_SECONDS || "120") * 1000;
const MATCHMAKING_SESSION_TTL_MS = Number(process.env.MATCHMAKING_SESSION_TTL_SECONDS || "300") * 1000;

function MatchmakingMode(){
    return process.env.MATCHMAKING_MODE;
}

function DeployserverUrl(){
    return process.env.DEPLOYSERVER_URL;
}

export type MatchmakingPhase = "QUEUED" | "STARTING" | "READY" | "FAILED" | "EXPIRED";

type MatchmakingQueueData = {
    GameMode: string,
    GameArgs: string,
    Groups: string[][],
    Players: string[],
    LastPlayerAddedTime: Date,
    Resolved: boolean,
    FreshInstance: boolean
};

export type MatchmakingSession = {
    candidateId: string,
    userId: string,
    playerIds: string[],
    partyId: string | undefined,
    privateMatch: boolean,
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
    serverId: string | undefined,
    cancelled: boolean
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

let MatchmakingQueueMap: Map<string, MatchmakingQueueData[]> = new Map<string, MatchmakingQueueData[]>(); // Key is HuntID
let MatchmakingSessionMap: Map<string, MatchmakingSession> = new Map<string, MatchmakingSession>(); // Key is PlayerID

function HuntIdRequiresMatchmaking(HuntId: string | undefined){
    return HuntId != undefined && !HuntId.includes("Ramsgate") && !HuntId.includes("Dojo");
}

function IsTrialsHuntId(HuntId: string | undefined){
    return HuntId?.startsWith("Trials_PlayerHunt_") === true
        || HuntId?.startsWith("CR19_PlayerHunt_Arena_") === true;
}

function CreateMatchmakingSession(PlayerId: string, PlayerIds: string[], PartyId: string | undefined, PrivateMatch: boolean, GameMode: string, GameArgs: string, HuntId: string, Phase: MatchmakingPhase): MatchmakingSession{
    const Now = new Date();

    return {
        candidateId: crypto.randomUUID(),
        userId: PlayerId,
        playerIds: [...new Set(PlayerIds)],
        partyId: PartyId,
        privateMatch: PrivateMatch,
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
        serverId: undefined,
        cancelled: false
    };
}

async function SyncMatchmakingActivity(Session: MatchmakingSession){
    for(const PlayerId of Session.playerIds){
        await UpdatePlayerMatchmakingActivity(PlayerId, {
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
            await UpdatePlayerLocation(PlayerId, Session.huntId);
        }
    }
}

function MarkSessionUpdated(Session: MatchmakingSession){
    Session.updatedAt = new Date();
}

function MarkSessionReady(Session: MatchmakingSession, GameOnDeployServer: LaunchGameResult){
    if(Session.cancelled){
        return;
    }

    Session.host = GameOnDeployServer.host;
    Session.port = GameOnDeployServer.port;
    Session.serverId = GameOnDeployServer.serverId;
    Session.phase = "READY";
    Session.statusReason = undefined;
    Session.readyAt = new Date();
    MarkSessionUpdated(Session);
    logger.info({
        candidateId: Session.candidateId,
        playerIds: Session.playerIds,
        partyId: Session.partyId,
        huntId: Session.huntId,
        host: Session.host,
        port: Session.port,
        serverId: Session.serverId
    }, "Matchmaking session ready");
}

function MarkSessionFailed(Session: MatchmakingSession, Reason: string){
    if(Session.cancelled){
        return;
    }

    Session.phase = "FAILED";
    Session.statusReason = Reason;
    MarkSessionUpdated(Session);
    logger.warn({
        candidateId: Session.candidateId,
        playerIds: Session.playerIds,
        partyId: Session.partyId,
        huntId: Session.huntId,
        reason: Reason
    }, "Matchmaking session failed");
}

function MarkSessionExpired(Session: MatchmakingSession, Reason: string){
    if(Session.cancelled){
        return;
    }

    Session.phase = "EXPIRED";
    Session.statusReason = Reason;
    MarkSessionUpdated(Session);
    logger.info({
        candidateId: Session.candidateId,
        playerIds: Session.playerIds,
        partyId: Session.partyId,
        huntId: Session.huntId,
        reason: Reason
    }, "Matchmaking session expired");
}

function RegisterSessionForPlayers(Session: MatchmakingSession) {
    for(const PlayerId of Session.playerIds){
        MatchmakingSessionMap.set(PlayerId, Session);
    }
}

function ExpireStaleSession(Session: MatchmakingSession){
    if(Session.phase === "FAILED" || Session.phase === "EXPIRED"){
        return false;
    }

    const LastMeaningfulUpdate = Session.lastHeartbeatAt ?? Session.readyAt ?? Session.updatedAt;
    if(Date.now() - LastMeaningfulUpdate.getTime() > MATCHMAKING_SESSION_TTL_MS){
        MarkSessionExpired(Session, "matchmaking_session_expired");
        return true;
    }

    return false;
}

async function LaunchGameOnDeployserver(GameMode: string, GameArgs: string, HuntId: string, ExpectedPlayers: string[] | undefined, FreshInstance = false): Promise<LaunchGameResult>{
    logger.info({
        gameMode: GameMode,
        huntId: HuntId,
        expectedPlayers: ExpectedPlayers ?? [],
        freshInstance: FreshInstance
    }, "Requesting deploy server matchmaking");

    const URL = "http://" + DeployserverUrl() + DEPLOYSERVER_MATCHMAKING_PATH;

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
                ExpectedPlayers: ExpectedPlayers,
                FreshInstance: FreshInstance
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

        logger.info({
            huntId: HuntId,
            host: MatchmakingData.host,
            port: MatchmakingData.port,
            serverId: MatchmakingData.id
        }, "Deploy server assigned gameserver");

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
    if(MatchmakingMode() !== "DEPLOYSERVER"){
        return {
            found: false,
            joinable: false
        };
    }

    const URL = "http://" + DeployserverUrl() + DEPLOYSERVER_STATUS_PATH;

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
    if(MatchmakingMode() !== "DEPLOYSERVER"){
        return false;
    }

    const URL = "http://" + DeployserverUrl() + DEPLOYSERVER_TOUCH_PLAYER_PATH;

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

async function PopQueue(HuntId: string, MatchmakingQueue: MatchmakingQueueData | undefined){
    if(MatchmakingQueue == undefined || MatchmakingQueue.Resolved){
        return;
    }

    MatchmakingQueue.Resolved = true;
    logger.info({
        huntId: HuntId,
        gameMode: MatchmakingQueue.GameMode,
        gameArgs: MatchmakingQueue.GameArgs,
        groups: MatchmakingQueue.Groups,
            players: MatchmakingQueue.Players,
            freshInstance: MatchmakingQueue.FreshInstance,
            queueAgeMs: Date.now() - MatchmakingQueue.LastPlayerAddedTime.getTime()
    }, "Starting matchmaking queue");

    for(const Session of UniqueSessionsForPlayers(MatchmakingQueue.Players)){
        if(Session.cancelled){
            continue;
        }

        Session.phase = "STARTING";
        MarkSessionUpdated(Session);
        await SyncMatchmakingActivity(Session);
    }
    
    const GameOnDeployServer = await LaunchGameOnDeployserver(MatchmakingQueue.GameMode, MatchmakingQueue.GameArgs, HuntId, MatchmakingQueue.Players, MatchmakingQueue.FreshInstance);

    for(const Session of UniqueSessionsForPlayers(MatchmakingQueue.Players)){
        if(Session.cancelled){
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

    const Queues = MatchmakingQueueMap.get(HuntId);
    if(Queues != undefined){
        const RemainingQueues = Queues.filter((Queue) => Queue !== MatchmakingQueue);
        if(RemainingQueues.length === 0){
            MatchmakingQueueMap.delete(HuntId);
        }
        else{
            MatchmakingQueueMap.set(HuntId, RemainingQueues);
        }
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

        logger.info({
            candidateId: ExistingSession.candidateId,
            playerId: PlayerId,
            huntId: HuntId,
            host: ExistingSession.host,
            port: ExistingSession.port,
            serverId: ExistingSession.serverId
        }, "Reusing ready matchmaking session");

        return ExistingSession;
    }

    MarkSessionExpired(ExistingSession, "assigned_gameserver_not_joinable");
    await SyncMatchmakingActivity(ExistingSession);
    return undefined;
}

async function TryReuseActiveSession(PlayerId: string, GameMode: string, GameArgs: string, HuntId: string, PlayerIds: string[], PrivateMatch: boolean) {
    const ExistingSession = MatchmakingSessionMap.get(PlayerId);
    if(ExistingSession == undefined){
        return undefined;
    }

    ExpireStaleSession(ExistingSession);

    const SameRequest =
        ExistingSession.gameMode === GameMode
        && ExistingSession.gameArgs === GameArgs
        && ExistingSession.huntId === HuntId
        && ExistingSession.privateMatch === PrivateMatch
        && SamePlayerSet(ExistingSession.playerIds, PlayerIds);

    if(SameRequest && (ExistingSession.phase === "QUEUED" || ExistingSession.phase === "STARTING")){
        logger.debug({
            candidateId: ExistingSession.candidateId,
            playerId: PlayerId,
            phase: ExistingSession.phase,
            huntId: HuntId,
            playerIds: ExistingSession.playerIds
        }, "Reusing active matchmaking session");
        return ExistingSession;
    }

    if(SameRequest && ExistingSession.phase === "READY"){
        return await TryReuseReadySession(PlayerId, GameMode, HuntId);
    }

    if(ExistingSession.phase !== "FAILED" && ExistingSession.phase !== "EXPIRED"){
        RemoveSession(ExistingSession, SameRequest ? "active_session_not_reusable" : "replaced_by_new_matchmaking_request");
    }

    return undefined;
}

export async function CheckAndUpdateQueueStatus(PlayerId: string){
    const Session = MatchmakingSessionMap.get(PlayerId);

    if(Session == undefined){
        return undefined;
    }

    const Expired = ExpireStaleSession(Session);
    if(Expired){
        await SyncMatchmakingActivity(Session);
        return Session;
    }

    if(Session.phase === "QUEUED" || Session.phase === "STARTING"){
        const MatchmakingQueue = FindQueueForPlayer(Session.huntId, PlayerId);

        if(MatchmakingQueue != undefined){
            const QueueAgeMs = Date.now() - MatchmakingQueue.LastPlayerAddedTime.getTime();
            if(QueueAgeMs > MATCHMAKING_QUEUE_WAIT_MS){
                logger.info({
                    candidateId: Session.candidateId,
                    playerId: PlayerId,
                    huntId: Session.huntId,
                    phase: Session.phase,
                    queueAgeMs: QueueAgeMs,
                    waitMs: MATCHMAKING_QUEUE_WAIT_MS
                }, "Matchmaking queue wait elapsed");
                await PopQueue(Session.huntId, MatchmakingQueue);
                return Session;
            }
            else{
                logger.debug({
                    candidateId: Session.candidateId,
                    playerId: PlayerId,
                    huntId: Session.huntId,
                    phase: Session.phase,
                    queueAgeMs: QueueAgeMs,
                    waitMs: MATCHMAKING_QUEUE_WAIT_MS
                }, "Matchmaking queue still waiting");
            }
        }
    }

    return Session;
}

export async function CancelNonReadyMatchmakingForFreshLogin(PlayerId: string) {
    const Session = MatchmakingSessionMap.get(PlayerId);
    if(Session == undefined || Session.phase === "READY" || Session.phase === "FAILED" || Session.phase === "EXPIRED"){
        return {
            cancelled: false,
            phase: Session?.phase,
            candidateId: Session?.candidateId,
            playerIds: Session?.playerIds ?? []
        };
    }

    const CancelledSession = {
        candidateId: Session.candidateId,
        phase: Session.phase,
        playerIds: [...Session.playerIds]
    };

    MarkSessionExpired(Session, "fresh_login_cleanup");
    await SyncMatchmakingActivity(Session);
    RemoveSession(Session, "fresh_login_cleanup");

    return {
        cancelled: true,
        ...CancelledSession
    };
}

function RemoveSession(Session: MatchmakingSession, Reason: string) {
    Session.cancelled = true;
    RemoveSessionFromQueues(Session, Reason);

    for(const PlayerId of Session.playerIds){
        if(MatchmakingSessionMap.get(PlayerId) === Session){
            MatchmakingSessionMap.delete(PlayerId);
        }
    }

    logger.info({
        candidateId: Session.candidateId,
        playerIds: Session.playerIds,
        huntId: Session.huntId,
        phase: Session.phase,
        reason: Reason
    }, "Removed matchmaking session");
}

function RemoveSessionFromQueues(Session: MatchmakingSession, Reason: string) {
    const Queues = MatchmakingQueueMap.get(Session.huntId);
    if(Queues == undefined){
        return;
    }

    let RemovedGroup = false;
    const RemainingQueues = Queues.map((Queue) => {
        const Groups = Queue.Groups.filter((Group) => !SamePlayerSet(Group, Session.playerIds));
        RemovedGroup ||= Groups.length !== Queue.Groups.length;

        return {
            ...Queue,
            Groups: Groups,
            Players: Groups.flat()
        };
    }).filter((Queue) => Queue.Groups.length > 0);

    if(!RemovedGroup){
        return;
    }

    if(RemainingQueues.length === 0){
        MatchmakingQueueMap.delete(Session.huntId);
    }
    else{
        MatchmakingQueueMap.set(Session.huntId, RemainingQueues);
    }

    logger.info({
        candidateId: Session.candidateId,
        huntId: Session.huntId,
        playerIds: Session.playerIds,
        reason: Reason
    }, "Removed matchmaking session from queue");
}

function ResolveMatchmakingGroup(PlayerId: string, RequestedPartyId: string | undefined) {
    const RequestedParty = GetPartyById(RequestedPartyId);
    const Party = RequestedParty?.members.has(PlayerId) === true
        ? RequestedParty
        : GetPartyForPlayer(PlayerId);

    if(Party == undefined){
        return {
            partyId: undefined,
            playerIds: [PlayerId]
        };
    }

    return {
        partyId: Party.partyId,
        playerIds: [...Party.members.keys()]
    };
}

function FindQueueForPlayer(HuntId: string, PlayerId: string) {
    return MatchmakingQueueMap.get(HuntId)?.find((Queue) => Queue.Players.includes(PlayerId));
}

function FindJoinableQueue(HuntId: string, GameMode: string, GameArgs: string, GroupSize: number) {
    return MatchmakingQueueMap.get(HuntId)?.find((Queue) =>
        !Queue.Resolved
        && Queue.GameMode === GameMode
        && Queue.GameArgs === GameArgs
        && Queue.Players.length + GroupSize <= 4);
}

function CreateQueue(HuntId: string, GameMode: string, GameArgs: string, PlayerIds: string[], FreshInstance: boolean){
    const Queue = {
        GameMode: GameMode,
        GameArgs: GameArgs,
        Groups: [[...PlayerIds]],
        Players: [...PlayerIds],
        LastPlayerAddedTime: new Date(),
        Resolved: false,
        FreshInstance: FreshInstance
    };

    const Queues = MatchmakingQueueMap.get(HuntId) ?? [];
    Queues.push(Queue);
    MatchmakingQueueMap.set(HuntId, Queues);
    logger.info({
        huntId: HuntId,
        gameMode: GameMode,
        gameArgs: GameArgs,
        playerIds: PlayerIds,
        queueCount: Queues.length
    }, "Created matchmaking queue");

    return Queue;
}

async function QueueGroup(HuntId: string, PlayerId: string, PlayerIds: string[], PartyId: string | undefined, GameMode: string, GameArgs: string, FreshInstance: boolean){
    const Session = CreateMatchmakingSession(PlayerId, PlayerIds, PartyId, false, GameMode, GameArgs, HuntId, "QUEUED");
    RegisterSessionForPlayers(Session);
    let ActiveQueue = FindJoinableQueue(HuntId, GameMode, GameArgs, PlayerIds.length);

    if(ActiveQueue != undefined){
        ActiveQueue.FreshInstance ||= FreshInstance;
        ActiveQueue.Groups.push([...PlayerIds]);
        ActiveQueue.Players.push(...PlayerIds);
        ActiveQueue.LastPlayerAddedTime = new Date();
        logger.info({
            huntId: HuntId,
            gameMode: GameMode,
            gameArgs: GameArgs,
            partyId: PartyId,
            groupPlayerIds: PlayerIds,
            queuedPlayers: ActiveQueue.Players,
            groupCount: ActiveQueue.Groups.length
        }, "Added group to matchmaking queue");

        if(ActiveQueue.Players.length >= 4 || MATCHMAKING_QUEUE_WAIT_MS <= 0){
            await PopQueue(HuntId, ActiveQueue);
        }
    }
    else{
        ActiveQueue = CreateQueue(HuntId, GameMode, GameArgs, PlayerIds, FreshInstance);

        if(MATCHMAKING_QUEUE_WAIT_MS <= 0){
            await PopQueue(HuntId, ActiveQueue);
        }
    }

    await SyncMatchmakingActivity(Session);
    logger.info({
        candidateId: Session.candidateId,
        userId: PlayerId,
        partyId: PartyId,
        playerIds: PlayerIds,
        huntId: HuntId,
        phase: Session.phase
    }, "Queued matchmaking group");

    return Session;
}

export async function HandlePlayerMatchmaking(GameMode: string, GameArgs: string, HuntId: string, PlayerId: string, Options: {
    partyId?: string;
    privateMatch?: boolean;
} = {}){
    if(MatchmakingMode() === "DISABLED"){
        logger.warn("Matchmaking is disabled, refusing MM!");

        return undefined;
    }

    if(MatchmakingMode() !== "DEPLOYSERVER"){
        logger.fatal("Unsupported MATCHMAKING_MODE!");

        return undefined;
    }

    const NormalizedGameArgs = GameArgs ?? "";
    const NormalizedHuntId = HuntId ?? "";
    const Group = ResolveMatchmakingGroup(PlayerId, Options.partyId);
    logger.info({
        userId: PlayerId,
        partyId: Group.partyId,
        requestedPartyId: Options.partyId,
        playerIds: Group.playerIds,
        gameMode: GameMode,
        requestedHuntId: HuntId,
        huntId: NormalizedHuntId,
        privateMatch: Options.privateMatch === true
    }, "Handling matchmaking join");
    const PrivateMatch = Options.privateMatch === true;
    const ExistingSession = MatchmakingSessionMap.get(PlayerId);
    const FreshInstance = ExistingSession?.phase === "READY"
        && IsTrialsHuntId(ExistingSession.huntId)
        && IsTrialsHuntId(NormalizedHuntId);

    if(FreshInstance){
        MarkSessionExpired(ExistingSession, "trial_retry_requires_fresh_instance");
        await SyncMatchmakingActivity(ExistingSession);
        RemoveSession(ExistingSession, "trial_retry_requires_fresh_instance");
        logger.info({
            previousCandidateId: ExistingSession.candidateId,
            playerIds: Group.playerIds,
            previousHuntId: ExistingSession.huntId,
            huntId: NormalizedHuntId
        }, "Trials retry requires a fresh gameserver instance");
    }

    const ReusableSession = FreshInstance
        ? undefined
        : await TryReuseActiveSession(PlayerId, GameMode, NormalizedGameArgs, NormalizedHuntId, Group.playerIds, PrivateMatch);

    if(ReusableSession != undefined){
        return ReusableSession;
    }

    if(PrivateMatch || !HuntIdRequiresMatchmaking(NormalizedHuntId)){
        const Session = CreateMatchmakingSession(PlayerId, Group.playerIds, Group.partyId, PrivateMatch, GameMode, NormalizedGameArgs, NormalizedHuntId, "STARTING");
        RegisterSessionForPlayers(Session);
        logger.info({
            candidateId: Session.candidateId,
            userId: PlayerId,
            partyId: Group.partyId,
            playerIds: Group.playerIds,
            huntId: NormalizedHuntId,
            privateMatch: PrivateMatch
        }, "Starting direct matchmaking session");
        await SyncMatchmakingActivity(Session);

        const GameOnDeployServer = await LaunchGameOnDeployserver(GameMode, NormalizedGameArgs, NormalizedHuntId, Group.playerIds, FreshInstance);

        if(Session.cancelled){
            return undefined;
        }

        if(GameOnDeployServer.succeeded){
            MarkSessionReady(Session, GameOnDeployServer);
        }
        else{
            MarkSessionFailed(Session, GameOnDeployServer.statusReason ?? "gameserver_startup_failed");
        }

        await SyncMatchmakingActivity(Session);

        return GameOnDeployServer.succeeded ? Session : undefined;
    }

    return await QueueGroup(NormalizedHuntId, PlayerId, Group.playerIds, Group.partyId, GameMode, NormalizedGameArgs, FreshInstance);
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

export function BuildCandidateStatusResponse(Session: MatchmakingSession, statusPeriodMillis: number, buildId: string) {
    const ResponseBody: any = {
        candidateId: Session.candidateId,
        candidateStatusPeriodMillis: statusPeriodMillis,
        gameMode: Session.gameMode,
        huntId: Session.huntId,
        playerStates: Object.fromEntries(Session.playerIds.map((PlayerId) => [PlayerId, {}])),
        status: CandidateStatusForPhase(Session.phase),
        statusDuration: 0.0,
        statusReason: Session.statusReason ?? null
    };

    if(Session.phase === "READY"){
        ResponseBody.serverInfo = {
            buildId: buildId,
            gameSessionId: Session.candidateId,
            host: Session.host,
            port: Session.port
        };
    }

    return ResponseBody;
}

export function GetPartyCandidateView(PlayerId: string) {
    const Session = MatchmakingSessionMap.get(PlayerId);
    if(Session == undefined || Session.phase === "FAILED" || Session.phase === "EXPIRED"){
        return undefined;
    }

    return {
        candidateId: Session.candidateId,
        candidateState: PartyCandidateStateForPhase(Session.phase),
        gauntletLevel: null,
        playerHuntId: Session.huntId || null,
        activePlayerIds: Session.playerIds
    };
}

function CandidateStatusForPhase(Phase: MatchmakingPhase) {
    if(Phase === "READY"){
        return "IN_PROGRESS";
    }

    if(Phase === "QUEUED"){
        return "QUEUED_FOR_START";
    }

    if(Phase === "STARTING"){
        return "MATCHING";
    }

    return "FAILED";
}

function PartyCandidateStateForPhase(Phase: MatchmakingPhase) {
    if(Phase === "READY"){
        return "IN_PROGRESS";
    }

    if(Phase === "QUEUED"){
        return "QUEUED_FOR_START";
    }

    if(Phase === "STARTING"){
        return "MATCHING";
    }

    return null;
}

function UniqueSessionsForPlayers(PlayerIds: string[]) {
    const Sessions = new Set<MatchmakingSession>();
    for(const PlayerId of PlayerIds){
        const Session = MatchmakingSessionMap.get(PlayerId);
        if(Session != undefined){
            Sessions.add(Session);
        }
    }

    return Sessions;
}

function SamePlayerSet(A: string[], B: string[]) {
    if(A.length !== B.length){
        return false;
    }

    const Players = new Set(A);
    return B.every((PlayerId) => Players.has(PlayerId));
}

function SerializeSession(Session: MatchmakingSession){
    return {
        candidateId: Session.candidateId,
        userId: Session.userId,
        playerIds: Session.playerIds,
        partyId: Session.partyId,
        privateMatch: Session.privateMatch,
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
        sessions: [...new Map([...MatchmakingSessionMap.values()].map((Session) => [Session.candidateId, Session])).values()].map(SerializeSession),
        queues: [...MatchmakingQueueMap.entries()].flatMap(([HuntId, Queues]) => Queues.map((Queue) => ({
            huntId: HuntId,
            gameMode: Queue.GameMode,
            gameArgs: Queue.GameArgs,
            groups: Queue.Groups,
            players: Queue.Players,
            freshInstance: Queue.FreshInstance,
            lastPlayerAddedTime: Queue.LastPlayerAddedTime.toISOString(),
            resolved: Queue.Resolved
        })))
    };
}
