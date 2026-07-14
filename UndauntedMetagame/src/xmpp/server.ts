import http from "http";
import { SaxesParser, SaxesTagPlain } from "saxes";
import { WebSocket, WebSocketServer } from "ws";
import { ValidateMetagameJWTAndGetPayload } from "../controllers/auth";
import { GetDisplayUsernameForUserId } from "../controllers/login";
import { RegisterSocialSession, TouchSocialSession, UnregisterSocialSession } from "../controllers/social";
import { logger } from "../logger";
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
    toKey: string;
    body: string;
    id?: string;
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

        logger.info(`Accepted XMPP websocket upgrade for ${RequestUrl.pathname}`);
        WebsocketServer.handleUpgrade(request, socket, head, (ws) => {
            WebsocketServer.emit("connection", ws, request);
        });
    });

    WebsocketServer.on("connection", (ws) => {
        const Session = createSession(ws);
        Sessions.add(Session);
        indexSession(Session);
        logger.info(`XMPP client connected as ${Session.userId}`);

        ws.on("message", (data) => handleFrame(Session, data.toString()));
        ws.on("pong", () => {
            Session.lastActivityAt = Date.now();
        });
        ws.on("close", () => closeSession(Session));
        ws.on("error", (error) => logger.warn(error, `XMPP websocket error for ${Session.userId}`));
    });

    const Heartbeat = setInterval(() => {
        const Now = Date.now();
        for (const Session of Sessions) {
            if (Now - Session.lastActivityAt > XMPP_IDLE_CLOSE_MS) {
                logger.info(`XMPP idle timeout for ${Session.userId} after ${Math.round((Now - Session.lastActivityAt) / 1000)}s`);
                Session.ws.close(1000, "idle timeout");
                continue;
            }

            if (Session.ws.readyState === WebSocket.OPEN) {
                Session.ws.ping();
            }
        }
    }, XMPP_HEARTBEAT_MS);

    Heartbeat.unref();
    WebsocketServer.on("close", () => clearInterval(Heartbeat));

    logger.info(`XMPP websocket server mounted at ${Path}`);
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

    logger.debug({ userId: session.userId, frame: TrimmedFrame.slice(0, 500) }, "XMPP frame received");

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
    logger.info({ userId: session.userId, displayName: session.displayName, recipientKeys: [...getSessionRecipientKeys(session)] }, "XMPP session authenticated");
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
                logger.info(`XMPP resolved generated display name ${userId} via local user ${LocalUserId}`);
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
        logger.info({ userId: session.userId, fullJid: session.fullJid, recipientKeys: [...getSessionRecipientKeys(session)] }, "XMPP session bound");
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
        send(session, `<iq type="result"${attr("id", Id)}${attr("to", session.fullJid)}><query xmlns="jabber:iq:roster"/></iq>`);
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

function handlePresence(session: XmppSession, node: XmppNode) {
    const To = node.attrs.to;
    if (To == undefined) {
        logger.info({ userId: session.userId, fullJid: session.fullJid }, "XMPP self presence");
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

    joinRoom(session, Room, Nick);
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
    logger.info({ userId: session.userId, room, deliveryKey: DeliveryKey, nick, memberCount: Members.size }, "XMPP joined room");

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
    logger.info({ userId: session.userId, room, deliveryKey: DeliveryKey, nick: JoinedNick }, "XMPP left room");
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

    logger.info({
        senderUserId: session.userId,
        room: Room,
        deliveryKey: DeliveryKey,
        fromNick: Message.fromNick,
        bodyPreview: body.slice(0, 80),
        roomMemberCount: Members.size,
        recipientCount: Recipients.size,
        broadcastFallback: Recipients.size > Members.size
    }, "XMPP groupchat route");

    for (const Recipient of Recipients) {
        sendRoomMessage(Recipient, Message, roomForRecipientDelivery(Recipient, Message));
    }
}

function handlePrivateMessage(session: XmppSession, node: XmppNode, body: string) {
    const To = node.attrs.to;
    if (To == undefined) {
        return;
    }

    const ToKeys = recipientKeysForValue(To);
    const ToKey = [...ToKeys][0] ?? normalizeUserKey(To);
    const Message: RoutedPrivateMessage = {
        fromUserId: session.userId,
        fromDisplayName: session.displayName,
        toKey: ToKey,
        body,
        id: node.attrs.id
    };

    const Recipients = new Set([...findRecipientSessions(To)].filter((Candidate) => Candidate !== session && Candidate.authenticated));
    logger.info({
        senderUserId: session.userId,
        toRaw: To,
        normalizedKeys: [...ToKeys],
        bodyPreview: body.slice(0, 80),
        recipientCount: Recipients.size
    }, "XMPP private chat route");

    if (Recipients.size === 0) {
        logger.warn({
            senderUserId: session.userId,
            toRaw: To,
            normalizedKeys: [...ToKeys]
        }, "XMPP private chat unresolved recipient");
    }

    for (const Recipient of Recipients) {
        sendPrivateMessage(Recipient, Message, Recipient.fullJid);
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
        `<message xmlns="jabber:client" type="chat"${attr("id", message.id)} from="${escapeXml(toBareJid(message.fromUserId))}" to="${escapeXml(to)}">`,
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
    logger.info({ userId: session.userId, fullJid: session.fullJid }, "XMPP client disconnected");
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
