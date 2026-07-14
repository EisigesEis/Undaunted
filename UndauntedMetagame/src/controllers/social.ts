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
};

type SocialEventListener = (event: SocialEvent) => void;

let NextSocialSessionId = 1;

const Sessions = new Map<string, SocialSession>();
const OnlineCounts = new Map<string, number>();
const PresenceStates = new Map<string, SocialPresenceState>();
const EventListeners = new Set<SocialEventListener>();

export function RegisterSocialSession(userId: string, source: SocialSessionSource) {
    const SessionId = `${source}-${NextSocialSessionId++}`;
    const WasOnline = IsSocialUserOnline(userId);

    Sessions.set(SessionId, { userId, source });
    OnlineCounts.set(userId, (OnlineCounts.get(userId) ?? 0) + 1);

    if(!WasOnline){
        EmitSocialEvent(BuildSocialEvent("presence.updated", userId, true, source));
    }

    return SessionId;
}

export function TouchSocialSession(_sessionId: string | undefined) {
}

export function UnregisterSocialSession(sessionId: string | undefined) {
    if(sessionId == undefined){
        return;
    }

    const Session = Sessions.get(sessionId);
    if(Session == undefined){
        return;
    }

    const PreviousCount = OnlineCounts.get(Session.userId) ?? 0;
    Sessions.delete(sessionId);

    if(PreviousCount <= 1){
        OnlineCounts.delete(Session.userId);
        PresenceStates.delete(Session.userId);
        EmitSocialEvent(BuildSocialEvent("presence.updated", Session.userId, false, Session.source));
    }
    else{
        OnlineCounts.set(Session.userId, PreviousCount - 1);
    }
}

export function IsSocialUserOnline(userId: string) {
    return (OnlineCounts.get(userId) ?? 0) > 0;
}

export function UpdateSocialPresenceState(userId: string, presence: Omit<SocialPresenceState, "updatedAt">) {
    const NextPresence: SocialPresenceState = {
        ...presence,
        updatedAt: new Date().toISOString()
    };
    const PreviousPresence = PresenceStates.get(userId);
    PresenceStates.set(userId, NextPresence);

    if(PresenceSignature(PreviousPresence) !== PresenceSignature(NextPresence)){
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
    for(const Listener of EventListeners){
        Listener(event);
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
    return {
        sessions: Sessions.size,
        usersOnline: OnlineCounts.size,
        presenceStates: [...PresenceStates.entries()].map(([UserId, Presence]) => ({
            userId: UserId,
            ...Presence
        }))
    };
}
