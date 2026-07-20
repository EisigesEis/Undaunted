import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import { AddEncounteredContent, GetBreadcrumbsForCharacterIdAndUserId, ProgressionError, QueryEncounteredContent, SetBreadcrumbsForCharacterIdAndUserId } from "../controllers/progression";
import progressionConfig from "../vendor/progression_config.json";
import { ApplyMasteryUpdate, ApplyTrackGrant, ConfiguredTrackIds, ConfirmTrack, DeleteTrack, Envelope, GetMasteryUpdateResponse, GetObjectives, GetTracks, MasteryTrackEvent, MasteryUpdate, TrackWire, ZeroObjectiveWire, ZeroTrackWire } from "../controllers/mastery";
import { ACTIVE_HUNTPASS, ClaimHuntPass } from "../controllers/huntpass";

export const progressionRouter = Router();

const ConfiguredTrackIdSet = new Set(
    (progressionConfig.payload.paths as { progression_id: string }[]).map((path) => path.progression_id)
);

function ValidateTrackPayload(payload: unknown): payload is { progression_id: string }[] {
    if (!Array.isArray(payload) || ConfiguredTrackIdSet.size === 0)
        return false;

    const returned = new Set<string>();
    for (const track of payload) {
        if (typeof track?.progression_id !== "string")
            return false;
        returned.add(track.progression_id);
    }
    return [...ConfiguredTrackIdSet].every((id) => returned.has(id));
}

function StatusForProgressionError(Error: ProgressionError){
    switch(Error){
        case "forbidden":
            return 403;
        case "conflict":
            return 409;
        case "invalid_data":
        case "db_error":
            return 500;
    }
}

progressionRouter.get("/encountered-content/:characterId/:contentType", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentType = req.params.contentType as number;

    logger.info(`Querying encountered content for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    const ContentResult = await QueryEncounteredContent(RequestorAccountId, CharacterId, [ContentType]);

    if(!ContentResult.success){
        res.status(StatusForProgressionError(ContentResult.error));
        res.send();
        return;
    }

    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {
            content_types: ContentResult.data,
            success: true
        }
    });
});

progressionRouter.post("/encountered-content/query/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentTypes = req.body.content_types;

    logger.info(`Querying encountered content for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    const ContentResult = await QueryEncounteredContent(RequestorAccountId, CharacterId, ContentTypes);

    if(!ContentResult.success){
        res.status(StatusForProgressionError(ContentResult.error));
        res.send();
        return;
    }

    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {
            content_types: ContentResult.data,
            success: true
        }
    });
});

progressionRouter.post("/encountered-content/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;
    const CharacterId = req.params.characterId;
    const ContentType = req.body.content_type;
    const ContentId = req.body.content_id;

    logger.info(`Adding encountered content ${ContentId} for userId ${RequestorAccountId} and characterId ${CharacterId}`);

    const ContentResult = await AddEncounteredContent(RequestorAccountId, CharacterId, ContentType, ContentId);

    if(!ContentResult.success){
        res.status(StatusForProgressionError(ContentResult.error));
        res.send();
        return;
    }

    res.status(200);
    res.send({
        code: null,
        message: "OK",
        payload: {}
    });
});

function Owns(req: any, res: any) {
    // Game servers act for the player in the URL; clients may only act for themselves.
    if (req.AuthData?.IsGameserver === true) return true;
    if (req.params.userId !== req.AuthData?.userId) { res.status(403).send(); return false; }
    return true;
}
progressionRouter.get("/progression/objectives/:userId", HasUndauntedMetagameAuth, async (req: any, res) => {
    if (!Owns(req, res)) return;
    const objectives = await GetObjectives(req.params.userId);
    // Objectives and tracks are loaded separately by the game.
    res.json(Envelope(objectives));
});

progressionRouter.get("/progression/objectives/:userId/:objectiveId", HasUndauntedMetagameAuth, async (req: any, res) => {
    if (!Owns(req, res)) return;
    const objective = (await GetObjectives(req.params.userId, req.params.objectiveId))[0];
    const payload = objective ?? ZeroObjectiveWire(req.params.userId, req.params.objectiveId);
    res.json(Envelope(payload));
});

progressionRouter.get("/breadcrumbs/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestedCharacterId = req.params.characterId;
    const RequestorUserId = req.AuthData.userId;

    logger.info(`Requested breadcrumbs for characterId ${RequestedCharacterId}`);

    const BreadcrumbsResult = await GetBreadcrumbsForCharacterIdAndUserId(RequestorUserId, RequestedCharacterId);

    if(!BreadcrumbsResult.success){
        res.status(StatusForProgressionError(BreadcrumbsResult.error));
        res.send();
        return;
    }

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: BreadcrumbsResult.data
    });
});

progressionRouter.post("/breadcrumbs/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestedCharacterId = req.params.characterId;
    const RequestorUserId = req.AuthData.userId;
    const BreadcrumbsFromUser = req.body.breadcrumbs;
    const UpdateVersion = req.body.updateVersion;

    logger.info(`Setting breadcrumbs for characterId ${RequestedCharacterId}`);

    const BreadcrumbsResult = await SetBreadcrumbsForCharacterIdAndUserId(RequestorUserId, RequestedCharacterId, BreadcrumbsFromUser, UpdateVersion);

    if(!BreadcrumbsResult.success){
        res.status(StatusForProgressionError(BreadcrumbsResult.error));
        res.send();
        return;
    }

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: BreadcrumbsResult.data
    });
});

function FirstDefined(source: any, names: string[]) {
    for (const name of names) if (source?.[name] !== undefined) return source[name];
    // Some game-server fields include a generated suffix.
    if (source != undefined && typeof source === "object") {
        for (const key of Object.keys(source)) {
            const lowerKey = key.toLowerCase();
            const matchedName = names.find((name) => lowerKey === name.toLowerCase() || lowerKey.startsWith(`${name.toLowerCase()}_`));
            if (matchedName != undefined) return source[key];
        }
    }
    return undefined;
}

type ParsedMasteryUpdate = { kind: "events"; update: MasteryUpdate };
type MasteryParseResult = ParsedMasteryUpdate | { kind: "invalid"; reason: string } | undefined;

function ValidMasteryInteger(value: number) {
    return Number.isSafeInteger(value) && value >= 0;
}

function ParseMasteryUpdate(body: any): MasteryParseResult {
    const source = body?.payload != undefined && typeof body.payload === "object" ? body.payload : body;
    const isSnakeCasePayload = source?.objectives !== undefined || source?.progress_tracks !== undefined;
    if (isSnakeCasePayload) {
        if (!Array.isArray(source?.objectives) || !Array.isArray(source?.progress_tracks)) return { kind: "invalid", reason: "objectives_and_progress_tracks_must_be_arrays" };
        const objectives = source.objectives.map((entry: any) => ({
            objectiveId: entry?.objective_id,
            value: Number(entry?.value),
            completedCount: Number(entry?.completed_count ?? 0)
        }));
        const progressEvents: MasteryTrackEvent[] = source.progress_tracks.map((entry: any) => ({
            track: entry?.progression_id,
            amount: Number(entry?.progress)
        }));
        if (objectives.some((entry: any) => typeof entry.objectiveId !== "string" || !entry.objectiveId || !ValidMasteryInteger(entry.value) || !ValidMasteryInteger(entry.completedCount)) ||
            progressEvents.some((entry: any) => typeof entry.track !== "string" || !entry.track || !ValidMasteryInteger(entry.amount))) return { kind: "invalid", reason: "mastery_values_must_be_non_negative_safe_integers" };
        return { kind: "events", update: { objectives, progressEvents } };
    }
    const objectiveSource = FirstDefined(source, ["playerObjectives", "PlayerObjectives", "player_objectives"]);
    const eventSource = FirstDefined(source, ["ProgresstrackEvents", "ProgressEvents", "progressEvents", "progress_track_events"]);
    if (objectiveSource === undefined && eventSource === undefined) return undefined;
    if ((objectiveSource !== undefined && !Array.isArray(objectiveSource)) || (eventSource !== undefined && !Array.isArray(eventSource))) return { kind: "invalid", reason: "mastery_objectives_and_progress_events_must_be_arrays" };

    const objectives = (objectiveSource ?? []).map((entry: any) => ({
        objectiveId: FirstDefined(entry, ["ObjectiveId", "objectiveId", "objective_id"]),
        value: Number(FirstDefined(entry, ["Value", "value", "Progress", "progress"])),
        completedCount: Number(FirstDefined(entry, ["CompletedCount", "completedCount", "completed_count"]) ?? 0)
    }));
    const progressEvents: MasteryTrackEvent[] = (eventSource ?? []).map((entry: any) => ({
        track: FirstDefined(entry, ["Track", "track", "progression_id", "progressionId"]),
        amount: Number(FirstDefined(entry, ["Amount", "amount"]))
    }));
    if (objectives.some((entry: any) => typeof entry.objectiveId !== "string" || !entry.objectiveId || !ValidMasteryInteger(entry.value) || !ValidMasteryInteger(entry.completedCount)) ||
        progressEvents.some((entry: MasteryTrackEvent) => typeof entry.track !== "string" || !entry.track || !ValidMasteryInteger(entry.amount))) return { kind: "invalid", reason: "mastery_values_must_be_non_negative_safe_integers" };
    return { kind: "events", update: { objectives, progressEvents } };
}

progressionRouter.post("/progression/:userId", HasUndauntedMetagameAuth, async (req: any, res) => {
    if (!Owns(req, res)) return;
    const body = req.body ?? {};
    const parsed = ParseMasteryUpdate(body);
    if (parsed?.kind === "invalid") {
        logger.warn({ userId: req.params.userId, reason: parsed.reason }, "Invalid mastery progress rejected");
        res.status(400).json({ code: "invalid_mastery_progress", message: parsed.reason, payload: null });
        return;
    }
    if (parsed == undefined) {
        // Old servers also use this endpoint as a handshake
        res.status(200).json(Envelope({}));
        return;
    }
    const trackIds = parsed.update.progressEvents.map(({ track }) => track);
    const objectiveIds = parsed.update.objectives.map(({ objectiveId }) => objectiveId);
    ApplyMasteryUpdate(req.params.userId, parsed.update);
    res.status(200).json(Envelope(await GetMasteryUpdateResponse(req.params.userId, trackIds, objectiveIds)));
});

progressionRouter.post("/progression/:userId/:progressionId/:amount", HasUndauntedMetagameAuth, async (req: any, res) => {
    if (!Owns(req, res)) return;
    const amount = Number(req.params.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !ConfiguredTrackIds().includes(req.params.progressionId)) {
        res.status(400).json({ code: "invalid_progression_grant", message: "Track and positive integer amount are required", payload: null });
        return;
    }
    const track = await ApplyTrackGrant(req.params.userId, req.params.progressionId, amount);
    res.status(200).json(Envelope(track));
});
progressionRouter.post("/progression/:userId/:progressionId/:rank/confirm/:kind", HasUndauntedMetagameAuth, async (req: any, res) => {
    if (!Owns(req, res)) return;
    if(req.params.progressionId === ACTIVE_HUNTPASS) {
        const Result = ClaimHuntPass(req.params.userId, Number(req.params.rank), req.params.kind);
        if(!Result.success) return res.status(Result.error === "rank_not_earned" || Result.error === "premium_required" ? 409 : 400).json({code: Result.error, message: Result.error, payload: null});
        return res.json(Envelope(TrackWire(req.params.userId, Result.track)));
    }
    res.json(Envelope(await ConfirmTrack(req.params.userId, req.params.progressionId, Number(req.params.rank), req.params.kind)));
});
progressionRouter.delete("/progression/:userId/:progressionId", HasUndauntedMetagameAuth, async (req: any, res) => { if (!Owns(req, res)) return; await DeleteTrack(req.params.userId, req.params.progressionId); res.json(Envelope({})); });
progressionRouter.get("/progression/:userId/:progressionId", HasUndauntedMetagameAuth, async (req: any, res) => {
    if (!Owns(req, res)) return;
    const track = (await GetTracks(req.params.userId, req.params.progressionId))[0];
    res.json(Envelope(track ?? ZeroTrackWire(req.params.userId, req.params.progressionId)));
});
progressionRouter.get("/progression/:userId", HasUndauntedMetagameAuth, async (req: any, res) => {
    if (!Owns(req, res)) return;
    const tracks = await GetTracks(req.params.userId);
    if (!ValidateTrackPayload(tracks)) {
        res.status(500).json({ code: "invalid_progression_tracks", message: "Configured progression tracks are incomplete", payload: null });
        return;
    }
    res.status(200).json(Envelope(tracks));
});
