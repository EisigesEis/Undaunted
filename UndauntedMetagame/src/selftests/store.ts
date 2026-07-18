import "./testEnvironment";
import assert from "node:assert";

export async function runSelftest(){
    const {GetDb} = await import("../db");
    const {characters, inventory, users} = await import("../db/schema");
    const {CreatePurchaseToken, GetBalancesForUser, GetLadyLuckCatalog, GetStoreCatalog, LadyLuckCatalog, PurchaseFromToken} = await import("../controllers/store");
    const Db = GetDb();
    await Db.insert(users).values({userId: "store-user", name: "Lady Luck Test", notes: 10, isAdmin: false});
    await Db.insert(characters).values({characterId: "store-character", userId: "store-user", createdDate: "now", lastModifiedDate: "now", name: "test", updateVersion: 0, data: "{}"});
    await Db.insert(inventory).values({
        characterId: "store-character",
        instancedItems: "[]",
        stackedItems: JSON.stringify([
            {catalogId: "CURRENCY_MARKS_STEEL", quantity: 10000},
            {catalogId: "CURRENCY_MARKS_GILDED", quantity: 10000},
        ]),
    });

    const ExpectedOrder = [
        "CELL_TRIALS_06_E", "CELL_TRIALS_01_E", "CELL_TRIALS_04_E", "CELL_TRIALS_02_E", "CELL_TRIALS_03_E", "CELL_TRIALS_05_E",
        "PART_EB_PASSIVE_TRIALS_01", "PART_EB_PASSIVE_TRIALS_02", "PART_GA_PASSIVE_TRIALS_01", "PART_GA_PASSIVE_TRIALS_02", "PART_CB_PASSIVE_TRIALS_01",
        "PART_CB_PASSIVE_TRIALS_02", "PART_DP_PASSIVE_TRIALS_01", "PART_DP_PASSIVE_TRIALS_02", "PART_MS_PASSIVE_TRIALS_01", "PART_MS_PASSIVE_TRIALS_02",
        "PART_GA_SPECIAL_SKILLSHOT_RESET", "PART_IH_SPECIAL_ISLANDCRACKER_DEFENSIVE", "PART_EB_SPECIAL_PARRY", "PART_CB_SPECIAL_INSATIABLE_DANCE",
        "PART_MS_SPECIAL_ROCKETLUNGE", "LT_TRIALS_00", "CONTAINER_CORE_SILVER_CELLCORE", "QI_DAMAGE_ENRAGEBONUS_POTION",
        "WP_GA_TRIALS_00", "WP_GA_TRIALS_01", "WP_CB_TRIALS_00", "WP_CB_TRIALS_01", "WP_IH_TRIALS_00", "WP_IH_TRIALS_01",
        "WP_DP_TRIALS_00", "WP_DP_TRIALS_01", "WP_MS_TRIALS_00", "WP_MS_TRIALS_01", "WP_EB_TRIALS_00", "WP_EB_TRIALS_01",
        "WP_AC_TRIALS_00", "WP_AC_TRIALS_01", "AR_TRIALS_ARMS_00", "AR_TRIALS_ARMS_01", "AR_TRIALS_LEGS_00", "AR_TRIALS_LEGS_01",
        "AR_TRIALS_HELM_00", "AR_TRIALS_HELM_01", "AR_TRIALS_CHEST_00", "AR_TRIALS_CHEST_01", "AC_HEAD_TRIALS_00", "AC_HEAD_TRIALS_01",
        "BNC_STANDARD_TRIALS_00", "BNC_STANDARD_TRIALS_01", "CONTAINER_CORE_GOLD_CELLCORE", "QI_DAMAGE_ENRAGEBONUS_POTION",
        "DYE_HP08B_PUNK_02_DURABLE", "DYE_HP11B_ENGINEER_00_DURABLE", "DYE_GRAY02_DURABLE", "DYE_GRAY01_DURABLE",
    ];
    const Catalog = await GetLadyLuckCatalog("store-user");
    assert.strictEqual(Catalog.length, 56);
    assert.deepStrictEqual(Catalog.map((Sku) => Sku.items[0].catalogId), ExpectedOrder);
    assert.deepStrictEqual(Catalog.map((Sku) => Sku.displayPriority), [...Catalog.keys()]);
    assert(Catalog.every((Sku) => JSON.stringify(Sku.tags) === JSON.stringify(["ladyluckstore"])));
    assert(Catalog.every((Sku) => Sku.prices.length === 1));
    assert(Catalog.every((Sku) => Sku.displayDescription.length > 0));
    assert.strictEqual(Catalog[3].images.standard, "/Game/UI/Textures/Trials/ui_trials_epic_cell_strategist.ui_trials_epic_cell_strategist");
    assert(Catalog.every((Sku) => Sku.prices[0].currencyId === "id_currency_marks_steel" ? Sku.steelMarksPrice === Sku.prices[0].price : Sku.gildedMarksPrice === Sku.prices[0].price));
    assert.strictEqual(Catalog[0].items[0].quantity, 1);
    assert.strictEqual(Catalog[0].maxAllowed, null);
    assert.strictEqual(Catalog[6].maxAllowed, 1);

    const CellToken = CreatePurchaseToken("store-user", "ladyluck_cell_trials_06_e", "markssteel");
    assert(CellToken);
    assert.deepStrictEqual(await PurchaseFromToken("store-user", CellToken, "markssteel"), {success: true});
    const RepeatCell = CreatePurchaseToken("store-user", "CELL_TRIALS_06_E", "markssteel");
    assert(RepeatCell);
    assert.deepStrictEqual(await PurchaseFromToken("store-user", RepeatCell, "markssteel"), {success: true});

    const ModToken = CreatePurchaseToken("store-user", "PART_EB_PASSIVE_TRIALS_01", "markssteel");
    assert(ModToken);
    assert.deepStrictEqual(await PurchaseFromToken("store-user", ModToken, "markssteel"), {success: true});
    assert.deepStrictEqual(await PurchaseFromToken("store-user", ModToken, "markssteel"), {success: false, error: "invalid_token"});
    const DuplicateModToken = CreatePurchaseToken("store-user", "PART_EB_PASSIVE_TRIALS_01", "markssteel");
    assert(DuplicateModToken);
    assert.deepStrictEqual(await PurchaseFromToken("store-user", DuplicateModToken, "markssteel"), {success: false, error: "already_owned"});
    assert.strictEqual((await GetLadyLuckCatalog("store-user"))[6].remaining, 0);

    const TonicToken = CreatePurchaseToken("store-user", "ladyluck_bundle_consumables_00", "markssteel");
    assert(TonicToken);
    assert.deepStrictEqual(await PurchaseFromToken("store-user", TonicToken, "markssteel"), {success: true});
    const GoldToken = CreatePurchaseToken("store-user", "ladyluck_weapon_axe_prestige", "marksgilded");
    assert(GoldToken);
    assert.deepStrictEqual(await PurchaseFromToken("store-user", GoldToken, "markssteel"), {success: false, error: "currency_mismatch"});
    assert.deepStrictEqual(await PurchaseFromToken("store-user", GoldToken, "marksgilded"), {success: true});

    const Row = await Db.query.inventory.findFirst();
    const Stacked = JSON.parse(Row!.stackedItems);
    const Instanced = JSON.parse(Row!.instancedItems);
    assert.strictEqual(Stacked.find((Item: any) => Item.catalogId === "CELL_TRIALS_06_E").quantity, 2);
    assert.strictEqual(Stacked.find((Item: any) => Item.catalogId === "QI_DAMAGE_ENRAGEBONUS_POTION").quantity, 25);
    assert(Instanced.some((Item: any) => Item.catalogId === "PART_EB_PASSIVE_TRIALS_01"));
    assert(Stacked.some((Item: any) => Item.catalogId === "WP_GA_TRIALS_01" && Item.quantity === 1));
    assert.deepStrictEqual(await GetBalancesForUser("store-user"), {
        CURRENCY_NOTES: 10, CURRENCY_MARKS_STEEL: 9300, CURRENCY_MARKS_GILDED: 9000,
    });

    assert.strictEqual(CreatePurchaseToken("store-user", "ladyluck_weapon_axe_normal", "markssteel"), undefined);
    assert.strictEqual(CreatePurchaseToken("store-user", "NOT_IMPLEMENTED", "markssteel"), undefined);
    assert.deepStrictEqual(await PurchaseFromToken("another-user", CellToken, "markssteel"), {success: false, error: "invalid_token"});
    assert.deepStrictEqual(await PurchaseFromToken("store-user", "not-a-token", "markssteel"), {success: false, error: "invalid_token"});

    const PremiumCatalog = await GetStoreCatalog("store-user", ["huntpass_store"]);
    assert.strictEqual(PremiumCatalog![0].id, "season09b_premium");
    assert.strictEqual(PremiumCatalog![0].prices[0].price, 0);
    const PremiumToken = CreatePurchaseToken("store-user", "season09b_premium", "platinum");
    assert(PremiumToken);
    assert.deepStrictEqual(await PurchaseFromToken("store-user", PremiumToken, "platinum"), {success: true});
    assert.strictEqual((await GetStoreCatalog("store-user", ["season09b_pass"]))![0].remaining, 0);

    const DailyCatalog = await GetStoreCatalog("store-user", ["fountain_daily_free_bundle"]);
    assert.deepStrictEqual(DailyCatalog![0].items, [{catalogId: "CONTAINER_CORE_REWARD_DAILY_01", quantity: 1}, {catalogId: "TOKEN_BOUNTY_DRAFT_PREMIUM", quantity: 4}]);
    const DailyToken = CreatePurchaseToken("store-user", "bundle_reward_login_daily_01", "platinum");
    assert(DailyToken);
    assert.deepStrictEqual(await PurchaseFromToken("store-user", DailyToken, "platinum"), {success: true});
    assert.strictEqual((await GetStoreCatalog("store-user", ["fountain_daily_free_bundle"]))![0].timeAvailabilityReason, "Cooldown");
    const AfterDaily = await Db.query.inventory.findFirst({where: (await import("drizzle-orm")).eq(inventory.characterId, "store-character")});
    const AfterDailyStacked = JSON.parse(AfterDaily!.stackedItems);
    assert.strictEqual(AfterDailyStacked.find((Item: any) => Item.catalogId === "CONTAINER_CORE_REWARD_DAILY_01").quantity, 1);
    assert.strictEqual(AfterDailyStacked.find((Item: any) => Item.catalogId === "TOKEN_BOUNTY_DRAFT_PREMIUM").quantity, 4);
    const DuplicateDaily = CreatePurchaseToken("store-user", "bundle_reward_login_daily_01", "platinum");
    assert(DuplicateDaily);
    assert.deepStrictEqual(await PurchaseFromToken("store-user", DuplicateDaily, "platinum"), {success: false, error: "already_owned"});

    const ExpiredPayload = {sub: "store-user", sku: LadyLuckCatalog[0].id, currency: "markssteel", exp: Date.now() - 1, nonce: "expired"};
    const ExpiredToken = Buffer.from(JSON.stringify(ExpiredPayload)).toString("base64url");
    assert.deepStrictEqual(await PurchaseFromToken("store-user", ExpiredToken, "markssteel"), {success: false, error: "invalid_token"});

    await Db.insert(users).values({userId: "poor-user", name: "Poor Test", notes: 0, isAdmin: false});
    await Db.insert(characters).values({characterId: "poor-character", userId: "poor-user", createdDate: "now", lastModifiedDate: "now", name: "test", updateVersion: 0, data: "{}"});
    await Db.insert(inventory).values({characterId: "poor-character", instancedItems: "[]", stackedItems: JSON.stringify([{catalogId: "CURRENCY_MARKS_STEEL", quantity: 149}])});
    const PoorToken = CreatePurchaseToken("poor-user", "CELL_TRIALS_06_E", "markssteel");
    assert(PoorToken);
    assert.deepStrictEqual(await PurchaseFromToken("poor-user", PoorToken, "markssteel"), {success: false, error: "insufficient_funds"});
    assert.strictEqual((await GetBalancesForUser("poor-user")).CURRENCY_MARKS_STEEL, 149);
}

if (require.main === module) void runSelftest().catch((error) => { console.error(error); process.exitCode = 1; });
