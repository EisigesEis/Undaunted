export type SocialSessionSource = "xmpp" | "stomp" | "activity";

export type SocialPresenceState = {
    status: string;
    properties: Record<string, unknown>;
    richPresence: string;
    bIsPlaying: boolean;
    bIsJoinable: boolean;
    bHasVoiceSupport: boolean;
    sessionId: string;
    updatedAt: string;
};

export type SocialEvent = {
    type: "presence.updated" | "friend.updated";
    userId: string;
    online: boolean;
    source: SocialSessionSource;
    occurredAt: string;
};

type SocialSession = {
    userId: string;
    source: SocialSessionSource;
    lastTouchedAt: number;
};

type SocialEventListener = (event: SocialEvent) => void;

let nextSocialSessionId = 1;

const Sessions = new Map<string, SocialSession>();
const OnlineCounts = new Map<string, number>();
const PresenceStates = new Map<string, SocialPresenceState>();
const EventListeners = new Set<SocialEventListener>();
const DEFAULT_SOCIAL_SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const SOCIAL_SESSION_IDLE_MS = parseEnvMs("SOCIAL_SESSION_IDLE_MS", DEFAULT_SOCIAL_SESSION_IDLE_MS);
const SOCIAL_SESSION_SWEEP_MS = 60_000;
let socialSessionSweep: ReturnType<typeof setInterval> | undefined = setInterval(() => SweepExpiredSocialSessions(), SOCIAL_SESSION_SWEEP_MS);
socialSessionSweep.unref();

export function RegisterSocialSession(userId: string, source: SocialSessionSource) {
    const sessionId = `${source}-${nextSocialSessionId++}`;
    const wasOnline = IsSocialUserOnline(userId);
    const nowMs = Date.now();

    Sessions.set(sessionId, { userId, source, lastTouchedAt: nowMs });
    OnlineCounts.set(userId, (OnlineCounts.get(userId) ?? 0) + 1);

    if(!wasOnline){
        EmitSocialEvent(BuildSocialEvent("presence.updated", userId, true, source));
    }

    return sessionId;
}

export function TouchSocialSession(sessionId: string | undefined) {
    if(sessionId == undefined) return;
    const socialSession = Sessions.get(sessionId);
    if(socialSession == undefined) return;
    const nowMs = Date.now();
    socialSession.lastTouchedAt = nowMs;
}

export function SweepExpiredSocialSessions(nowMs = Date.now()) {
    const expiredSessionIds: string[] = [];
    for(const [sessionId, session] of Sessions){
        if(nowMs - session.lastTouchedAt > SOCIAL_SESSION_IDLE_MS){
            expiredSessionIds.push(sessionId);
        }
    }

    for(const sessionId of expiredSessionIds){
        UnregisterSocialSession(sessionId);
    }
    return expiredSessionIds.length;
}

export function StopSocialSessionSweep() {
    if(socialSessionSweep == undefined){
        return;
    }

    clearInterval(socialSessionSweep);
    socialSessionSweep = undefined;
}

export function StartSocialSessionSweep() {
    if(socialSessionSweep != undefined){
        return;
    }

    socialSessionSweep = setInterval(() => SweepExpiredSocialSessions(), SOCIAL_SESSION_SWEEP_MS);
    socialSessionSweep.unref();
}

export function UnregisterSocialSession(sessionId: string | undefined) {
    if(sessionId == undefined){
        return;
    }

    const session = Sessions.get(sessionId);
    if(session == undefined){
        return;
    }

    const previousSessionCount = OnlineCounts.get(session.userId) ?? 0;
    Sessions.delete(sessionId);

    if(previousSessionCount <= 1){
        OnlineCounts.delete(session.userId);
        PresenceStates.delete(session.userId);
        EmitSocialEvent(BuildSocialEvent("presence.updated", session.userId, false, session.source));
    }
    else{
        OnlineCounts.set(session.userId, previousSessionCount - 1);
    }
}

export function IsSocialUserOnline(userId: string) {
    return (OnlineCounts.get(userId) ?? 0) > 0;
}

export function UpdateSocialPresenceState(userId: string, presence: Omit<SocialPresenceState, "updatedAt">) {
    const nextPresence: SocialPresenceState = {
        ...presence,
        updatedAt: new Date().toISOString()
    };
    const previousPresence = PresenceStates.get(userId);
    PresenceStates.set(userId, nextPresence);

    if(PresenceSignature(previousPresence) !== PresenceSignature(nextPresence)){
        EmitSocialEvent(BuildSocialEvent("presence.updated", userId, true, "xmpp"));
    }
}

export function GetSocialPresenceState(userId: string) {
    return PresenceStates.get(userId);
}

export function AddSocialEventListener(listener: SocialEventListener) {
    EventListeners.add(listener);

    return () => EventListeners.delete(listener);
}

export function BuildSocialEvent(type: SocialEvent["type"], userId: string, online: boolean, source: SocialSessionSource): SocialEvent {
    return {
        type,
        userId,
        online,
        source,
        occurredAt: new Date().toISOString()
    };
}

export function EmitSocialEvent(event: SocialEvent) {
    for(const listener of EventListeners){
        listener(event);
    }
}

function PresenceSignature(presence: SocialPresenceState | undefined) {
    if(presence == undefined){
        return "";
    }

    return JSON.stringify({
        status: presence.status,
        richPresence: presence.richPresence,
        bIsPlaying: presence.bIsPlaying,
        bIsJoinable: presence.bIsJoinable,
        bHasVoiceSupport: presence.bHasVoiceSupport,
        sessionId: presence.sessionId,
        properties: presence.properties
    });
}

export function GetSocialDebugState() {
    const sessionsCount = Sessions.size;
    const onlineUserCount = OnlineCounts.size;
    const presenceStates = [...PresenceStates.entries()].map(([userId, presence]) => ({
        userId,
        ...presence
    }));

    return {
        sessions: sessionsCount,
        usersOnline: onlineUserCount,
        sessionLease: {idleMs: SOCIAL_SESSION_IDLE_MS, sweepMs: SOCIAL_SESSION_SWEEP_MS},
        sweepRunning: socialSessionSweep != undefined,
        presenceStates
    };
}

function parseEnvMs(name: string, fallback: number) {
    const rawValue = process.env[name];
    if(rawValue == undefined || rawValue.trim().length === 0){
        return fallback;
    }

    const parsedMs = Number(rawValue);
    if(Number.isFinite(parsedMs) && Number.isInteger(parsedMs) && parsedMs >= 0){
        return parsedMs;
    }

    return fallback;
}
