import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { inventory } from "../db/schema";
import { logger } from "../logger";
import { DoesCharacterBelongToUserId } from "./character";

export type InventoryError = "forbidden" | "not_found" | "conflict" | "invalid_inventory_data" | "db_error";
export type InventoryResult<T = void> = { success: true, data?: T } | { success: false, error: InventoryError };

class InventoryConflictError extends Error {
    constructor(message: string){
        super(message);
        this.name = "InventoryConflictError";
    }
}

function MakeEmptyInventoryRow(CharacterId: string): typeof inventory.$inferInsert {
    return {
        characterId: CharacterId,
        instancedItems: "[]",
        stackedItems: "[]",
    };
}

function FindInstancedItemIndex(InstancedItems: any[], InstanceId: string){
    return InstancedItems.findIndex((Item) => Item.instanceId === InstanceId);
}

function AssertSuperiorInstancedItemVersion(CurrentItem: any, IncomingItem: any, Operation: string){
    if(typeof CurrentItem.updateVersion !== "number"){
        return;
    }

    if(typeof IncomingItem.updateVersion !== "number" || IncomingItem.updateVersion <= CurrentItem.updateVersion){
        throw new InventoryConflictError(`Refusing stale instanced item ${Operation} ${IncomingItem.catalogId}/${IncomingItem.instanceId}: current updateVersion ${CurrentItem.updateVersion}, incoming updateVersion ${IncomingItem.updateVersion}`);
    }
}

export async function UpdateInstancedItem(CharacterId: string, UserId: string, InstanceId: string, CatalogId: string, ItemData: string, UpdateVersion: number): Promise<InventoryResult<any>>{
    if(!await DoesCharacterBelongToUserId(UserId, CharacterId)){
        logger.error(`Specified characterId ${CharacterId} does not belong to user ${UserId}`);
        return {success: false, error: "forbidden"};
    }

    try{
        return GetDb().transaction((tx) => {
            let CurrentInventory = tx.query.inventory.findFirst({where: eq(inventory.characterId, CharacterId)}).sync();

            if(CurrentInventory == undefined){
                logger.info(`Creating inventory for characterId ${CharacterId} and userId ${UserId}`);

                CurrentInventory = MakeEmptyInventoryRow(CharacterId);

                tx.insert(inventory).values(CurrentInventory).run();
            }

            const InstancedItems: any[] = JSON.parse(CurrentInventory.instancedItems);

            for(const Item of InstancedItems){
                if(Item.catalogId === CatalogId && Item.instanceId == InstanceId){
                    AssertSuperiorInstancedItemVersion(Item, {catalogId: CatalogId, instanceId: InstanceId, updateVersion: UpdateVersion}, "update");

                    Item.itemData = ItemData;
                    Item.updateVersion = UpdateVersion;

                    logger.info(`Updating Instanced Item ${CatalogId} for CharacterId ${CharacterId} and UserId ${UserId}`);

                    tx.update(inventory).set({
                        instancedItems: JSON.stringify(InstancedItems)
                    }).where(eq(inventory.characterId, CharacterId)).run();

                    return {success: true, data: Item} as InventoryResult<any>;
                }
            }

            return {success: false, error: "not_found"} as InventoryResult<any>;
        });
    }
    catch(error){
        if(error instanceof InventoryConflictError){
            logger.warn(error.message);
            return {success: false, error: "conflict"};
        }

        if(error instanceof SyntaxError){
            logger.error(error, `Invalid inventory data while updating instanced item ${CatalogId} for characterId ${CharacterId} and userId ${UserId}`);
            return {success: false, error: "invalid_inventory_data"};
        }

        logger.error(error, `Failed to update instanced item ${CatalogId} for characterId ${CharacterId} and userId ${UserId}`);
        return {success: false, error: "db_error"};
    }
}

export async function RunInventoryTransaction(UserId: string, CharacterId: string, TransactionId: string, InstancedItemsToAdd: any[], StackedItemsToAdd: any[], InstancedItemsToRemove: any[], StackedItemsToRemove: any[], InstancedItemsToSave: any[]): Promise<InventoryResult<any[]>>{
    InstancedItemsToAdd ??= [];
    StackedItemsToAdd ??= [];
    InstancedItemsToRemove ??= [];
    StackedItemsToRemove ??= [];
    InstancedItemsToSave ??= [];

    let TouchedStackedItems: any[] = []; // TODO: Clean this up if this ends up working

    if(!await DoesCharacterBelongToUserId(UserId, CharacterId)){
        logger.error(`Specified characterId ${CharacterId} does not belong to user ${UserId}`);
        return {success: false, error: "forbidden"};
    }

    const ShouldTouchInstancedItems = InstancedItemsToAdd.length > 0 || InstancedItemsToRemove.length > 0 || InstancedItemsToSave.length > 0;
    const ShouldTouchStackedItems = StackedItemsToAdd.length > 0 || StackedItemsToRemove.length > 0;

    if(!ShouldTouchInstancedItems && !ShouldTouchStackedItems){
        return {success: true};
    }

    try{
        GetDb().transaction((tx) => {
            let CurrentInventory = tx.query.inventory.findFirst({where: eq(inventory.characterId, CharacterId)}).sync();

            if(CurrentInventory == undefined){
                logger.info(`Creating inventory for characterId ${CharacterId}`)

                CurrentInventory = MakeEmptyInventoryRow(CharacterId);

                tx.insert(inventory).values(CurrentInventory).run();
            }

            const Update: Partial<typeof inventory.$inferInsert> = {};

            if(ShouldTouchInstancedItems){
                const InstancedItems: any[] = JSON.parse(CurrentInventory.instancedItems);

                for(const ItemToRemove of InstancedItemsToRemove){
                    const ItemIndex = FindInstancedItemIndex(InstancedItems, ItemToRemove.instanceId);

                    if(ItemIndex >= 0){
                        AssertSuperiorInstancedItemVersion(InstancedItems[ItemIndex], ItemToRemove, "remove");
                        InstancedItems.splice(ItemIndex, 1);
                    }
                }

                for(const ItemToSave of InstancedItemsToSave){
                    const ItemIndex = FindInstancedItemIndex(InstancedItems, ItemToSave.instanceId);

                    if(ItemIndex >= 0){
                        AssertSuperiorInstancedItemVersion(InstancedItems[ItemIndex], ItemToSave, "save");
                        InstancedItems[ItemIndex] = ItemToSave;
                    }
                    else{
                        InstancedItems.push(ItemToSave);
                    }
                }

                for(const ItemToAdd of InstancedItemsToAdd){
                    const ItemIndex = FindInstancedItemIndex(InstancedItems, ItemToAdd.instanceId);

                    if(ItemIndex >= 0){
                        AssertSuperiorInstancedItemVersion(InstancedItems[ItemIndex], ItemToAdd, "add");
                        InstancedItems[ItemIndex] = ItemToAdd;
                    }
                    else{
                        InstancedItems.push(ItemToAdd);
                    }
                }

                Update.instancedItems = JSON.stringify(InstancedItems);
            }

            if(ShouldTouchStackedItems){
                const StackedItems: any[] = JSON.parse(CurrentInventory.stackedItems);

                for(const ItemToRemove of StackedItemsToRemove){
                    const ItemIndex = StackedItems.findIndex((Item) => Item.catalogId === ItemToRemove.catalogId);

                    if(ItemIndex < 0){
                        continue;
                    }

                    StackedItems[ItemIndex].quantity -= ItemToRemove.quantity;

                    if(StackedItems[ItemIndex].quantity <= 0){
                        StackedItems.splice(ItemIndex, 1);
                    }
                }

                for(const ItemToAdd of StackedItemsToAdd){
                    const ItemIndex = StackedItems.findIndex((Item) => Item.catalogId === ItemToAdd.catalogId);

                    if(ItemIndex >= 0){
                        StackedItems[ItemIndex].quantity += ItemToAdd.quantity;
                        TouchedStackedItems.push(StackedItems[ItemIndex]);
                    }
                    else{
                        TouchedStackedItems.push(ItemToAdd);
                        StackedItems.push(ItemToAdd);
                    }
                }

                Update.stackedItems = JSON.stringify(StackedItems);
            }

            tx.update(inventory).set(Update).where(eq(inventory.characterId, CharacterId)).run();
        });
    }
    catch(error){
        if(error instanceof InventoryConflictError){
            logger.warn(error.message);
            return {success: false, error: "conflict"};
        }

        if(error instanceof SyntaxError){
            logger.error(error, `Invalid inventory data while running transaction ${TransactionId} for characterId ${CharacterId} and userId ${UserId}`);
            return {success: false, error: "invalid_inventory_data"};
        }

        logger.error(error, `Failed to run inventory transaction ${TransactionId} for characterId ${CharacterId} and userId ${UserId}`);
        return {success: false, error: "db_error"};
    }

    return {success: true, data: TouchedStackedItems};
}

export async function GetInventoryForUserIdAndCharacterId(UserId: string, CharacterId: string): Promise<InventoryResult<{characterId: string, instancedItems: any[], stackedItems: any[]}>>{
    if(!await DoesCharacterBelongToUserId(UserId, CharacterId)){ // TODO: HACK: Get rid of this ugly thing, this is a workaround as we don't have a userId on our inventories table
        return {success: false, error: "forbidden"};
    }

    try{
        let InventoryFromDb = await GetDb().query.inventory.findFirst({where: eq(inventory.characterId, CharacterId)});

        if(InventoryFromDb == undefined){
            logger.info(`Creating inventory for characterId ${CharacterId} and userId ${UserId}`);

            InventoryFromDb = MakeEmptyInventoryRow(CharacterId);

            await GetDb().insert(inventory).values(InventoryFromDb);
        }

        return {
            success: true,
            data: {
                characterId: CharacterId,
                instancedItems: JSON.parse(InventoryFromDb!.instancedItems),
                stackedItems: JSON.parse(InventoryFromDb!.stackedItems)
            }
        };
    }
    catch(error){
        if(error instanceof SyntaxError){
            logger.error(error, `Invalid inventory data while fetching inventory for characterId ${CharacterId} and userId ${UserId}`);
            return {success: false, error: "invalid_inventory_data"};
        }

        logger.error(error, `Failed to fetch inventory for characterId ${CharacterId} and userId ${UserId}`);
        return {success: false, error: "db_error"};
    }
}
