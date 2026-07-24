import http from "http";
import { SaxesParser, SaxesTagPlain } from "saxes";
import { WebSocket, WebSocketServer } from "ws";
import { ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { BuildPresenceResult, GetSocialFriendUserIds } from "../controllers/friends";
import { GetDisplayUsernameForUserId } from "../controllers/login";
import { AddPartyEventListener, IsPlayerInPartyRoom } from "../controllers/party";
import { AddSocialEventListener, RegisterSocialSession, TouchSocialSession, UnregisterSocialSession, UpdateSocialPresenceState } from "../controllers/social";
import { logger } from "../logger";
import { LogProtocol } from "../protocolLogger";
import { attr, escapeXml, findChild, findDescendant, nodeText, parseOpeningTag, XmppNode } from "./xml";

const XMPP_PATH = process.env.XMPP_PATH || "/xmpp";
const XMPP_DOMAIN = process.env.XMPP_DOMAIN || "prod.ol.epicgames.com";
const XMPP_REQUIRE_AUTH = process.env.XMPP_REQUIRE_AUTH !== "false";
const XMPP_IDLE_CLOSE_MS = Number(process.env.XMPP_IDLE_CLOSE_MS || String(2 * 60 * 60 * 1000));
const XMPP_HEARTBEAT_MS = Number(process.env.XMPP_HEARTBEAT_MS || "30000");
const XMPP_BROADCAST_LONE_ROOM_MESSAGES = process.env.XMPP_BROADCAST_LONE_ROOM_MESSAGES === "true";

/**
 * TODO:
 * - Once party/guild implemented, verify said chat works.
 * - Verify social restrictions (don't receive dm from non-friend) and auth security (impersonation).
 */

type XmppSession = {
    id: string;
    ws: WebSocket;
    authenticated: boolean;
    userId: string;
    displayName: string;
    resource: string;
    bareJid: string;
    fullJid: string;
    rooms: Map<string, string>;
    handledStanzas: number;
    lastActivityAt: number;
    socialSessionId?: string;
};

type RoutedRoomMessage = {
    room: string;
    deliveryKey: string;
    fromNick: string;
    fromDisplayName: string;
    body: string;
    id?: string;
};

type RoutedPrivateMessage = {
    fromUserId: string;
    fromDisplayName: string;
    fromJid: string;
    toKey: string;
    toRaw: string;
    body: string;
    id?: string;
};

type XmppTarget = {
    accountNode: string;
    accountKey: string;
    domain?: string;
    resource?: string;
};

type SessionIdentity = {
    userId: string;
    displayName: string;
};

export type AttachXmppServerOptions = {
    path?: string;
    rejectUnknownPath?: boolean;
};

let NextSessionId = 1;

const Sessions = new Set<XmppSession>();
const SessionsByRecipientKey = new Map<string, Set<XmppSession>>();
const RoomMembers = new Map<string, Set<XmppSession>>();

export function AttachXmppServer(server: http.Server, options: AttachXmppServerOptions = {}) {
    const Path = options.path ?? XMPP_PATH;
    const RejectUnknownPath = options.rejectUnknownPath ?? true;
    const WebsocketServer = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
        const RequestUrl = SafeRequestUrl(request);
        if (RequestUrl == undefined) {
            if (RejectUnknownPath) {
                socket.destroy();
            }
            return;
        }

        const IsXmppPath = RequestUrl.pathname === Path || RequestUrl.pathname.startsWith(`${Path}:`);
        if (!IsXmppPath) {
            if (!RejectUnknownPath) {
                return;
            }

            logger.warn(`Rejected websocket upgrade for ${RequestUrl.pathname}; XMPP is mounted at ${Path}`);
            socket.destroy();
            return;
        }

        LogProtocol("xmpp", "upgrade.accepted", { path: RequestUrl.pathname });
        WebsocketServer.handleUpgrade(request, socket, head, (ws) => {
            WebsocketServer.emit("connection", ws, request);
        });
    });

    WebsocketServer.on("connection", (ws) => {
        const Session = createSession(ws);
        Sessions.add(Session);
        indexSession(Session);
        LogProtocol("xmpp", "session.connected", { userId: Session.userId, sessionId: Session.id });

        ws.on("message", (data) => handleFrame(Session, data.toString()));
        ws.on("pong", () => {
            Session.lastActivityAt = Date.now();
            TouchSocialSession(Session.socialSessionId);
        });
        ws.on("close", () => closeSession(Session));
        ws.on("error", (error) => logger.warn(error, `XMPP websocket error for ${Session.userId}`));
    });

    const Heartbeat = setInterval(() => {
        const Now = Date.now();
        for (const Session of Sessions) {
            if (Now - Session.lastActivityAt > XMPP_IDLE_CLOSE_MS) {
                LogProtocol("xmpp", "session.idle_timeout", { userId: Session.userId, sessionId: Session.id, idleSeconds: Math.round((Now - Session.lastActivityAt) / 1000) });
                Session.ws.close(1000, "idle timeout");
                continue;
            }

            if (Session.ws.readyState === WebSocket.OPEN) {
                Session.ws.ping();
            }
        }
    }, XMPP_HEARTBEAT_MS);

    Heartbeat.unref();
    const RemoveSocialEventListener = AddSocialEventListener((event) => {
        void BroadcastFriendPresence(event.userId);
    });
    const RemovePartyEventListener = AddPartyEventListener((event) => {
        EjectRemovedPartyMembers(event.partyId, event.removedPlayerIds);
    });

    WebsocketServer.on("close", () => {
        clearInterval(Heartbeat);
        RemoveSocialEventListener();
        RemovePartyEventListener();
    });

    logger.info(`XMPP websocket server mounted at ${Path}`);
    LogProtocol("xmpp", "server.mounted", { path: Path });
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
        logger.warn({ rawUrl: RawUrl }, "Received malformed XMPP websocket upgrade URL");
        return undefined;
    }
}

function createSession(ws: WebSocket): XmppSession {
    const Id = String(NextSessionId++);
    const UserId = `local-${Id}`;
    const Resource = `undaunted-${Id}`;

    return {
        id: Id,
        ws,
        authenticated: false,
        userId: UserId,
        displayName: UserId,
        resource: Resource,
        bareJid: toBareJid(UserId),
        fullJid: `${toBareJid(UserId)}/${Resource}`,
        rooms: new Map(),
        handledStanzas: 0,
        lastActivityAt: Date.now()
    };
}

function handleFrame(session: XmppSession, frame: string) {
    session.lastActivityAt = Date.now();
    TouchSocialSession(session.socialSessionId);
    const TrimmedFrame = frame.trim();
    if (TrimmedFrame.length === 0) {
        return;
    }

    if (!IsXmppPingFrame(TrimmedFrame)) {
        LogProtocol("xmpp", "frame.received", { userId: session.userId, framePreview: TrimmedFrame.slice(0, 500) });
    }

    if (TrimmedFrame.startsWith("<stream:stream") || TrimmedFrame.startsWith("<stream")) {
        handleStreamOpen(session, parseOpeningTag(TrimmedFrame));
        return;
    }

    const Nodes = parseXmppFragment(TrimmedFrame);
    for (const Node of Nodes) {
        handleNode(session, Node);
    }
}

function handleNode(session: XmppSession, node: XmppNode) {
    session.handledStanzas++;
    switch (node.name) {
        case "open":
            handleStreamOpen(session, node);
            break;
        case "close":
            send(session, `<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>`);
            session.ws.close();
            break;
        case "auth":
            void handleAuth(session, node);
            break;
        case "response":
            void handleAuth(session, node);
            break;
        case "enable":
            if (!ensureAuthenticated(session, node)) {
                return;
            }
            send(session, `<enabled xmlns="urn:xmpp:sm:3"${attr("id", session.id)} resume="true"/>`);
            break;
        case "r":
            if (!ensureAuthenticated(session, node)) {
                return;
            }
            send(session, `<a xmlns="urn:xmpp:sm:3" h="${session.handledStanzas}"/>`);
            break;
        case "a":
            break;
        case "iq":
            if (!ensureAuthenticated(session, node)) {
                return;
            }
            handleIq(session, node);
            break;
        case "presence":
            if (!ensureAuthenticated(session, node)) {
                return;
            }
            handlePresence(session, node);
            break;
        case "message":
            if (!ensureAuthenticated(session, node)) {
                return;
            }
            handleMessage(session, node);
            break;
        default:
            logger.debug(`Ignored XMPP node ${node.name}`);
            break;
    }
}

function handleStreamOpen(session: XmppSession, node: XmppNode | undefined) {
    send(session, `<open xmlns="urn:ietf:params:xml:ns:xmpp-framing"${attr("from", XMPP_DOMAIN)}${attr("id", session.id)} version="1.0" xml:lang="en"/>`);
    sendFeatures(session, node?.attrs.version ?? "1.0");
}

function sendFeatures(session: XmppSession, version: string) {
    const SaslFeature = session.authenticated
        ? ""
        : XMPP_REQUIRE_AUTH
            ? `<mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms>`
            : `<mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism><mechanism>ANONYMOUS</mechanism></mechanisms>`;

    send(session, [
        `<stream:features xmlns:stream="http://etherx.jabber.org/streams" version="${escapeXml(version)}">`,
        SaslFeature,
        `<bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/>`,
        `<session xmlns="urn:ietf:params:xml:ns:xmpp-session"/>`,
        `<sm xmlns="urn:xmpp:sm:3"/>`,
        `</stream:features>`
    ].join(""));
}

async function handleAuth(session: XmppSession, node: XmppNode) {
    const Encoded = node.children.filter((Child) => typeof Child === "string").join("").trim();
    const Identity = identityFromPlainAuth(Encoded) ?? (XMPP_REQUIRE_AUTH ? undefined : permissiveIdentity(session));

    if (Identity == undefined) {
        logger.warn({ sessionId: session.id }, "Rejected XMPP auth");
        send(session, `<failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><not-authorized/></failure>`);
        return;
    }

    const DisplayName = await resolveDisplayName(Identity.userId, Identity.displayName);
    applyIdentity(session, { ...Identity, displayName: DisplayName });
    session.authenticated = true;
    LogProtocol("xmpp", "session.authenticated", { userId: session.userId, displayName: session.displayName, recipientKeys: [...getSessionRecipientKeys(session)] });
    send(session, `<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>`);
}

function ensureAuthenticated(session: XmppSession, node: XmppNode) {
    if (!XMPP_REQUIRE_AUTH || session.authenticated) {
        return true;
    }

    logger.warn(`Rejected unauthenticated XMPP ${node.name} stanza for ${session.userId}`);
    if (node.name === "iq") {
        send(session, `<iq type="error"${attr("id", node.attrs.id)}><error type="auth"><not-authorized xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></iq>`);
    }
    else {
        send(session, `<failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><not-authorized/></failure>`);
    }

    return false;
}

function identityFromPlainAuth(encoded: string): SessionIdentity | undefined {
    if (encoded.length === 0) {
        return undefined;
    }

    let Decoded = "";
    try {
        Decoded = Buffer.from(encoded, "base64").toString("utf8");
    }
    catch {
        return undefined;
    }

    const Parts = Decoded.split("\u0000").filter((Part) => Part.length > 0);
    const Token = Parts.find((Part) => Part.split(".").length === 3) ?? Parts[Parts.length - 1];
    const UserIdFromToken = validateJwtAndGetUserId(Token);
    if (UserIdFromToken != undefined) {
        return { userId: UserIdFromToken, displayName: UserIdFromToken };
    }

    if (XMPP_REQUIRE_AUTH) {
        return undefined;
    }

    const UserId = Parts.find((Part) => Part.length > 0);
    if (UserId != undefined) {
        return { userId: bareNode(UserId), displayName: bareNode(UserId) };
    }

    return undefined;
}

function validateJwtAndGetUserId(token: string | undefined) {
    if (token == undefined) {
        return undefined;
    }

    try {
        const Payload = ValidateMetagameJWTAndGetPayload(token);

        return typeof (Payload as any).userId === "string" ? (Payload as any).userId : undefined;
    }
    catch {
        return undefined;
    }
}

function permissiveIdentity(session: XmppSession): SessionIdentity {
    return {
        userId: session.userId,
        displayName: session.displayName
    };
}

function applyIdentity(session: XmppSession, identity: SessionIdentity) {
    unindexSession(session);
    UnregisterSocialSession(session.socialSessionId);
    session.userId = identity.userId;
    session.displayName = identity.displayName;
    session.bareJid = toBareJid(identity.userId);
    session.fullJid = `${session.bareJid}/${session.resource}`;
    indexSession(session);
    session.socialSessionId = RegisterSocialSession(identity.userId, "xmpp");
}

async function resolveDisplayName(userId: string, fallback: string) {
    const FallbackName = cleanDisplayName(fallback, userId);

    try {
        const Username = cleanDisplayName(await GetDisplayUsernameForUserId(userId), FallbackName);
        if (!isGeneratedDisplayName(Username, userId)) {
            return Username;
        }
    }
    catch (error) {
        logger.warn(error, `Could not resolve XMPP display name for ${userId}`);
    }

    if (!isGeneratedDisplayName(FallbackName, userId)) {
        return FallbackName;
    }

    const LocalDisplayName = await resolveConfiguredLocalDisplayName(userId);
    return LocalDisplayName ?? FallbackName;
}

async function resolveConfiguredLocalDisplayName(userId: string) {
    const LocalUserIds = [
        process.env.LOCAL_USER_ID,
        process.env.DEFAULT_USER_ID
    ].filter((Value): Value is string => Value != undefined && Value.length > 0 && Value !== userId);

    for (const LocalUserId of LocalUserIds) {
        try {
            const LocalDisplayName = cleanDisplayName(await GetDisplayUsernameForUserId(LocalUserId), LocalUserId);
            if (!isGeneratedDisplayName(LocalDisplayName, LocalUserId)) {
                LogProtocol("xmpp", "display_name.local_fallback", { userId, localUserId: LocalUserId });
                return LocalDisplayName;
            }
        }
        catch (error) {
            logger.warn(error, `Could not resolve local XMPP display name for ${LocalUserId}`);
        }
    }

    return undefined;
}

function handleIq(session: XmppSession, node: XmppNode) {
    const Id = node.attrs.id;
    const Type = node.attrs.type ?? "get";

    if (Type === "result" || Type === "error") {
        return;
    }

    const Bind = findDescendant(node, "bind");
    if (Bind != undefined) {
        const Resource = nodeText(Bind, "resource") ?? session.resource;
        unindexSession(session);
        session.resource = sanitizeResource(Resource);
        session.fullJid = `${session.bareJid}/${session.resource}`;
        indexSession(session);
        LogProtocol("xmpp", "session.bound", { userId: session.userId, fullJid: session.fullJid, recipientKeys: [...getSessionRecipientKeys(session)] });
        send(session, `<iq xmlns="jabber:client" type="result"${attr("id", Id)}${attr("to", session.fullJid)}><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><jid>${escapeXml(session.fullJid)}</jid></bind></iq>`);
        return;
    }

    if (findDescendant(node, "session") != undefined) {
        send(session, `<iq xmlns="jabber:client" type="result"${attr("id", Id)}${attr("to", session.fullJid)}/>`);
        return;
    }

    if (findDescendant(node, "ping") != undefined) {
        send(session, `<iq type="result"${attr("id", Id)}${attr("from", node.attrs.to)}${attr("to", session.fullJid)}/>`);
        return;
    }

    const Query = findDescendant(node, "query");
    if (Query?.attrs.xmlns === "jabber:iq:roster") {
        void sendRoster(session, Id);
        return;
    }

    if (Query?.attrs.xmlns === "http://jabber.org/protocol/disco#info") {
        send(session, [
            `<iq type="result"${attr("id", Id)}${attr("from", node.attrs.to)}${attr("to", session.fullJid)}>`,
            `<query xmlns="http://jabber.org/protocol/disco#info">`,
            `<identity category="conference" type="text" name="Undaunted XMPP"/>`,
            `<feature var="http://jabber.org/protocol/muc"/>`,
            `<feature var="jabber:iq:roster"/>`,
            `</query></iq>`
        ].join(""));
        return;
    }

    if (Query?.attrs.xmlns === "http://jabber.org/protocol/disco#items") {
        send(session, `<iq type="result"${attr("id", Id)}${attr("from", node.attrs.to)}${attr("to", session.fullJid)}><query xmlns="http://jabber.org/protocol/disco#items"/></iq>`);
        return;
    }

    send(session, `<iq type="result"${attr("id", Id)}${attr("to", session.fullJid)}/>`);
}

async function sendRoster(session: XmppSession, id: string | undefined) {
    const FriendUserIds = await GetConfiguredRosterFriendIds(session.userId);
    const Items = await Promise.all(FriendUserIds.map(async (FriendUserId) => {
        const Presence = await BuildPresenceResult(FriendUserId);
        const DisplayName = String(Presence.payload.displayName ?? FriendUserId);

        return [
            `<item jid="${escapeXml(toBareJid(FriendUserId))}"`,
            ` name="${escapeXml(DisplayName)}"`,
            ` subscription="both"/>`
        ].join("");
    }));

    send(session, [
        `<iq type="result"${attr("id", id)}${attr("to", session.fullJid)}>`,
        `<query xmlns="jabber:iq:roster">`,
        ...Items,
        `</query></iq>`
    ].join(""));
    LogProtocol("xmpp", "roster.response", {
        userId: session.userId,
        fullJid: session.fullJid,
        friendUserIds: FriendUserIds
    });

    for (const FriendUserId of FriendUserIds) {
        await sendFriendPresence(session, FriendUserId);
    }
}

async function BroadcastFriendPresence(friendUserId: string) {
    const ConfiguredFriends = await GetSocialFriendUserIds();
    if (!ConfiguredFriends.includes(friendUserId)) {
        return;
    }

    for (const Session of Sessions) {
        if (!Session.authenticated || Session.userId === friendUserId) {
            continue;
        }

        await sendFriendPresence(Session, friendUserId);
    }
}

async function sendFriendPresence(session: XmppSession, friendUserId: string) {
    const Presence = await BuildPresenceResult(friendUserId);
    const From = fullPresenceJidForUserId(friendUserId);

    if (!Presence.payload.IsOnline) {
        send(session, `<presence xmlns="jabber:client" type="unavailable" from="${escapeXml(From)}" to="${escapeXml(session.fullJid)}"/>`);
        return;
    }

    const StatusJson = JSON.stringify({
        Status: Presence.payload.StatusStr,
        StatusStr: Presence.payload.StatusStr,
        State: Presence.payload.State,
        IsOnline: Presence.payload.IsOnline,
        IsPlaying: Presence.payload.IsPlaying,
        IsJoinable: Presence.payload.IsJoinable,
        AppId: Presence.payload.AppId,
        PlatformString: Presence.payload.PlatformString,
        RichPresence: Presence.payload.StatusStr,
        Properties: {
            Status: Presence.payload.StatusStr,
            RichPresence_s: Presence.payload.StatusStr,
            AppId: Presence.payload.AppId,
            PlatformString: Presence.payload.PlatformString,
            State: Presence.payload.State,
            IsOnline: Presence.payload.IsOnline
        }
    });

    send(session, [
        `<presence xmlns="jabber:client" from="${escapeXml(From)}" to="${escapeXml(session.fullJid)}">`,
        `<show>chat</show>`,
        `<status>${escapeXml(StatusJson)}</status>`,
        `</presence>`
    ].join(""));
    LogProtocol("xmpp", "presence.friend_direct", {
        recipientUserId: session.userId,
        friendUserId,
        from: From,
        to: session.fullJid,
        online: Presence.payload.IsOnline,
        state: Presence.payload.State,
        status: Presence.payload.StatusStr
    });
}

async function GetConfiguredRosterFriendIds(userId: string) {
    return (await GetSocialFriendUserIds()).filter((FriendUserId) => FriendUserId !== userId);
}

function fullPresenceJidForUserId(userId: string) {
    const LiveSession = [...Sessions].find((Session) => Session.authenticated && Session.userId === userId);
    if (LiveSession != undefined) {
        return LiveSession.fullJid;
    }

    return `${toBareJid(userId)}/V2:Jackal:WIN::${sanitizeResource(userId)}`;
}

function handlePresence(session: XmppSession, node: XmppNode) {
    const To = node.attrs.to;
    if (To == undefined) {
        const PresenceState = ParseSelfPresenceState(node, session.id);
        if (PresenceState != undefined) {
            UpdateSocialPresenceState(session.userId, PresenceState);
        }

        LogProtocol("xmpp", "presence.self", { userId: session.userId, fullJid: session.fullJid, presence: PresenceState });
        send(session, `<presence xmlns="jabber:client" from="${escapeXml(session.fullJid)}" to="${escapeXml(session.fullJid)}"/>`);
        return;
    }

    const Room = bareJid(To);
    const RequestedNick = resourceFromJid(To) ?? session.displayName;
    const Nick = canonicalRoomNick(session, RequestedNick);

    if (node.attrs.type === "unavailable") {
        leaveRoom(session, Room, Nick);
        return;
    }

    if (!CanAccessRoom(session, Room)) {
        LogProtocol("xmpp", "room.join.denied", { userId: session.userId, room: Room });
        sendRoomOccupantUnavailable(session, Room, session, Nick, true);
        return;
    }

    joinRoom(session, Room, Nick);
}

function IsXmppPingFrame(frame: string) {
    return frame.includes("<ping") && frame.includes("urn:xmpp:ping");
}

function ParseSelfPresenceState(node: XmppNode, fallbackSessionId: string) {
    const RawStatus = nodeText(node, "status");
    if (RawStatus == undefined || RawStatus.trim().length === 0) {
        return undefined;
    }

    const TrimmedStatus = RawStatus.trim();
    let ParsedStatus: unknown;

    try {
        ParsedStatus = JSON.parse(TrimmedStatus);
    }
    catch {
        return {
            status: TrimmedStatus,
            properties: {
                Status: TrimmedStatus
            },
            richPresence: TrimmedStatus,
            bIsPlaying: false,
            bIsJoinable: false,
            bHasVoiceSupport: false,
            sessionId: fallbackSessionId
        };
    }

    if (!IsRecord(ParsedStatus)) {
        return undefined;
    }

    const RawProperties = IsRecord(ParsedStatus.Properties) ? ParsedStatus.Properties : {};
    const Status = StringValue(ParsedStatus.Status) ?? StringValue(RawProperties.RichPresence_s) ?? "Online";

    return {
        status: Status,
        properties: {
            ...RawProperties,
            Status,
            bIsPlaying: BooleanValue(ParsedStatus.bIsPlaying),
            bIsJoinable: BooleanValue(ParsedStatus.bIsJoinable),
            bHasVoiceSupport: BooleanValue(ParsedStatus.bHasVoiceSupport),
            SessionId: StringValue(ParsedStatus.SessionId) ?? ""
        },
        richPresence: Status,
        bIsPlaying: BooleanValue(ParsedStatus.bIsPlaying),
        bIsJoinable: BooleanValue(ParsedStatus.bIsJoinable),
        bHasVoiceSupport: BooleanValue(ParsedStatus.bHasVoiceSupport),
        sessionId: StringValue(ParsedStatus.SessionId) ?? fallbackSessionId
    };
}

function IsRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function StringValue(value: unknown) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function BooleanValue(value: unknown) {
    return typeof value === "boolean" ? value : false;
}

function joinRoom(session: XmppSession, room: string, nick: string) {
    const DeliveryKey = roomDeliveryKey(room);
    let Members = RoomMembers.get(DeliveryKey);
    if (Members == undefined) {
        Members = new Set();
        RoomMembers.set(DeliveryKey, Members);
    }

    const ExistingMembers = [...Members].filter((Member) => Member !== session && Member.authenticated);
    Members.add(session);
    session.rooms.set(room, nick);
    LogProtocol("xmpp", "room.joined", { userId: session.userId, room, deliveryKey: DeliveryKey, nick, memberCount: Members.size });

    sendRoomOccupantPresence(session, room, session, nick, true);

    for (const ExistingMember of ExistingMembers) {
        const ExistingNick = roomNickForDeliveryKey(ExistingMember, DeliveryKey);
        if (ExistingNick != undefined) {
            sendRoomOccupantPresence(session, roomForRecipientDeliveryKey(session, DeliveryKey, room), ExistingMember, ExistingNick, false);
        }

        sendRoomOccupantPresence(ExistingMember, roomForRecipientDeliveryKey(ExistingMember, DeliveryKey, room), session, nick, false);
    }
}

function leaveRoom(session: XmppSession, room: string, nick: string) {
    const JoinedNick = session.rooms.get(room) ?? nick;
    const DeliveryKey = roomDeliveryKey(room);
    RoomMembers.get(DeliveryKey)?.delete(session);
    session.rooms.delete(room);
    LogProtocol("xmpp", "room.left", { userId: session.userId, room, deliveryKey: DeliveryKey, nick: JoinedNick });
    sendRoomOccupantUnavailable(session, room, session, JoinedNick, true);

    for (const Member of RoomMembers.get(DeliveryKey) ?? []) {
        if (Member.authenticated) {
            sendRoomOccupantUnavailable(Member, roomForRecipientDeliveryKey(Member, DeliveryKey, room), session, JoinedNick, false);
        }
    }

}

function handleMessage(session: XmppSession, node: XmppNode) {
    const Body = nodeText(node, "body");
    if (Body == undefined || Body.length === 0) {
        logger.warn({ userId: session.userId, attrs: node.attrs }, "Ignored XMPP message without body");
        return;
    }

    if (node.attrs.type === "groupchat") {
        handleGroupMessage(session, node, Body);
        return;
    }

    handlePrivateMessage(session, node, Body);
}

function handleGroupMessage(session: XmppSession, node: XmppNode, body: string) {
    const Room = bareJid(node.attrs.to ?? "general");
    if (!CanAccessRoom(session, Room)) {
        LogProtocol("xmpp", "message.groupchat.denied", { userId: session.userId, room: Room });
        return;
    }

    const DeliveryKey = roomDeliveryKey(Room);
    if (!session.rooms.has(Room)) {
        joinRoom(session, Room, epicRoomNick(session));
    }

    const Message: RoutedRoomMessage = {
        room: Room,
        deliveryKey: DeliveryKey,
        fromNick: messageRoomNick(session, session.rooms.get(Room) ?? session.displayName),
        fromDisplayName: session.displayName,
        body,
        id: node.attrs.id
    };

    const Members = RoomMembers.get(DeliveryKey) ?? new Set<XmppSession>();
    const Recipients = new Set([...Members].filter((Candidate) => Candidate.authenticated));
    if (Recipients.size <= 1 && XMPP_BROADCAST_LONE_ROOM_MESSAGES) {
        for (const Candidate of Sessions) {
            if (Candidate.authenticated) {
                Recipients.add(Candidate);
            }
        }
    }

    LogProtocol("xmpp", "message.groupchat.route", {
        senderUserId: session.userId,
        room: Room,
        deliveryKey: DeliveryKey,
        fromNick: Message.fromNick,
        bodyPreview: body.slice(0, 80),
        roomMemberCount: Members.size,
        recipientCount: Recipients.size,
        broadcastFallback: Recipients.size > Members.size
    });

    for (const Recipient of Recipients) {
        sendRoomMessage(Recipient, Message, roomForRecipientDelivery(Recipient, Message));
    }
}

function handlePrivateMessage(session: XmppSession, node: XmppNode, body: string) {
    const To = node.attrs.to;
    if (To == undefined) {
        return;
    }

    const Target = parseXmppTarget(To);
    const ToKeys = recipientKeysForValue(Target.accountNode);
    const ToKey = Target.accountKey;
    const Message: RoutedPrivateMessage = {
        fromUserId: session.userId,
        fromDisplayName: session.displayName,
        fromJid: session.fullJid,
        toKey: ToKey,
        toRaw: To,
        body,
        id: node.attrs.id
    };

    const Recipients = new Set([...findRecipientSessions(To)].filter((Candidate) => Candidate !== session && Candidate.authenticated));
    LogProtocol("xmpp", "message.private.route", {
        senderUserId: session.userId,
        toRaw: To,
        targetAccount: Target.accountNode,
        targetDomain: Target.domain,
        targetResource: Target.resource,
        normalizedKeys: [...ToKeys],
        bodyPreview: body.slice(0, 80),
        recipientCount: Recipients.size
    });

    if (Recipients.size === 0) {
        logger.warn({
            senderUserId: session.userId,
            toRaw: To,
            targetAccount: Target.accountNode,
            targetDomain: Target.domain,
            normalizedKeys: [...ToKeys]
        }, "XMPP private chat unresolved recipient");
        send(session, [
            `<message xmlns="jabber:client" type="error"${attr("id", node.attrs.id)} from="${escapeXml(To)}" to="${escapeXml(session.fullJid)}">`,
            `<error type="cancel"><item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error>`,
            `</message>`
        ].join(""));
        return;
    }

    for (const Recipient of Recipients) {
        sendPrivateMessage(Recipient, Message, Recipient.fullJid);
    }

    // RE: Client 1.4.4 correlates a pending DM with the exact `to` JID it
    // sent. Echoing the recipient's canonical JID instead breaks that match,
    // notably for local-domain targets such as user@127.0.0.1:9000.
    const Recipient = [...Recipients][0];
    if (Recipient != undefined) {
        sendPrivateMessage(session, Message, Message.toRaw);
    }
}

function sendRoomMessage(session: XmppSession, message: RoutedRoomMessage, room: string) {
    send(session, [
        `<message xmlns="jabber:client" type="groupchat"${attr("id", message.id)} from="${escapeXml(room)}/${escapeXml(message.fromNick)}" to="${escapeXml(session.fullJid)}">`,
        `<body>${escapeXml(message.body)}</body>`,
        `</message>`
    ].join(""));
}

function sendRoomOccupantPresence(recipient: XmppSession, room: string, occupant: XmppSession, nick: string, isSelf: boolean) {
    const ItemAffiliation = isSelf ? "owner" : "none";
    const ItemRole = isSelf ? "moderator" : "participant";
    const StatusCodes = isSelf ? `<status code="110"/><status code="100"/><status code="170"/><status code="201"/>` : "";
    send(recipient, [
        `<presence xmlns="jabber:client" from="${escapeXml(room)}/${escapeXml(nick)}" to="${escapeXml(recipient.fullJid)}">`,
        `<x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="${ItemAffiliation}" role="${ItemRole}" jid="${escapeXml(occupant.fullJid)}" nick="${escapeXml(nick)}"/>${StatusCodes}</x>`,
        `</presence>`
    ].join(""));
}

function sendRoomOccupantUnavailable(recipient: XmppSession, room: string, occupant: XmppSession, nick: string, isSelf: boolean) {
    const StatusCodes = isSelf ? `<status code="110"/><status code="100"/><status code="170"/>` : "";
    send(recipient, [
        `<presence xmlns="jabber:client" type="unavailable" from="${escapeXml(room)}/${escapeXml(nick)}" to="${escapeXml(recipient.fullJid)}">`,
        `<x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="none" role="none" jid="${escapeXml(occupant.fullJid)}" nick="${escapeXml(nick)}"/>${StatusCodes}</x>`,
        `</presence>`
    ].join(""));
}

function sendPrivateMessage(session: XmppSession, message: RoutedPrivateMessage, to: string) {
    send(session, [
        `<message xmlns="jabber:client" type="chat"${attr("id", message.id)} from="${escapeXml(message.fromJid)}" to="${escapeXml(to)}">`,
        `<body>${escapeXml(message.body)}</body>`,
        `</message>`
    ].join(""));
}

function closeSession(session: XmppSession) {
    for (const Room of [...session.rooms.keys()]) {
        RoomMembers.get(roomDeliveryKey(Room))?.delete(session);
    }

    UnregisterSocialSession(session.socialSessionId);
    unindexSession(session);
    Sessions.delete(session);
    LogProtocol("xmpp", "session.disconnected", { userId: session.userId, fullJid: session.fullJid });
}

function CanAccessRoom(session: XmppSession, room: string) {
    const PartyId = PartyIdFromRoom(room);
    if (PartyId == undefined) {
        return true;
    }

    return IsPlayerInPartyRoom(session.userId, PartyId);
}

function PartyIdFromRoom(room: string) {
    const Node = decodeXmppValue(bareNode(room));
    const Match = Node.match(/^Party-(.+)$/i);
    return Match?.[1];
}

function EjectRemovedPartyMembers(partyId: string, removedPlayerIds: string[]) {
    const RemovedPlayers = new Set(removedPlayerIds);

    for (const Session of Sessions) {
        if (!RemovedPlayers.has(Session.userId)) {
            continue;
        }

        for (const [Room, Nick] of [...Session.rooms.entries()]) {
            if (PartyIdFromRoom(Room) === partyId) {
                leaveRoom(Session, Room, Nick);
            }
        }
    }
}

function indexSession(session: XmppSession) {
    for (const Key of getSessionRecipientKeys(session)) {
        addToIndex(SessionsByRecipientKey, Key, session);
    }
}

function unindexSession(session: XmppSession) {
    for (const Key of getSessionRecipientKeys(session)) {
        removeFromIndex(SessionsByRecipientKey, Key, session);
    }
}

function addToIndex(index: Map<string, Set<XmppSession>>, key: string, session: XmppSession) {
    let SessionsForKey = index.get(key);
    if (SessionsForKey == undefined) {
        SessionsForKey = new Set();
        index.set(key, SessionsForKey);
    }

    SessionsForKey.add(session);
}

function removeFromIndex(index: Map<string, Set<XmppSession>>, key: string, session: XmppSession) {
    const SessionsForKey = index.get(key);
    if (SessionsForKey == undefined) {
        return;
    }

    SessionsForKey.delete(session);
    if (SessionsForKey.size === 0) {
        index.delete(key);
    }
}

function findRecipientSessions(to: string) {
    const Recipients = new Set<XmppSession>();
    for (const Key of recipientKeysForValue(to)) {
        for (const Session of SessionsByRecipientKey.get(Key) ?? []) {
            Recipients.add(Session);
        }
    }

    return Recipients;
}

function parseXmppFragment(frame: string) {
    const Parser = new SaxesParser({ fragment: true, xmlns: false });
    const Stack: XmppNode[] = [];
    const Roots: XmppNode[] = [];

    Parser.on("opentag", (tag: SaxesTagPlain) => {
        const Node: XmppNode = {
            name: tag.name,
            attrs: tag.attributes,
            children: []
        };

        const Parent = Stack[Stack.length - 1];
        if (Parent == undefined) {
            Roots.push(Node);
        }
        else {
            Parent.children.push(Node);
        }

        if (!tag.isSelfClosing) {
            Stack.push(Node);
        }
    });

    Parser.on("text", (text) => {
        const Parent = Stack[Stack.length - 1];
        if (Parent != undefined) {
            Parent.children.push(text);
        }
    });

    Parser.on("closetag", (tag: SaxesTagPlain) => {
        if (!tag.isSelfClosing) {
            Stack.pop();
        }
    });

    Parser.on("error", (error) => {
        logger.warn(error, `Could not parse XMPP frame`);
    });

    Parser.write(frame).close();
    return Roots;
}

function send(session: XmppSession, frame: string) {
    if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(frame);
    }
}

function toBareJid(userId: string) {
    return `${escapeJidNode(bareNode(userId))}@${XMPP_DOMAIN}`;
}

function bareJid(jid: string) {
    return jid.split("/")[0];
}

function bareNode(value: string) {
    const WithoutResource = bareJid(value);
    return WithoutResource.includes("@") ? WithoutResource.split("@")[0] : WithoutResource;
}

function resourceFromJid(jid: string) {
    const Parts = jid.split("/");
    return Parts.length > 1 ? Parts.slice(1).join("/") : undefined;
}

function roomDeliveryKey(room: string) {
    const Node = bareNode(room);
    if (/^City-/i.test(Node)) {
        return "City";
    }

    return room;
}

function roomForRecipientDelivery(session: XmppSession, message: RoutedRoomMessage) {
    return roomForRecipientDeliveryKey(session, message.deliveryKey, message.room);
}

function roomForRecipientDeliveryKey(session: XmppSession, deliveryKey: string, fallbackRoom: string) {
    if (deliveryKey === fallbackRoom) {
        return fallbackRoom;
    }

    for (const Room of session.rooms.keys()) {
        if (roomDeliveryKey(Room) === deliveryKey) {
            return Room;
        }
    }

    return fallbackRoom;
}

function roomNickForDeliveryKey(session: XmppSession, deliveryKey: string) {
    for (const [Room, Nick] of session.rooms.entries()) {
        if (roomDeliveryKey(Room) === deliveryKey) {
            return Nick;
        }
    }

    return undefined;
}

function epicRoomNick(session: XmppSession) {
    return `${encodeURIComponent(cleanDisplayName(session.displayName, session.userId))}:${session.userId}:${session.resource}`;
}

function canonicalRoomNick(session: XmppSession, requestedNick: string) {
    if (isInvalidMcpRoomNick(requestedNick)) {
        return epicRoomNick(session);
    }

    return requestedNick;
}

function messageRoomNick(session: XmppSession, nick: string) {
    if (isInvalidMcpRoomNick(nick)) {
        return epicRoomNick(session);
    }

    return nick;
}

function isInvalidMcpRoomNick(nick: string) {
    return /^InvalidMCPUser(?::|$)/i.test(decodeXmppValue(nick).trim());
}

function cleanDisplayName(value: string | undefined, fallback: string) {
    const Cleaned = (value ?? "").trim();

    return Cleaned.length > 0 ? Cleaned : fallback;
}

function isGeneratedDisplayName(displayName: string, userId: string) {
    const NormalizedDisplayName = displayName.trim().toLowerCase();
    const NormalizedUserId = userId.trim().toLowerCase();

    return NormalizedDisplayName.length === 0
        || NormalizedDisplayName === NormalizedUserId
        || /^(uid[-_]|local-\d+$|uuk_)/i.test(displayName);
}

function sanitizeResource(resource: string) {
    return resource.replace(/[<>&"']/g, "_").slice(0, 80) || "undaunted";
}

function escapeJidNode(node: string) {
    return node.replace(/\s+/g, "_").replace(/[<>&"'@/]/g, "_");
}

function normalizeUserKey(value: string) {
    return bareNode(value).trim().toLowerCase();
}

function parseXmppTarget(value: string): XmppTarget {
    const Decoded = decodeXmppValue(value).trim();
    const SlashIndex = Decoded.indexOf("/");
    const Bare = SlashIndex >= 0 ? Decoded.slice(0, SlashIndex) : Decoded;
    const Resource = SlashIndex >= 0 ? Decoded.slice(SlashIndex + 1) : undefined;
    const AtIndex = Bare.indexOf("@");
    const AccountNode = (AtIndex >= 0 ? Bare.slice(0, AtIndex) : Bare).trim();
    const Domain = AtIndex >= 0 ? Bare.slice(AtIndex + 1).trim() : undefined;

    return {
        accountNode: AccountNode,
        accountKey: normalizeUserKey(AccountNode),
        domain: Domain && Domain.length > 0 ? Domain : undefined,
        resource: Resource && Resource.length > 0 ? Resource : undefined
    };
}

function recipientKeysForValue(value: string | undefined) {
    const Keys = new Set<string>();
    if (value == undefined) {
        return Keys;
    }

    const Seeds = new Set<string>([
        value,
        decodeXmppValue(value),
        bareJid(value),
        decodeXmppValue(bareJid(value)),
        bareNode(value),
        decodeXmppValue(bareNode(value)),
        cleanDisplayName(value, value),
        cleanDisplayName(bareNode(value), bareNode(value)),
        value.replaceAll("_", " "),
        bareNode(value).replaceAll("_", " ")
    ]);

    for (const Seed of Seeds) {
        const Normalized = normalizeUserKey(Seed);
        if (Normalized.length > 0) {
            Keys.add(Normalized);
        }

        const Cleaned = cleanDisplayName(Seed, Seed).trim().toLowerCase();
        if (Cleaned.length > 0) {
            Keys.add(Cleaned);
        }
    }

    return Keys;
}

function decodeXmppValue(value: string) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}

function getSessionRecipientKeys(session: XmppSession) {
    const Values = [
        session.userId,
        session.displayName,
        session.bareJid,
        session.fullJid,
        toBareJid(session.userId),
        toBareJid(session.displayName),
        escapeJidNode(session.displayName)
    ];

    return new Set(Values.flatMap((Value) => [...recipientKeysForValue(Value)]));
}

export function GetXmppDebugState() {
    return {
        sessions: Sessions.size,
        authenticated: [...Sessions].filter((Session) => Session.authenticated).length,
        users: [...Sessions].map((Session) => ({
            id: Session.id,
            userId: Session.userId,
            displayName: Session.displayName,
            fullJid: Session.fullJid,
            authenticated: Session.authenticated,
            recipientKeys: [...getSessionRecipientKeys(Session)]
        })),
        rooms: [...RoomMembers.entries()].map(([deliveryKey, members]) => ({
            deliveryKey,
            members: [...members].map((Session) => ({
                id: Session.id,
                userId: Session.userId,
                displayName: Session.displayName,
                fullJid: Session.fullJid,
                rooms: [...Session.rooms.entries()]
                    .filter(([Room]) => roomDeliveryKey(Room) === deliveryKey)
                    .map(([Room, Nick]) => ({ room: Room, nick: Nick })),
                authenticated: Session.authenticated
            }))
        }))
    };
}
