import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { characters, cooldowns, entitlements, inventory, users } from "../db/schema";
import { HUNTPASS_PREMIUM_ENTITLEMENT } from "./huntpass";
import { ReconcileTrialsCosmeticOwnership } from "./inventory";

export type StoreCurrencyId = "CURRENCY_NOTES" | "CURRENCY_MARKS_STEEL" | "CURRENCY_MARKS_GILDED";
export type PurchaseCurrency = "markssteel" | "marksgilded" | "platinum";
type StoreItem = { catalogId: string, quantity: number };
type StorePrice = { currencyId: string, price: number, salesPrice: number | null, multiPrice: unknown };
export type StoreSku = {
    id: string;
    displayName: string;
    displayDescription: string;
    displayPriority: number;
    prices: StorePrice[];
    maxAllowed: number | null;
    remaining: number | null;
    duplicateInstancedItems: string[] | null;
    images: Record<string, unknown>;
    tags: string[];
    scheduledTags: unknown;
    items: StoreItem[];
    entitlements: unknown[];
    skuProgression: unknown;
    loadoutSlots: unknown;
    availableFrom: unknown;
    availableTo: unknown;
    timeAvailabilityReason: unknown;
    platformOfferId: unknown;
    missingEntitlementNames: unknown;
    steelMarksPrice?: number;
    gildedMarksPrice?: number;
};

const CurrencyAliases: Record<string, StoreCurrencyId> = {
    id_currency_notes: "CURRENCY_NOTES",
    id_currency_marks_steel: "CURRENCY_MARKS_STEEL",
    id_currency_marks_gilded: "CURRENCY_MARKS_GILDED",
};

const CurrencyCatalogIds: Record<PurchaseCurrency, string> = {
    markssteel: "id_currency_marks_steel",
    marksgilded: "id_currency_marks_gilded",
    platinum: "id_currency_platinum",
};

type NativeTrialsProduct = {
    id: string;
    catalogId?: string;
    displayName: string;
    displayDescription?: string;
    currency: PurchaseCurrency;
    price: number;
    instanced?: boolean;
    oneTime?: boolean;
    items?: StoreItem[];
};

export const TrialsStoreIconPaths: Record<string, string> = {
    // Cells
    CELL_TRIALS_06_E: "Trials/ui_trials_epic_cell_engineer",
    CELL_TRIALS_01_E: "Trials/ui_trials_epic_cell_berserker",
    CELL_TRIALS_04_E: "Trials/ui_trials_epic_cell_mobility",
    CELL_TRIALS_02_E: "Trials/ui_trials_epic_cell_strategist",
    CELL_TRIALS_03_E: "Trials/ui_trials_epic_cell_engineer",
    CELL_TRIALS_05_E: "Trials/ui_trials_epic_cell_power",

    // Weapon mods
    PART_EB_PASSIVE_TRIALS_01: "Icons/Mastery/Framed/ico_mastery_keenedge",
    PART_EB_PASSIVE_TRIALS_02: "Icons/Mastery/Framed/ico_ladyluck_sword_1",
    PART_GA_PASSIVE_TRIALS_01: "Icons/Mastery/Framed/ico_mastery_railsplitterscanteen_6_1",
    PART_GA_PASSIVE_TRIALS_02: "Icons/Mastery/Framed/ico_ladyluck_axe_1",
    PART_CB_PASSIVE_TRIALS_01: "Icons/Mastery/Framed/ico_mastery_momentumblades_6_1",
    PART_CB_PASSIVE_TRIALS_02: "Icons/Mastery/Framed/ico_ladyluck_chainblade_1",
    PART_DP_PASSIVE_TRIALS_01: "Icons/Mastery/Framed/ico_mastery_tacticiansmagazine_6_1",
    PART_DP_PASSIVE_TRIALS_02: "Icons/Mastery/Framed/ico_ladyluck_repeater_2",
    PART_MS_PASSIVE_TRIALS_01: "Icons/Mastery/Framed/ico_mastery_barbedspearhead_6_1",
    PART_MS_PASSIVE_TRIALS_02: "Icons/Mastery/Framed/ico_ladyluck_spear_2",

    // Weapon specials
    PART_GA_SPECIAL_SKILLSHOT_RESET: "Icons/Mastery/Ability/ico_mastery_relentlessonslaught",
    PART_IH_SPECIAL_ISLANDCRACKER_DEFENSIVE: "Icons/Mastery/Ability/ico_mastery_ironheartlandbreaker",
    PART_EB_SPECIAL_PARRY: "Icons/Mastery/Ability/ico_mastery_defensiveoverdrive",
    PART_CB_SPECIAL_INSATIABLE_DANCE: "Icons/Mastery/Ability/ico_mastery_insatiabledance",
    PART_MS_SPECIAL_ROCKETLUNGE: "Icons/Mastery/Ability/ico_mastery_recklessleap",
    // Lanterns
    LT_TRIALS_00: "Icons/Lanterns/ico_equip_LT_trials_00",

    // Tonic packs (bundle SKU IDs, not catalog IDs)
    ladyluck_bundle_consumables_00: "Icons/Items/ico_qi_tonic_generic",
    ladyluck_bundle_consumables_01: "Icons/Items/ico_qi_tonic_generic",

    // Dyes
    DYE_HP08B_PUNK_02_DURABLE: "HuntpassRewards/2019_Season08b/HP8B_Dyes_entropy",
    DYE_HP11B_ENGINEER_00_DURABLE: "HuntpassRewards/2019_Season08b/HP8B_Dyes_entropy",
    DYE_GRAY02_DURABLE: "Trials/ui_trials_dye_black",
    DYE_GRAY01_DURABLE: "HuntpassRewards/ui_hp_dye_sagacity",
};

const UI_TEXTURE_ROOT = "/Game/UI/Textures/";

function TrialsProductIcon(Product: NativeTrialsProduct) {
    const Path = TrialsStoreIconPaths[Product.catalogId ?? Product.id] ?? TrialsStoreIconPaths[Product.id];
    return Path ? `${UI_TEXTURE_ROOT}${Path}.${Path.split("/").at(-1)}` : undefined;
}

const Cell = (Number: string, Name: string): NativeTrialsProduct => ({
    id: `ladyluck_cell_trials_${Number}_e`, catalogId: `CELL_TRIALS_${Number}_E`,
    displayName: `+3 ${Name} Cell`, currency: "markssteel", price: 150,
});
const Part = (CatalogId: string, Name: string, Price = 250): NativeTrialsProduct => ({
    id: `ladyluck_${CatalogId.toLowerCase()}`, catalogId: CatalogId,
    displayName: Name, currency: "markssteel", price: Price, instanced: true, oneTime: true,
});
const Cosmetic = (Id: string, CatalogId: string, Name: string, Price: number): NativeTrialsProduct => ({
    id: Id, catalogId: CatalogId, displayName: Name,
    currency: "marksgilded", price: Price, oneTime: true,
});

const NativeTrialsProducts: NativeTrialsProduct[] = [
    Cell("06", "Mender"),
    Cell("01", "Berserker"),
    Cell("04", "Sprinter"),
    Cell("02", "Strategist"),
    Cell("03", "Engineer"),
    Cell("05", "Discipline"),

    Part("PART_EB_PASSIVE_TRIALS_01", "Keen Edge"),
    Part("PART_EB_PASSIVE_TRIALS_02", "Dynamic Bladecore"),
    Part("PART_GA_PASSIVE_TRIALS_01", "Railsplitter's Canteen"),
    Part("PART_GA_PASSIVE_TRIALS_02", "Furious Axecore"),
    Part("PART_CB_PASSIVE_TRIALS_01", "Momentum Blades"),
    Part("PART_CB_PASSIVE_TRIALS_02", "Demolition Blades"),
    Part("PART_DP_PASSIVE_TRIALS_01", "Tactician's Magazine"),
    Part("PART_DP_PASSIVE_TRIALS_02", "Demolition Sights"),
    Part("PART_MS_PASSIVE_TRIALS_01", "Barbed Spearhead"),
    Part("PART_MS_PASSIVE_TRIALS_02", "Executioner's Spearhead"),

    Part("PART_GA_SPECIAL_SKILLSHOT_RESET", "Relentless Onslaught", 500),
    Part("PART_IH_SPECIAL_ISLANDCRACKER_DEFENSIVE", "Ironheart Landbreaker", 500),
    Part("PART_EB_SPECIAL_PARRY", "Avenging Overdrive", 500),
    Part("PART_CB_SPECIAL_INSATIABLE_DANCE", "Insatiable Dance", 500),
    Part("PART_MS_SPECIAL_ROCKETLUNGE", "Reckless Leap", 500),
    {id: "ladyluck_lantern_cooldown_01", catalogId: "LT_TRIALS_00", displayName: "Broadsides Lantern", displayDescription: "Strike with the full fury of the Fortunate Soul. Drop a bomb from above that explodes after a short delay and can interrupt Behemoths.", currency: "markssteel", price: 500, instanced: true, oneTime: true},

    {id: "ladyluck_core_silver_slayer", catalogId: "CONTAINER_CORE_SILVER_CELLCORE", displayName: "Silver Slayer Core", currency: "markssteel", price: 150},
    {id: "ladyluck_bundle_consumables_00", displayName: "Silver Tonic Pack", currency: "markssteel", price: 150, items: [
        {catalogId: "QI_DAMAGE_ENRAGEBONUS_POTION", quantity: 25},
        {catalogId: "QI_LANTERN_POTION", quantity: 25},
        {catalogId: "QI_ATTACK_SPEED_POTION", quantity: 25},
    ]},

    // TODO: Purchased armor does not allow equip. Possibly missing entitlement/token.
    Cosmetic("ladyluck_weapon_axe_normal", "WP_GA_TRIALS_00", "Victorious Axe", 500),
    Cosmetic("ladyluck_weapon_axe_prestige", "WP_GA_TRIALS_01", "Champion's Axe", 1000),
    Cosmetic("ladyluck_weapon_chainblade_normal", "WP_CB_TRIALS_00", "Victorious Chain Blades", 500),
    Cosmetic("ladyluck_weapon_chainblade_prestige", "WP_CB_TRIALS_01", "Champion's Chain Blades", 1000),
    Cosmetic("ladyluck_weapon_hammer_normal", "WP_IH_TRIALS_00", "Victorious Hammer", 500),
    Cosmetic("ladyluck_weapon_hammer_prestige", "WP_IH_TRIALS_01", "Champion's Hammer", 1000),
    Cosmetic("ladyluck_weapon_repeaters_normal", "WP_DP_TRIALS_00", "Victorious Repeaters", 500),
    Cosmetic("ladyluck_weapon_repeaters_prestige", "WP_DP_TRIALS_01", "Champion's Repeaters", 1000),
    Cosmetic("ladyluck_weapon_spear_normal", "WP_MS_TRIALS_00", "Victorious War Pike", 500),
    Cosmetic("ladyluck_weapon_spear_prestige", "WP_MS_TRIALS_01", "Champion's War Pike", 1000),
    Cosmetic("ladyluck_weapon_sword_normal", "WP_EB_TRIALS_00", "Victorious Sword", 500),
    Cosmetic("ladyluck_weapon_sword_prestige", "WP_EB_TRIALS_01", "Champion's Sword", 1000),
    Cosmetic("ladyluck_weapon_strikers_normal", "WP_AC_TRIALS_00", "Victorious Aether Strikers", 500),
    Cosmetic("ladyluck_weapon_strikers_prestige", "WP_AC_TRIALS_01", "Champion's Aether Strikers", 1000),
    Cosmetic("ladyluck_armor_arms", "AR_TRIALS_ARMS_00", "Victorious Gauntlets", 500),
    Cosmetic("ladyluck_armor_arms_prestige", "AR_TRIALS_ARMS_01", "Champion's Gauntlets", 1000),
    Cosmetic("ladyluck_armor_legs", "AR_TRIALS_LEGS_00", "Victorious Greaves", 500),
    Cosmetic("ladyluck_armor_legs_prestige", "AR_TRIALS_LEGS_01", "Champion's Greaves", 1000),
    Cosmetic("ladyluck_armor_helm", "AR_TRIALS_HELM_00", "Victorious Helm", 500),
    Cosmetic("ladyluck_armor_helm_prestige", "AR_TRIALS_HELM_01", "Champion's Helm", 1000),
    Cosmetic("ladyluck_armor_chest", "AR_TRIALS_CHEST_00", "Victorious Plate", 500),
    Cosmetic("ladyluck_armor_chest_prestige", "AR_TRIALS_CHEST_01", "Champion's Plate", 1000),
    Cosmetic("ladyluck_headbling_normal", "AC_HEAD_TRIALS_00", "Crown of the Victor", 500),
    Cosmetic("ladyluck_headbling_prestige", "AC_HEAD_TRIALS_01", "Crown of the Champion", 1000),
    Cosmetic("ladyluck_weapon_banner_normal", "BNC_STANDARD_TRIALS_00", "Victorious Standard", 500),
    Cosmetic("ladyluck_weapon_banner_prestige", "BNC_STANDARD_TRIALS_01", "Champion's Standard", 1000),

    {id: "ladyluck_core_gold_slayer", catalogId: "CONTAINER_CORE_GOLD_CELLCORE", displayName: "Gold Slayer Core", currency: "marksgilded", price: 150},
    {id: "ladyluck_bundle_consumables_01", displayName: "Gold Tonic Pack", currency: "marksgilded", price: 150, items: [
        {catalogId: "QI_DAMAGE_ENRAGEBONUS_POTION", quantity: 50},
        {catalogId: "QI_LANTERN_POTION", quantity: 50},
        {catalogId: "QI_ATTACK_SPEED_POTION", quantity: 50},
    ]},
    {id: "trials_dye_hp08b_punk_02", catalogId: "DYE_HP08B_PUNK_02_DURABLE", displayName: "Entropy", displayDescription: "An aether-infused dye that may be applied to many different fabrics and surfaces.", currency: "markssteel", price: 500, oneTime: true},
    {id: "trials_dye_hp11b_engineer_00", catalogId: "DYE_HP11B_ENGINEER_00_DURABLE", displayName: "Sundown", displayDescription: "An aether-infused dye that may be applied to many different fabrics and surfaces.", currency: "markssteel", price: 500, oneTime: true},
    Cosmetic("single_dye_black", "DYE_GRAY02_DURABLE", "Midnight Champion", 500),
    Cosmetic("single_dye_white", "DYE_GRAY01_DURABLE", "Sunlight Champion", 500),
];

function NativeTrialsSku(Product: NativeTrialsProduct, Index: number): StoreSku {
    const Items = Product.items ?? [{catalogId: Product.catalogId!, quantity: 1}];
    const CurrencyId = CurrencyCatalogIds[Product.currency];
    const Icon = TrialsProductIcon(Product);
    return {
        id: Product.id,
        displayName: Product.displayName,
        displayDescription: Product.displayDescription ?? `${Product.displayName} is a reward offered by Lady Luck for proving yourself in the Trials.`,
        displayPriority: Index,
        prices: [{currencyId: CurrencyId, price: Product.price, salesPrice: null, multiPrice: null}],
        ...(Product.currency === "markssteel" ? {steelMarksPrice: Product.price} : {gildedMarksPrice: Product.price}),
        maxAllowed: Product.oneTime ? 1 : null,
        remaining: Product.oneTime ? 1 : null,
        duplicateInstancedItems: Product.instanced ? Items.map((Item) => Item.catalogId) : null,
        images: Icon ? {standard: Icon} : {},
        tags: ["ladyluckstore"], scheduledTags: null,
        items: Items,
        entitlements: [], skuProgression: null, loadoutSlots: null,
        availableFrom: null, availableTo: null, timeAvailabilityReason: null,
        platformOfferId: null, missingEntitlementNames: null,
    };
}

export const LadyLuckCatalog: StoreSku[] = NativeTrialsProducts.map(NativeTrialsSku);
const PremiumSku: StoreSku = {
    id: "season09b_premium", displayName: "Elite Hunt Pass", displayDescription: "Collect more rewards while you hunt!", displayPriority: 300,
    prices: [{currencyId: "id_currency_platinum", price: 0, salesPrice: null, multiPrice: null}], maxAllowed: 1, remaining: 1,
    duplicateInstancedItems: null, images: {}, tags: ["event_pass", "huntpass_store", "season09b_pass", "season09b_store", "live", "one_time", "rarity_rare"], scheduledTags: null, items: [],
    entitlements: [{name: HUNTPASS_PREMIUM_ENTITLEMENT, duration: 0}], skuProgression: {progressionId: "season09b", xp: 0, ranks: null}, loadoutSlots: null,
    availableFrom: null, availableTo: null, timeAvailabilityReason: null, platformOfferId: null, missingEntitlementNames: null,
};
const DailyCoreSku: StoreSku = {
    id: "bundle_reward_login_daily_01", displayName: "Daily Login Bundle",
    displayDescription: "Claim this offer on a 24-hour cooldown for a kickstart of resources. ", displayPriority: 1,
    prices: [{currencyId: "id_currency_platinum", price: 0, salesPrice: null, multiPrice: null}], maxAllowed: null, remaining: null,
    duplicateInstancedItems: null, images: {}, tags: ["free", "live", "rarity_common", "fountain_daily_free_bundle"], scheduledTags: null,
    items: [{catalogId: "CONTAINER_CORE_REWARD_DAILY_01", quantity: 1}, {catalogId: "TOKEN_BOUNTY_DRAFT_PREMIUM", quantity: 4}],
    entitlements: [], skuProgression: null, loadoutSlots: null, availableFrom: null, availableTo: null, timeAvailabilityReason: null,
    platformOfferId: null, missingEntitlementNames: null,
};
const DailyCooldownId = `store:${DailyCoreSku.id}`;
const IssuedPurchaseTokens = new Map<string, {sub: string, sku: string, currency: PurchaseCurrency, exp: number, nonce: string}>();

function DecodeInventory(Row: {instancedItems: string, stackedItems: string} | undefined){
    return {
        instancedItems: Row ? JSON.parse(Row.instancedItems) as any[] : [],
        stackedItems: Row ? JSON.parse(Row.stackedItems) as any[] : [],
    };
}

function FindQuantity(StackedItems: any[], CatalogId: string){
    return StackedItems.find((Item) => Item.catalogId === CatalogId)?.quantity ?? 0;
}

async function GetPrimaryCharacterId(UserId: string){
    return (await GetDb().query.characters.findFirst({where: eq(characters.userId, UserId)}))?.characterId;
}

export async function GetBalancesForUser(UserId: string){
    const User = await GetDb().query.users.findFirst({where: eq(users.userId, UserId)});
    const CharacterId = await GetPrimaryCharacterId(UserId);
    const Row = CharacterId ? await GetDb().query.inventory.findFirst({where: eq(inventory.characterId, CharacterId)}) : undefined;
    const {stackedItems} = DecodeInventory(Row);
    return {
        CURRENCY_NOTES: FindQuantity(stackedItems, "CURRENCY_NOTES") || User?.notes || 0,
        CURRENCY_MARKS_STEEL: FindQuantity(stackedItems, "CURRENCY_MARKS_STEEL"),
        CURRENCY_MARKS_GILDED: FindQuantity(stackedItems, "CURRENCY_MARKS_GILDED"),
    };
}

export async function GetNotesForUser(UserId: string){
    return (await GetBalancesForUser(UserId)).CURRENCY_NOTES;
}

export async function GetLadyLuckCatalog(UserId: string){
    const CharacterId = await GetPrimaryCharacterId(UserId);
    const Row = CharacterId ? await GetDb().query.inventory.findFirst({where: eq(inventory.characterId, CharacterId)}) : undefined;
    const Current = DecodeInventory(Row);
    if(Row && ReconcileTrialsCosmeticOwnership(Current.instancedItems, Current.stackedItems)){
        await GetDb().update(inventory).set({
            instancedItems: JSON.stringify(Current.instancedItems),
            stackedItems: JSON.stringify(Current.stackedItems),
        }).where(eq(inventory.characterId, CharacterId!));
    }
    const Owned = new Set([
        ...Current.instancedItems.map((Item) => Item.catalogId),
        ...Current.stackedItems.filter((Item) => Item.quantity > 0).map((Item) => Item.catalogId),
    ]);

    return LadyLuckCatalog.map((Sku) => {
        if(Sku.maxAllowed == null) return {...Sku};
        const IsOwned = Sku.items.some((Item) => Owned.has(Item.catalogId))
            || (Sku.duplicateInstancedItems ?? []).some((CatalogId) => Owned.has(CatalogId));
        return {...Sku, remaining: IsOwned ? 0 : Sku.maxAllowed};
    });
}

export async function GetStoreCatalog(UserId: string, Tags: string[]){
    if(Tags.includes("ladyluckstore")) return GetLadyLuckCatalog(UserId);
    if(Tags.includes("huntpass_store") || Tags.includes("season09b_pass")){
        const Owned = await GetDb().query.entitlements.findFirst({where: and(eq(entitlements.userId, UserId), eq(entitlements.entitlement, HUNTPASS_PREMIUM_ENTITLEMENT))});
        return [{...PremiumSku, remaining: Owned ? 0 : 1}];
    }
    if(Tags.includes("fountain_daily_free_bundle")){
        const Active = await GetDb().query.cooldowns.findFirst({where: and(eq(cooldowns.userId, UserId), eq(cooldowns.cooldownId, DailyCooldownId))});
        return [{...DailyCoreSku, timeAvailabilityReason: Active && Active.expiresAt > new Date().toISOString() ? "Cooldown" : null}];
    }
    return undefined;
}

function CurrencyForSku(Sku: StoreSku): PurchaseCurrency | undefined {
    if(Sku.prices[0]?.currencyId === CurrencyCatalogIds.markssteel) return "markssteel";
    if(Sku.prices[0]?.currencyId === CurrencyCatalogIds.marksgilded) return "marksgilded";
    if(Sku.prices[0]?.currencyId === CurrencyCatalogIds.platinum) return "platinum";
    return undefined;
}

export function CreatePurchaseToken(UserId: string, SkuId: string, Currency?: PurchaseCurrency){
    const Sku = [...LadyLuckCatalog, PremiumSku, DailyCoreSku].find((Candidate) => Candidate.id === SkuId || Candidate.items.some((Item) => Item.catalogId === SkuId));
    const RequiredCurrency = Sku ? CurrencyForSku(Sku) : undefined;
    if(!Sku || !RequiredCurrency || (Currency != null && Currency !== RequiredCurrency)) return undefined;
    const Payload = {sub: UserId, sku: Sku.id, currency: RequiredCurrency, exp: Date.now() + 5 * 60_000, nonce: randomBytes(12).toString("hex")};
    const Token = Buffer.from(JSON.stringify(Payload)).toString("base64url");
    IssuedPurchaseTokens.set(Token, Payload);
    return Token;
}

export type PurchaseResult = {success: true} | {success: false, error: "invalid_token" | "currency_mismatch" | "not_found" | "no_character" | "already_owned" | "insufficient_funds" | "db_error"};

export async function PurchaseFromToken(UserId: string, Token: string, Currency?: PurchaseCurrency): Promise<PurchaseResult>{
    let Payload: any;
    try { Payload = JSON.parse(Buffer.from(Token, "base64url").toString("utf8")); }
    catch { return {success: false, error: "invalid_token"}; }
    const Issued = IssuedPurchaseTokens.get(Token);
    if(!Issued || Payload?.sub !== Issued.sub || Payload?.sku !== Issued.sku || Payload?.currency !== Issued.currency || Payload?.exp !== Issued.exp || Payload?.nonce !== Issued.nonce
        || Payload.sub !== UserId || Payload.exp < Date.now()){
        if(Payload?.exp < Date.now()) IssuedPurchaseTokens.delete(Token);
        return {success: false, error: "invalid_token"};
    }
    if(Currency != null && Payload.currency !== Currency) return {success: false, error: "currency_mismatch"};

    const Sku = [...LadyLuckCatalog, PremiumSku, DailyCoreSku].find((Candidate) => Candidate.id === Payload.sku);
    if(!Sku) return {success: false, error: "not_found"};
    if(CurrencyForSku(Sku) !== Payload.currency) return {success: false, error: "currency_mismatch"};
    const CharacterId = await GetPrimaryCharacterId(UserId);
    if(!CharacterId && Sku.id !== PremiumSku.id) return {success: false, error: "no_character"};

    try {
        const Result = GetDb().transaction((Tx) => {
            const DateValue = new Date().toISOString();
            if(Sku.id === PremiumSku.id){
                const Existing = Tx.query.entitlements.findFirst({where: and(eq(entitlements.userId, UserId), eq(entitlements.entitlement, HUNTPASS_PREMIUM_ENTITLEMENT))}).sync();
                if(Existing) return {success: false, error: "already_owned"} as PurchaseResult;
                Tx.insert(entitlements).values({userId: UserId, entitlement: HUNTPASS_PREMIUM_ENTITLEMENT, grantedDate: DateValue, expiresAt: null}).run();
                return {success: true} as PurchaseResult;
            }
            if(Sku.id === DailyCoreSku.id){
                const Existing = Tx.query.cooldowns.findFirst({where: and(eq(cooldowns.userId, UserId), eq(cooldowns.cooldownId, DailyCooldownId))}).sync();
                if(Existing && Existing.expiresAt > DateValue) return {success: false, error: "already_owned"} as PurchaseResult;
            }
            const Row = Tx.query.inventory.findFirst({where: eq(inventory.characterId, CharacterId!)}).sync();
            const Current = DecodeInventory(Row);
            ReconcileTrialsCosmeticOwnership(Current.instancedItems, Current.stackedItems);
            const Owned = new Set([...Current.instancedItems.map((Item) => Item.catalogId), ...Current.stackedItems.filter((Item) => Item.quantity > 0).map((Item) => Item.catalogId)]);
            if(Sku.maxAllowed != null && (Sku.items.some((Item) => Owned.has(Item.catalogId)) || (Sku.duplicateInstancedItems ?? []).some((Id) => Owned.has(Id)))){
                return {success: false, error: "already_owned"} as PurchaseResult;
            }

            const Price = Sku.prices[0];
            const CurrencyId = CurrencyAliases[Price.currencyId] ?? Price.currencyId.toUpperCase();
            if(Price.price > 0){
                const CurrencyItem = Current.stackedItems.find((Item) => Item.catalogId === CurrencyId);
                if(!CurrencyItem || CurrencyItem.quantity < Price.price) return {success: false, error: "insufficient_funds"} as PurchaseResult;
                CurrencyItem.quantity -= Price.price;
            }

            for(const Item of Sku.items){
                const IsInstanced = (Sku.duplicateInstancedItems ?? []).includes(Item.catalogId);
                if(IsInstanced){
                    Current.instancedItems.push({catalogId: Item.catalogId, instanceId: randomBytes(16).toString("base64url").toUpperCase(), itemData: null, updateVersion: 0});
                }
                else {
                    const Existing = Current.stackedItems.find((Candidate) => Candidate.catalogId === Item.catalogId);
                    if(Existing) Existing.quantity += Item.quantity;
                    else Current.stackedItems.push({...Item});
                }
            }

            const Values = {characterId: CharacterId!, instancedItems: JSON.stringify(Current.instancedItems), stackedItems: JSON.stringify(Current.stackedItems)};
            if(Row) Tx.update(inventory).set(Values).where(eq(inventory.characterId, CharacterId!)).run();
            else Tx.insert(inventory).values(Values).run();
            if(Sku.id === DailyCoreSku.id){
                const ExpiresAt = new Date(Date.parse(DateValue) + 24 * 60 * 60_000).toISOString();
                Tx.insert(cooldowns).values({userId: UserId, cooldownId: DailyCooldownId, expiresAt: ExpiresAt, createdDate: DateValue})
                    .onConflictDoUpdate({target: [cooldowns.userId, cooldowns.cooldownId], set: {expiresAt: ExpiresAt, createdDate: DateValue}}).run();
            }
            return {success: true} as PurchaseResult;
        });
        if(Result.success) IssuedPurchaseTokens.delete(Token);
        return Result;
    }
    catch { return {success: false, error: "db_error"}; }
}
