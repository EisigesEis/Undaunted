import http from "http";
import jwt, { JwtPayload } from "jsonwebtoken";
import { SaxesParser, SaxesTagPlain } from "saxes";
import { WebSocket, WebSocketServer } from "ws";
import { GetDisplayUsernameForUserId } from "../controllers/login";
import { logger } from "../logger";
import { attr, escapeXml, findChild, findDescendant, nodeText, parseOpeningTag, XmppNode } from "./xml";

const XMPP_PATH = process.env.XMPP_PATH || "/xmpp";
const XMPP_DOMAIN = process.env.XMPP_DOMAIN || "prod.ol.epicgames.com";
const XMPP_HISTORY_LIMIT = Number(process.env.XMPP_HISTORY_LIMIT || "50");
const XMPP_REQUIRE_AUTH = process.env.XMPP_REQUIRE_AUTH === "true";
const XMPP_IDLE_CLOSE_MS = Number(process.env.XMPP_IDLE_CLOSE_MS || String(2 * 60 * 60 * 1000));
const XMPP_HEARTBEAT_MS = Number(process.env.XMPP_HEARTBEAT_MS || "30000");

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
};

type StoredRoomMessage = {
    room: string;
    fromNick: string;
    fromDisplayName: string;
    body: string;
    id?: string;
    stamp: string;
};

type StoredPrivateMessage = {
    fromUserId: string;
    fromDisplayName: string;
    toKey: string;
    body: string;
    id?: string;
    stamp: string;
};

type SessionIdentity = {
    userId: string;
    displayName: string;
};

export type AttachXmppServerOptions = {
    path?: string;
};

let NextSessionId = 1;

const Sessions = new Set<XmppSession>();
const SessionsByUserId = new Map<string, Set<XmppSession>>();
const SessionsByName = new Map<string, Set<XmppSession>>();
const RoomMembers = new Map<string, Set<XmppSession>>();
const RoomHistory = new Map<string, StoredRoomMessage[]>();
const PrivateHistory = new Map<string, StoredPrivateMessage[]>();

export function AttachXmppServer(server: http.Server, options: AttachXmppServerOptions = {}) {
    const Path = options.path ?? XMPP_PATH;
    const WebsocketServer = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
        const RequestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
        const IsXmppPath = RequestUrl.pathname === Path || RequestUrl.pathname.startsWith(`${Path}:`);
        if (!IsXmppPath) {
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
            send(session, `<enabled xmlns="urn:xmpp:sm:3"${attr("id", session.id)} resume="true"/>`);
            break;
        case "r":
            send(session, `<a xmlns="urn:xmpp:sm:3" h="${session.handledStanzas}"/>`);
            break;
        case "a":
            break;
        case "iq":
            handleIq(session, node);
            break;
        case "presence":
            handlePresence(session, node);
            break;
        case "message":
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
    const Identity = identityFromPlainAuth(Encoded) ?? permissiveIdentity(session);

    if (XMPP_REQUIRE_AUTH && Identity.userId.startsWith("local-")) {
        send(session, `<failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><not-authorized/></failure>`);
        return;
    }

    const DisplayName = await resolveDisplayName(Identity.userId, Identity.displayName);
    applyIdentity(session, { ...Identity, displayName: DisplayName });
    session.authenticated = true;
    logger.info(`XMPP session authenticated as ${session.userId}`);
    send(session, `<success xmlns="urn:ietf:params:xml:ns:xmpp-sasl"/>`);
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

    const UserId = Parts.find((Part) => Part.length > 0);
    if (UserId != undefined) {
        return { userId: bareNode(UserId), displayName: bareNode(UserId) };
    }

    return undefined;
}

function validateJwtAndGetUserId(token: string | undefined) {
    if (token == undefined || process.env.AUTH_SIGNING_PUBKEY_B64 == undefined) {
        return undefined;
    }

    try {
        const PublicKey = Buffer.from(process.env.AUTH_SIGNING_PUBKEY_B64, "base64").toString("utf-8");
        const Payload = jwt.verify(token, PublicKey, {
            algorithms: ["RS256"],
            issuer: "undaunted-metagame",
            audience: "undaunted-metagame"
        }) as JwtPayload;

        return typeof Payload.userId === "string" ? Payload.userId : undefined;
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
    session.userId = identity.userId;
    session.displayName = identity.displayName;
    session.bareJid = toBareJid(identity.userId);
    session.fullJid = `${session.bareJid}/${session.resource}`;
    indexSession(session);
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
        session.resource = sanitizeResource(Resource);
        session.fullJid = `${session.bareJid}/${session.resource}`;
        logger.info(`XMPP session bound ${session.fullJid}`);
        send(session, `<iq type="result"${attr("id", Id)}><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><jid>${escapeXml(session.fullJid)}</jid></bind></iq>`);
        replayPrivateHistory(session);
        return;
    }

    if (findDescendant(node, "session") != undefined) {
        send(session, `<iq type="result"${attr("id", Id)}${attr("to", session.fullJid)}/>`);
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
        send(session, `<presence from="${escapeXml(session.fullJid)}" to="${escapeXml(session.fullJid)}"/>`);
        return;
    }

    const Room = bareJid(To);
    const RequestedNick = resourceFromJid(To) ?? session.displayName;
    const Nick = RequestedNick;

    if (node.attrs.type === "unavailable") {
        leaveRoom(session, Room, Nick);
        return;
    }

    joinRoom(session, Room, Nick);
}

function joinRoom(session: XmppSession, room: string, nick: string) {
    let Members = RoomMembers.get(room);
    if (Members == undefined) {
        Members = new Set();
        RoomMembers.set(room, Members);
    }

    Members.add(session);
    session.rooms.set(room, nick);
    logger.info(`XMPP ${session.userId} joined room ${room} as ${nick}`);

    send(session, [
        `<presence xmlns="jabber:client" from="${escapeXml(room)}/${escapeXml(nick)}" to="${escapeXml(session.fullJid)}">`,
        `<x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="owner" role="moderator" jid="${escapeXml(session.fullJid)}" nick="${escapeXml(nick)}"/><status code="110"/><status code="100"/><status code="170"/><status code="201"/></x>`,
        `</presence>`
    ].join(""));

    replayRoomHistory(session, room);
}

function leaveRoom(session: XmppSession, room: string, nick: string) {
    const JoinedNick = session.rooms.get(room) ?? nick;
    RoomMembers.get(room)?.delete(session);
    session.rooms.delete(room);
    logger.info(`XMPP ${session.userId} left room ${room} as ${JoinedNick}`);
    send(session, [
        `<presence xmlns="jabber:client" type="unavailable" from="${escapeXml(room)}/${escapeXml(JoinedNick)}" to="${escapeXml(session.fullJid)}">`,
        `<x xmlns="http://jabber.org/protocol/muc#user"><item affiliation="owner" role="none" jid="${escapeXml(session.fullJid)}" nick="${escapeXml(JoinedNick)}"/><status code="110"/><status code="100"/><status code="170"/></x>`,
        `</presence>`
    ].join(""));

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
    if (!session.rooms.has(Room)) {
        joinRoom(session, Room, session.displayName);
    }

    const Message: StoredRoomMessage = {
        room: Room,
        fromNick: session.rooms.get(Room) ?? session.displayName,
        fromDisplayName: session.displayName,
        body,
        id: node.attrs.id,
        stamp: new Date().toISOString()
    };

    pushBounded(RoomHistory, Room, Message);
    logger.info(`XMPP groupchat from ${session.userId} to ${Room}: ${body.slice(0, 80)}`);
    const Members = RoomMembers.get(Room) ?? new Set<XmppSession>();
    for (const Member of Members) {
        sendRoomMessage(Member, Message);
    }
}

function handlePrivateMessage(session: XmppSession, node: XmppNode, body: string) {
    const To = node.attrs.to;
    if (To == undefined) {
        return;
    }

    const ToKey = normalizeUserKey(bareNode(To));
    const Message: StoredPrivateMessage = {
        fromUserId: session.userId,
        fromDisplayName: session.displayName,
        toKey: ToKey,
        body,
        id: node.attrs.id,
        stamp: new Date().toISOString()
    };

    pushBounded(PrivateHistory, privateHistoryKey(normalizeUserKey(session.userId), ToKey), Message);

    const Recipients = findRecipientSessions(ToKey);
    logger.info(`XMPP private chat from ${session.userId} to ${ToKey}: ${body.slice(0, 80)} (${Recipients.size} recipient sessions)`);
    for (const Recipient of Recipients) {
        sendPrivateMessage(Recipient, Message, Recipient.fullJid);
    }

    if (!Recipients.has(session)) {
        sendPrivateMessage(session, Message, session.fullJid);
    }
}

function sendRoomMessage(session: XmppSession, message: StoredRoomMessage, delayed = false) {
    const Delay = delayed ? `<delay xmlns="urn:xmpp:delay" stamp="${escapeXml(message.stamp)}"/>` : "";
    send(session, [
        `<message xmlns="jabber:client" type="groupchat"${attr("id", message.id)} from="${escapeXml(message.room)}/${escapeXml(message.fromNick)}" to="${escapeXml(session.fullJid)}">`,
        `<body>${escapeXml(message.body)}</body>`,
        Delay,
        `</message>`
    ].join(""));
}

function sendPrivateMessage(session: XmppSession, message: StoredPrivateMessage, to: string, delayed = false) {
    const Delay = delayed ? `<delay xmlns="urn:xmpp:delay" stamp="${escapeXml(message.stamp)}"/>` : "";
    send(session, [
        `<message type="chat"${attr("id", message.id)} from="${escapeXml(toBareJid(message.fromUserId))}" to="${escapeXml(to)}">`,
        `<body>${escapeXml(message.body)}</body>`,
        Delay,
        `</message>`
    ].join(""));
}

function replayRoomHistory(session: XmppSession, room: string) {
    for (const Message of RoomHistory.get(room) ?? []) {
        sendRoomMessage(session, Message, true);
    }
}

function replayPrivateHistory(session: XmppSession) {
    const Keys = new Set([
        normalizeUserKey(session.userId),
        normalizeUserKey(session.displayName),
        normalizeUserKey(session.bareJid)
    ]);

    for (const [Key, Messages] of PrivateHistory.entries()) {
        if (![...Keys].some((UserKey) => Key.split("|").includes(UserKey))) {
            continue;
        }

        for (const Message of Messages) {
            sendPrivateMessage(session, Message, session.fullJid, true);
        }
    }
}

function closeSession(session: XmppSession) {
    for (const Room of [...session.rooms.keys()]) {
        RoomMembers.get(Room)?.delete(session);
    }

    unindexSession(session);
    Sessions.delete(session);
    logger.info(`XMPP client disconnected ${session.userId}`);
}

function indexSession(session: XmppSession) {
    addToIndex(SessionsByUserId, normalizeUserKey(session.userId), session);
    addToIndex(SessionsByName, normalizeUserKey(session.displayName), session);
    addToIndex(SessionsByUserId, normalizeUserKey(session.bareJid), session);
}

function unindexSession(session: XmppSession) {
    removeFromIndex(SessionsByUserId, normalizeUserKey(session.userId), session);
    removeFromIndex(SessionsByName, normalizeUserKey(session.displayName), session);
    removeFromIndex(SessionsByUserId, normalizeUserKey(session.bareJid), session);
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

function findRecipientSessions(toKey: string) {
    return new Set([
        ...(SessionsByUserId.get(toKey) ?? []),
        ...(SessionsByName.get(toKey) ?? [])
    ]);
}

function pushBounded<T>(history: Map<string, T[]>, key: string, value: T) {
    const Values = history.get(key) ?? [];
    Values.push(value);
    while (Values.length > XMPP_HISTORY_LIMIT) {
        Values.shift();
    }
    history.set(key, Values);
}

function privateHistoryKey(left: string, right: string) {
    return [left, right].sort().join("|");
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

function defaultRoomNick(session: XmppSession) {
    return cleanDisplayName(session.displayName, session.userId);
}

function canonicalRoomNick(session: XmppSession, requestedNick?: string) {
    return cleanDisplayName(session.displayName, cleanDisplayName(requestedNick, session.userId));
}

function cleanDisplayName(value: string | undefined, fallback: string) {
    const Cleaned = (value ?? "")
        .replace(/\s*\[No Epic Account\]/gi, "")
        .trim();

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
    return bareNode(value).toLowerCase();
}

export function GetXmppDebugState() {
    return {
        sessions: Sessions.size,
        rooms: [...RoomMembers.entries()].map(([room, members]) => ({ room, members: members.size })),
        roomHistory: [...RoomHistory.entries()].map(([room, messages]) => ({ room, messages: messages.length })),
        privateThreads: PrivateHistory.size
    };
}
