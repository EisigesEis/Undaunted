import "./testEnvironment";
import assert from "node:assert";
import http from "node:http";
import { app } from "../app";
import { SignMetagameJWTForUid } from "../controllers/auth";
import { GetDb } from "../db";
import { characters, inventory, users } from "../db/schema";
import { GetInventoryForUserIdAndCharacterId, RunInventoryTransaction, UpdateInstancedItem } from "../controllers/inventory";

export async function runSelftest(){
    const Db = GetDb();
    await Db.insert(users).values([
        {userId: "inventory-user", name: "Inventory Test", notes: 0, isAdmin: false},
        {userId: "inventory-other-user", name: "Other Inventory Test", notes: 0, isAdmin: false}
    ]);
    await Db.insert(characters).values([
        {characterId: "inventory-character", userId: "inventory-user", createdDate: "now", lastModifiedDate: "now", name: "test", updateVersion: 0, data: "{}"},
        {characterId: "inventory-lazy-read", userId: "inventory-user", createdDate: "now", lastModifiedDate: "now", name: "lazy read", updateVersion: 0, data: "{}"},
        {characterId: "inventory-competing-reads", userId: "inventory-user", createdDate: "now", lastModifiedDate: "now", name: "competing reads", updateVersion: 0, data: "{}"},
        {characterId: "inventory-lazy-transaction", userId: "inventory-user", createdDate: "now", lastModifiedDate: "now", name: "lazy transaction", updateVersion: 0, data: "{}"},
        {characterId: "inventory-competing-writes", userId: "inventory-user", createdDate: "now", lastModifiedDate: "now", name: "competing writes", updateVersion: 0, data: "{}"}
    ]);
    await Db.insert(inventory).values({
        characterId: "inventory-character",
        instancedItems: JSON.stringify([
            {catalogId: "QI_BASIC_FLARE_DURABLE", instanceId: "protected", itemData: null, updateVersion: 0},
            {catalogId: "PART_TEST", instanceId: "removable", itemData: null, updateVersion: 0},
        ]),
        stackedItems: JSON.stringify([
            {catalogId: "QI_DAMAGE_ENRAGEBONUS_POTION", quantity: 2},
            {catalogId: "CELL_TEST", quantity: 2},
        ])
    });

    const Result = await RunInventoryTransaction("inventory-user", "inventory-character", "removal-test", [], [], [
        {catalogId: "QI_BASIC_FLARE_DURABLE", instanceId: "protected"},
        {catalogId: "PART_TEST", instanceId: "removable"},
    ], [
        {catalogId: "QI_DAMAGE_ENRAGEBONUS_POTION", quantity: 2},
        {catalogId: "CELL_TEST", quantity: 2},
    ], []);
    assert.deepStrictEqual(Result.success && Result.data?.removedInstancedItems.map((Item) => Item.instanceId), ["removable"]);
    assert.deepStrictEqual(Result.success && Result.data?.removedInstancedItems[0], {
        catalogId: "PART_TEST", instanceId: "removable", updateVersion: 0
    });
    assert.deepStrictEqual(Result.success && Result.data?.updatedStackedItems, [
        {catalogId: "QI_DAMAGE_ENRAGEBONUS_POTION", quantity: 2},
        {catalogId: "QI_DAMAGE_ENRAGEBONUS_POTION", quantity: 1},
        {catalogId: "CELL_TEST", quantity: 0}
    ]);

    const Row = await Db.query.inventory.findFirst();
    assert.deepStrictEqual(JSON.parse(Row!.instancedItems).map((Item: any) => Item.instanceId), ["protected"]);
    assert.deepStrictEqual(JSON.parse(Row!.stackedItems), [{catalogId: "QI_DAMAGE_ENRAGEBONUS_POTION", quantity: 2}]);

    const Created = await RunInventoryTransaction("inventory-user", "inventory-character", "create-test", [{
        accountId: "spoofed-user",
        catalogId: "WP_TEST",
        instanceId: "weapon-instance",
        itemData: "{\"CurrentLevel\":1}",
        updateVersion: 1
    }], [], [], [], []);
    assert.strictEqual(Created.success, true);
    assert.deepStrictEqual(Created.success && Created.data?.createdInstancedItems[0], {
        catalogId: "WP_TEST",
        instanceId: "weapon-instance",
        itemData: "{\"CurrentLevel\":1}",
        updateVersion: 1
    });

    const Updated = await RunInventoryTransaction("inventory-user", "inventory-character", "upgrade-test", [], [], [], [], [{
        accountId: "spoofed-user",
        catalogId: "WP_TEST",
        instanceId: "weapon-instance",
        itemData: "{\"CurrentLevel\":2}",
        updateVersion: 2
    }]);
    assert.strictEqual(Updated.success, true);
    assert.deepStrictEqual(Updated.success && Updated.data?.updatedInstancedItems[0], {
        catalogId: "WP_TEST",
        instanceId: "weapon-instance",
        itemData: "{\"CurrentLevel\":2}",
        updateVersion: 2
    });

    const RepeatedUpdate = await RunInventoryTransaction("inventory-user", "inventory-character", "repeated-upgrade-test", [], [], [], [], [{
        accountId: "spoofed-user",
        catalogId: "WP_TEST",
        instanceId: "weapon-instance",
        itemData: "{\"CurrentLevel\":2}",
        updateVersion: 2
    }]);
    assert.strictEqual(RepeatedUpdate.success, true);
    assert.deepStrictEqual(RepeatedUpdate.success && RepeatedUpdate.data?.updatedInstancedItems, []);

    const DirectUpdate = await UpdateInstancedItem("inventory-character", "inventory-user", "weapon-instance", "WP_TEST", "{\"CurrentLevel\":3}", 3);
    assert.strictEqual(DirectUpdate.success, true);
    assert.strictEqual(DirectUpdate.success && DirectUpdate.data.accountId, "inventory-user");
    assert.strictEqual(DirectUpdate.success && DirectUpdate.data.updateVersion, 3);

    const StaleUpdate = await RunInventoryTransaction("inventory-user", "inventory-character", "stale-upgrade-test", [], [], [], [], [{
        catalogId: "WP_TEST",
        instanceId: "weapon-instance",
        itemData: "{\"CurrentLevel\":2}",
        updateVersion: 2
    }]);
    assert.deepStrictEqual(StaleUpdate, {success: false, error: "conflict"});

    const StatelessRetry = await RunInventoryTransaction("inventory-user", "inventory-character", "stateless-retry-test", [], [], [], [], [{
        accountId: "spoofed-user",
        catalogId: "QI_BASIC_FLARE_DURABLE",
        instanceId: "protected",
        updateVersion: 0
    }]);
    assert.strictEqual(StatelessRetry.success, true);
    assert.deepStrictEqual(StatelessRetry.success && StatelessRetry.data?.updatedInstancedItems, []);

    const InventoryResult = await GetInventoryForUserIdAndCharacterId("inventory-user", "inventory-character");
    assert.strictEqual(InventoryResult.success, true);
    const StoredWeapon = InventoryResult.success && InventoryResult.data?.instancedItems.find((Item) => Item.instanceId === "weapon-instance");
    assert.deepStrictEqual(StoredWeapon, {
        accountId: "inventory-user",
        catalogId: "WP_TEST",
        instanceId: "weapon-instance",
        itemData: "{\"CurrentLevel\":3}",
        updateVersion: 3
    });

    const InventoryBeforeForbiddenOperations = await Db.query.inventory.findFirst({
        where: (Inventories, {eq}) => eq(Inventories.characterId, "inventory-character")
    });
    assert(InventoryBeforeForbiddenOperations != undefined);

    assert.deepStrictEqual(
        await GetInventoryForUserIdAndCharacterId("inventory-other-user", "inventory-character"),
        {success: false, error: "forbidden"}
    );
    assert.deepStrictEqual(
        await RunInventoryTransaction("inventory-other-user", "inventory-character", "forbidden-transaction", [{
            catalogId: "WP_FORBIDDEN",
            instanceId: "forbidden-instance",
            itemData: "{}",
            updateVersion: 1
        }], [], [], [], []),
        {success: false, error: "forbidden"}
    );
    assert.deepStrictEqual(
        await RunInventoryTransaction("inventory-other-user", "inventory-character", "forbidden-empty-transaction", [], [], [], [], []),
        {success: false, error: "forbidden"}
    );
    assert.deepStrictEqual(
        await UpdateInstancedItem("inventory-character", "inventory-other-user", "weapon-instance", "WP_TEST", "{\"CurrentLevel\":99}", 99),
        {success: false, error: "forbidden"}
    );

    const InventoryAfterForbiddenOperations = await Db.query.inventory.findFirst({
        where: (Inventories, {eq}) => eq(Inventories.characterId, "inventory-character")
    });
    assert.deepStrictEqual(InventoryAfterForbiddenOperations, InventoryBeforeForbiddenOperations);

    const LazyRead = await GetInventoryForUserIdAndCharacterId("inventory-user", "inventory-lazy-read");
    assert.deepStrictEqual(LazyRead, {
        success: true,
        data: {characterId: "inventory-lazy-read", instancedItems: [], stackedItems: []}
    });
    assert.deepStrictEqual(await Db.query.inventory.findFirst({
        where: (Inventories, {eq}) => eq(Inventories.characterId, "inventory-lazy-read")
    }), {
        characterId: "inventory-lazy-read",
        instancedItems: "[]",
        stackedItems: "[]"
    });

    const CompetingReads = await Promise.all([
        GetInventoryForUserIdAndCharacterId("inventory-user", "inventory-competing-reads"),
        GetInventoryForUserIdAndCharacterId("inventory-user", "inventory-competing-reads")
    ]);
    assert.deepStrictEqual(CompetingReads, [
        {success: true, data: {characterId: "inventory-competing-reads", instancedItems: [], stackedItems: []}},
        {success: true, data: {characterId: "inventory-competing-reads", instancedItems: [], stackedItems: []}}
    ]);
    assert.strictEqual((await Db.query.inventory.findMany({
        where: (Inventories, {eq}) => eq(Inventories.characterId, "inventory-competing-reads")
    })).length, 1);

    const LazyTransaction = await RunInventoryTransaction("inventory-user", "inventory-lazy-transaction", "lazy-transaction", [{
        catalogId: "WP_LAZY",
        instanceId: "lazy-instance",
        itemData: "{}",
        updateVersion: 1
    }], [{catalogId: "CURRENCY_LAZY", quantity: 2}], [], [], []);
    assert.strictEqual(LazyTransaction.success, true);
    const LazyTransactionInventory = await GetInventoryForUserIdAndCharacterId("inventory-user", "inventory-lazy-transaction");
    assert.strictEqual(LazyTransactionInventory.success, true);
    assert.deepStrictEqual(LazyTransactionInventory.success && LazyTransactionInventory.data?.instancedItems, [{
        accountId: "inventory-user",
        catalogId: "WP_LAZY",
        instanceId: "lazy-instance",
        itemData: "{}",
        updateVersion: 1
    }]);
    assert.deepStrictEqual(LazyTransactionInventory.success && LazyTransactionInventory.data?.stackedItems, [
        {catalogId: "CURRENCY_LAZY", quantity: 2}
    ]);

    const CompetingWrites = await Promise.all([
        RunInventoryTransaction("inventory-user", "inventory-competing-writes", "competing-write-a", [{
            catalogId: "WP_COMPETING_A",
            instanceId: "competing-a",
            itemData: "{}",
            updateVersion: 1
        }], [], [], [], []),
        RunInventoryTransaction("inventory-user", "inventory-competing-writes", "competing-write-b", [{
            catalogId: "WP_COMPETING_B",
            instanceId: "competing-b",
            itemData: "{}",
            updateVersion: 1
        }], [], [], [], [])
    ]);
    assert(CompetingWrites.every((Result) => Result.success));
    const CompetingInventory = await GetInventoryForUserIdAndCharacterId("inventory-user", "inventory-competing-writes");
    assert.strictEqual(CompetingInventory.success, true);
    assert.deepStrictEqual(
        CompetingInventory.success && CompetingInventory.data?.instancedItems.map((Item) => Item.instanceId).sort(),
        ["competing-a", "competing-b"]
    );

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const port = (server.address() as any).port;
        const response = await fetch(`http://127.0.0.1:${port}/inventory`, {
            method: "POST",
            headers: { Authorization: `Bearer ${SignMetagameJWTForUid("inventory-user")}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                accountId: "spoofed-user",
                characterId: "inventory-character",
                transactionId: "route-upgrade-test",
                addInstancedItems: [],
                addStackedItems: [],
                removeInstancedItems: [],
                removeStackedItems: [],
                saveInstancedItems: [{
                    accountId: "spoofed-user",
                    catalogId: "WP_TEST",
                    instanceId: "weapon-instance",
                    itemData: "{\"CurrentLevel\":4}",
                    updateVersion: 4
                }]
            })
        });
        const body = await response.json() as any;
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(body, {
            createdInstancedItems: [],
            updatedInstancedItems: [{
                catalogId: "WP_TEST",
                instanceId: "weapon-instance",
                updateVersion: 4,
                itemData: "{\"CurrentLevel\":4}"
            }],
            updatedStackedItems: [],
            removedInstancedItems: []
        });
        assert.strictEqual(Object.prototype.hasOwnProperty.call(body.updatedInstancedItems[0], "accountId"), false);

        const repeatedResponse = await fetch(`http://127.0.0.1:${port}/inventory`, {
            method: "POST",
            headers: { Authorization: `Bearer ${SignMetagameJWTForUid("inventory-user")}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                characterId: "inventory-character",
                transactionId: "route-repeated-upgrade-test",
                saveInstancedItems: [{
                    catalogId: "WP_TEST",
                    instanceId: "weapon-instance",
                    itemData: "{\"CurrentLevel\":4}",
                    updateVersion: 4
                }]
            })
        });
        assert.strictEqual(repeatedResponse.status, 200);
        assert.deepStrictEqual(await repeatedResponse.json(), {
            createdInstancedItems: [],
            updatedInstancedItems: [],
            updatedStackedItems: [],
            removedInstancedItems: []
        });

        const emptyResponse = await fetch(`http://127.0.0.1:${port}/inventory`, {
            method: "POST",
            headers: { Authorization: `Bearer ${SignMetagameJWTForUid("inventory-user")}`, "Content-Type": "application/json" },
            body: JSON.stringify({ characterId: "inventory-character", transactionId: "empty-route-test" })
        });
        assert.deepStrictEqual(await emptyResponse.json(), {
            createdInstancedItems: [],
            updatedInstancedItems: [],
            updatedStackedItems: [],
            removedInstancedItems: []
        });

        const directResponse = await fetch(`http://127.0.0.1:${port}/inventory/instanceditem`, {
            method: "POST",
            headers: { Authorization: `Bearer ${SignMetagameJWTForUid("inventory-user")}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                characterId: "inventory-character",
                catalogId: "WP_TEST",
                instanceId: "weapon-instance",
                itemData: "{\"CurrentLevel\":5}",
                updateVersion: 5
            })
        });
        assert.strictEqual(directResponse.status, 200);
        assert.strictEqual(await directResponse.text(), "");
    }
    finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

if (require.main === module) void runSelftest().catch((error) => { console.error(error); process.exitCode = 1; });
