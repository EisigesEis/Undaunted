import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { BuildLoadoutResponsePayload, BuildLoadoutSlotCountPayload, EnsureUnlockedLoadoutSlotsForUserIdAndCharacterId, GetLoadoutSetForUserIdAndCharacterId, MAX_UNLOCKED_LOADOUT_SLOTS, SetActiveLoadoutIndexForUserIdAndCharacterId, SetLoadoutDataForUserIdAndCharacterId } from "../controllers/loadout";
import type { LoadoutMutationResult } from "../controllers/loadout";
import { logger } from "../logger";

export const loadoutRouter = Router();

function SendLoadoutJson(res: any, Payload: Record<string, any>){
    const Body = JSON.stringify(Payload);
    logger.info({route: res.req?.path, status: 200, bytes: Buffer.byteLength(Body), keys: Object.keys(Payload)}, "Loadout response shape");
    res.status(200).json(Payload);
}

function SendLoadoutSetResponse(res: any, LoadoutSet: {loadouts: any[], persistent: any, activeIndex: number}){
    SendLoadoutJson(res, {
        code: null,
        message: "OK",
        payload: BuildLoadoutResponsePayload(LoadoutSet)
    });
}

function SendLoadoutMutationResponse(res: any){
    // RE: SetPersistentLoadout, SetLoadoutForSlot, and SetActiveLoadoutSlot
    // parse generic response null + OK.
    SendLoadoutJson(res, {
        code: null,
        message: "OK"
    });
}

function SendSlotCountResponse(res: any, LoadoutSet: {loadouts: any[], activeIndex: number}){
    const Payload = BuildLoadoutSlotCountPayload(LoadoutSet);

    SendLoadoutJson(res, {code: null, message: "OK", payload: Payload});
}

function SendAccountSlotCountResponse(res: any){
    SendLoadoutJson(res, {
        code: null,
        message: "OK",
        payload: {
            num_account_slots: 0,
            max_account_slots: 0,
            num_character_slots: 0,
            max_character_slots: MAX_UNLOCKED_LOADOUT_SLOTS
        }
    });
}

function SendActiveLoadoutResponse(res: any, LoadoutSet: {loadouts: any[], persistent: any, activeIndex: number}){
    const ActiveLoadout = LoadoutSet.loadouts[LoadoutSet.activeIndex] ?? LoadoutSet.loadouts[0];

    SendLoadoutJson(res, {
        code: null,
        message: "OK",
        success: true,
        ...ActiveLoadout
        // TODO: One of the only requests of this shape with ... unpack instead of payload:
        // might need RE.
        // payload: ActiveLoadout
    });
}

function resolveRequestorAccountId(req: any){
    return req.AuthData.IsGameserver ? req.params.userId : req.AuthData.userId;
}

function sendEmptyError(res: any, Result?: LoadoutMutationResult){
    res.status(Result?.statusCode ?? 400);
    res.send();
}

function parseRouteInteger(Value: string){
    const ParsedValue = Number.parseInt(Value, 10);

    if(!Number.isInteger(ParsedValue) || String(ParsedValue) !== Value){
        return undefined;
    }

    return ParsedValue;
}

loadoutRouter.get("/loadout/:userId/slotcount", HasUndauntedMetagameAuth, async (req: any, res) => {
    logger.info({method: req.method, path: req.path, userId: req.params.userId}, "Account loadout slot count");
    SendAccountSlotCountResponse(res);
});

loadoutRouter.post("/loadout/:userId/unlock/:slots", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestedSlots = parseRouteInteger(req.params.slots);
    logger.info({method: req.method, path: req.path, userId: req.params.userId, slots: req.params.slots}, "Account loadout unlock");

    if(RequestedSlots == undefined || RequestedSlots < 1 || RequestedSlots > MAX_UNLOCKED_LOADOUT_SLOTS){
        res.status(400);
        res.send();
        return;
    }

    SendAccountSlotCountResponse(res);
});

loadoutRouter.get("/loadout/:userId/:characterId/slotcount", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = resolveRequestorAccountId(req);
    const CharacterId = req.params.characterId;

    const LoadoutSet = await GetLoadoutSetForUserIdAndCharacterId(RequestorAccountId, CharacterId);

    SendSlotCountResponse(res, LoadoutSet);
});

loadoutRouter.get("/loadout/:userId/:characterId/all", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = resolveRequestorAccountId(req);
    const CharacterId = req.params.characterId;

    const LoadoutSet = await GetLoadoutSetForUserIdAndCharacterId(RequestorAccountId, CharacterId);

    SendLoadoutSetResponse(res, LoadoutSet);
});

loadoutRouter.get("/loadout/:userId/:characterId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = resolveRequestorAccountId(req);
    const CharacterId = req.params.characterId;

    const LoadoutSet = await GetLoadoutSetForUserIdAndCharacterId(RequestorAccountId, CharacterId);

    SendActiveLoadoutResponse(res, LoadoutSet);
});

loadoutRouter.post("/loadout/:userId/:characterId/unlock/:slots", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = resolveRequestorAccountId(req);
    const CharacterId = req.params.characterId;
    const RequestedSlots = parseRouteInteger(req.params.slots);

    if(RequestedSlots == undefined || RequestedSlots < 1 || RequestedSlots > MAX_UNLOCKED_LOADOUT_SLOTS){
        sendEmptyError(res);
        return;
    }

    const Result = await EnsureUnlockedLoadoutSlotsForUserIdAndCharacterId(RequestorAccountId, CharacterId, RequestedSlots);

    if(!Result.success || Result.loadoutState == undefined){
        sendEmptyError(res, Result);
        return;
    }

    SendSlotCountResponse(res, Result.loadoutState);
});

loadoutRouter.post("/loadout/:userId/:characterId/active/:index", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = resolveRequestorAccountId(req);
    const CharacterId = req.params.characterId;
    const Index = req.params.index;

    const Result = await SetActiveLoadoutIndexForUserIdAndCharacterId(RequestorAccountId, CharacterId, Index);

    if(!Result.success || Result.loadoutState == undefined){
        sendEmptyError(res, Result);
        return;
    }

    SendLoadoutMutationResponse(res);
});

loadoutRouter.post("/loadout/:userId/:characterId/:index", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = resolveRequestorAccountId(req);
    const CharacterId = req.params.characterId;
    const Data = req.body.data;
    const Index = req.params.index;

    const Result = await SetLoadoutDataForUserIdAndCharacterId(RequestorAccountId, CharacterId, Index, Data);

    if(Result.success && Result.loadoutState != undefined){
        SendLoadoutMutationResponse(res);
    }
    else{
        sendEmptyError(res, Result);
    }
});
