import "./testEnvironment";
import assert from "assert";
import http from "http";
import { app } from "../app";
import { SignMetagameJWTForUid } from "../controllers/auth";
import { GetDb } from "../db";
import { users } from "../db/schema";

type EpicFriendsResponse = {
    friends: Array<{
        accountId: string;
        displayName: string;
        created: string;
        favorite: boolean;
    }>;
    blockList: unknown[];
};

export async function runSelftest() {
    process.env.PROTOCOL_FILE_LOG = "false";
    await GetDb().insert(users).values([
        { userId: "UB", name: "UB", notes: 0, isAdmin: false },
        { userId: "UE", name: "UE", notes: 0, isAdmin: false }
    ]).onConflictDoNothing();

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
        assert(UbEpicFriends.friends.some((Friend) => Friend.accountId === "UE"));
        const UeFriend = UbEpicFriends.friends.find((Friend) => Friend.accountId === "UE")!;
        assert.strictEqual(UeFriend.favorite, false);
        assert.strictEqual(UbEpicFriends.blockList.length, 0);
        assert.deepStrictEqual(Object.keys(UbEpicFriends).sort(), ["blockList", "friends"]);
        assert(UeFriend.displayName.length > 0);
        assert.deepStrictEqual(Object.keys(UeFriend).sort(), ["accountId", "created", "displayName", "favorite"]);

        const UeEpicFriends = await getJson<EpicFriendsResponse>(`${BaseUrl}/epic/friends/v1/UE`, UeToken);
        assert(UeEpicFriends.friends.some((Friend) => Friend.accountId === "UB"));

        const SdkAccounts = await getJson<Array<Record<string, any>>>(`${BaseUrl}/epic/id/v2/sdk/accounts?accountId=UB&accountId=UE`, UbToken);
        assert.strictEqual(SdkAccounts.length, 2);
        for(const Account of SdkAccounts){
            assert.deepStrictEqual(Object.keys(Account).sort(), ["accountId", "country", "displayName", "id", "linkedAccounts", "name", "preferredLanguage", "username"]);
            assert(Account.displayName.length > 0);
            assert(Array.isArray(Account.linkedAccounts));
            for(const LinkedAccount of Account.linkedAccounts){
                assert.deepStrictEqual(Object.keys(LinkedAccount).sort(), ["accountId", "displayName", "identityProviderId"]);
            }
        }

        const SingleBulkAccount = await getJson<Array<Record<string, any>>>(`${BaseUrl}/account/api/public/account?accountId=UE`, UbToken);
        assert(Array.isArray(SingleBulkAccount), "bulk account lookup must remain an array for one account");
        assert.strictEqual(SingleBulkAccount.length, 1);
        assert.strictEqual(SingleBulkAccount[0].accountId, "UE");
        assert.strictEqual(SingleBulkAccount[0].displayName, UeFriend.displayName);
        assert.deepStrictEqual(SingleBulkAccount[0].linkedAccounts, [{
            identityProviderId: "epic",
            accountId: "UE",
            displayName: UeFriend.displayName
        }]);

        const MissingBulkAccount = await getJson<Array<Record<string, any>>>(`${BaseUrl}/account/api/public/account?accountId=missing-whisper-user`, UbToken);
        assert.deepStrictEqual(MissingBulkAccount, []);

        const PathAccount = await getJson<Record<string, any>>(`${BaseUrl}/account/api/public/account/UE`, UbToken);
        assert(!Array.isArray(PathAccount));
        assert.strictEqual(PathAccount.accountId, "UE");
        assert.strictEqual(PathAccount.displayName, UeFriend.displayName);

        const DisplayNameAccount = await getJson<Record<string, any>>(`${BaseUrl}/account/api/public/account/displayName/${encodeURIComponent(UeFriend.displayName.toLocaleLowerCase())}`, UbToken);
        assert.strictEqual(DisplayNameAccount.accountId, "UE");
        assert.strictEqual(DisplayNameAccount.displayName, UeFriend.displayName);
        await expectStatus(`${BaseUrl}/account/api/public/account/missing-whisper-user`, UbToken, 404);
        await expectStatus(`${BaseUrl}/account/api/public/account/displayName/missing-whisper-user`, UbToken, 404);

        const MismatchedEpicFriends = await getJson<EpicFriendsResponse>(`${BaseUrl}/epic/friends/v1/eos-route-account`, UbToken);
        assert(MismatchedEpicFriends.friends.some((Friend) => Friend.accountId === "UE"));

        const BlockList = await getJson<unknown[]>(`${BaseUrl}/epic/friends/v1/eos-route-account/blocklist`, UbToken);
        assert.deepStrictEqual(BlockList, []);

        const SelfAccountInfo = await getJson<Record<string, any>>(`${BaseUrl}/accountinfo`, UbToken);
        assert(readLegacyArchonFriendIds(SelfAccountInfo.data).includes("UE"));

        const PublicAccountInfo = await postJson<Record<string, any>>(`${BaseUrl}/accountinfo/public`, UbToken, {
            accountId: "UB"
        });
        assert.strictEqual(PublicAccountInfo.accountId, "UB");
        assert(readLegacyArchonFriendIds(PublicAccountInfo.data).includes("UE"));
        assert(PublicAccountInfo.Friends.Friends.some((Friend: any) => Friend.UniqueId === "UE"));

        const LegacyFriends = await getJson<Array<Record<string, any>>>(`${BaseUrl}/friends/api/v1/UB/friends`, UbToken);
        const UeLegacyFriend = LegacyFriends.find((Friend) => Friend.accountId === "UE")!;
        assert(UeLegacyFriend);
        assert.strictEqual(UeLegacyFriend.IsOnline, false);
        assert.strictEqual(UeLegacyFriend.State, 1);
        assert.strictEqual(UeLegacyFriend.StatusStr, "Offline");
        assert.strictEqual(UeLegacyFriend.AppId, "Jackal");
        assert.strictEqual(UeLegacyFriend.PlatformString, "WIN");

        const MismatchedLegacyFriends = await getJson<Array<Record<string, any>>>(`${BaseUrl}/friends/api/v1/XQBF5VHGFJHR5AUILEPYI55MUQ/friends`, UbToken);
        assert(MismatchedLegacyFriends.some((Friend) => Friend.accountId === "UE"));
        assert(MismatchedLegacyFriends.every((Friend) => Friend.IsOnline === false));

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
        const UeFriendWithPresence = LegacyFriendsWithPresence.find((Friend) => Friend.accountId === "UE")!;
        assert.strictEqual(UeFriendWithPresence.StatusStr, "Dauntless - In the city");
        assert.strictEqual(UeFriendWithPresence.presence, undefined);
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

async function expectStatus(url: string, token: string, status: number) {
    const Response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(Response.status, status, `${url} should return ${status}`);
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

if (require.main === module) void runSelftest().catch((error) => { console.error(error); process.exitCode = 1; });
