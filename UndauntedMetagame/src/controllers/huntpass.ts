import { and, eq, gt } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { GetDb } from "../db";
import { characters, cooldowns, entitlements, inventory, progressiontracks } from "../db/schema";
import progressionConfig from "../vendor/progression_config.json";

export const ACTIVE_HUNTPASS = "season09b";
export const HUNTPASS_PREMIUM_ENTITLEMENT = "season09b_premium";
const Now = () => new Date().toISOString();
const TrackKey = (userId: string) => and(eq(progressiontracks.userId, userId), eq(progressiontracks.progressionId, ACTIVE_HUNTPASS));
const Config = (progressionConfig.payload.paths as any[]).find((Path) => Path.progression_id === ACTIVE_HUNTPASS)!;
const RankRequirements = [...(Config.requirements ?? [])]
    .filter((Requirement: any) => Number(Requirement.rank_id) > 0)
    .sort((Left: any, Right: any) => Number(Left.rank_id) - Number(Right.rank_id));

function NextUtcDay(DateValue = new Date()) {
    return new Date(Date.UTC(DateValue.getUTCFullYear(), DateValue.getUTCMonth(), DateValue.getUTCDate() + 1)).toISOString();
}

export function HuntPassRank(Progress: number) {
    let RemainingXp = Math.max(0, Progress);
    let Rank = 0;

    for(const Requirement of RankRequirements){
        const RequiredXp = Math.max(0, Number(Requirement.xp_required ?? 0));
        if(RemainingXp < RequiredXp) return Rank;
        RemainingXp -= RequiredXp;
        Rank = Number(Requirement.rank_id);
    }

    const PrestigeXp = Number(Config.prestige?.xp_per_level ?? 0);
    return PrestigeXp > 0 ? Rank + Math.floor(RemainingXp / PrestigeXp) : Rank;
}

function Decode(Row: {instancedItems: string, stackedItems: string} | undefined) {
    return { instanced: Row ? JSON.parse(Row.instancedItems) as any[] : [], stacked: Row ? JSON.parse(Row.stackedItems) as any[] : [] };
}

function AddStacked(Stacked: any[], CatalogId: string, Quantity: number) {
    const Existing = Stacked.find((Item) => Item.catalogId === CatalogId);
    if(Existing) Existing.quantity += Quantity;
    else Stacked.push({catalogId: CatalogId, quantity: Quantity});
}

function GrantEntitlement(Tx: any, UserId: string, Reward: any, DateValue: string) {
    const Name = Reward.entitlement ?? Reward.name;
    if(typeof Name !== "string" || !Name) return;
    const Duration = Number(Reward.duration ?? 0);
    const ExpiresAt = Duration > 0 ? new Date(Date.parse(DateValue) + Duration * 60 * 60_000).toISOString() : null;
    Tx.insert(entitlements).values({userId: UserId, entitlement: Name, grantedDate: DateValue, expiresAt: ExpiresAt})
        .onConflictDoUpdate({target: [entitlements.userId, entitlements.entitlement], set: {grantedDate: DateValue, expiresAt: ExpiresAt}}).run();
}

export function StartCooldown(UserId: string, CooldownId: string) {
    if(!CooldownId) return {success: false as const, error: "invalid_cooldown" as const};
    return GetDb().transaction((Tx) => {
        const DateValue = Now();
        const Existing = Tx.query.cooldowns.findFirst({where: and(eq(cooldowns.userId, UserId), eq(cooldowns.cooldownId, CooldownId))}).sync();
        if(Existing && Existing.expiresAt > DateValue) return {success: true as const, applied: false, expiresAt: Existing.expiresAt};
        const ExpiresAt = NextUtcDay();
        Tx.insert(cooldowns).values({userId: UserId, cooldownId: CooldownId, expiresAt: ExpiresAt, createdDate: DateValue})
            .onConflictDoUpdate({target: [cooldowns.userId, cooldowns.cooldownId], set: {expiresAt: ExpiresAt, createdDate: DateValue}}).run();
        return {success: true as const, applied: true, expiresAt: ExpiresAt};
    });
}

export async function GetActiveCooldowns(UserId: string) {
    const DateValue = Now();
    return (await GetDb().query.cooldowns.findMany({where: and(eq(cooldowns.userId, UserId), gt(cooldowns.expiresAt, DateValue))}))
        .reduce<Record<string, string>>((Result, Row) => { Result[Row.cooldownId] = Row.expiresAt; return Result; }, {});
}

export async function GetEntitlements(UserId: string) {
    const DateValue = Now();
    return (await GetDb().query.entitlements.findMany({where: eq(entitlements.userId, UserId)}))
        .filter((Entry) => Entry.expiresAt == null || Entry.expiresAt > DateValue)
        .map((Entry) => ({entitlement: Entry.entitlement, granted_date: Entry.grantedDate, expiration_date: Entry.expiresAt}));
}

export function ClaimHuntPass(UserId: string, RequestedRank: number, Kind: string) {
    const Premium = Kind.toLowerCase().includes("premium");
    if(!Number.isSafeInteger(RequestedRank) || RequestedRank < 0) return {success: false as const, error: "invalid_rank" as const};
    return GetDb().transaction((Tx) => {
        const Track = Tx.query.progressiontracks.findFirst({where: TrackKey(UserId)}).sync();
        const CurrentTrack = Track ?? {
            progressionId: ACTIVE_HUNTPASS,
            progress: 0,
            confirmedFreemiumRank: 0,
            confirmedPremiumRank: 0,
            confirmedDate: null
        };
        const EarnedRank = HuntPassRank(CurrentTrack.progress);
        if(RequestedRank > EarnedRank) return {success: false as const, error: "rank_not_earned" as const};
        if(Premium && !Tx.query.entitlements.findFirst({where: and(eq(entitlements.userId, UserId), eq(entitlements.entitlement, HUNTPASS_PREMIUM_ENTITLEMENT))}).sync())
            return {success: false as const, error: "premium_required" as const};
        const Confirmed = Premium ? CurrentTrack.confirmedPremiumRank : CurrentTrack.confirmedFreemiumRank;
        if(RequestedRank <= Confirmed) return {success: true as const, claimed: false, track: CurrentTrack};
        const Character = Tx.query.characters.findFirst({where: eq(characters.userId, UserId)}).sync();
        if(!Character) return {success: false as const, error: "no_character" as const};
        const Row = Tx.query.inventory.findFirst({where: eq(inventory.characterId, Character.characterId)}).sync();
        const Items = Decode(Row);
        const Rewards = Premium ? Config.premium_rewards : Config.free_rewards;
        const DateValue = Now();
        for(let Rank = Confirmed + 1; Rank <= RequestedRank; ++Rank) {
            if(Rank > 50){
                const PrestigeReward = Premium ? Config.prestige?.premium_rewards : Config.prestige?.free_rewards;
                for(const Item of PrestigeReward?.stacked_items ?? []) AddStacked(Items.stacked, Item.catalog_id, Number(Item.quantity ?? 1));
                for(const RewardEntitlement of PrestigeReward?.entitlements ?? []) GrantEntitlement(Tx, UserId, RewardEntitlement, DateValue);
                continue;
            }
            const Reward = Rewards.find((Entry: any) => Entry.rank_id === Rank);
            if(!Reward) continue;
            for(const Item of Reward.stacked_items ?? []) AddStacked(Items.stacked, Item.catalog_id, Number(Item.quantity ?? 1));
            for(const CatalogId of [...(Reward.instanced_items ?? []), ...(Reward.ordered_instanced_items ?? [])])
                Items.instanced.push({catalogId: typeof CatalogId === "string" ? CatalogId : CatalogId.catalog_id, instanceId: randomBytes(16).toString("base64url").toUpperCase(), itemData: null, updateVersion: 0});
            for(const RewardEntitlement of Reward.entitlements ?? []) GrantEntitlement(Tx, UserId, RewardEntitlement, DateValue);
        }
        const Values = {characterId: Character.characterId, instancedItems: JSON.stringify(Items.instanced), stackedItems: JSON.stringify(Items.stacked)};
        if(Row) Tx.update(inventory).set(Values).where(eq(inventory.characterId, Character.characterId)).run();
        else Tx.insert(inventory).values(Values).run();
        const TrackValues = Premium
            ? {confirmedPremiumRank: RequestedRank, confirmedDate: DateValue, lastModifiedDate: DateValue}
            : {confirmedFreemiumRank: RequestedRank, confirmedDate: DateValue, lastModifiedDate: DateValue};
        if(Track) Tx.update(progressiontracks).set(TrackValues).where(TrackKey(UserId)).run();
        else Tx.insert(progressiontracks).values({userId: UserId, progressionId: ACTIVE_HUNTPASS, ...TrackValues}).run();
        return {success: true as const, claimed: true, track: Tx.query.progressiontracks.findFirst({where: TrackKey(UserId)}).sync()};
    });
}
