/**
 * TODO:
 * Figure out how game decides social presence in this update.
 * Currently every friend is just shown as offline.
 */

export type SocialSessionSource = "xmpp" | "stomp" | "activity";

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
        EmitSocialEvent(BuildSocialEvent("presence.updated", Session.userId, false, Session.source));
    }
    else{
        OnlineCounts.set(Session.userId, PreviousCount - 1);
    }
}

export function IsSocialUserOnline(userId: string) {
    return (OnlineCounts.get(userId) ?? 0) > 0;
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

export function GetSocialDebugState() {
    return {
        sessions: Sessions.size,
        usersOnline: OnlineCounts.size
    };
}
