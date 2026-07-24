import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { ClaimEscalationReward, EscalationError, EscalationPayload, GetEscalationProgression, NormalizeEscalationPayload, SaveEscalationProgression } from "../controllers/escalation";

export const escalationRouter = Router();

function StatusForEscalationError(Error: EscalationError){
	switch(Error){
		case "conflict":
			return 409;
		case "invalid_data":
		case "not_unlocked":
			return 400;
		case "not_found":
			return 404;
		case "db_error":
			return 500;
	}
}

function AuthorizedEscalationUserId(req: any){
	const RequestedUserId = req.params.userId;

	if(req.AuthData.IsGameserver){
		return RequestedUserId;
	}

	if(req.AuthData.userId !== RequestedUserId){
		return undefined;
	}

	return req.AuthData.userId;
}

function SendEscalationPayload(res: any, Payload: EscalationPayload){
	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: Payload
	});
}

escalationRouter.get("/escalation/:escalationSeason/:userId", HasUndauntedMetagameAuth, async (req: any, res) => {
	const EscalationSeason = req.params.escalationSeason;
	const UserId = AuthorizedEscalationUserId(req);

	if(UserId == undefined){
		res.status(403);
		res.send();
		return;
	}

	const EscalationResult = await GetEscalationProgression(UserId, EscalationSeason);

	if(!EscalationResult.success){
		const Status = StatusForEscalationError(EscalationResult.error);
		res.status(Status);
		res.send();
		return;
	}

	SendEscalationPayload(res, EscalationResult.data);
});

async function SaveEscalationProgressionRoute(req: any, res: any){
	const EscalationSeason = req.params.escalationSeason;
	const UserId = AuthorizedEscalationUserId(req);

	if(UserId == undefined){
		res.status(403);
		res.send();
		return;
	}

	const NormalizedPayload = NormalizeEscalationPayload(req.body);
	const EscalationResult = await SaveEscalationProgression(UserId, EscalationSeason, NormalizedPayload);

	if(!EscalationResult.success){
		const Status = StatusForEscalationError(EscalationResult.error);
		res.status(Status);
		res.send();
		return;
	}

	SendEscalationPayload(res, EscalationResult.data);
}

escalationRouter.post("/escalation/:escalationSeason/:userId", HasUndauntedMetagameAuth, SaveEscalationProgressionRoute);
escalationRouter.put("/escalation/:escalationSeason/:userId", HasUndauntedMetagameAuth, SaveEscalationProgressionRoute);

escalationRouter.post("/escalation/:escalationSeason/:userId/rewards/:unlockId/claim", HasUndauntedMetagameAuth, async (req: any, res) => {
	const EscalationSeason = req.params.escalationSeason;
	const UnlockId = req.params.unlockId;
	const UserId = AuthorizedEscalationUserId(req);

	if(UserId == undefined){
		res.status(403);
		res.send();
		return;
	}

	const EscalationResult = await ClaimEscalationReward(UserId, EscalationSeason, UnlockId);

	if(!EscalationResult.success){
		const Status = StatusForEscalationError(EscalationResult.error);
		res.status(Status);
		res.send();
		return;
	}

	SendEscalationPayload(res, EscalationResult.data);
});
