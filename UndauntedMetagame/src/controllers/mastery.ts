import { and, eq, sql } from "drizzle-orm";
import { GetDb } from "../db";
import { progressionobjectives, progressiontracks } from "../db/schema";
import progressionConfig from "../vendor/progression_config.json";

type Track = typeof progressiontracks.$inferSelect;
type Objective = typeof progressionobjectives.$inferSelect;
type TrackWireRow = Pick<Track, "progressionId" | "progress" | "confirmedFreemiumRank" | "confirmedPremiumRank" | "confirmedDate">;

const Now = () => new Date().toISOString();
const ConfiguredPaths = progressionConfig.payload.paths as { progression_id: string; requirements?: { rank_id: number; xp_required: number }[] }[];
const ConfiguredIds = ConfiguredPaths.map(({ progression_id }) => progression_id);
const ConfiguredIdSet = new Set(ConfiguredIds);
const RequirementsByTrack = new Map<string, { rank_id: number; xp_required: number }[]>();
for (const path of ConfiguredPaths) if (!RequirementsByTrack.has(path.progression_id)) RequirementsByTrack.set(path.progression_id, path.requirements ?? []);
const TrackKey = (userId: string, progressionId: string) => and(eq(progressiontracks.userId, userId), eq(progressiontracks.progressionId, progressionId));
const ObjectiveKey = (userId: string, objectiveId: string) => and(eq(progressionobjectives.userId, userId), eq(progressionobjectives.objectiveId, objectiveId));
export type MasteryObjectiveUpdate = { objectiveId: string; value: number; completedCount: number };
export type MasteryTrackEvent = { track: string; amount: number };
export type MasteryUpdate = { objectives: MasteryObjectiveUpdate[]; progressEvents: MasteryTrackEvent[] };
export type MasteryTrackSnapshot = { track: string; progress: number };
export type MasterySnapshot = { objectives: MasteryObjectiveUpdate[]; progressTracks: MasteryTrackSnapshot[] };
export type MasteryApplyResult = { applied: boolean; duplicate: boolean };
export type MasteryGrantResponse = {
    progress_tracks: ReturnType<typeof TrackWire>[];
    objectives: ReturnType<typeof ObjectiveWire>[];
};

export function Envelope(payload: unknown) { return { code: null, message: "OK", payload }; }
export function TrackWire(userId: string, track: TrackWireRow | undefined) {
    const row = track as TrackWireRow;
    return { phx_account_id: userId, progression_id: row.progressionId, progress: row.progress, confirmed_fremium_rank: row.confirmedFreemiumRank, confirmed_premium_rank: row.confirmedPremiumRank, confirmed_date: row.confirmedDate };
}
export function ZeroTrackWire(userId: string, progressionId: string) { return { phx_account_id: userId, progression_id: progressionId, progress: 0, confirmed_fremium_rank: 0, confirmed_premium_rank: 0, confirmed_date: null }; }
export function ConfiguredTrackIds() { return [...ConfiguredIds]; }
export function RankForTrackProgress(progressionId: string, progress: number) {
    return (RequirementsByTrack.get(progressionId) ?? []).reduce((rank, requirement) => progress >= requirement.xp_required ? Math.max(rank, requirement.rank_id) : rank, 0);
}
export function ObjectiveWire(userId: string, objective: Objective) { return { phx_account_id: userId, objective_id: objective.objectiveId, progress: objective.progress, completed_count: objective.completedCount, created_date: objective.createdDate, last_modified_date: objective.lastModifiedDate }; }
export function ZeroObjectiveWire(userId: string, objectiveId: string) { const now = Now(); return { phx_account_id: userId, objective_id: objectiveId, progress: 0, completed_count: 0, created_date: now, last_modified_date: now }; }

export async function GetTracks(userId: string, progressionId?: string) {
    const db = GetDb();
    const rows = progressionId ? await db.query.progressiontracks.findMany({ where: TrackKey(userId, progressionId) }) : await db.query.progressiontracks.findMany({ where: eq(progressiontracks.userId, userId) });
    if (progressionId !== undefined) return rows.length ? rows.map((row) => TrackWire(userId, row)) : [ZeroTrackWire(userId, progressionId)];

    const persisted = new Map(rows.map((row) => [row.progressionId, TrackWire(userId, row)]));
    const configured = ConfiguredIds.map((id) => persisted.get(id) ?? ZeroTrackWire(userId, id));
    const additional = [...persisted].filter(([id]) => !ConfiguredIdSet.has(id)).map(([, track]) => track);
    return [...configured, ...additional];
}
export async function GetObjectives(userId: string, objectiveId?: string) {
    const db = GetDb();
    const rows = objectiveId ? await db.query.progressionobjectives.findMany({ where: ObjectiveKey(userId, objectiveId) }) : await db.query.progressionobjectives.findMany({ where: eq(progressionobjectives.userId, userId) });
    return rows.map((row) => ObjectiveWire(userId, row));
}
export async function GetMasteryGrantResponse(userId: string, trackIds: string[], objectiveIds: string[]): Promise<MasteryGrantResponse> {
    const tracksById = new Map((await GetTracks(userId)).map((track) => [track.progression_id, track]));
    const objectivesById = new Map((await GetObjectives(userId)).map((objective) => [objective.objective_id, objective]));
    return {
        progress_tracks: [...new Set(trackIds)].map((id) => tracksById.get(id)).filter((track) => track !== undefined),
        objectives: [...new Set(objectiveIds)].map((id) => objectivesById.get(id)).filter((objective) => objective !== undefined)
    };
}
export async function ApplyTrackGrant(userId: string, progressionId: string, amount: number) {
    const db = GetDb(); const existing = await db.query.progressiontracks.findFirst({ where: TrackKey(userId, progressionId) }); const now = Now();
    const progress = Math.max(0, (existing?.progress ?? 0) + amount);
    const track: TrackWireRow = existing ? { progressionId, progress, confirmedFreemiumRank: existing.confirmedFreemiumRank, confirmedPremiumRank: existing.confirmedPremiumRank, confirmedDate: existing.confirmedDate } : { progressionId, progress, confirmedFreemiumRank: 0, confirmedPremiumRank: 0, confirmedDate: null };
    if (existing) await db.update(progressiontracks).set({ progress, lastModifiedDate: now }).where(TrackKey(userId, progressionId));
    else await db.insert(progressiontracks).values({ userId, progressionId, progress, lastModifiedDate: now });
    return TrackWire(userId, track);
}
export async function ConfirmTrack(userId: string, progressionId: string, rank: number, kind: string) {
    const db = GetDb(); const existing = await db.query.progressiontracks.findFirst({ where: TrackKey(userId, progressionId) }); const now = Now(); const premium = kind.toLowerCase().includes("premium");
    const confirmedFreemiumRank = premium ? existing?.confirmedFreemiumRank ?? 0 : Math.max(existing?.confirmedFreemiumRank ?? 0, rank);
    const confirmedPremiumRank = premium ? Math.max(existing?.confirmedPremiumRank ?? 0, rank) : existing?.confirmedPremiumRank ?? 0;
    const track: TrackWireRow = { progressionId, progress: existing?.progress ?? 0, confirmedFreemiumRank, confirmedPremiumRank, confirmedDate: now };
    if (existing) await db.update(progressiontracks).set({ confirmedFreemiumRank, confirmedPremiumRank, confirmedDate: now, lastModifiedDate: now }).where(TrackKey(userId, progressionId));
    else await db.insert(progressiontracks).values({ userId, progressionId, confirmedFreemiumRank, confirmedPremiumRank, confirmedDate: now, lastModifiedDate: now });
    return TrackWire(userId, track);
}
export async function ApplyObjective(userId: string, objectiveId: string, progress: number, completedCount = 0) {
    const db = GetDb(); const existing = await db.query.progressionobjectives.findFirst({ where: ObjectiveKey(userId, objectiveId) }); const now = Now();
    const storedProgress = Math.max(existing?.progress ?? 0, progress); const storedCompletedCount = Math.max(existing?.completedCount ?? 0, completedCount);
    const objective: Objective = existing ? { ...existing, progress: storedProgress, completedCount: storedCompletedCount, lastModifiedDate: now } : { userId, objectiveId, progress: storedProgress, completedCount: storedCompletedCount, createdDate: now, lastModifiedDate: now };
    if (existing) await db.update(progressionobjectives).set({ progress: storedProgress, completedCount: storedCompletedCount, lastModifiedDate: now }).where(ObjectiveKey(userId, objectiveId));
    else await db.insert(progressionobjectives).values(objective);
    return ObjectiveWire(userId, objective);
}

function ApplyObjectives(tx: any, userId: string, objectives: MasteryObjectiveUpdate[], now: string) {
    const aggregated = new Map<string, MasteryObjectiveUpdate>();
    for (const incoming of objectives) {
        const current = aggregated.get(incoming.objectiveId);
        aggregated.set(incoming.objectiveId, current ? {
            objectiveId: incoming.objectiveId,
            value: Math.max(current.value, incoming.value),
            completedCount: Math.max(current.completedCount, incoming.completedCount)
        } : incoming);
    }
    if (!aggregated.size) return;

    tx.insert(progressionobjectives).values([...aggregated.values()].map((objective) => ({
        userId, objectiveId: objective.objectiveId, progress: objective.value,
        completedCount: objective.completedCount, createdDate: now, lastModifiedDate: now
    }))).onConflictDoUpdate({
        target: [progressionobjectives.userId, progressionobjectives.objectiveId],
        set: {
            progress: sql`max(${progressionobjectives.progress}, excluded.progress)`,
            completedCount: sql`max(${progressionobjectives.completedCount}, excluded.completedCount)`,
            lastModifiedDate: now
        },
        setWhere: sql`excluded.progress > ${progressionobjectives.progress} OR excluded.completedCount > ${progressionobjectives.completedCount}`
    }).run();
}

function ApplyTracks(tx: any, userId: string, tracks: { track: string; value: number }[], now: string, delta: boolean) {
    const aggregated = new Map<string, number>();
    for (const incoming of tracks) aggregated.set(incoming.track, delta
        ? (aggregated.get(incoming.track) ?? 0) + incoming.value
        : Math.max(aggregated.get(incoming.track) ?? 0, incoming.value));
    if (!aggregated.size) return;
    tx.insert(progressiontracks).values([...aggregated].map(([progressionId, progress]) => ({
        userId, progressionId, progress, lastModifiedDate: now
    }))).onConflictDoUpdate({
        target: [progressiontracks.userId, progressiontracks.progressionId],
        set: {
            progress: delta ? sql`${progressiontracks.progress} + excluded.progress` : sql`max(${progressiontracks.progress}, excluded.progress)`,
            lastModifiedDate: now
        },
        setWhere: delta ? sql`excluded.progress != 0` : sql`excluded.progress > ${progressiontracks.progress}`
    }).run();
}

export function ApplyMasteryUpdate(userId: string, update: MasteryUpdate) {
    return GetDb().transaction((tx) => {
        const now = Now();
        ApplyObjectives(tx, userId, update.objectives, now);
        ApplyTracks(tx, userId, update.progressEvents.map(({ track, amount }) => ({ track, value: amount })), now, true);
        return { applied: true, duplicate: false } satisfies MasteryApplyResult;
    });
}

export function ApplyMasterySnapshot(userId: string, snapshot: MasterySnapshot) {
    return GetDb().transaction((tx) => {
        const now = Now();
        ApplyObjectives(tx, userId, snapshot.objectives, now);
        ApplyTracks(tx, userId, snapshot.progressTracks.map(({ track, progress }) => ({ track, value: progress })), now, false);
        return { applied: true, duplicate: false } satisfies MasteryApplyResult;
    });
}

export async function DeleteTrack(userId: string, progressionId: string) { await GetDb().delete(progressiontracks).where(TrackKey(userId, progressionId)); }
