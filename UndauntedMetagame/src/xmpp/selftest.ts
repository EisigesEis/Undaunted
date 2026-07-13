import assert from "assert";
import http from "http";
import WebSocket from "ws";
import { RememberUsernameForUserId } from "../controllers/login";
import { AttachXmppServer } from "./server";

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

    const Alice = await connectBoundClient(`${BaseUrl}/xmpp`, "alice", "alice-resource");
    const Bob = await connectBoundClient(`${BaseUrl}/xmpp`, "bob", "bob-resource");
    const Room = "general@conference.prod.ol.epicgames.com";

    Alice.ws.send(`<presence to="${Room}/UID-alice [No Epic Account]"/>`);
    Bob.ws.send(`<presence to="${Room}/bob"/>`);
    await Alice.waitFor((Message) => Message.includes('status code="110"'), "alice room join ack");
    await Bob.waitFor((Message) => Message.includes('status code="110"'), "bob room join ack");

    Alice.ws.send(`<message type="groupchat" id="group-1" to="${Room}"><body>Hello room</body></message>`);
    await Alice.waitFor((Message) => Message.includes('type="groupchat"') && Message.includes(`from="${Room}/UID-alice [No Epic Account]"`) && Message.includes("Hello room"), "alice group echo");
    await Bob.waitFor((Message) => Message.includes('type="groupchat"') && Message.includes(`from="${Room}/UID-alice [No Epic Account]"`) && Message.includes("Hello room"), "bob group delivery");

    process.env.LOCAL_USER_ID = "local-display-user";
    RememberUsernameForUserId("local-display-user", "Local Slayer");
    RememberUsernameForUserId("UID-generated-local-user", "UID-generated-local-user");
    const Local = await connectBoundClient(`${BaseUrl}/xmpp`, "UID-generated-local-user", "local-resource");
    Local.ws.send(`<presence to="${Room}/UID-generated-local-user [No Epic Account]"/>`);
    await Local.waitFor((Message) => Message.includes('status code="110"'), "local generated user room join ack");
    Local.ws.send(`<message type="groupchat" id="group-local" to="${Room}"><body>Local hello</body></message>`);
    await Bob.waitFor((Message) => Message.includes('type="groupchat"') && Message.includes(`from="${Room}/UID-generated-local-user [No Epic Account]"`) && Message.includes("Local hello"), "local generated user requested nick delivery");

    Alice.ws.send(`<message type="chat" id="private-1" to="bob@prod.ol.epicgames.com"><body>Hello Bob</body></message>`);
    await Bob.waitFor((Message) => Message.includes('type="chat"') && Message.includes("Hello Bob"), "bob private delivery");
    assert(!Alice.messages.some((Message) => Message.includes('id="private-1"') && Message.includes("Hello Bob")), "private message should not be echoed to sender when recipient is online");

    Alice.ws.send(`<presence type="unavailable" to="${Room}/alice"/>`);
    await Alice.waitFor((Message) => Message.includes('type="unavailable"'), "alice room leave ack");

    Alice.ws.close();
    Bob.ws.close();
    Local.ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function connectBoundClient(url: string, userId: string, resource: string) {
    const Client = await connect(url);
    Client.ws.send(`<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="prod.ol.epicgames.com" version="1.0"/>`);
    await Client.waitFor((Message) => Message.includes("<stream:features"), `${userId} features`);

    const Plain = Buffer.from(`\u0000${userId}\u0000local-password`, "utf8").toString("base64");
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
