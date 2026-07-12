import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import { AddEncounteredContent, GetBreadcrumbsForCharacterIdAndUserId, ProgressionError, QueryEncounteredContent, SetBreadcrumbsForCharacterIdAndUserId } from "../controllers/progression";
import progressionConfig from "../vendor/progression_config.json";

// TODO: We will be gaining progression support very soon, but for now just a stub

export const progressionRouter = Router();

const STUB_MAX_PROGRESS = 99999999;
const STUB_SEASON_RANK = 99999999;

const StubbedMasteryTrackIds = [
    "MasteryTrack_PlayerLevel",
    "MasteryTrack_Behemoth",
    "MasteryTrack_Weapon_Strikers",
    "MasteryTrack_Weapon_Hammer",
    "MasteryTrack_Weapon_Repeaters",
    "MasteryTrack_Weapon_ChainBlades",
    "MasteryTrack_Weapon_Axe",
    "MasteryTrack_Weapon_Sword",
    "MasteryTrack_Weapon_Spear",
];

const STUB_CONFIRMED_DATE = new Date().toISOString();
const ProgressionConfigPaths = progressionConfig.payload.paths as { progression_id: string, requirements?: { rank_id: number }[] }[];

function GetConfiguredMaxRank(ProgressionId: string){
    const ProgressionPath = ProgressionConfigPaths.find((Path) => Path.progression_id === ProgressionId);

    if(!ProgressionPath?.requirements?.length){
        return STUB_SEASON_RANK;
    }

    return Math.max(...ProgressionPath.requirements.map((Requirement) => Requirement.rank_id));
}

const StubbedMasteryProgressTrackTemplates = StubbedMasteryTrackIds.map((ProgressionId) => {
    const ConfirmedRank = GetConfiguredMaxRank(ProgressionId);

    return {
        progression_id: ProgressionId,
        progress: STUB_MAX_PROGRESS,
        confirmed_fremium_rank: ConfirmedRank,
        confirmed_premium_rank: ConfirmedRank,
        confirmed_date: STUB_CONFIRMED_DATE,
    };
});
const StubbedProgressTrackTemplates = [
    {
        progression_id: "season09b",
        progress: STUB_MAX_PROGRESS,
        confirmed_fremium_rank: STUB_SEASON_RANK,
        confirmed_premium_rank: STUB_SEASON_RANK,
        confirmed_date: STUB_CONFIRMED_DATE,
    },
    ...StubbedMasteryProgressTrackTemplates,
];

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

progressionRouter.get("/progression/objectives/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;

    logger.info(`Objective progression fetched for userId ${RequestorAccountId}`);
    
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            objectives: [
                
            ],
            progress_tracks: StubbedMasteryProgressTrackTemplates.map((TrackTemplate) => ({ phx_account_id: RequestorAccountId, ...TrackTemplate }))
        }
    })
});

progressionRouter.get("/progression/objectives/:userId/:objectiveId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;

    logger.info(`Objective progression fetched for userId ${RequestorAccountId}`);
    
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: {
            phx_account_id: req.params.userId,
            objective_id: req.params.objectiveId,
            progress: 9999999,
            completed_count: 9999999,
            created_date: new Date("1970-1-1").toISOString(),
            last_modified_date: new Date("1970-1-1").toISOString(),
        }
    })
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

progressionRouter.post("/progression/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestorAccountId = req.params.userId;
    
    logger.info(`Progression set for userId ${RequestorAccountId} (stubbed)`);
    
    res.status(400); // TODO: Figure out how to properly grant progression. If this returns anything other than 400, we get the infinite mastery pop issue
    res.send();
});

progressionRouter.get("/progression/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequestorAccountId = req.AuthData.userId;

    // TODO: Impl proper progression. Right now this is the minimum to not block the Boreal crafting reqs

    logger.info(`Progression fetched for userId ${RequestorAccountId} (stubbed)`);
    
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: StubbedProgressTrackTemplates.map((TrackTemplate) => ({ phx_account_id: RequestorAccountId, ...TrackTemplate }))
    })
});
