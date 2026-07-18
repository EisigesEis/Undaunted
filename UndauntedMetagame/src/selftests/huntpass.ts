import "./testEnvironment";
import assert from "node:assert";
import http from "node:http";

export async function runSelftest(){
    const {GetDb} = await import("../db");
    const {characters, entitlements, inventory, users} = await import("../db/schema");
    const {ClaimHuntPass, GetActiveCooldowns, GetEntitlements, StartCooldown} = await import("../controllers/huntpass");
    const {ApplyTrackGrant} = await import("../controllers/mastery");
    const {SignMetagameJWTForUid} = await import("../controllers/auth");
    const {app} = await import("../app");
    const Db = GetDb();
    await Db.insert(users).values({userId: "hp-user", name: "Hunt Pass Test", notes: 0, isAdmin: false});
    await Db.insert(characters).values({characterId: "hp-character", userId: "hp-user", createdDate: "now", lastModifiedDate: "now", name: "test", updateVersion: 0, data: "{}"});
    await Db.insert(inventory).values({characterId: "hp-character", instancedItems: "[]", stackedItems: "[]"});

    const RankZero = ClaimHuntPass("hp-user", 0, "free");
    assert.equal(RankZero.success, true);
    assert.equal((RankZero as any).track.progressionId, "season09b");

    assert.equal((await ApplyTrackGrant("hp-user", "season09b", 10)).progress, 10);
    for(let Index = 0; Index < 10; ++Index) assert.equal((StartCooldown("hp-user", `daily-${Index}`) as any).applied, true);
    assert.equal((StartCooldown("hp-user", "daily-0") as any).applied, false);
    assert.equal(Object.keys(await GetActiveCooldowns("hp-user")).length, 10);
    assert.equal((await ApplyTrackGrant("hp-user", "season09b", 90)).progress, 100);
    assert.equal((await ApplyTrackGrant("hp-user", "season09b", 1)).progress, 101);

    assert.equal(ClaimHuntPass("hp-user", 1, "free").success, true);
    assert.equal((ClaimHuntPass("hp-user", 1, "free") as any).claimed, false);
    assert.deepEqual(ClaimHuntPass("hp-user", 2, "free"), {success: false, error: "rank_not_earned"});
    assert.deepEqual(ClaimHuntPass("hp-user", 1, "premium"), {success: false, error: "premium_required"});
    await Db.insert(entitlements).values({userId: "hp-user", entitlement: "season09b_premium", grantedDate: new Date().toISOString(), expiresAt: null});
    assert.equal((await GetEntitlements("hp-user"))[0].entitlement, "season09b_premium");
    assert.equal(ClaimHuntPass("hp-user", 1, "premium").success, true);
    const BeforePrestige = JSON.parse((await Db.query.inventory.findFirst())!.stackedItems)
        .find((Item: any) => Item.catalogId === "CURRENCY_PRESTIGE")?.quantity ?? 0;
    await ApplyTrackGrant("hp-user", "season09b", 5000);
    assert.equal(ClaimHuntPass("hp-user", 51, "premium").success, true);

    const Row = await Db.query.inventory.findFirst();
    const Stacked = JSON.parse(Row!.stackedItems);
    assert(Stacked.some((Item: any) => Item.catalogId === "TITLE_HP09B_COMMANDO_00"));
    assert(Stacked.some((Item: any) => Item.catalogId === "AR_HP09B_COMMANDO_HELM_00"));
    assert.equal(Stacked.find((Item: any) => Item.catalogId === "CURRENCY_PRESTIGE").quantity, BeforePrestige + 105);

    const Server = http.createServer(app);
    await new Promise<void>((Resolve) => Server.listen(0, "127.0.0.1", Resolve));
    try{
        const Address = Server.address();
        assert(Address != null && typeof Address !== "string");
        const Url = `http://127.0.0.1:${Address.port}/huntpass/hp-user`;
        const Authorization = `Bearer ${SignMetagameJWTForUid("hp-user")}`;
        const Selected = await fetch(Url, {headers: {Authorization}});
        assert.equal(Selected.status, 200);
        assert.equal((await Selected.json() as any).payload, "season09b");

        const Select = await fetch(Url, {
            method: "POST",
            headers: {Authorization, "Content-Type": "application/json"},
            body: JSON.stringify("season09b")
        });
        assert.equal(Select.status, 200);
        assert.equal((await Select.json() as any).payload, "season09b");
    }
    finally{
        await new Promise<void>((Resolve) => Server.close(() => Resolve()));
    }
    console.log("Hunt Pass selftest passed");
}

if (require.main === module) void runSelftest().catch((error) => { console.error(error); process.exitCode = 1; });
