import { and, eq } from "drizzle-orm";
import { GetDb } from "../db";
import { breadcrumbs, encounteredcontent } from "../db/schema";
import { logger } from "../logger";
import { DoesCharacterBelongToUserId } from "./character";

type EncounteredContent = { content: unknown; category: unknown };
export type ProgressionError = "forbidden" | "conflict" | "invalid_data" | "db_error";
export type ProgressionResult<T = void> = { success: true; data?: T } | { success: false; error: ProgressionError };

class ProgressionConflictError extends Error { constructor(message: string) { super(message); this.name = "ProgressionConflictError"; } }
const EncounteredContentFor = (userId: string, characterId: string) => and(eq(encounteredcontent.userId, userId), eq(encounteredcontent.characterId, characterId));
const BreadcrumbsFor = (userId: string, characterId: string) => and(eq(breadcrumbs.userId, userId), eq(breadcrumbs.characterId, characterId));
const Parse = <T>(value: string) => JSON.parse(value) as T;

async function RunProgressionOperation<T>(userId: string, characterId: string, invalidDataMessage: string, dbErrorMessage: string, operation: () => Promise<T> | T): Promise<ProgressionResult<T>> {
    if (!await DoesCharacterBelongToUserId(userId, characterId)) { logger.error(`Specified characterId ${characterId} does not belong to user ${userId}`); return { success: false, error: "forbidden" }; }
    try { return { success: true, data: await operation() }; }
    catch (error) {
        if (error instanceof ProgressionConflictError) { logger.warn(error.message); return { success: false, error: "conflict" }; }
        if (error instanceof SyntaxError) { logger.error(error, invalidDataMessage); return { success: false, error: "invalid_data" }; }
        logger.error(error, dbErrorMessage); return { success: false, error: "db_error" };
    }
}

export async function QueryEncounteredContent(userId: string, characterId: string, categoriesToQuery: number[]): Promise<ProgressionResult<any[]>> {
    logger.info(`Querying ${categoriesToQuery.length} categories for userId ${userId} and characterId ${characterId}`);
    return RunProgressionOperation(userId, characterId, `Invalid encountered content data for characterId ${characterId} and userId ${userId}`, `Failed to query encountered content for characterId ${characterId} and userId ${userId}`, async () => {
        const db = GetDb(); const row = await db.query.encounteredcontent.findFirst({ where: EncounteredContentFor(userId, characterId) }); const content = Parse<EncounteredContent[]>(row?.encounteredcontent ?? "[]");
        const byCategory = new Map<number, unknown[]>();
        for (const entry of content) { const category = Number(entry.category); if (Number.isNaN(category)) continue; const values = byCategory.get(category); if (values) values.push(entry.content); else byCategory.set(category, [entry.content]); }
        return categoriesToQuery.map((category) => ({ content: byCategory.get(Number(category)) ?? [], content_type: Number(category) }));
    });
}

export async function AddEncounteredContent(userId: string, characterId: string, contentType: number, contentId: string): Promise<ProgressionResult> {
    return RunProgressionOperation(userId, characterId, `Invalid encountered content data while adding ${contentId} for characterId ${characterId} and userId ${userId}`, `Failed to add encountered content ${contentId} for characterId ${characterId} and userId ${userId}`, async () => {
        const db = GetDb(); const row = await db.query.encounteredcontent.findFirst({ where: EncounteredContentFor(userId, characterId) }); const content = Parse<EncounteredContent[]>(row?.encounteredcontent ?? "[]");
        if (!row) await db.insert(encounteredcontent).values({ userId, characterId, encounteredcontent: "[]" });
        if (content.some((entry) => Number(entry.category) === Number(contentType) && entry.content === contentId)) return;
        content.push({ content: contentId, category: contentType }); await db.update(encounteredcontent).set({ encounteredcontent: JSON.stringify(content) }).where(EncounteredContentFor(userId, characterId));
    });
}

export async function GetBreadcrumbsForCharacterIdAndUserId(userId: string, characterId: string): Promise<ProgressionResult<{ breadcrumbs: any[]; updateVersion: number }>> {
    return RunProgressionOperation(userId, characterId, `Invalid breadcrumb data for characterId ${characterId} and userId ${userId}`, `Failed to fetch breadcrumbs for characterId ${characterId} and userId ${userId}`, async () => {
        const db = GetDb(); const row = await db.query.breadcrumbs.findFirst({ where: BreadcrumbsFor(userId, characterId) });
        if (!row) { logger.info(`Creating new breadcrumbs entry for character ${characterId}`); await db.insert(breadcrumbs).values({ breadcrumbs: "[]", updateVersion: 0, userId, characterId }); }
        return { breadcrumbs: Parse<any[]>(row?.breadcrumbs ?? "[]"), updateVersion: row?.updateVersion ?? 0 };
    });
}

export async function SetBreadcrumbsForCharacterIdAndUserId(userId: string, characterId: string, breadcrumbsFromUser: any, updateVersion: number): Promise<ProgressionResult<{ breadcrumbs: any; updateVersion: number }>> {
    return RunProgressionOperation(userId, characterId, `Invalid breadcrumb data while setting breadcrumbs for characterId ${characterId} and userId ${userId}`, `Failed to set breadcrumbs for characterId ${characterId} and userId ${userId}`, async () => {
        const db = GetDb(); const row = await db.query.breadcrumbs.findFirst({ where: BreadcrumbsFor(userId, characterId) }); const value = JSON.stringify(breadcrumbsFromUser);
        if (!row) { logger.info(`Creating new breadcrumbs entry for character ${characterId}`); await db.insert(breadcrumbs).values({ breadcrumbs: value, updateVersion, userId, characterId }); }
        else if (row.updateVersion >= updateVersion) throw new ProgressionConflictError(`Refusing stale breadcrumbs update for characterId ${characterId} and userId ${userId}: current updateVersion ${row.updateVersion}, incoming updateVersion ${updateVersion}`);
        else { logger.info(`Updating breadcrumbs entry for character ${characterId} with updateVersion ${updateVersion}`); await db.update(breadcrumbs).set({ breadcrumbs: value, updateVersion }).where(BreadcrumbsFor(userId, characterId)); }
        return { breadcrumbs: breadcrumbsFromUser, updateVersion };
    });
}
