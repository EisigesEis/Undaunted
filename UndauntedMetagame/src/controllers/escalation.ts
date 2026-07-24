import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { escalationprogression } from "../db/schema";
import { logger } from "../logger";

export type EscalationPayload = {
    escalation_level: number;
    next_level_xp: number;
    talents_progress: any[];
    unlock_progress: any[];
    update_version: number;
};

export type EscalationError = "conflict" | "invalid_data" | "not_found" | "not_unlocked" | "db_error";
export type EscalationResult<T = EscalationPayload> = {success: true, data: T} | {success: false, error: EscalationError};

function EscalationFor(userId: string, escalationSeason: string) {
    return and(eq(escalationprogression.userId, userId), eq(escalationprogression.escalationSeason, escalationSeason));
}

function DefaultPayload(): EscalationPayload {
    return {
        escalation_level: 1,
        next_level_xp: 0,
        talents_progress: [],
        unlock_progress: [],
        update_version: 0
    };
}

function PayloadFromRow(row: typeof escalationprogression.$inferSelect): EscalationPayload {
    return {
        escalation_level: row.escalationLevel,
        next_level_xp: row.nextLevelXp,
        talents_progress: JSON.parse(row.talentsProgress),
        unlock_progress: JSON.parse(row.unlockProgress),
        update_version: row.updateVersion
    };
}

function PayloadToRow(payload: EscalationPayload) {
    return {
        escalationLevel: payload.escalation_level,
        nextLevelXp: payload.next_level_xp,
        talentsProgress: JSON.stringify(payload.talents_progress),
        unlockProgress: JSON.stringify(payload.unlock_progress),
        updateVersion: payload.update_version,
        lastModifiedDate: new Date().toISOString()
    };
}

function ValidatePayload(payload: EscalationPayload): EscalationError | undefined {
    if(!Number.isFinite(payload.escalation_level) || !Number.isFinite(payload.next_level_xp)){
        return "invalid_data";
    }

    if(!Number.isInteger(payload.update_version) || !Number.isFinite(payload.update_version)){
        return "invalid_data";
    }

    if(!Array.isArray(payload.talents_progress) || !Array.isArray(payload.unlock_progress)){
        return "invalid_data";
    }

    return undefined;
}

function ReadFirstDefined(source: any, keys: string[]) {
    if(source == undefined || typeof source !== "object"){
        return undefined;
    }

    for(const Key of keys){
        if(source[Key] !== undefined){
            return source[Key];
        }
    }

    return undefined;
}

export function NormalizeEscalationPayload(body: any): EscalationPayload {
    const Source = body?.payload != undefined && typeof body.payload === "object" ? body.payload : body;

    return {
        escalation_level: ReadFirstDefined(Source, ["escalation_level", "escalationLevel", "EscalationLevel"]),
        next_level_xp: ReadFirstDefined(Source, ["next_level_xp", "nextLevelXp", "nextLevelXP", "EscalationExperienceToNextLevel", "XPToNextLevel"]),
        talents_progress: ReadFirstDefined(Source, ["talents_progress", "talentsProgress", "TalentsProgress"]),
        unlock_progress: ReadFirstDefined(Source, ["unlock_progress", "unlockProgress", "UnlockProgress"]),
        update_version: ReadFirstDefined(Source, ["update_version", "updateVersion", "UpdateVersion"])
    };
}

function DbError(error: unknown, message: string): EscalationResult {
    if(error instanceof SyntaxError){
        logger.error(error, message);
        return {success: false, error: "invalid_data"};
    }

    logger.error(error, message);
    return {success: false, error: "db_error"};
}

export async function GetEscalationProgression(userId: string, escalationSeason: string): Promise<EscalationResult> {
    try{
        return GetDb().transaction((tx) => {
            const Existing = tx.query.escalationprogression.findFirst({
                where: EscalationFor(userId, escalationSeason)
            }).sync();

            if(Existing != undefined){
                return {success: true, data: PayloadFromRow(Existing)} as EscalationResult;
            }

            const Payload = DefaultPayload();
            tx.insert(escalationprogression).values({
                userId,
                escalationSeason,
                ...PayloadToRow(Payload)
            }).run();

            return {success: true, data: Payload} as EscalationResult;
        });
    }
    catch(error){
        return DbError(error, `Failed to fetch escalation progression for userId ${userId} and season ${escalationSeason}`);
    }
}

export async function SaveEscalationProgression(userId: string, escalationSeason: string, payload: EscalationPayload): Promise<EscalationResult> {
    const ValidationError = ValidatePayload(payload);
    if(ValidationError != undefined){
        return {success: false, error: ValidationError};
    }

    try{
        return GetDb().transaction((tx) => {
            const Existing = tx.query.escalationprogression.findFirst({
                where: EscalationFor(userId, escalationSeason)
            }).sync();

            if(Existing != undefined && Existing.updateVersion >= payload.update_version){
                return {success: false, error: "conflict"} as EscalationResult;
            }

            if(Existing == undefined){
                tx.insert(escalationprogression).values({
                    userId,
                    escalationSeason,
                    ...PayloadToRow(payload)
                }).run();
            }
            else{
                tx.update(escalationprogression).set(PayloadToRow(payload)).where(EscalationFor(userId, escalationSeason)).run();
            }

            return {success: true, data: payload} as EscalationResult;
        });
    }
    catch(error){
        return DbError(error, `Failed to save escalation progression for userId ${userId} and season ${escalationSeason}`);
    }
}

export async function ClaimEscalationReward(userId: string, escalationSeason: string, unlockId: string): Promise<EscalationResult> {
    try{
        return GetDb().transaction((tx) => {
            const Existing = tx.query.escalationprogression.findFirst({
                where: EscalationFor(userId, escalationSeason)
            }).sync();

            if(Existing == undefined){
                return {success: false, error: "not_found"} as EscalationResult;
            }

            const Payload = PayloadFromRow(Existing);
            const Unlock = Payload.unlock_progress.find((Progress: any) => Progress?.UnlockId === unlockId);

            if(Unlock == undefined){
                return {success: false, error: "not_found"} as EscalationResult;
            }

            if(Unlock.bIsCollected === true){
                return {success: false, error: "conflict"} as EscalationResult;
            }

            if(Unlock.bIsUnlocked !== true){
                return {success: false, error: "not_unlocked"} as EscalationResult;
            }

            Unlock.bIsCollected = true;
            Payload.update_version += 1;
            tx.update(escalationprogression).set(PayloadToRow(Payload)).where(EscalationFor(userId, escalationSeason)).run();

            return {success: true, data: Payload} as EscalationResult;
        });
    }
    catch(error){
        return DbError(error, `Failed to claim escalation reward ${unlockId} for userId ${userId} and season ${escalationSeason}`);
    }
}
