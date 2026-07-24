import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { characters, inventory } from "../db/schema";
import { logger } from "../logger";

export type InventoryError = "forbidden" | "not_found" | "conflict" | "invalid_inventory_item" | "invalid_inventory_data" | "db_error";
export type InventoryResult<T = void> = { success: true, data?: T } | { success: false, error: InventoryError };
export type InventoryTransactionInstancedItem = {
    catalogId: string;
    instanceId: string;
    updateVersion: number;
    itemData?: string;
};
export type InventoryTransactionStackedItem = { catalogId: string; quantity: number };
export type InventoryTransactionData = {
    createdInstancedItems: InventoryTransactionInstancedItem[];
    updatedInstancedItems: InventoryTransactionInstancedItem[];
    updatedStackedItems: InventoryTransactionStackedItem[];
    removedInstancedItems: InventoryTransactionInstancedItem[];
};

const RemovalBlockPattern = process.env.INVENTORY_REMOVAL_BLOCK_REGEX ?? "^(QI_.*|CONTAINER_CORE_.*_CELLCORE)$";
let RemovalBlockRegex: RegExp;
try {
    RemovalBlockRegex = new RegExp(RemovalBlockPattern);
}
catch (error) {
    throw new Error(`Invalid INVENTORY_REMOVAL_BLOCK_REGEX ${JSON.stringify(RemovalBlockPattern)}: ${error instanceof Error ? error.message : error}`);
}

class InventoryConflictError extends Error {
    constructor(message: string){
        super(message);
        this.name = "InventoryConflictError";
    }
}

class InventoryValidationError extends Error {
    constructor(message: string){
        super(message);
        this.name = "InventoryValidationError";
    }
}

function MakeEmptyInventoryRow(CharacterId: string): typeof inventory.$inferInsert {
    return {
        characterId: CharacterId,
        instancedItems: "[]",
        stackedItems: "[]",
    };
}

function GetOwnedCharacterInventory(Db: Pick<ReturnType<typeof GetDb>, "select">, UserId: string, CharacterId: string) {
    const Row = Db
        .select({
            instancedItems: inventory.instancedItems,
            stackedItems: inventory.stackedItems
        })
        .from(characters)
        .leftJoin(inventory, eq(characters.characterId, inventory.characterId))
        .where(and(eq(characters.characterId, CharacterId), eq(characters.userId, UserId)))
        .get();

    if(Row == undefined) {
        return undefined;
    }

    const {instancedItems, stackedItems} = Row;
    return {
        Inventory: instancedItems === null
            ? undefined
            : {characterId: CharacterId, instancedItems, stackedItems: stackedItems!}
    };
}

function HasStatelessItemData(Item: any){
    return !Object.prototype.hasOwnProperty.call(Item, "itemData") || Item.itemData == null;
}

function InstancedItemForAccount(UserId: string, Item: any){
    return {
        ...Item,
        accountId: UserId,
        catalogId: Item?.catalogId,
        instanceId: Item?.instanceId,
        updateVersion: Item?.updateVersion,
        itemData: Item?.itemData ?? null
    };
}

function TransactionInstancedItem(Item: any): InventoryTransactionInstancedItem {
    if(typeof Item?.catalogId !== "string" || !Item.catalogId || typeof Item?.instanceId !== "string" || !Item.instanceId ||
        !Number.isSafeInteger(Item?.updateVersion) || Item.updateVersion < 0 ||
        (Item.itemData != null && typeof Item.itemData !== "string")) {
        throw new InventoryValidationError("Invalid instanced item response data");
    }
    const result: InventoryTransactionInstancedItem = {
        catalogId: Item.catalogId,
        instanceId: Item.instanceId,
        updateVersion: Item.updateVersion
    };
    if(typeof Item.itemData === "string") result.itemData = Item.itemData;
    return result;
}

function TransactionStackedItem(Item: any): InventoryTransactionStackedItem {
    if(typeof Item?.catalogId !== "string" || !Item.catalogId || !Number.isSafeInteger(Item?.quantity) || Item.quantity < 0) {
        throw new InventoryValidationError("Invalid stacked item response data");
    }
    return { catalogId: Item.catalogId, quantity: Item.quantity };
}

function IsRemovalBlocked(Item: any){
    return typeof Item?.catalogId === "string" && RemovalBlockRegex.test(Item.catalogId);
}

export function DecodeInventory(Row: {instancedItems: string, stackedItems: string} | undefined){
    return {
        instancedItems: Row ? JSON.parse(Row.instancedItems) as any[] : [],
        stackedItems: Row ? JSON.parse(Row.stackedItems) as any[] : [],
    };
}

function IsAllowedStaleStatelessReplacement(CurrentItem: any, IncomingItem: any, Operation: string){
    return Operation !== "remove"
        && HasStatelessItemData(CurrentItem)
        && HasStatelessItemData(IncomingItem)
        && CurrentItem.updateVersion === 0;
}

function IsSameInstancedItem(CurrentItem: any, IncomingItem: any){
    return CurrentItem.catalogId === IncomingItem.catalogId
        && CurrentItem.instanceId === IncomingItem.instanceId
        && CurrentItem.updateVersion === IncomingItem.updateVersion
        && (CurrentItem.itemData ?? null) === (IncomingItem.itemData ?? null);
}

function AssertValidIncomingInstancedItem(IncomingItem: any, Operation: string){
    if(HasStatelessItemData(IncomingItem) && IncomingItem.updateVersion !== 0){
        throw new InventoryValidationError(`Refusing stateless instanced item ${Operation} ${IncomingItem.catalogId}/${IncomingItem.instanceId}: expected updateVersion 0, got ${IncomingItem.updateVersion}`);
    }
}

function AssertExistingInstancedItemWrite(CurrentItem: any, IncomingItem: any, Operation: string): "write" | "skip"{
    if(Operation !== "remove"){
        AssertValidIncomingInstancedItem(IncomingItem, Operation);
    }

    if(typeof CurrentItem.updateVersion !== "number"){
        return "write";
    }

    if(IsAllowedStaleStatelessReplacement(CurrentItem, IncomingItem, Operation)){
        return "skip";
    }

    if(IsSameInstancedItem(CurrentItem, IncomingItem)){
        return "skip";
    }

    const IsStaleInstancedItem = typeof IncomingItem.updateVersion !== "number" || IncomingItem.updateVersion <= CurrentItem.updateVersion;
    if(IsStaleInstancedItem){
        throw new InventoryConflictError(`Refusing stale instanced item ${Operation} ${IncomingItem.catalogId}/${IncomingItem.instanceId}: current updateVersion ${CurrentItem.updateVersion}, incoming updateVersion ${IncomingItem.updateVersion}`);
    }

    return "write";
}

export async function UpdateInstancedItem(CharacterId: string, UserId: string, InstanceId: string, CatalogId: string, ItemData: string | null | undefined, UpdateVersion: number): Promise<InventoryResult<any>>{
    try{
        return GetDb().transaction((tx) => {
            const CharacterInventory = GetOwnedCharacterInventory(tx, UserId, CharacterId);

            if(CharacterInventory == undefined){
                logger.error(`Specified characterId ${CharacterId} does not belong to user ${UserId}`);
                return {success: false, error: "forbidden"} as InventoryResult<any>;
            }

            let CurrentInventory = CharacterInventory.Inventory;

            if(CurrentInventory == undefined){
                logger.info(`Creating inventory for characterId ${CharacterId} and userId ${UserId}`);

                CurrentInventory = MakeEmptyInventoryRow(CharacterId);

                tx.insert(inventory).values(CurrentInventory).run();
            }

            const {instancedItems: InstancedItems} = DecodeInventory(CurrentInventory);
            const ItemIndex = InstancedItems.findIndex((Item) => Item.catalogId === CatalogId && Item.instanceId === InstanceId);

            if(ItemIndex < 0){
                return {success: false, error: "not_found"} as InventoryResult<any>;
            }

            const Item = InstancedItemForAccount(UserId, InstancedItems[ItemIndex]);
            InstancedItems[ItemIndex] = Item;
            const IncomingItem = {catalogId: CatalogId, instanceId: InstanceId, itemData: ItemData, updateVersion: UpdateVersion};

            if(AssertExistingInstancedItemWrite(Item, IncomingItem, "update") === "skip"){
                logger.info(`Skipping stale stateless Instanced Item ${CatalogId} for CharacterId ${CharacterId} and UserId ${UserId}`);
                return {success: true, data: Item} as InventoryResult<any>;
            }

            Item.itemData = ItemData;
            Item.updateVersion = UpdateVersion;

            logger.info(`Updating Instanced Item ${CatalogId} for CharacterId ${CharacterId} and UserId ${UserId}`);

            tx.update(inventory).set({
                instancedItems: JSON.stringify(InstancedItems)
            }).where(eq(inventory.characterId, CharacterId)).run();

            return {success: true, data: Item} as InventoryResult<any>;
        });
    }
    catch(error){
        if(error instanceof InventoryConflictError){
            logger.warn(error.message);
            return {success: false, error: "conflict"};
        }

        if(error instanceof InventoryValidationError){
            logger.warn(error.message);
            return {success: false, error: "invalid_inventory_item"};
        }

        if(error instanceof SyntaxError){
            logger.error(error, `Invalid inventory data while updating instanced item ${CatalogId} for characterId ${CharacterId} and userId ${UserId}`);
            return {success: false, error: "invalid_inventory_data"};
        }

        logger.error(error, `Failed to update instanced item ${CatalogId} for characterId ${CharacterId} and userId ${UserId}`);
        return {success: false, error: "db_error"};
    }
}

export async function RunInventoryTransaction(UserId: string, CharacterId: string, TransactionId: string, InstancedItemsToAdd: any[], StackedItemsToAdd: any[], InstancedItemsToRemove: any[], StackedItemsToRemove: any[], InstancedItemsToSave: any[]): Promise<InventoryResult<InventoryTransactionData>>{
    InstancedItemsToAdd ??= [];
    StackedItemsToAdd ??= [];
    InstancedItemsToRemove ??= [];
    StackedItemsToRemove ??= [];
    InstancedItemsToSave ??= [];

    const TransactionData: InventoryTransactionData = {
        createdInstancedItems: [],
        updatedInstancedItems: [],
        updatedStackedItems: [],
        removedInstancedItems: [],
    };

    const ShouldTouchInstancedItems = InstancedItemsToAdd.length > 0 || InstancedItemsToSave.length > 0 || InstancedItemsToRemove.length > 0;
    const ShouldTouchStackedItems = StackedItemsToAdd.length > 0 || StackedItemsToRemove.length > 0;

    try{
        return GetDb().transaction((tx) => {
            const CharacterInventory = GetOwnedCharacterInventory(tx, UserId, CharacterId);

            if(CharacterInventory == undefined){
                logger.error(`Specified characterId ${CharacterId} does not belong to user ${UserId}`);
                return {success: false, error: "forbidden"} as InventoryResult<InventoryTransactionData>;
            }

            if(!ShouldTouchInstancedItems && !ShouldTouchStackedItems){
                return {success: true, data: TransactionData} as InventoryResult<InventoryTransactionData>;
            }

            let CurrentInventory = CharacterInventory.Inventory;

            if(CurrentInventory == undefined){
                logger.info(`Creating inventory for characterId ${CharacterId}`)

                CurrentInventory = MakeEmptyInventoryRow(CharacterId);

                tx.insert(inventory).values(CurrentInventory).run();
            }

            const Update: Partial<typeof inventory.$inferInsert> = {};
            const Current = DecodeInventory(CurrentInventory);

            if(ShouldTouchInstancedItems){
                const InstancedItems = Current.instancedItems.map((Item) => InstancedItemForAccount(UserId, Item));
                const ItemByInstanceId = new Map<any, any>();
                for(const Item of InstancedItems){
                    if(!ItemByInstanceId.has(Item.instanceId)) ItemByInstanceId.set(Item.instanceId, Item);
                }
                let DidUpdateInstancedItems = false;

                const UpsertItem = (IncomingItem: any, Operation: "save" | "add") => {
                    const Item = InstancedItemForAccount(UserId, IncomingItem);
                    const Existing = ItemByInstanceId.get(Item.instanceId);
                    if(Existing != undefined){
                        if(AssertExistingInstancedItemWrite(Existing, Item, Operation) === "skip"){
                            return;
                        }
                        InstancedItems[InstancedItems.indexOf(Existing)] = Item;
                        ItemByInstanceId.set(Item.instanceId, Item);
                        TransactionData.updatedInstancedItems.push(TransactionInstancedItem(Item));
                        DidUpdateInstancedItems = true;
                    }
                    else{
                        AssertValidIncomingInstancedItem(Item, Operation);
                        ItemByInstanceId.set(Item.instanceId, Item);
                        InstancedItems.push(Item);
                        TransactionData.createdInstancedItems.push(TransactionInstancedItem(Item));
                        DidUpdateInstancedItems = true;
                    }
                };

                for(const ItemToSave of InstancedItemsToSave){
                    UpsertItem(ItemToSave, "save");
                }

                for(const ItemToAdd of InstancedItemsToAdd){
                    UpsertItem(ItemToAdd, "add");
                }

                for(const ItemToRemove of InstancedItemsToRemove){
                    const Existing = ItemByInstanceId.get(ItemToRemove.instanceId);
                    if(Existing == undefined || IsRemovalBlocked(ItemToRemove) || IsRemovalBlocked(Existing)) continue;
                    const ItemIndex = InstancedItems.indexOf(Existing);
                    if(ItemIndex < 0) continue;
                    const [RemovedItem] = InstancedItems.splice(ItemIndex, 1);
                    ItemByInstanceId.delete(ItemToRemove.instanceId);
                    TransactionData.removedInstancedItems.push(TransactionInstancedItem(RemovedItem));
                    DidUpdateInstancedItems = true;
                }

                if(DidUpdateInstancedItems){
                    Update.instancedItems = JSON.stringify(InstancedItems);
                }
            }

            if(ShouldTouchStackedItems){
                const StackedItems = Current.stackedItems;
                const ItemByCatalogId = new Map<string, any>();
                let DidUpdateStackedItems = false;
                for(const Item of StackedItems){
                    if(!ItemByCatalogId.has(Item.catalogId)) ItemByCatalogId.set(Item.catalogId, Item);
                }

                for(const ItemToAdd of StackedItemsToAdd){
                    const Existing = ItemByCatalogId.get(ItemToAdd.catalogId);
                    if(Existing){
                        Existing.quantity += ItemToAdd.quantity;
                        TransactionData.updatedStackedItems.push(TransactionStackedItem(Existing));
                    }
                    else{
                        TransactionData.updatedStackedItems.push(TransactionStackedItem(ItemToAdd));
                        StackedItems.push(ItemToAdd);
                        ItemByCatalogId.set(ItemToAdd.catalogId, ItemToAdd);
                    }
                    DidUpdateStackedItems = true;
                }

                for(const ItemToRemove of StackedItemsToRemove){
                    const Existing = ItemByCatalogId.get(ItemToRemove.catalogId);
                    if(!Existing) continue;
                    if(IsRemovalBlocked(ItemToRemove) || IsRemovalBlocked(Existing)){
                        TransactionData.updatedStackedItems.push(TransactionStackedItem(Existing), TransactionStackedItem({
                            catalogId: Existing.catalogId, quantity: Existing.quantity > 0 ? Existing.quantity - 1 : 1
                        }));
                        continue;
                    }
                    Existing.quantity -= Number(ItemToRemove.quantity ?? 0);
                    if(Existing.quantity <= 0){
                        const ItemIndex = StackedItems.indexOf(Existing);
                        if(ItemIndex >= 0) StackedItems.splice(ItemIndex, 1);
                        ItemByCatalogId.delete(ItemToRemove.catalogId);
                        Existing.quantity = 0;
                    }
                    TransactionData.updatedStackedItems.push(TransactionStackedItem(Existing));
                    DidUpdateStackedItems = true;
                }

                if(DidUpdateStackedItems) Update.stackedItems = JSON.stringify(StackedItems);
            }

            if(Object.keys(Update).length > 0){
                tx.update(inventory).set(Update).where(eq(inventory.characterId, CharacterId)).run();
            }

            return {success: true, data: TransactionData} as InventoryResult<InventoryTransactionData>;
        });
    }
    catch(error){
        if(error instanceof InventoryConflictError){
            logger.warn(error.message);
            return {success: false, error: "conflict"};
        }

        if(error instanceof InventoryValidationError){
            logger.warn(error.message);
            return {success: false, error: "invalid_inventory_item"};
        }

        if(error instanceof SyntaxError){
            logger.error(error, `Invalid inventory data while running transaction ${TransactionId} for characterId ${CharacterId} and userId ${UserId}`);
            return {success: false, error: "invalid_inventory_data"};
        }

        logger.error(error, `Failed to run inventory transaction ${TransactionId} for characterId ${CharacterId} and userId ${UserId}`);
        return {success: false, error: "db_error"};
    }

}

export async function GetInventoryForUserIdAndCharacterId(UserId: string, CharacterId: string): Promise<InventoryResult<{characterId: string, instancedItems: any[], stackedItems: any[]}>>{
    try{
        const Db = GetDb();
        const CharacterInventory = GetOwnedCharacterInventory(Db, UserId, CharacterId);

        if(CharacterInventory == undefined){
            return {success: false, error: "forbidden"};
        }

        let InventoryFromDb = CharacterInventory.Inventory;

        if(InventoryFromDb == undefined){
            logger.info(`Creating inventory for characterId ${CharacterId} and userId ${UserId}`);

            const EmptyInventory = MakeEmptyInventoryRow(CharacterId);
            const CreatedInventory = Db.insert(inventory)
                .values(EmptyInventory)
                .onConflictDoNothing() // Another request created inventory after lookup, do not overwrite
                .returning()
                .get();

            InventoryFromDb = CreatedInventory ?? await Db.query.inventory.findFirst({where: eq(inventory.characterId, CharacterId)});
            if(InventoryFromDb == undefined){
                throw new Error(`Inventory creation did not produce a row for characterId ${CharacterId}`);
            }
        }

        const {instancedItems: StoredInstancedItems, stackedItems: StackedItems} = DecodeInventory(InventoryFromDb);
        const InstancedItems = StoredInstancedItems.map((Item) => InstancedItemForAccount(UserId, Item));
        return {
            success: true,
            data: {
                characterId: CharacterId,
                instancedItems: InstancedItems,
                stackedItems: StackedItems
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
