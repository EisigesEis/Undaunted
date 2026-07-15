import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { loadouts } from "../db/schema";
import { logger } from "../logger";

// TODO: Once store plat purchases exist raise to (I think) 15.
export const MAX_UNLOCKED_LOADOUT_SLOTS = 6;
const DEFAULT_ACTIVE_LOADOUT_INDEX = 0;
const DEFAULT_EMPTY_ID = "";
const DEFAULT_NONE_ID = "None";
const DEFAULT_SLOT_UPDATE_VERSION = 0;

type LoadoutRow = {
    characterId: string;
    userId: string;
    loadouts: string;
    persistent: string;
    activeIndex: number;
};

type LoadoutState = {
    loadouts: any[];
    persistent: any;
    activeIndex: number;
};

export type LoadoutMutationResult = {
    success: boolean;
    statusCode?: number;
    loadoutState?: LoadoutState;
};

const DEFAULT_INSTANCE_DATA = JSON.stringify({
    SheenType: 73,
    IsPrimarySheenActive: true,
    PrimaryDyeId: DEFAULT_NONE_ID,
    IsSecondarySheenActive: true,
    SecondaryDyeId: DEFAULT_NONE_ID,
    IsTertiarySheenActive: false,
    TertiaryDyeId: DEFAULT_NONE_ID,
    TransmogCatalogId: DEFAULT_NONE_ID,
    TransmogEnabled: false,
    EquippedCells: [],
    EquippedCellsv2: [],
    SubTypeMetadataArray: {
        ItemSubType: "subtype_eblade",
        EquippedItemParts: [{
            WeaponPartId: "PART_EB_SPECIAL_DEFAULT",
            SlotIndex: 0,
        }]
    }
});

const DEFAULT_APPEARANCE = JSON.stringify({
    CreationState: "EArchonCharacterCreationState::NewCharacter",
    Data: [],
    AssetReferences: [],
    StringData: []
});

const DEFAULT_BANNER_CUSTOMIZATION = JSON.stringify({
    BannerMeshItemID: "BNC_MESH_BEGINNER_00",
    FabricMaterialItemID: "BNC_FABRIC_BEGINNER_00",
    SigilTextureItemID: "BNC_SIGIL_BEGINNER_00",
    PlantVFXItemID: DEFAULT_EMPTY_ID,
    PersistantStandardVFXItemID: DEFAULT_EMPTY_ID,
    AnimationItemID: "BNC_ANIMATION_BEGINNER_00",
    BackgroundColourItemID: "DYE_BANNER_BACKGROUND_DEFAULT",
    BorderColourItemID: "DYE_BANNER_SIGIL_DEFAULT",
    SigilColourItemID: "DYE_BANNER_SIGIL_DEFAULT",
    BackgroundSheenType: 0,
    BorderSheenType: 0,
    SigilSheenType: 0
});

const DEFAULT_QUICK_CURIOSITIES_ITEMS = Array.from({length: 8}, (_, item_index) => ({
    item_index,
    item_id: DEFAULT_EMPTY_ID,
    instance_id: DEFAULT_EMPTY_ID,
}));

const DEFAULT_EQUIPMENT = {
    weapon: {
        item_id: "WP_EB_TRAINING",
        instance_id: "WP_EB_TRAINING",
        instance_data: DEFAULT_INSTANCE_DATA
    },
    helmet: {
        item_id: "AR_UNEQUIPPED_HELM",
        instance_id: "AR_UNEQUIPPED_HELM",
        instance_data: DEFAULT_INSTANCE_DATA
    },
    chest: {
        item_id: "AR_BEGINNER_CHEST",
        instance_id: "AR_BEGINNER_CHEST",
        instance_data: DEFAULT_INSTANCE_DATA
    },
    arms: {
        item_id: "AR_BEGINNER_ARMS",
        instance_id: "AR_BEGINNER_ARMS",
        instance_data: DEFAULT_INSTANCE_DATA
    },
    legs: {
        item_id: "AR_BEGINNER_LEGS",
        instance_id: "AR_BEGINNER_LEGS",
        instance_data: DEFAULT_INSTANCE_DATA
    },
    lantern: {
        item_id: "LT_BASIC",
        instance_id: "LT_BASIC",
        instance_data: DEFAULT_INSTANCE_DATA
    },
    player_role: {
        item_id: "PR_DARKNESS",
        instance_id: "PR_DARKNESS",
        instance_data: DEFAULT_INSTANCE_DATA
    },
};

const DEFAULT_PERSISTENT = {
    manual_emotes: Array(6).fill(DEFAULT_EMPTY_ID),
    intro_emote: "EM_INTRO_BEGINNER_01",
    banner: "BN_BEGINNER_00",
    bannerCustomization: DEFAULT_BANNER_CUSTOMIZATION,
    flare: "QI_BASIC_FLARE_DURABLE",
    title: DEFAULT_EMPTY_ID,
    head_accessory: DEFAULT_EMPTY_ID,
    back_accessory: DEFAULT_EMPTY_ID,
    pet: DEFAULT_EMPTY_ID,
    glider: "GD_FRAME_STARTER_BASE",
    update_version: DEFAULT_SLOT_UPDATE_VERSION,
    quick_chats: Array(9).fill(DEFAULT_EMPTY_ID),
    emojis: Array(9).fill(DEFAULT_EMPTY_ID),
    quick_curiosities_items: DEFAULT_QUICK_CURIOSITIES_ITEMS,
    quickwheel: [],
};

function createDefaultLoadoutSlot(SlotIndex: number){
    return {
        weapon: {...DEFAULT_EQUIPMENT.weapon},
        helmet: {...DEFAULT_EQUIPMENT.helmet},
        chest: {...DEFAULT_EQUIPMENT.chest},
        arms: {...DEFAULT_EQUIPMENT.arms},
        legs: {...DEFAULT_EQUIPMENT.legs},
        lantern: {...DEFAULT_EQUIPMENT.lantern},
        player_role: {...DEFAULT_EQUIPMENT.player_role},
        subweapon: null,
        appearance: DEFAULT_APPEARANCE,
        flask: "FL_HEALING_DEFAULT",
        quick_items: [],
        slot_index: SlotIndex,
        update_version: DEFAULT_SLOT_UPDATE_VERSION,
        custom_name: DEFAULT_EMPTY_ID,
        persistent: DEFAULT_PERSISTENT
    };
}

function parseJsonField<T>(Value: string, Fallback: T): T {
    try {
        return JSON.parse(Value);
    }
    catch {
        return Fallback;
    }
}

function clampActiveIndex(ActiveIndex: number, LoadoutCount: number){
    if(!Number.isInteger(ActiveIndex) || ActiveIndex < 0 || ActiveIndex >= LoadoutCount){
        return 0;
    }

    return ActiveIndex;
}

function normalizeLoadouts(LoadoutData: unknown){
    if(!Array.isArray(LoadoutData) || LoadoutData.length === 0){
        return [createDefaultLoadoutSlot(0)];
    }

    return LoadoutData.slice(0, MAX_UNLOCKED_LOADOUT_SLOTS).map((LoadoutSlot: any, SlotIndex) => ({
        ...LoadoutSlot,
        slot_index: SlotIndex
    }));
}

function parseLoadoutRow(LoadoutDbRow: LoadoutRow): LoadoutState{
    const ParsedLoadouts = normalizeLoadouts(parseJsonField(LoadoutDbRow.loadouts, []));

    return {
        loadouts: ParsedLoadouts,
        persistent: parseJsonField(LoadoutDbRow.persistent, DEFAULT_PERSISTENT),
        activeIndex: clampActiveIndex(LoadoutDbRow.activeIndex, ParsedLoadouts.length)
    };
}

function createLoadoutRow(UserId: string, CharacterId: string, SlotCount = 1): LoadoutRow{
    return {
        characterId: CharacterId,
        userId: UserId,
        loadouts: JSON.stringify(Array.from({length: SlotCount}, (_, SlotIndex) => createDefaultLoadoutSlot(SlotIndex))),
        persistent: JSON.stringify(DEFAULT_PERSISTENT),
        activeIndex: DEFAULT_ACTIVE_LOADOUT_INDEX
    };
}

function getOrCreateLoadoutRow(Transaction: any, UserId: string, CharacterId: string, SlotCount = 1): {row: LoadoutRow, created: boolean}{
    let LoadoutDbRow = Transaction.query.loadouts.findFirst({where: and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId))}).sync();

    if(LoadoutDbRow != undefined){
        return {row: LoadoutDbRow, created: false};
    }

    const NewLoadoutRow = createLoadoutRow(UserId, CharacterId, SlotCount);

    Transaction.insert(loadouts).values(NewLoadoutRow).run();

    return {row: NewLoadoutRow, created: true};
}

function parseLoadoutIndex(Index: string){
    const ParsedIndex = Number.parseInt(Index, 10);

    if(!Number.isInteger(ParsedIndex) || String(ParsedIndex) !== Index || ParsedIndex < 0 || ParsedIndex >= MAX_UNLOCKED_LOADOUT_SLOTS){
        return undefined;
    }

    return ParsedIndex;
}

export function BuildLoadoutResponsePayload(LoadoutState: LoadoutState){
    const SlotCount = LoadoutState.loadouts.length;

    return {
        loadouts: LoadoutState.loadouts,
        persistent: LoadoutState.persistent,
        LoadoutSlotDataArray: LoadoutState.loadouts,
        ActiveLoadoutSlotIndex: LoadoutState.activeIndex,
        NumLoadoutSlots: SlotCount,
        NumAccountLoadoutSlots: SlotCount,
        NumCharacterLoadoutSlots: SlotCount,
        MaxNumLoadoutSlots: MAX_UNLOCKED_LOADOUT_SLOTS,
        MaxNumAccountLoadoutSlots: MAX_UNLOCKED_LOADOUT_SLOTS,
        MaxNumCharacterLoadoutSlots: MAX_UNLOCKED_LOADOUT_SLOTS,
        num_account_slots: SlotCount,
        max_account_slots: MAX_UNLOCKED_LOADOUT_SLOTS,
        num_character_slots: SlotCount,
        max_character_slots: MAX_UNLOCKED_LOADOUT_SLOTS,
        active_index: LoadoutState.activeIndex,
        needs_migration: false
    };
}

export function BuildLoadoutSlotCountPayload(LoadoutState: {loadouts: any[], activeIndex: number}){
    const SlotCount = LoadoutState.loadouts.length;

    return {
        GrantedLoadoutSlots: SlotCount,
        NumLoadoutSlots: SlotCount,
        NumAccountLoadoutSlots: SlotCount,
        NumCharacterLoadoutSlots: SlotCount,
        MaxNumLoadoutSlots: MAX_UNLOCKED_LOADOUT_SLOTS,
        MaxNumAccountLoadoutSlots: MAX_UNLOCKED_LOADOUT_SLOTS,
        MaxNumCharacterLoadoutSlots: MAX_UNLOCKED_LOADOUT_SLOTS,
        ActiveLoadoutSlotIndex: LoadoutState.activeIndex,
        slot_count: SlotCount,
        slotCount: SlotCount,
        num_slots: SlotCount,
        num_account_slots: SlotCount,
        max_account_slots: MAX_UNLOCKED_LOADOUT_SLOTS,
        num_character_slots: SlotCount,
        max_character_slots: MAX_UNLOCKED_LOADOUT_SLOTS,
        active_index: LoadoutState.activeIndex
    };
}

export async function GetAllLoadoutsForUserIdAndCharacterId(UserId: string, CharacterId: string){
    const LoadoutState = await GetLoadoutSetForUserIdAndCharacterId(UserId, CharacterId);

    return LoadoutState.loadouts;
}

export async function GetLoadoutSetForUserIdAndCharacterId(UserId: string, CharacterId: string){
    return GetDb().transaction((Transaction) => {
        const LoadoutDbRow = getOrCreateLoadoutRow(Transaction, UserId, CharacterId);

        if(LoadoutDbRow.created){
            logger.info(`Creating new loadout state for userId ${UserId} and characterId ${CharacterId}`);
        }

        return parseLoadoutRow(LoadoutDbRow.row);
    });
}

export async function GetPersistentLoadoutForUserIdAndCharacterId(UserId: string, CharacterId: string){
    const LoadoutState = await GetLoadoutSetForUserIdAndCharacterId(UserId, CharacterId);

    return LoadoutState.persistent;
}

export async function SetLoadoutDataForUserIdAndCharacterId(UserId: string, CharacterId: string, Index: string, Data: unknown): Promise<LoadoutMutationResult>{
    let ParsedData: any;

    try{
        ParsedData = typeof Data === "string" ? JSON.parse(Data) : Data;
    }
    catch(error){
        logger.error(error, `Invalid loadout data JSON for index ${Index}`);
        return {success: false, statusCode: 400};
    }

    if(ParsedData == undefined){
        logger.error(`Missing loadout data for index ${Index}`);
        return {success: false, statusCode: 400};
    }

    try{
        return GetDb().transaction((Transaction) => {
            const LoadoutDbRow = getOrCreateLoadoutRow(Transaction, UserId, CharacterId).row;
            const ExistingLoadoutState = parseLoadoutRow(LoadoutDbRow);

            if(Index === "persistent"){
                const PersistentData = JSON.stringify(ParsedData);

                if(LoadoutDbRow.persistent === PersistentData){
                    return {
                        success: true,
                        loadoutState: ExistingLoadoutState
                    };
                }

                Transaction.update(loadouts).set({
                    persistent: PersistentData
                }).where(and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId))).run();

                return {
                    success: true,
                    loadoutState: {
                        ...ExistingLoadoutState,
                        persistent: ParsedData
                    }
                };
            }

            const LoadoutIndex = parseLoadoutIndex(Index);

            if(LoadoutIndex == undefined){
                logger.error(`Unsupported Loadout Data Index ${Index}`);
                return {success: false, statusCode: 400};
            }

            if(LoadoutIndex >= ExistingLoadoutState.loadouts.length){
                logger.error(`Loadout index ${Index} is not unlocked for userId ${UserId} and characterId ${CharacterId}`);
                return {success: false, statusCode: 400};
            }

            if(typeof ParsedData !== "object" || Array.isArray(ParsedData)){
                logger.error(`Invalid loadout slot payload shape for index ${Index}`);
                return {success: false, statusCode: 400};
            }

            const UpdatedSlot = {
                ...ParsedData,
                slot_index: LoadoutIndex
            };
            const ExistingSlot = ExistingLoadoutState.loadouts[LoadoutIndex];
            const ExistingVersion = ExistingSlot?.update_version;
            const IncomingVersion = UpdatedSlot.update_version;

            if(typeof ExistingVersion === "number" && typeof IncomingVersion === "number" && IncomingVersion < ExistingVersion){
                logger.warn({
                    userId: UserId,
                    characterId: CharacterId,
                    index: LoadoutIndex,
                    existingUpdateVersion: ExistingVersion,
                    incomingUpdateVersion: IncomingVersion
                }, "Rejected stale loadout slot update");

                return {success: false, statusCode: 409};
            }

            const UpdatedLoadouts = ExistingLoadoutState.loadouts.slice();
            UpdatedLoadouts[LoadoutIndex] = UpdatedSlot;
            const UpdatedLoadoutState = {
                ...ExistingLoadoutState,
                loadouts: UpdatedLoadouts,
                activeIndex: LoadoutIndex
            };

            Transaction.update(loadouts).set({
                loadouts: JSON.stringify(UpdatedLoadouts),
                activeIndex: LoadoutIndex
            }).where(and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId))).run();

            return {
                success: true,
                loadoutState: UpdatedLoadoutState
            };
        });
    }
    catch(error){
        logger.error(error, `Failed to update loadout data index ${Index}`);
        return {success: false, statusCode: 400};
    }
}

export async function SetActiveLoadoutIndexForUserIdAndCharacterId(UserId: string, CharacterId: string, Index: string): Promise<LoadoutMutationResult>{
    const LoadoutIndex = parseLoadoutIndex(Index);

    if(LoadoutIndex == undefined){
        logger.error(`Unsupported active loadout index ${Index}`);
        return {success: false, statusCode: 400};
    }

    try{
        return GetDb().transaction((Transaction) => {
            const ExistingLoadoutDbRow = Transaction.query.loadouts.findFirst({where: and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId))}).sync();

            if(ExistingLoadoutDbRow == undefined){
                if(LoadoutIndex !== 0){
                    logger.error(`Active loadout index ${Index} is not unlocked for new userId ${UserId} and characterId ${CharacterId}`);
                    return {success: false, statusCode: 400};
                }

                const NewLoadoutRow = createLoadoutRow(UserId, CharacterId);
                Transaction.insert(loadouts).values(NewLoadoutRow).run();

                return {success: true, loadoutState: parseLoadoutRow(NewLoadoutRow)};
            }

            const ExistingLoadoutState = parseLoadoutRow(ExistingLoadoutDbRow);

            if(LoadoutIndex >= ExistingLoadoutState.loadouts.length){
                logger.error(`Active loadout index ${Index} is not unlocked for userId ${UserId} and characterId ${CharacterId}`);
                return {success: false, statusCode: 400};
            }

            if(ExistingLoadoutState.activeIndex === LoadoutIndex){
                return {success: true, loadoutState: ExistingLoadoutState};
            }

            Transaction.update(loadouts).set({
                activeIndex: LoadoutIndex
            }).where(and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId))).run();

            return {
                success: true,
                loadoutState: {
                    ...ExistingLoadoutState,
                    activeIndex: LoadoutIndex
                }
            };
        });
    }
    catch(error){
        logger.error(error, `Failed to set active loadout index ${Index}`);
        return {success: false, statusCode: 400};
    }
}

export async function EnsureUnlockedLoadoutSlotsForUserIdAndCharacterId(UserId: string, CharacterId: string, SlotCount: number): Promise<LoadoutMutationResult>{
    if(!Number.isInteger(SlotCount) || SlotCount < 1 || SlotCount > MAX_UNLOCKED_LOADOUT_SLOTS){
        logger.error(`Unsupported loadout unlock slot count ${SlotCount}`);
        return {success: false, statusCode: 400};
    }

    try{
        return GetDb().transaction((Transaction) => {
            const ExistingLoadoutDbRow = Transaction.query.loadouts.findFirst({where: and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId))}).sync();

            if(ExistingLoadoutDbRow == undefined){
                const NewLoadoutRow = createLoadoutRow(UserId, CharacterId, SlotCount);
                Transaction.insert(loadouts).values(NewLoadoutRow).run();

                return {success: true, loadoutState: parseLoadoutRow(NewLoadoutRow)};
            }

            const ExistingLoadoutState = parseLoadoutRow(ExistingLoadoutDbRow);

            if(SlotCount <= ExistingLoadoutState.loadouts.length){
                return {success: true, loadoutState: ExistingLoadoutState};
            }

            const UpdatedLoadouts = ExistingLoadoutState.loadouts.slice();

            for(let SlotIndex = UpdatedLoadouts.length; SlotIndex < SlotCount; SlotIndex++){
                UpdatedLoadouts.push(createDefaultLoadoutSlot(SlotIndex));
            }

            const UpdatedLoadoutState = {
                ...ExistingLoadoutState,
                loadouts: UpdatedLoadouts,
                activeIndex: clampActiveIndex(ExistingLoadoutDbRow.activeIndex, UpdatedLoadouts.length)
            };

            Transaction.update(loadouts).set({
                loadouts: JSON.stringify(UpdatedLoadoutState.loadouts),
                activeIndex: UpdatedLoadoutState.activeIndex
            }).where(and(eq(loadouts.characterId, CharacterId), eq(loadouts.userId, UserId))).run();

            return {success: true, loadoutState: UpdatedLoadoutState};
        });
    }
    catch(error){
        logger.error(error, `Failed to unlock loadout slots for userId ${UserId} and characterId ${CharacterId}`);
        return {success: false, statusCode: 400};
    }
}
