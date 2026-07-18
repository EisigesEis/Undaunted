import "./testEnvironment";
import assert from "node:assert";
import { GetDb } from "../db";
import { characters, inventory, users } from "../db/schema";
import { RunInventoryTransaction } from "../controllers/inventory";

export async function runSelftest(){
    const Db = GetDb();
    await Db.insert(users).values({userId: "inventory-user", name: "Inventory Test", notes: 0, isAdmin: false});
    await Db.insert(characters).values({characterId: "inventory-character", userId: "inventory-user", createdDate: "now", lastModifiedDate: "now", name: "test", updateVersion: 0, data: "{}"});
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

    const Row = await Db.query.inventory.findFirst();
    assert.deepStrictEqual(JSON.parse(Row!.instancedItems).map((Item: any) => Item.instanceId), ["protected"]);
    assert.deepStrictEqual(JSON.parse(Row!.stackedItems), [{catalogId: "QI_DAMAGE_ENRAGEBONUS_POTION", quantity: 2}]);
}

if (require.main === module) void runSelftest().catch((error) => { console.error(error); process.exitCode = 1; });
