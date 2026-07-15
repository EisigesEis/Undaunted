import assert from "node:assert";
import crypto from "node:crypto";
import http from "node:http";

type LoadoutSetResponse = {
    code: null;
    message: "OK";
    payload: LoadoutPayload;
};

type LoadoutPayload = {
    loadouts: any[];
    persistent: any;
    active_index: number;
    ActiveLoadoutSlotIndex: number;
    NumLoadoutSlots: number;
    MaxNumLoadoutSlots: number;
};

type SlotCountResponse = {
    GrantedLoadoutSlots: number;
    NumLoadoutSlots: number;
    MaxNumLoadoutSlots: number;
    ActiveLoadoutSlotIndex: number;
};

async function main(){
    const KeyPair = crypto.generateKeyPairSync("rsa", {modulusLength: 2048});

    process.env.DB_FILENAME = ":memory:";
    process.env.PROTOCOL_FILE_LOG = "false";
    process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(KeyPair.privateKey.export({type: "pkcs1", format: "pem"}).toString()).toString("base64");
    process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(KeyPair.publicKey.export({type: "pkcs1", format: "pem"}).toString()).toString("base64");

    const { app } = await import("../app");
    const { SignMetagameJWTForUid } = await import("../controllers/auth");

    const Server = http.createServer(app);
    await new Promise<void>((resolve) => Server.listen(0, "127.0.0.1", resolve));

    const Address = Server.address();
    assert(Address != undefined && typeof Address !== "string");
    const BaseUrl = `http://127.0.0.1:${Address.port}`;
    const Token = SignMetagameJWTForUid("loadout-test-user");

    try{
        const Initial = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.strictEqual(Initial.payload.loadouts.length, 1);
        assert.strictEqual(Initial.payload.active_index, 0);
        assert.strictEqual(Initial.payload.MaxNumLoadoutSlots, 6);

        const SlotCountBeforeUnlock = await getJson<SlotCountResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/slotcount`, Token);
        assert.strictEqual(SlotCountBeforeUnlock.NumLoadoutSlots, 1);
        assert.strictEqual(SlotCountBeforeUnlock.MaxNumLoadoutSlots, 6);
        assert.strictEqual(SlotCountBeforeUnlock.ActiveLoadoutSlotIndex, 0);

        const PrimarySlot = BuildSlot(0, "WP_TEST_PRIMARY", 5);
        const SavePrimary = await postJson<any>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/0`, Token, {data: PrimarySlot});
        assert.strictEqual(SavePrimary.payload.loadouts.length, 1);
        assert.strictEqual(SavePrimary.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");

        const RepeatedPrimary = await postJson<any>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/0`, Token, {data: PrimarySlot});
        assert.strictEqual(RepeatedPrimary.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/1`, Token, {data: BuildSlot(1, "WP_LOCKED", 0)}, 400);
        let AfterLockedWrite = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.strictEqual(AfterLockedWrite.payload.loadouts.length, 1);
        assert.strictEqual(AfterLockedWrite.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/unlock/7`, Token, {}, 400);
        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/unlock/0`, Token, {}, 400);
        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/unlock/3abc`, Token, {}, 400);

        const Unlock = await postJson<SlotCountResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/unlock/6`, Token, {});
        assert.strictEqual(Unlock.NumLoadoutSlots, 6);
        assert.strictEqual(Unlock.GrantedLoadoutSlots, 6);
        assert.strictEqual(Unlock.MaxNumLoadoutSlots, 6);

        const AfterUnlock = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.strictEqual(AfterUnlock.payload.loadouts.length, 6);
        assert.strictEqual(AfterUnlock.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");
        assert.strictEqual(AfterUnlock.payload.loadouts[1].weapon.item_id, "WP_EB_TRAINING");
        assert.strictEqual(AfterUnlock.payload.loadouts[5].weapon.item_id, "WP_EB_TRAINING");

        const UnlockAgain = await postJson<SlotCountResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/unlock/6`, Token, {});
        assert.strictEqual(UnlockAgain.NumLoadoutSlots, 6);
        const AfterRepeatedUnlock = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.deepStrictEqual(AfterRepeatedUnlock.payload.loadouts, AfterUnlock.payload.loadouts);

        const SlotOne = BuildSlot(1, "WP_TEST_SECONDARY", 1);
        const SaveSlotOne = await postJson<any>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/1`, Token, {data: SlotOne});
        assert.strictEqual(SaveSlotOne.payload.loadouts[1].weapon.item_id, "WP_TEST_SECONDARY");
        assert.strictEqual(SaveSlotOne.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");
        assert.strictEqual(SaveSlotOne.payload.loadouts[5].weapon.item_id, "WP_EB_TRAINING");
        assert.strictEqual(SaveSlotOne.payload.active_index, 1);

        const SlotFive = BuildSlot(5, "WP_TEST_SLOT_FIVE", 2);
        const SaveSlotFive = await postJson<any>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/5`, Token, {data: SlotFive});
        assert.strictEqual(SaveSlotFive.payload.loadouts[5].weapon.item_id, "WP_TEST_SLOT_FIVE");
        assert.strictEqual(SaveSlotFive.payload.loadouts[1].weapon.item_id, "WP_TEST_SECONDARY");
        assert.strictEqual(SaveSlotFive.payload.active_index, 5);

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/6`, Token, {data: BuildSlot(6, "WP_TOO_FAR", 0)}, 400);

        const Persistent = {
            manual_emotes: ["EMOTE_TEST"],
            update_version: 7
        };
        const SavePersistent = await postJson<any>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/persistent`, Token, {data: Persistent});
        assert.deepStrictEqual(SavePersistent.payload.persistent, Persistent);
        assert.strictEqual(SavePersistent.payload.loadouts[1].weapon.item_id, "WP_TEST_SECONDARY");
        assert.strictEqual(SavePersistent.payload.loadouts[5].weapon.item_id, "WP_TEST_SLOT_FIVE");

        const Active = await postJson<any>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/active/5`, Token, {});
        assert.strictEqual(Active.payload.active_index, 5);
        assert.strictEqual(Active.payload.loadouts[1].weapon.item_id, "WP_TEST_SECONDARY");

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/0`, Token, {data: BuildSlot(0, "WP_STALE", 4)}, 409);
        const AfterStale = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.strictEqual(AfterStale.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");
        assert.strictEqual(AfterStale.payload.loadouts[0].update_version, 5);

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/0`, Token, {data: "{"}, 400);
        const AfterInvalidJson = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.strictEqual(AfterInvalidJson.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/active/6`, Token, {}, 400);

        console.log("Loadout selftest passed");
    }
    finally{
        await new Promise<void>((resolve, reject) => Server.close((error) => error ? reject(error) : resolve()));
    }
}

function BuildSlot(SlotIndex: number, WeaponId: string, UpdateVersion: number){
    return {
        weapon: {
            item_id: WeaponId,
            instance_id: WeaponId,
            instance_data: "{}"
        },
        helmet: {
            item_id: "AR_TEST_HELM",
            instance_id: "AR_TEST_HELM",
            instance_data: "{}"
        },
        chest: {
            item_id: "AR_TEST_CHEST",
            instance_id: "AR_TEST_CHEST",
            instance_data: "{}"
        },
        arms: {
            item_id: "AR_TEST_ARMS",
            instance_id: "AR_TEST_ARMS",
            instance_data: "{}"
        },
        legs: {
            item_id: "AR_TEST_LEGS",
            instance_id: "AR_TEST_LEGS",
            instance_data: "{}"
        },
        lantern: {
            item_id: "LT_TEST",
            instance_id: "LT_TEST",
            instance_data: "{}"
        },
        player_role: {
            item_id: "PR_TEST",
            instance_id: "PR_TEST",
            instance_data: "{}"
        },
        subweapon: null,
        appearance: "{}",
        flask: "FL_HEALING_DEFAULT",
        quick_items: [],
        slot_index: SlotIndex,
        update_version: UpdateVersion,
        custom_name: `slot-${SlotIndex}`
    };
}

async function getJson<T>(Url: string, Token: string): Promise<T>{
    const Response = await fetch(Url, {
        headers: {
            authorization: `bearer ${Token}`
        }
    });

    if(Response.status !== 200){
        assert.fail(`${Url} returned ${Response.status}: ${await Response.text()}`);
    }

    return await Response.json() as T;
}

async function postJson<T>(Url: string, Token: string, Body: unknown): Promise<T>{
    const Response = await fetch(Url, {
        method: "POST",
        headers: {
            authorization: `bearer ${Token}`,
            "content-type": "application/json"
        },
        body: JSON.stringify(Body)
    });

    if(Response.status !== 200){
        assert.fail(`${Url} returned ${Response.status}: ${await Response.text()}`);
    }

    return await Response.json() as T;
}

async function expectStatus(Url: string, Token: string, Body: unknown, Status: number){
    const Response = await fetch(Url, {
        method: "POST",
        headers: {
            authorization: `bearer ${Token}`,
            "content-type": "application/json"
        },
        body: JSON.stringify(Body)
    });

    assert.strictEqual(Response.status, Status, `${Url} returned ${Response.status}, expected ${Status}`);
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
