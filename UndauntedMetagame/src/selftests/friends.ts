import "dotenv/config";
import assert from "assert";
import http from "http";
import { app } from "../app";
import { SignMetagameJWTForUid } from "../controllers/auth";

type EpicFriendsResponse = {
    friends: Array<{
        accountId: string;
        created: string;
        favorite: boolean;
    }>;
    blockList: unknown[];
};

async function main() {
    process.env.PROTOCOL_FILE_LOG = "false";
    process.env.SOCIAL_FRIEND_USER_IDS = "UB,UE";

    const Server = http.createServer(app);
    await new Promise<void>((resolve) => Server.listen(0, "127.0.0.1", resolve));

    const Address = Server.address();
    assert(Address != undefined && typeof Address !== "string");
    const BaseUrl = `http://127.0.0.1:${Address.port}`;
    const UbToken = SignMetagameJWTForUid("UB");
    const UeToken = SignMetagameJWTForUid("UE");

    try {
        const Exchange = await getJson<{ code: string }>(`${BaseUrl}/epic/oauth/v2/exchange?exchange_code=UB&consumingClientId=cf27c69fe66441e8a8a4e8faf396ee4c`, UbToken);
        assert.strictEqual(Exchange.code, "UB");

        const EpicV2Token = await postForm<Record<string, any>>(`${BaseUrl}/epic/oauth/v2/token`, {
            grant_type: "exchange_code",
            exchange_code: Exchange.code
        });
        assert.strictEqual(EpicV2Token.account_id, "UB");
        assert.strictEqual(EpicV2Token.token_type, "bearer");
        assert(Array.isArray(EpicV2Token.scope));
        assert(EpicV2Token.scope.includes("friends_list"));

        const UbEpicFriends = await getJson<EpicFriendsResponse>(`${BaseUrl}/epic/friends/v1/UB`, UbToken);
        assert.deepStrictEqual(UbEpicFriends.friends.map((Friend) => Friend.accountId), ["UE"]);
        assert.strictEqual(UbEpicFriends.friends[0].favorite, false);
        assert.strictEqual(UbEpicFriends.blockList.length, 0);

        const UeEpicFriends = await getJson<EpicFriendsResponse>(`${BaseUrl}/epic/friends/v1/UE`, UeToken);
        assert.deepStrictEqual(UeEpicFriends.friends.map((Friend) => Friend.accountId), ["UB"]);

        const MismatchedEpicFriends = await getJson<EpicFriendsResponse>(`${BaseUrl}/epic/friends/v1/eos-route-account`, UbToken);
        assert.deepStrictEqual(MismatchedEpicFriends.friends.map((Friend) => Friend.accountId), ["UE"]);

        const BlockList = await getJson<unknown[]>(`${BaseUrl}/epic/friends/v1/eos-route-account/blocklist`, UbToken);
        assert.deepStrictEqual(BlockList, []);

        const SelfAccountInfo = await getJson<Record<string, any>>(`${BaseUrl}/accountinfo`, UbToken);
        assert.deepStrictEqual(readLegacyArchonFriendIds(SelfAccountInfo.data), ["UE"]);

        const PublicAccountInfo = await postJson<Record<string, any>>(`${BaseUrl}/accountinfo/public`, UbToken, {
            accountId: "UB"
        });
        assert.strictEqual(PublicAccountInfo.accountId, "UB");
        assert.deepStrictEqual(readLegacyArchonFriendIds(PublicAccountInfo.data), ["UE"]);
        assert.deepStrictEqual(PublicAccountInfo.Friends.Friends.map((Friend: any) => Friend.UniqueId), ["UE"]);

        const LegacyFriends = await getJson<Array<Record<string, any>>>(`${BaseUrl}/friends/api/v1/UB/friends`, UbToken);
        assert.strictEqual(LegacyFriends.length, 1);
        assert.strictEqual(LegacyFriends[0].accountId, "UE");
        assert.strictEqual(LegacyFriends[0].online, true);
        assert.strictEqual(LegacyFriends[0].IsOnline, true);
        assert.strictEqual(LegacyFriends[0].State, 0);
        assert.strictEqual(LegacyFriends[0].StatusStr, "Online");
        assert.strictEqual(LegacyFriends[0].AppId, "Jackal");
        assert.strictEqual(LegacyFriends[0].PlatformString, "WIN");

        const MismatchedLegacyFriends = await getJson<Array<Record<string, any>>>(`${BaseUrl}/friends/api/v1/XQBF5VHGFJHR5AUILEPYI55MUQ/friends`, UbToken);
        assert.deepStrictEqual(MismatchedLegacyFriends.map((Friend) => Friend.accountId), ["UE"]);
        assert(MismatchedLegacyFriends.every((Friend) => Friend.online === true));

        await patchJson(`${BaseUrl}/epic/presence/v1/53565ba467df4edbb6f5a3d939a8b4f2/UE/presence/test-conn`, UeToken, {
            status: "online",
            activity: {
                value: "Dauntless - In the city"
            },
            props: {
                ProductId: "prod-jackal",
                Platform: "WIN",
                RichPresence: "InTheCity"
            },
            conn: {
                props: {}
            }
        });

        const LegacyFriendsWithPresence = await getJson<Array<Record<string, any>>>(`${BaseUrl}/friends/api/v1/UB/friends`, UbToken);
        assert.strictEqual(LegacyFriendsWithPresence[0].richPresence, "Dauntless - In the city");
        assert.strictEqual(LegacyFriendsWithPresence[0].presence.source, undefined);
        assert.strictEqual(LegacyFriendsWithPresence[0].presence.richPresence, "Dauntless - In the city");
    } finally {
        await new Promise<void>((resolve) => Server.close(() => resolve()));
    }
}

function readLegacyArchonFriendIds(data: string) {
    const Data = JSON.parse(data);
    const FriendsSave = JSON.parse(Data.Friends);
    return FriendsSave.Friends.map((Friend: any) => Friend.UniqueId);
}

async function getJson<T>(url: string, token: string): Promise<T> {
    const Response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    if (Response.status !== 200) {
        assert.fail(`${url} should return 200 but returned ${Response.status}: ${await Response.text()}`);
    }

    return await Response.json() as T;
}

async function patchJson(url: string, token: string, body: Record<string, any>) {
    const Response = await fetch(url, {
        method: "PATCH",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (Response.status !== 200) {
        assert.fail(`${url} should return 200 but returned ${Response.status}: ${await Response.text()}`);
    }

    return await Response.json();
}

async function postJson<T>(url: string, token: string, body: Record<string, any>): Promise<T> {
    const Response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (Response.status !== 200) {
        assert.fail(`${url} should return 200 but returned ${Response.status}: ${await Response.text()}`);
    }

    return await Response.json() as T;
}

async function postForm<T>(url: string, body: Record<string, string>): Promise<T> {
    const Response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams(body).toString()
    });

    if (Response.status !== 200) {
        assert.fail(`${url} should return 200 but returned ${Response.status}: ${await Response.text()}`);
    }

    return await Response.json() as T;
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
