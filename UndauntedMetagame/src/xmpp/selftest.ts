import "dotenv/config";
import assert from "assert";
import http from "http";
import WebSocket from "ws";
import { SignMetagameJWTForUid } from "../controllers/auth";
import { RememberUsernameForUserId } from "../controllers/login";
import { AttachXmppServer } from "./server";

/**
 * TODO:
 * In future should be based on more live traffic assertions.
 */

type TestClient = {
    ws: WebSocket;
    messages: string[];
    waitFor: (predicate: (message: string) => boolean, label: string) => Promise<string>;
};

async function main() {
    const server = http.createServer((_req, res) => {
        res.statusCode = 404;
        res.end();
    });

    AttachXmppServer(server, { path: "/xmpp" });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const Address = server.address();
    assert(Address != undefined && typeof Address !== "string");
    const BaseUrl = `ws://127.0.0.1:${Address.port}`;

    await assert.rejects(connect(`${BaseUrl}/not-xmpp`));
    await assert.rejects(connect(`${BaseUrl}//`));

    RememberUsernameForUserId("alice", "Alice");
    RememberUsernameForUserId("bob", "Bob");
    RememberUsernameForUserId("eve", "Eve");
    const AliceResource = "V2:JackalDev:WIN::ALICE";
    const BobResource = "V2:JackalDev:WIN::BOB";
    const EveResource = "V2:JackalDev:WIN::EVE";
    const Alice = await connectBoundClient(`${BaseUrl}/xmpp`, "alice", AliceResource);
    const Bob = await connectBoundClient(`${BaseUrl}/xmpp`, "bob", BobResource);
    const Eve = await connectBoundClient(`${BaseUrl}/xmpp`, "eve", EveResource);
    const Room = "Party-test_NjgyNDg2XzIuMS4xX3NoaXBwaW5n@muc.prod.ol.epicgames.com";
    const OtherRoom = "Hunt-other@muc.prod.ol.epicgames.com";
    const AliceNick = roomNick("Alice", "alice", AliceResource);
    const BobNick = roomNick("Bob", "bob", BobResource);
    const EveNick = roomNick("Eve", "eve", EveResource);

    Alice.ws.send(`<presence to="${Room}/${AliceNick}"><x xmlns="http://jabber.org/protocol/muc"><history maxstanzas="50"/></x></presence>`);
    Bob.ws.send(`<presence to="${Room}/${BobNick}"><x xmlns="http://jabber.org/protocol/muc"><history maxstanzas="50"/></x></presence>`);
    await Alice.waitFor((Message) => Message.includes('status code="110"'), "alice room join ack");
    await Bob.waitFor((Message) => Message.includes('status code="110"'), "bob room join ack");
    await Alice.waitFor((Message) => Message.includes(`from="${Room}/${BobNick}"`) && Message.includes('role="participant"'), "alice sees bob room occupant");
    await Bob.waitFor((Message) => Message.includes(`from="${Room}/${AliceNick}"`) && Message.includes('role="participant"'), "bob sees alice room occupant");

    Alice.ws.send(`<message type="groupchat" id="group-1" to="${Room}"><body>Hello room</body></message>`);
    await Alice.waitFor((Message) => Message.includes('xmlns="jabber:client"') && Message.includes('type="groupchat"') && Message.includes(`from="${Room}/${AliceNick}"`) && Message.includes("Hello room"), "alice group live echo");
    await Bob.waitFor((Message) => Message.includes('type="groupchat"') && Message.includes(`from="${Room}/${AliceNick}"`) && Message.includes("Hello room"), "bob group delivery");

    Eve.ws.send(`<presence to="${OtherRoom}/${EveNick}"><x xmlns="http://jabber.org/protocol/muc"><history maxstanzas="50"/></x></presence>`);
    await Eve.waitFor((Message) => Message.includes(OtherRoom) && Message.includes('status code="110"'), "eve other room join ack");
    Alice.ws.send(`<message type="groupchat" id="group-room-only" to="${Room}"><body>Room only</body></message>`);
    await Bob.waitFor((Message) => Message.includes('id="group-room-only"') && Message.includes("Room only"), "bob room-only delivery");
    await delay(50);
    assert(!Eve.messages.some((Message) => Message.includes('id="group-room-only"') && Message.includes("Room only")), "groupchat should not leak to different rooms");

    const AliceCityRoom = "City-alice@muc.127.0.0.1:9000";
    const BobCityRoom = "City-bob@muc.127.0.0.1:9000";
    Alice.ws.send(`<presence to="${AliceCityRoom}/${AliceNick}"><x xmlns="http://jabber.org/protocol/muc"><history maxstanzas="50"/></x></presence>`);
    Bob.ws.send(`<presence to="${BobCityRoom}/${BobNick}"><x xmlns="http://jabber.org/protocol/muc"><history maxstanzas="50"/></x></presence>`);
    await Alice.waitFor((Message) => Message.includes(AliceCityRoom) && Message.includes('status code="110"'), "alice city room join ack");
    await Bob.waitFor((Message) => Message.includes(BobCityRoom) && Message.includes('status code="110"'), "bob city room join ack");
    await Alice.waitFor((Message) => Message.includes(`from="${AliceCityRoom}/${BobNick}"`) && Message.includes('role="participant"'), "alice sees bob city occupant");
    await Bob.waitFor((Message) => Message.includes(`from="${BobCityRoom}/${AliceNick}"`) && Message.includes('role="participant"'), "bob sees alice city occupant");

    Alice.ws.send(`<message type="groupchat" id="city-cross-room" to="${AliceCityRoom}"><body>City hello</body></message>`);
    await Alice.waitFor((Message) => Message.includes('id="city-cross-room"') && Message.includes(`from="${AliceCityRoom}/${AliceNick}"`) && Message.includes("City hello"), "alice city local echo");
    await Bob.waitFor((Message) => Message.includes('id="city-cross-room"') && Message.includes(`from="${BobCityRoom}/${AliceNick}"`) && Message.includes("City hello"), "bob city cross-room delivery");
    await delay(50);
    assert(!Eve.messages.some((Message) => Message.includes('id="city-cross-room"') && Message.includes("City hello")), "city groupchat should not leak outside city rooms");

    const InvalidNickRoom = "Party-invalid@muc.prod.ol.epicgames.com";
    Alice.ws.send(`<presence to="${InvalidNickRoom}/InvalidMCPUser:alice:${AliceResource}"><x xmlns="http://jabber.org/protocol/muc"><history maxstanzas="50"/></x></presence>`);
    const InvalidNickAck = await Alice.waitFor((Message) => Message.includes(InvalidNickRoom) && Message.includes('status code="110"'), "invalid nick room join ack");
    assert(!InvalidNickAck.includes("InvalidMCPUser"), "invalid MCP room nick should be canonicalized on join");
    Alice.ws.send(`<message type="groupchat" id="invalid-nick-message" to="${InvalidNickRoom}"><body>Name check</body></message>`);
    const InvalidNickEcho = await Alice.waitFor((Message) => Message.includes('id="invalid-nick-message"') && Message.includes("Name check"), "invalid nick group echo");
    assert(!InvalidNickEcho.includes("InvalidMCPUser"), "invalid MCP room nick should not be used for chat sender");

    process.env.LOCAL_USER_ID = "local-display-user";
    RememberUsernameForUserId("local-display-user", "Local Slayer");
    RememberUsernameForUserId("UID-generated-local-user", "UID-generated-local-user");
    const LocalResource = "V2:JackalDev:WIN::LOCAL";
    const Local = await connectBoundClient(`${BaseUrl}/xmpp`, "UID-generated-local-user", LocalResource);
    const LocalNick = roomNick("Local Slayer", "UID-generated-local-user", LocalResource);
    const CanonicalLocalNick = roomNick("Local Slayer", "UID-generated-local-user", LocalResource);
    Local.ws.send(`<presence to="${Room}/${LocalNick}"><x xmlns="http://jabber.org/protocol/muc"><history maxstanzas="50"/></x></presence>`);
    await Local.waitFor((Message) => Message.includes('status code="110"'), "local generated user room join ack");
    await delay(50);
    assert(!Local.messages.some((Message) => Message.includes('id="group-1"') && Message.includes("Hello room")), "late room join should not replay old room messages");

    Local.ws.send(`<message type="groupchat" id="group-local" to="${Room}"><body>Local hello</body></message>`);
    await Bob.waitFor((Message) => Message.includes('type="groupchat"') && Message.includes(`from="${Room}/${CanonicalLocalNick}"`) && Message.includes("Local hello"), "local generated user requested nick delivery");

    Alice.ws.send(`<message type="chat" id="private-1" to="bob@prod.ol.epicgames.com"><body>Hello Bob</body></message>`);
    await Bob.waitFor((Message) => Message.includes('type="chat"') && Message.includes("Hello Bob"), "bob private delivery");
    assert(!Alice.messages.some((Message) => Message.includes('id="private-1"') && Message.includes("Hello Bob")), "private message should not be echoed to sender when recipient is online");

    Alice.ws.send(`<message type="chat" id="private-userid" to="bob"><body>Hello Bob by account</body></message>`);
    await Bob.waitFor((Message) => Message.includes('type="chat"') && Message.includes("Hello Bob by account"), "bob account id private delivery");

    Alice.ws.send(`<message type="chat" id="private-display" to="Bob"><body>Hello Bob by display</body></message>`);
    await Bob.waitFor((Message) => Message.includes('type="chat"') && Message.includes("Hello Bob by display"), "bob display private delivery");

    Alice.ws.send(`<message type="chat" id="private-missing" to="Nobody"><body>Hello nobody</body></message>`);
    await delay(50);
    assert.strictEqual(Alice.ws.readyState, WebSocket.OPEN, "unmatched whisper should not close sender socket");

    Alice.ws.send(`<message type="chat" id="private-offline" to="charlie"><body>Hello offline Charlie</body></message>`);
    await delay(50);
    const Charlie = await connectBoundClient(`${BaseUrl}/xmpp`, "charlie", "charlie-resource");
    await delay(50);
    assert(!Charlie.messages.some((Message) => Message.includes("Hello offline Charlie")), "offline whisper should not replay after reconnect");

    Alice.ws.send(`<presence type="unavailable" to="${Room}/alice"/>`);
    await Alice.waitFor((Message) => Message.includes('type="unavailable"'), "alice room leave ack");

    Alice.ws.close();
    Bob.ws.close();
    Eve.ws.close();
    Local.ws.close();
    Charlie.ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

function roomNick(displayName: string, userId: string, resource: string) {
    return `${encodeURIComponent(displayName)}:${userId}:${resource}`;
}

function delay(milliseconds: number) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function connectBoundClient(url: string, userId: string, resource: string) {
    const Client = await connect(url);
    Client.ws.send(`<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="prod.ol.epicgames.com" version="1.0"/>`);
    await Client.waitFor((Message) => Message.includes("<stream:features"), `${userId} features`);

    const Plain = Buffer.from(`\u0000${userId}\u0000${SignMetagameJWTForUid(userId)}`, "utf8").toString("base64");
    Client.ws.send(`<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">${Plain}</auth>`);
    await Client.waitFor((Message) => Message.includes("<success"), `${userId} sasl success`);

    Client.ws.send(`<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="prod.ol.epicgames.com" version="1.0"/>`);
    await Client.waitFor((Message) => Message.includes("<stream:features"), `${userId} post-auth features`);

    Client.ws.send(`<iq type="set" id="bind-${userId}"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>${resource}</resource></bind></iq>`);
    await Client.waitFor((Message) => Message.includes(`id="bind-${userId}"`) && Message.includes(`${userId}@prod.ol.epicgames.com/${resource}`), `${userId} bind result`);

    Client.ws.send(`<iq type="set" id="session-${userId}"><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></iq>`);
    await Client.waitFor((Message) => Message.includes(`id="session-${userId}"`), `${userId} session result`);
    return Client;
}

function connect(url: string) {
    return new Promise<TestClient>((resolve, reject) => {
        const Ws = new WebSocket(url);
        const Messages: string[] = [];
        const Waiters: Array<{
            predicate: (message: string) => boolean;
            resolve: (message: string) => void;
            reject: (error: Error) => void;
            label: string;
            timeout: NodeJS.Timeout;
        }> = [];

        Ws.on("open", () => {
            resolve({
                ws: Ws,
                messages: Messages,
                waitFor: (predicate, label) => waitForMessage(Messages, Waiters, predicate, label)
            });
        });

        Ws.on("message", (data) => {
            const Message = data.toString();
            Messages.push(Message);
            for (const Waiter of [...Waiters]) {
                if (!Waiter.predicate(Message)) {
                    continue;
                }

                clearTimeout(Waiter.timeout);
                Waiters.splice(Waiters.indexOf(Waiter), 1);
                Waiter.resolve(Message);
            }
        });

        Ws.on("error", reject);
        Ws.on("close", () => reject(new Error(`websocket closed before open: ${url}`)));
    });
}

function waitForMessage(
    messages: string[],
    waiters: Array<{
        predicate: (message: string) => boolean;
        resolve: (message: string) => void;
        reject: (error: Error) => void;
        label: string;
        timeout: NodeJS.Timeout;
    }>,
    predicate: (message: string) => boolean,
    label: string
) {
    const ExistingMessage = messages.find(predicate);
    if (ExistingMessage != undefined) {
        return Promise.resolve(ExistingMessage);
    }

    return new Promise<string>((resolve, reject) => {
        const Waiter = {
            predicate,
            resolve,
            reject,
            label,
            timeout: setTimeout(() => {
                waiters.splice(waiters.indexOf(Waiter), 1);
                reject(new Error(`Timed out waiting for ${label}`));
            }, 2000)
        };
        waiters.push(Waiter);
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
