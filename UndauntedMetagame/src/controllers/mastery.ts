import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { GetDb } from "../db";
import { progressionobjectives, progressionreceipts, progressiontracks } from "../db/schema";
import progressionConfig from "../vendor/progression_config.json";

const Now = () => new Date().toISOString();
const ConfiguredPaths = progressionConfig.payload.paths as { progression_id: string; requirements?: { rank_id: number; xp_required: number }[] }[];
const TrackKey = (userId: string, progressionId: string) => and(eq(progressiontracks.userId, userId), eq(progressiontracks.progressionId, progressionId));
const ObjectiveKey = (userId: string, objectiveId: string) => and(eq(progressionobjectives.userId, userId), eq(progressionobjectives.objectiveId, objectiveId));

export type MasteryObjectiveUpdate = { objectiveId: string; value: number; completedCount: number };
export type MasteryTrackEvent = { track: string; amount: number };
export type MasteryUpdate = { objectives: MasteryObjectiveUpdate[]; progressEvents: MasteryTrackEvent[] };
export type MasteryTrackSnapshot = { track: string; progress: number };
export type MasterySnapshot = { objectives: MasteryObjectiveUpdate[]; progressTracks: MasteryTrackSnapshot[] };

export function Envelope(payload: unknown) { return { code: null, message: "OK", payload }; }
export function TrackWire(userId: string, track: any) {
    return { phx_account_id: userId, progression_id: track.progressionId, progress: track.progress, confirmed_fremium_rank: track.confirmedFreemiumRank, confirmed_premium_rank: track.confirmedPremiumRank, confirmed_date: track.confirmedDate };
}
export function ZeroTrackWire(userId: string, progressionId: string) {
    return { phx_account_id: userId, progression_id: progressionId, progress: 0, confirmed_fremium_rank: 0, confirmed_premium_rank: 0, confirmed_date: null };
}
export function ConfiguredTrackIds() { return ConfiguredPaths.map((path) => path.progression_id); }
export function RankForTrackProgress(progressionId: string, progress: number) {
    const requirements = ConfiguredPaths.find((path) => path.progression_id === progressionId)?.requirements ?? [];
    return requirements.reduce((rank, requirement) => progress >= requirement.xp_required ? Math.max(rank, requirement.rank_id) : rank, 0);
}
export function ObjectiveWire(userId: string, objective: any) {
    return { phx_account_id: userId, objective_id: objective.objectiveId, progress: objective.progress, completed_count: objective.completedCount, created_date: objective.createdDate, last_modified_date: objective.lastModifiedDate };
}

// Missing objectives start at zero.
export function ZeroObjectiveWire(userId: string, objectiveId: string) {
    const now = Now();
    return { phx_account_id: userId, objective_id: objectiveId, progress: 0, completed_count: 0, created_date: now, last_modified_date: now };
}

export async function GetTracks(userId: string, progressionId?: string) {
    const rows = progressionId ? await GetDb().query.progressiontracks.findMany({ where: TrackKey(userId, progressionId) }) : await GetDb().query.progressiontracks.findMany({ where: eq(progressiontracks.userId, userId) });
    if (progressionId != undefined) return rows.length > 0 ? rows.map((row) => TrackWire(userId, row)) : [ZeroTrackWire(userId, progressionId)];

    // Fresh accounts still need every configured track at zero.
    const persisted = new Map(rows.map((row) => [row.progressionId, TrackWire(userId, row)]));
    const configuredIds = ConfiguredTrackIds();
    const configured = configuredIds.map((id) => persisted.get(id) ?? ZeroTrackWire(userId, id));
    const additional = [...persisted.entries()].filter(([id]) => !configuredIds.includes(id)).map(([, track]) => track);
    return [...configured, ...additional];
}
export async function GetObjectives(userId: string, objectiveId?: string) {
    const rows = objectiveId ? await GetDb().query.progressionobjectives.findMany({ where: ObjectiveKey(userId, objectiveId) }) : await GetDb().query.progressionobjectives.findMany({ where: eq(progressionobjectives.userId, userId) });
    return rows.map((row) => ObjectiveWire(userId, row));
}
export async function ApplyTrackGrant(userId: string, progressionId: string, amount: number) {
    const existing = await GetDb().query.progressiontracks.findFirst({ where: TrackKey(userId, progressionId) });
    const now = Now();
    if (existing == undefined) await GetDb().insert(progressiontracks).values({ userId, progressionId, progress: Math.max(0, amount), lastModifiedDate: now });
    else await GetDb().update(progressiontracks).set({ progress: Math.max(0, existing.progress + amount), lastModifiedDate: now }).where(TrackKey(userId, progressionId));
    return (await GetTracks(userId, progressionId))[0];
}
export async function ConfirmTrack(userId: string, progressionId: string, rank: number, kind: string) {
    const existing = await GetDb().query.progressiontracks.findFirst({ where: TrackKey(userId, progressionId) });
    const now = Now(); const premium = kind.toLowerCase().includes("premium");
    if (existing == undefined) await GetDb().insert(progressiontracks).values({ userId, progressionId, confirmedFreemiumRank: premium ? 0 : rank, confirmedPremiumRank: premium ? rank : 0, confirmedDate: now, lastModifiedDate: now });
    else await GetDb().update(progressiontracks).set({ confirmedFreemiumRank: premium ? existing.confirmedFreemiumRank : Math.max(existing.confirmedFreemiumRank, rank), confirmedPremiumRank: premium ? Math.max(existing.confirmedPremiumRank, rank) : existing.confirmedPremiumRank, confirmedDate: now, lastModifiedDate: now }).where(TrackKey(userId, progressionId));
    return (await GetTracks(userId, progressionId))[0];
}
export async function ApplyObjective(userId: string, objectiveId: string, progress: number, completedCount = 0) {
    const existing = await GetDb().query.progressionobjectives.findFirst({ where: ObjectiveKey(userId, objectiveId) }); const now = Now();
    if (existing == undefined) await GetDb().insert(progressionobjectives).values({ userId, objectiveId, progress: Math.max(0, progress), completedCount: Math.max(0, completedCount), createdDate: now, lastModifiedDate: now });
    else await GetDb().update(progressionobjectives).set({ progress: Math.max(existing.progress, progress), completedCount: Math.max(existing.completedCount, completedCount), lastModifiedDate: now }).where(ObjectiveKey(userId, objectiveId));
    return (await GetObjectives(userId, objectiveId))[0];
}

// Apply XP only when an objective moves forward, so retries are safe.
export function ApplyMasteryUpdate(userId: string, update: MasteryUpdate) {
    return GetDb().transaction((tx) => {
        const now = Now();
        const advanced: MasteryObjectiveUpdate[] = [];

        for (const objective of update.objectives) {
            const existing = tx.query.progressionobjectives.findFirst({ where: ObjectiveKey(userId, objective.objectiveId) }).sync();
            const nextProgress = Math.max(0, objective.value);
            const nextCompletedCount = Math.max(0, objective.completedCount);
            if (existing != undefined && existing.progress >= nextProgress && existing.completedCount >= nextCompletedCount) continue;

            if (existing == undefined) {
                tx.insert(progressionobjectives).values({ userId, objectiveId: objective.objectiveId, progress: nextProgress, completedCount: nextCompletedCount, createdDate: now, lastModifiedDate: now }).run();
            } else {
                tx.update(progressionobjectives).set({ progress: Math.max(existing.progress, nextProgress), completedCount: Math.max(existing.completedCount, nextCompletedCount), lastModifiedDate: now }).where(ObjectiveKey(userId, objective.objectiveId)).run();
            }
            advanced.push(objective);
        }

        if (advanced.length === 0) return { advanced: false, advancedObjectiveIds: [] as string[], appliedTracks: [] as string[] };

        const fingerprint = createHash("sha256").update(JSON.stringify({ objectives: advanced, progressEvents: update.progressEvents })).digest("hex");
        const prior = tx.query.progressionreceipts.findFirst({ where: and(eq(progressionreceipts.userId, userId), eq(progressionreceipts.fingerprint, fingerprint)) }).sync();
        if (prior != undefined) return { advanced: false, advancedObjectiveIds: [] as string[], appliedTracks: [] as string[] };

        const appliedTracks: string[] = [];
        for (const event of update.progressEvents) {
            const existing = tx.query.progressiontracks.findFirst({ where: TrackKey(userId, event.track) }).sync();
            if (existing == undefined) tx.insert(progressiontracks).values({ userId, progressionId: event.track, progress: Math.max(0, event.amount), lastModifiedDate: now }).run();
            else tx.update(progressiontracks).set({ progress: Math.max(0, existing.progress + event.amount), lastModifiedDate: now }).where(TrackKey(userId, event.track)).run();
            appliedTracks.push(event.track);
        }
        tx.insert(progressionreceipts).values({ userId, fingerprint, response: JSON.stringify({ advanced, appliedTracks }), createdDate: now }).run();
        return { advanced: true, advancedObjectiveIds: advanced.map((objective) => objective.objectiveId), appliedTracks };
    });
}

// Snapshots are totals. Never move saved progress backwards.
export function ApplyMasterySnapshot(userId: string, snapshot: MasterySnapshot) {
    return GetDb().transaction((tx) => {
        const now = Now();
        const advancedObjectiveIds: string[] = [];
        const advancedTracks: string[] = [];

        for (const objective of snapshot.objectives) {
            const existing = tx.query.progressionobjectives.findFirst({ where: ObjectiveKey(userId, objective.objectiveId) }).sync();
            const progress = Math.max(0, objective.value);
            const completedCount = Math.max(0, objective.completedCount);
            if (existing != undefined && existing.progress >= progress && existing.completedCount >= completedCount) continue;
            if (existing == undefined) {
                tx.insert(progressionobjectives).values({ userId, objectiveId: objective.objectiveId, progress, completedCount, createdDate: now, lastModifiedDate: now }).run();
            } else {
                tx.update(progressionobjectives).set({ progress: Math.max(existing.progress, progress), completedCount: Math.max(existing.completedCount, completedCount), lastModifiedDate: now }).where(ObjectiveKey(userId, objective.objectiveId)).run();
            }
            advancedObjectiveIds.push(objective.objectiveId);
        }

        for (const track of snapshot.progressTracks) {
            const existing = tx.query.progressiontracks.findFirst({ where: TrackKey(userId, track.track) }).sync();
            const progress = Math.max(0, track.progress);
            if (existing != undefined && existing.progress >= progress) continue;
            if (existing == undefined) {
                tx.insert(progressiontracks).values({ userId, progressionId: track.track, progress, lastModifiedDate: now }).run();
            } else {
                tx.update(progressiontracks).set({ progress, lastModifiedDate: now }).where(TrackKey(userId, track.track)).run();
            }
            advancedTracks.push(track.track);
        }

        return {
            advanced: advancedObjectiveIds.length > 0 || advancedTracks.length > 0,
            advancedObjectives: advancedObjectiveIds.length,
            advancedObjectiveIds,
            appliedTracks: advancedTracks
        };
    });
}

export async function DeleteTrack(userId: string, progressionId: string) { await GetDb().delete(progressiontracks).where(TrackKey(userId, progressionId)); }
export async function ReplayOrStore(userId: string, request: unknown, operation: () => Promise<unknown>) {
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const prior = await GetDb().query.progressionreceipts.findFirst({ where: and(eq(progressionreceipts.userId, userId), eq(progressionreceipts.fingerprint, fingerprint)) });
    if (prior) return JSON.parse(prior.response);
    const result = await operation();
    await GetDb().insert(progressionreceipts).values({ userId, fingerprint, response: JSON.stringify(result), createdDate: Now() });
    return result;
}
