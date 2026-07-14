import http from "http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { JwtPayload } from "jsonwebtoken";
import { ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { BuildPresenceEventPayload, GetSocialFriendUserIds } from "../controllers/friends";
import { GetDisplayUsernameForUserId } from "../controllers/login";
import { AddSocialEventListener, BuildSocialEvent, RegisterSocialSession, SocialEvent, TouchSocialSession, UnregisterSocialSession } from "../controllers/social";
import { logger } from "../logger";
import { LogProtocol } from "../protocolLogger";

/**
 * TODO:
 * This endpoint was so far undocumented. Find out how sub. destination and message bodies
 * are decided. We can choose to keep disabled until we figure out locally how it works.
 * Guessing hunt status is communicated? But then is there anything game expects to receive?
 */

type StompFrame = {
    command: string;
    headers: Record<string, string>;
    body: string;
};

type StompSubscription = {
    id: string;
    destination: string;
};

type StompSession = {
    id: string;
    ws: WebSocket;
    request: http.IncomingMessage;
    requestUrl: URL;
    buffer: string;
    authenticated: boolean;
    userId: string | undefined;
    displayName: string | undefined;
    socialSessionId: string | undefined;
    authSource: string | undefined;
    subscriptions: Map<string, StompSubscription>;
    lastActivityAt: number;
};

type TokenCandidate = {
    token: string;
    source: string;
};

type AttachStompServerOptions = {
    heartbeatMs?: number;
    idleCloseMs?: number;
};

const STOMP_HEARTBEAT_MS = Number(process.env.STOMP_HEARTBEAT_MS || "30000");
const STOMP_IDLE_CLOSE_MS = Number(process.env.STOMP_IDLE_CLOSE_MS || String(2 * 60 * 60 * 1000));

const Sessions = new Set<StompSession>();

export function AttachStompServer(server: http.Server, options: AttachStompServerOptions = {}) {
    const WebsocketServer = new WebSocketServer({ noServer: true });
    const HeartbeatMs = options.heartbeatMs ?? STOMP_HEARTBEAT_MS;
    const IdleCloseMs = options.idleCloseMs ?? STOMP_IDLE_CLOSE_MS;

    server.on("upgrade", (request, socket, head) => {
        const RequestUrl = SafeRequestUrl(request);
        if (RequestUrl == undefined) {
            socket.destroy();
            return;
        }

        if (RequestUrl.pathname === "/xmpp" || RequestUrl.pathname.startsWith("/xmpp:")) {
            return;
        }

        LogProtocol("stomp", "upgrade.accepted", { path: RequestUrl.pathname });
        WebsocketServer.handleUpgrade(request, socket, head, (ws) => {
            WebsocketServer.emit("connection", ws, request);
        });
    });

    WebsocketServer.on("connection", (ws, request) => {
        const RequestUrl = SafeRequestUrl(request);
        if (RequestUrl == undefined) {
            ws.close(1002, "malformed websocket URL");
            return;
        }

        const Session: StompSession = {
            id: randomUUID(),
            ws,
            request,
            requestUrl: RequestUrl,
            buffer: "",
            authenticated: false,
            userId: undefined,
            displayName: undefined,
            socialSessionId: undefined,
            authSource: undefined,
            subscriptions: new Map(),
            lastActivityAt: Date.now()
        };

        Sessions.add(Session);
        ws.on("message", (data) => handleData(Session, data.toString()));
        ws.on("pong", () => Touch(Session));
        ws.on("close", (code, reason) => CloseSession(Session, code, reason.toString()));
        ws.on("error", (error) => logger.warn(error, "STOMP websocket error"));
    });

    const RemoveListener = AddSocialEventListener((Event) => void BroadcastSocialEvent(Event));
    const Heartbeat = setInterval(() => {
        const Now = Date.now();
        for (const Session of Sessions) {
            if (Now - Session.lastActivityAt > IdleCloseMs) {
                LogProtocol("stomp", "session.idle_timeout", { userId: Session.userId, sessionId: Session.id });
                Session.ws.close(1000, "idle timeout");
                continue;
            }

            if (Session.ws.readyState === WebSocket.OPEN) {
                if (Session.authenticated) {
                    Session.ws.send("\n");
                }
                Session.ws.ping();
            }
        }
    }, HeartbeatMs);

    Heartbeat.unref();
    WebsocketServer.on("close", () => {
        clearInterval(Heartbeat);
        RemoveListener();
    });

    logger.info("STOMP websocket server mounted for non-XMPP upgrades");
    LogProtocol("stomp", "server.mounted", {});
    return WebsocketServer;
}

function SafeRequestUrl(request: http.IncomingMessage) {
    let RawUrl = request.url ?? "/";
    if (RawUrl === "//") {
        RawUrl = "/";
    }
    const Base = `http://${request.headers.host ?? "localhost"}`;

    try {
        return new URL(RawUrl, Base);
    }
    catch {
        logger.warn({ rawUrl: RawUrl }, "Received malformed STOMP websocket upgrade URL");
        return undefined;
    }
}

function handleData(session: StompSession, data: string) {
    Touch(session);

    if (data === "\n" || data.trim().length === 0) {
        return;
    }

    session.buffer += data;
    const Frames = session.buffer.split("\0");
    session.buffer = Frames.pop() ?? "";

    for (const RawFrame of Frames) {
        const Frame = ParseFrame(RawFrame);
        if (Frame == undefined) {
            continue;
        }

        LogProtocol("stomp", "frame.received", {
            userId: session.userId,
            path: session.requestUrl.pathname,
            command: Frame.command,
            authenticated: session.authenticated,
            headerKeys: Object.keys(Frame.headers)
        });

        HandleFrame(session, Frame);
    }
}

function HandleFrame(session: StompSession, frame: StompFrame) {
    switch (frame.command) {
        case "CONNECT":
        case "STOMP":
            void HandleConnect(session, frame);
            break;
        case "SUBSCRIBE":
            if (!EnsureAuthenticated(session)) {
                return;
            }
            void HandleSubscribe(session, frame);
            break;
        case "UNSUBSCRIBE":
            if (!EnsureAuthenticated(session)) {
                return;
            }
            HandleUnsubscribe(session, frame);
            break;
        case "SEND":
            if (!EnsureAuthenticated(session)) {
                return;
            }
            HandleSend(session, frame);
            break;
        case "ACK":
        case "NACK":
            if (!EnsureAuthenticated(session)) {
                return;
            }
            logger.debug({ userId: session.userId, command: frame.command, messageId: frame.headers.id ?? frame.headers["message-id"] }, "Compatible STOMP ack");
            SendReceiptIfRequested(session, frame);
            break;
        case "DISCONNECT":
            SendReceiptIfRequested(session, frame);
            session.ws.close(1000, "disconnect");
            break;
        default:
            logger.debug(`Ignored STOMP command ${frame.command}`);
            break;
    }
}

async function HandleConnect(session: StompSession, frame: StompFrame) {
    const PathAccountId = ExtractAccountIdFromPath(session.requestUrl.pathname);
    const HeaderAccountId = ExtractAccountIdFromHeaders(frame.headers);
    const RequestedAccountId = PathAccountId ?? HeaderAccountId;
    const Token = ExtractBearerToken(session.request, session.requestUrl, frame.headers);
    let UserId = ValidateTokenAndGetUserId(Token?.token);
    let AuthSource = Token?.source;

    if (UserId == undefined) {
        if (RequestedAccountId != undefined && AllowLocalPathAuth()) {
            UserId = RequestedAccountId;
            AuthSource = PathAccountId != undefined ? "path-local-fallback" : "connect-header-local-fallback";
        }
        else {
            logger.warn({
                path: session.requestUrl.pathname,
                pathAccountId: PathAccountId,
                headerAccountId: HeaderAccountId,
                hasTokenCandidate: Token != undefined,
                tokenSource: Token?.source,
                headerKeys: Object.keys(frame.headers)
            }, "Rejected STOMP CONNECT with bad auth");
            SendErrorAndClose(session, "Authentication failed", "missing or invalid bearer token");
            return;
        }
    }

    if (RequestedAccountId != undefined && RequestedAccountId !== UserId) {
        logger.warn({ path: session.requestUrl.pathname, userId: UserId, pathAccountId: PathAccountId, headerAccountId: HeaderAccountId }, "Rejected STOMP CONNECT path/user mismatch");
        SendErrorAndClose(session, "Authentication failed", "token account does not match websocket identity");
        return;
    }

    session.authenticated = true;
    session.userId = UserId;
    session.authSource = AuthSource;
    session.displayName = await GetDisplayUsernameForUserId(UserId).catch(() => UserId);
    session.socialSessionId = RegisterSocialSession(UserId, "stomp");
    LogProtocol("stomp", "session.connected", { userId: UserId, path: session.requestUrl.pathname, displayName: session.displayName, authSource: AuthSource, pathAccountId: PathAccountId, headerAccountId: HeaderAccountId });

    SendFrame(session, {
        command: "CONNECTED",
        headers: {
            version: "1.2",
            "heart-beat": `${STOMP_HEARTBEAT_MS},${STOMP_HEARTBEAT_MS}`,
            server: "Undaunted"
        },
        body: ""
    });
}

async function HandleSubscribe(session: StompSession, frame: StompFrame) {
    const Destination = frame.headers.destination ?? "/topic/friends";
    const Id = frame.headers.id ?? Destination;
    session.subscriptions.set(Id, {
        id: Id,
        destination: Destination
    });
    LogProtocol("stomp", "subscription.added", { userId: session.userId, destination: Destination, subscriptionId: Id, subscriptionCount: session.subscriptions.size });
    SendReceiptIfRequested(session, frame);

    if (session.userId != undefined) {
        await SendInitialPresenceSnapshots(session, {
            id: Id,
            destination: Destination
        });
    }
}

function HandleUnsubscribe(session: StompSession, frame: StompFrame) {
    const Id = frame.headers.id ?? frame.headers.destination;
    if (Id != undefined) {
        session.subscriptions.delete(Id);
    }
    LogProtocol("stomp", "subscription.removed", { userId: session.userId, subscriptionId: Id, subscriptionCount: session.subscriptions.size });
    SendReceiptIfRequested(session, frame);
}

function HandleSend(session: StompSession, frame: StompFrame) {
    LogProtocol("stomp", "send.received", { userId: session.userId, destination: frame.headers.destination, bodyLength: frame.body.length });
    if (session.userId == undefined) {
        return;
    }

    void BroadcastSocialEvent({
        type: "friend.updated",
        userId: session.userId,
        online: true,
        source: "stomp",
        occurredAt: new Date().toISOString()
    });
    SendReceiptIfRequested(session, frame);
}

async function BroadcastSocialEvent(event: SocialEvent) {
    const EnrichedEvent = await EnrichSocialEvent(event);

    for (const Session of Sessions) {
        if (!Session.authenticated || Session.ws.readyState !== WebSocket.OPEN) {
            continue;
        }

        for (const Subscription of Session.subscriptions.values()) {
            SendMessageToSubscription(Session, Subscription, EnrichedEvent);
        }
    }
}

async function SendInitialPresenceSnapshots(session: StompSession, subscription: StompSubscription) {
    if (session.userId == undefined) {
        return;
    }

    const UserIds = [
        session.userId,
        ...GetSocialFriendUserIds().filter((UserId) => UserId !== session.userId)
    ];

    LogProtocol("stomp", "presence.initial_snapshots", {
        userId: session.userId,
        destination: subscription.destination,
        snapshotUserIds: UserIds
    });

    for (const UserId of UserIds) {
        SendMessageToSubscription(
            session,
            subscription,
            await BuildPresenceEventPayload(BuildSocialEvent("presence.updated", UserId, false, "stomp"))
        );
    }
}

function SendMessageToSubscription(session: StompSession, subscription: StompSubscription, event: SocialEvent | Record<string, any>) {
    const EventRecord = event as Record<string, any>;
    LogProtocol("stomp", "message.sent", {
        sessionUserId: session.userId,
        eventUserId: typeof EventRecord.userId === "string" ? EventRecord.userId : EventRecord.accountId,
        destination: subscription.destination,
        subscriptionId: subscription.id,
        type: EventRecord.type,
        richPresence: EventRecord.richPresence,
        statusText: EventRecord.statusText
    });

    SendFrame(session, {
        command: "MESSAGE",
        headers: {
            subscription: subscription.id,
            destination: subscription.destination,
            "message-id": randomUUID(),
            "content-type": "application/json"
        },
        body: JSON.stringify(event)
    });
}

async function EnrichSocialEvent(event: SocialEvent | Record<string, any>) {
    return BuildPresenceEventPayload(event as Record<string, any>);
}

function SendReceiptIfRequested(session: StompSession, frame: StompFrame) {
    const ReceiptId = frame.headers.receipt;
    if (ReceiptId == undefined || ReceiptId.length === 0) {
        return;
    }

    SendFrame(session, {
        command: "RECEIPT",
        headers: {
            "receipt-id": ReceiptId
        },
        body: ""
    });
}

function EnsureAuthenticated(session: StompSession) {
    if (session.authenticated) {
        return true;
    }

    SendErrorAndClose(session, "Authentication required", "send CONNECT with bearer token first");
    return false;
}

function ParseFrame(rawFrame: string): StompFrame | undefined {
    const Normalized = rawFrame.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\n+/, "");
    if (Normalized.trim().length === 0) {
        return undefined;
    }

    const SeparatorIndex = Normalized.indexOf("\n\n");
    const HeaderBlock = SeparatorIndex === -1 ? Normalized : Normalized.slice(0, SeparatorIndex);
    const Body = SeparatorIndex === -1 ? "" : Normalized.slice(SeparatorIndex + 2);
    const Lines = HeaderBlock.split("\n");
    const Command = Lines.shift()?.trim();

    if (Command == undefined || Command.length === 0) {
        return undefined;
    }

    const Headers: Record<string, string> = {};
    for (const Line of Lines) {
        const Separator = Line.indexOf(":");
        if (Separator === -1) {
            continue;
        }

        Headers[Line.slice(0, Separator).trim()] = Line.slice(Separator + 1).trim();
    }

    return {
        command: Command,
        headers: Headers,
        body: Body
    };
}

function SendFrame(session: StompSession, frame: StompFrame) {
    if (session.ws.readyState !== WebSocket.OPEN) {
        return;
    }

    const HeaderLines = Object.entries(frame.headers).map(([Key, Value]) => `${Key}:${Value}`);
    session.ws.send([
        frame.command,
        ...HeaderLines,
        "",
        frame.body
    ].join("\n") + "\0");
}

function SendErrorAndClose(session: StompSession, message: string, detail: string) {
    SendFrame(session, {
        command: "ERROR",
        headers: {
            message
        },
        body: detail
    });

    session.ws.close(1008, message);
}

function CloseSession(session: StompSession, code?: number, reason?: string) {
    UnregisterSocialSession(session.socialSessionId);
    Sessions.delete(session);
    LogProtocol("stomp", "session.disconnected", {
        userId: session.userId,
        path: session.requestUrl.pathname,
        authenticated: session.authenticated,
        authSource: session.authSource,
        subscriptionCount: session.subscriptions.size,
        closeCode: code,
        closeReason: reason
    });
}

function Touch(session: StompSession) {
    session.lastActivityAt = Date.now();
    TouchSocialSession(session.socialSessionId);
}

function ExtractBearerToken(request: http.IncomingMessage, requestUrl: URL, headers: Record<string, string>): TokenCandidate | undefined {
    const Candidates = [
        { value: headers.authorization, source: "frame.authorization" },
        { value: headers.Authorization, source: "frame.Authorization" },
        { value: headers["access-token"], source: "frame.access-token" },
        { value: headers.access_token, source: "frame.access_token" },
        { value: headers["auth-token"], source: "frame.auth-token" },
        { value: headers.auth_token, source: "frame.auth_token" },
        { value: headers.bearer, source: "frame.bearer" },
        { value: headers.passcode, source: "frame.passcode" },
        { value: headers.token, source: "frame.token" },
        { value: request.headers.authorization, source: "request.authorization" },
        { value: request.headers["access-token"], source: "request.access-token" },
        { value: request.headers["auth-token"], source: "request.auth-token" },
        { value: requestUrl.searchParams.get("access_token"), source: "query.access_token" },
        { value: requestUrl.searchParams.get("token"), source: "query.token" },
        { value: requestUrl.searchParams.get("auth_token"), source: "query.auth_token" },
        { value: requestUrl.searchParams.get("bearer"), source: "query.bearer" }
    ];

    for (const Candidate of Candidates) {
        if (typeof Candidate.value !== "string" || Candidate.value.length === 0) {
            continue;
        }

        return {
            token: Candidate.value.toLowerCase().startsWith("bearer ") ? Candidate.value.slice("bearer ".length) : Candidate.value,
            source: Candidate.source
        };
    }

    return undefined;
}

function ValidateTokenAndGetUserId(token: string | undefined) {
    if (token == undefined) {
        return undefined;
    }

    try {
        const Payload = ValidateMetagameJWTAndGetPayload(token) as JwtPayload;
        return typeof Payload.userId === "string" ? NormalizeAccountId(Payload.userId) : undefined;
    }
    catch {
        return undefined;
    }
}

function ExtractAccountIdFromPath(pathname: string) {
    const Parts = pathname.split("/").filter((Part) => Part.length > 0);
    if (Parts[0] === "ws" && Parts[1] != undefined) {
        return NormalizeAccountId(Parts[1]);
    }

    if (Parts[0] === "notifications" && Parts[1] === "v1" && Parts[2] != undefined) {
        return NormalizeAccountId(Parts[2]);
    }

    return undefined;
}

function ExtractAccountIdFromHeaders(headers: Record<string, string>) {
    const Candidates = [
        headers.login,
        headers.accountId,
        headers.account_id,
        headers.userId,
        headers.user_id,
        headers["account-id"],
        headers["user-id"],
        headers["x-epic-account-id"],
        headers["x-mcp-account-id"]
    ];

    for (const Candidate of Candidates) {
        const AccountId = NormalizeAccountId(Candidate);
        if (AccountId != undefined) {
            return AccountId;
        }
    }

    return undefined;
}

function NormalizeAccountId(value: string | undefined) {
    if (value == undefined) {
        return undefined;
    }

    const Decoded = decodeURIComponent(value).trim();
    if (Decoded.length === 0 || Decoded === "{accountid}") {
        return undefined;
    }

    return Decoded.toUpperCase().startsWith("MCP:") ? Decoded.slice("MCP:".length) : Decoded;
}

function AllowLocalPathAuth() {
    return process.env.STOMP_ALLOW_PATH_AUTH === "true" || process.env.AUTH_MODE === "NONE" || process.env.NODE_ENV !== "production";
}

export function GetStompDebugState() {
    return {
        sessions: Sessions.size,
        authenticated: [...Sessions].filter((Session) => Session.authenticated).length,
        users: [...Sessions].map((Session) => ({
            id: Session.id,
            userId: Session.userId,
            path: Session.requestUrl.pathname,
            authenticated: Session.authenticated,
            authSource: Session.authSource,
            subscriptionCount: Session.subscriptions.size
        }))
    };
}
