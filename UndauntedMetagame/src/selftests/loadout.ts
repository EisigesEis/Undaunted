import "./testEnvironment";
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
    num_account_slots: number;
    max_account_slots: number;
    num_character_slots: number;
    max_character_slots: number;
    needs_migration: boolean;
};

type GenericPhoenixResponse = {
    code: null;
    message: "OK";
};

type SlotCountPayload = {
    num_account_slots: number;
    max_account_slots: number;
    num_character_slots: number;
    max_character_slots: number;
};

type SlotCountResponse = GenericPhoenixResponse & {
    payload: SlotCountPayload;
};

export async function runSelftest(){
    const KeyPair = crypto.generateKeyPairSync("rsa", {modulusLength: 2048});

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
        const AccountSlots = await getJson<any>(`${BaseUrl}/loadout/loadout-test-user/slotcount`, Token);
        assert.deepStrictEqual(AccountSlots, {
            code: null,
            message: "OK",
            payload: {num_account_slots: 0, max_account_slots: 0, num_character_slots: 0, max_character_slots: 6}
        });
        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/unlock/0`, Token, {}, 400);
        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/unlock/7`, Token, {}, 400);
        const AccountUnlock = await postJson<any>(`${BaseUrl}/loadout/loadout-test-user/unlock/1`, Token, {});
        assert.deepStrictEqual(AccountUnlock, AccountSlots);

        const Initial = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.strictEqual(Initial.payload.loadouts.length, 1);
        assert.strictEqual(Initial.payload.active_index, 0);
        assert.strictEqual(Initial.payload.max_character_slots, 6);

        const SlotCountBeforeUnlock = await getJson<SlotCountResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/slotcount`, Token);
        assert.deepStrictEqual(Object.keys(SlotCountBeforeUnlock).sort(), ["code", "message", "payload"]);
        assert.deepStrictEqual(Object.keys(SlotCountBeforeUnlock.payload).sort(), ["max_account_slots", "max_character_slots", "num_account_slots", "num_character_slots"]);
        assert.deepStrictEqual(SlotCountBeforeUnlock.payload, {
            num_account_slots: 0,
            max_account_slots: 0,
            num_character_slots: 1,
            max_character_slots: 6
        });

        const PrimarySlot = BuildSlot(0, "WP_TEST_PRIMARY", 5);
        const SavePrimary = await postJson<GenericPhoenixResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/0`, Token, {data: PrimarySlot});
        assert.deepStrictEqual(SavePrimary, {code: null, message: "OK"});

        const RepeatedPrimary = await postJson<GenericPhoenixResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/0`, Token, {data: PrimarySlot});
        assert.deepStrictEqual(RepeatedPrimary, {code: null, message: "OK"});

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/1`, Token, {data: BuildSlot(1, "WP_LOCKED", 0)}, 400);
        let AfterLockedWrite = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.strictEqual(AfterLockedWrite.payload.loadouts.length, 1);
        assert.strictEqual(AfterLockedWrite.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/unlock/7`, Token, {}, 400);
        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/unlock/0`, Token, {}, 400);
        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/unlock/3abc`, Token, {}, 400);

        const Unlock = await postJson<SlotCountResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/unlock/6`, Token, {});
        assert.deepStrictEqual(Unlock, {
            code: null,
            message: "OK",
            payload: {num_account_slots: 0, max_account_slots: 0, num_character_slots: 6, max_character_slots: 6}
        });

        const AfterUnlock = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.strictEqual(AfterUnlock.payload.loadouts.length, 6);
        assert.strictEqual(AfterUnlock.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");
        assert.strictEqual(AfterUnlock.payload.loadouts[1].weapon.item_id, "WP_EB_TRAINING");
        assert.strictEqual(AfterUnlock.payload.loadouts[5].weapon.item_id, "WP_EB_TRAINING");

        const UnlockAgain = await postJson<SlotCountResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/unlock/6`, Token, {});
        assert.strictEqual(UnlockAgain.payload.num_character_slots, 6);
        const AfterRepeatedUnlock = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.deepStrictEqual(AfterRepeatedUnlock.payload.loadouts, AfterUnlock.payload.loadouts);

        const SlotOne = BuildSlot(1, "WP_TEST_SECONDARY", 1);
        const SaveSlotOne = await postJson<GenericPhoenixResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/1`, Token, {data: SlotOne});
        assert.deepStrictEqual(SaveSlotOne, {code: null, message: "OK"});

        const SlotFive = BuildSlot(5, "WP_TEST_SLOT_FIVE", 2);
        const SaveSlotFive = await postJson<GenericPhoenixResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/5`, Token, {data: SlotFive});
        assert.deepStrictEqual(SaveSlotFive, {code: null, message: "OK"});

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/6`, Token, {data: BuildSlot(6, "WP_TOO_FAR", 0)}, 400);

        const Persistent = {
            manual_emotes: ["EMOTE_TEST"],
            update_version: 7
        };
        const SavePersistent = await postJson<GenericPhoenixResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/persistent`, Token, {data: Persistent});
        assert.deepStrictEqual(SavePersistent, {code: null, message: "OK"});

        const Active = await postJson<GenericPhoenixResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/active/5`, Token, {});
        assert.deepStrictEqual(Active, {code: null, message: "OK"});
        const ActiveLoadout = await getJson<any>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character`, Token);
        assert.strictEqual(ActiveLoadout.weapon.item_id, "WP_TEST_SLOT_FIVE");

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/0`, Token, {data: BuildSlot(0, "WP_STALE", 4)}, 409);
        const AfterStale = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.strictEqual(AfterStale.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");
        assert.strictEqual(AfterStale.payload.loadouts[0].update_version, 5);

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/0`, Token, {data: "{"}, 400);
        const AfterInvalidJson = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.strictEqual(AfterInvalidJson.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");

        // Invalid primitive, null, array, and oversized objects must not replace
        // the known-good persistent or slot state.
        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/0`, Token, {data: null}, 400);
        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/0`, Token, {data: []}, 400);
        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/persistent`, Token, {data: "invalid"}, 400);
        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/persistent`, Token, {data: {blob: "x".repeat(1024 * 1024)}}, 400);
        const AfterRejectedPayloads = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.strictEqual(AfterRejectedPayloads.payload.loadouts[0].weapon.item_id, "WP_TEST_PRIMARY");
        assert.deepStrictEqual(AfterRejectedPayloads.payload.persistent, Persistent);

        // Unknown fields are deliberately retained pending a real loadout capture;
        // the sanitization guard rejects unsafe shapes without inventing an allowlist.
        const PersistentWithUnknownField = {...Persistent, unverified_client_field: {value: "preserved"}};
        const SavedUnknownField = await postJson<GenericPhoenixResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/persistent`, Token, {data: PersistentWithUnknownField});
        assert.deepStrictEqual(SavedUnknownField, {code: null, message: "OK"});
        const AfterUnknownField = await getJson<LoadoutSetResponse>(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/all`, Token);
        assert.deepStrictEqual(AfterUnknownField.payload.persistent, PersistentWithUnknownField);

        await expectStatus(`${BaseUrl}/loadout/loadout-test-user/loadout-test-character/active/6`, Token, {}, 400);

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

if (require.main === module) void runSelftest().catch((error) => { console.error(error); process.exitCode = 1; });
