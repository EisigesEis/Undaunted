import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { BuildLoadoutResponsePayload, BuildLoadoutSlotCountPayload, EnsureUnlockedLoadoutSlotsForUserIdAndCharacterId, GetLoadoutSetForUserIdAndCharacterId, MAX_UNLOCKED_LOADOUT_SLOTS, SetActiveLoadoutIndexForUserIdAndCharacterId, SetLoadoutDataForUserIdAndCharacterId } from "../controllers/loadout";
import type { LoadoutMutationResult } from "../controllers/loadout";

export const loadoutRouter = Router();

function SendLoadoutSetResponse(res: any, LoadoutSet: {loadouts: any[], persistent: any, activeIndex: number}){
    res.status(200);
    res.json({
        code: null,
        message: "OK",
        payload: BuildLoadoutResponsePayload(LoadoutSet)
    });
}

function SendLoadoutMutationResponse(res: any, LoadoutSet: {loadouts: any[], persistent: any, activeIndex: number}){
    const Payload = BuildLoadoutResponsePayload(LoadoutSet);

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        success: true,
        payload: Payload
    });
}

function SendSlotCountResponse(res: any, LoadoutSet: {loadouts: any[], activeIndex: number}){
    const Payload = BuildLoadoutSlotCountPayload(LoadoutSet);

    res.status(200);
    res.json(Payload);
}

function SendMaxAccountSlotCountResponse(res: any){
    const Payload = {
        GrantedLoadoutSlots: MAX_UNLOCKED_LOADOUT_SLOTS,
        NumLoadoutSlots: MAX_UNLOCKED_LOADOUT_SLOTS,
        NumAccountLoadoutSlots: MAX_UNLOCKED_LOADOUT_SLOTS,
        MaxNumLoadoutSlots: MAX_UNLOCKED_LOADOUT_SLOTS,
        MaxNumAccountLoadoutSlots: MAX_UNLOCKED_LOADOUT_SLOTS,
        slot_count: MAX_UNLOCKED_LOADOUT_SLOTS,
        slotCount: MAX_UNLOCKED_LOADOUT_SLOTS,
        num_slots: MAX_UNLOCKED_LOADOUT_SLOTS,
        num_account_slots: MAX_UNLOCKED_LOADOUT_SLOTS,
        max_account_slots: MAX_UNLOCKED_LOADOUT_SLOTS
    };

    res.status(200);
    res.json(Payload);
}

function SendActiveLoadoutResponse(res: any, LoadoutSet: {loadouts: any[], persistent: any, activeIndex: number}){
    const ActiveLoadout = LoadoutSet.loadouts[LoadoutSet.activeIndex] ?? LoadoutSet.loadouts[0];

    res.status(200);
    res.json({
        code: null,
        message: "OK",
        success: true,
        ...ActiveLoadout,
        payload: ActiveLoadout
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
    SendMaxAccountSlotCountResponse(res);
});

loadoutRouter.post("/loadout/:userId/unlock/:slots", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestedSlots = parseRouteInteger(req.params.slots);

    if(RequestedSlots == undefined || RequestedSlots < 1 || RequestedSlots > MAX_UNLOCKED_LOADOUT_SLOTS){
        res.status(400);
        res.send();
        return;
    }

    SendMaxAccountSlotCountResponse(res);
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

    SendLoadoutMutationResponse(res, Result.loadoutState);
});

loadoutRouter.post("/loadout/:userId/:characterId/:index", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RequestorAccountId = resolveRequestorAccountId(req);
    const CharacterId = req.params.characterId;
    const Data = req.body.data;
    const Index = req.params.index;

    const Result = await SetLoadoutDataForUserIdAndCharacterId(RequestorAccountId, CharacterId, Index, Data);

    if(Result.success && Result.loadoutState != undefined){
        SendLoadoutMutationResponse(res, Result.loadoutState);
    }
    else{
        sendEmptyError(res, Result);
    }
});
