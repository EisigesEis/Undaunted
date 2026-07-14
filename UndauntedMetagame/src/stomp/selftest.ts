import "dotenv/config";
import assert from "assert";
import http from "http";
import WebSocket from "ws";
import { SignMetagameJWTForUid } from "../controllers/auth";
import { AttachStompServer } from "./server";
import { AttachXmppServer } from "../xmpp/server";
import { RememberUsernameForUserId } from "../controllers/login";
import { RegisterSocialSession, UnregisterSocialSession } from "../controllers/social";
import { UpdatePlayerActivity } from "../controllers/undauntedapi";

/**
 * TODO:
 * In future should be based on more live traffic assertions.
 */

type TestClient = {
    ws: WebSocket;
    messages: string[];
    waitFor: (predicate: (message: string) => boolean, label: string) => Promise<string>;
};

const TestUserId = "stomp-test-user-a";
const TestFriendId = "stomp-test-user-b";

async function main() {
    const server = http.createServer((_req, res) => {
        res.statusCode = 404;
        res.end();
    });

    AttachXmppServer(server, { path: "/xmpp", rejectUnknownPath: false });
    AttachStompServer(server, { heartbeatMs: 100, idleCloseMs: 5000 });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const Address = server.address();
    assert(Address != undefined && typeof Address !== "string");
    const BaseUrl = `ws://127.0.0.1:${Address.port}`;
    process.env.SOCIAL_FRIEND_USER_IDS = `${TestUserId},${TestFriendId}`;
    RememberUsernameForUserId(TestUserId, "STOMP Test User");
    RememberUsernameForUserId(TestFriendId, "STOMP Test Friend");
    const Token = SignMetagameJWTForUid(TestUserId);
    const FriendSession = RegisterSocialSession(TestFriendId, "xmpp");

    const Alice = await connect(`${BaseUrl}/ws/${TestUserId}?access_token=${encodeURIComponent(Token)}`);
    Alice.ws.send("CONNECT\naccept-version:1.2\n\n\0");
    await Alice.waitFor((Message) => Message.startsWith("CONNECTED"), "connected frame");

    Alice.ws.send("SUBSCRIBE\nid:friends\ndestination:/topic/friends\n\n\0");
    await Alice.waitFor((Message) => Message.startsWith("MESSAGE") && Message.includes("presence.updated"), "subscription message");
    await Alice.waitFor((Message) => Message.startsWith("MESSAGE") && Message.includes(`"userId":"${TestFriendId}"`) && Message.includes('"online":true'), "friend online snapshot");

    UnregisterSocialSession(FriendSession);
    await Alice.waitFor((Message) => Message.startsWith("MESSAGE") && Message.includes(`"userId":"${TestFriendId}"`) && Message.includes('"online":false'), "friend offline broadcast");

    await UpdatePlayerActivity(TestFriendId, "Ramsgate_City");
    const ActiveFriendSession = RegisterSocialSession(TestFriendId, "xmpp");
    await Alice.waitFor((Message) => Message.startsWith("MESSAGE") && Message.includes(`"userId":"${TestFriendId}"`) && Message.includes('"online":true') && Message.includes("In Ramsgate"), "friend activity presence broadcast");

    Alice.ws.send("\n");
    assert.strictEqual(Alice.ws.readyState, WebSocket.OPEN);
    await Alice.waitFor((Message) => Message === "\n", "server heartbeat");

    const Bad = await connect(`${BaseUrl}/stomp`);
    Bad.ws.send("CONNECT\naccept-version:1.2\n\n\0");
    await Bad.waitFor((Message) => Message.startsWith("ERROR"), "bad auth error");

    const RootPath = await connect(`${BaseUrl}//`);
    RootPath.ws.send("CONNECT\naccept-version:1.2\n\n\0");
    await RootPath.waitFor((Message) => Message.startsWith("ERROR"), "normalized root auth error");

    const Notifications = await connect(`${BaseUrl}/notifications/v1/${TestUserId}`, {
        Authorization: `Bearer ${Token}`
    });
    Notifications.ws.send("STOMP\naccept-version:1.2\n\n\0");
    await Notifications.waitFor((Message) => Message.startsWith("CONNECTED"), "notifications connected frame");

    const MpcPath = await connect(`${BaseUrl}/ws/MCP%3A${TestFriendId}`);
    MpcPath.ws.send("CONNECT\r\naccept-version:1.2\r\n\r\n\0");
    await MpcPath.waitFor((Message) => Message.startsWith("CONNECTED"), "mcp path fallback connected frame");

    const LoginHeader = await connect(`${BaseUrl}/stomp`);
    LoginHeader.ws.send(`CONNECT\naccept-version:1.2\nlogin:MCP:${TestFriendId}\n\n\0`);
    await LoginHeader.waitFor((Message) => Message.startsWith("CONNECTED"), "mcp login fallback connected frame");
    LoginHeader.ws.send("SUBSCRIBE\nid:receipt-test\ndestination:/topic/friends\nreceipt:sub-1\n\n\0");
    await LoginHeader.waitFor((Message) => Message.startsWith("RECEIPT") && Message.includes("receipt-id:sub-1"), "subscription receipt");

    Alice.ws.close();
    Bad.ws.close();
    RootPath.ws.close();
    Notifications.ws.close();
    MpcPath.ws.close();
    LoginHeader.ws.close();
    UnregisterSocialSession(ActiveFriendSession);
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

function connect(url: string, headers: Record<string, string> = {}) {
    return new Promise<TestClient>((resolve, reject) => {
        const Ws = new WebSocket(url, { headers });
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
