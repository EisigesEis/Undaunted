import { Router } from "express";
import { logger } from "../logger";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import progressionconfig from "../vendor/progression_config.json";
import { ACTIVE_HUNTPASS, GetActiveCooldowns, GetEntitlements, StartCooldown } from "../controllers/huntpass";
import { UpdatePlayerActivity } from "../controllers/undauntedapi";
import { MarkMatchmakingHeartbeat, TouchDeployserverForPlayerActivity } from "../controllers/matchmaking";

export const systemRouter = Router();

systemRouter.get("/dauntless-status", (req, res) => {
    logger.info("Status");

    res.json({
	    "show-status": true,
	    "en": "Welcome to Undaunted v0.0.5!",
	    "fr": "Welcome to Undaunted v0.0.5!",
	    "it": "Welcome to Undaunted v0.0.5!",
	    "es": "Welcome to Undaunted v0.0.5!",
	    "de": "Welcome to Undaunted v0.0.5!",
	    "pt": "Welcome to Undaunted v0.0.5!",
	    "ru": "Welcome to Undaunted v0.0.5!",
	    "ja": "Welcome to Undaunted v0.0.5!"
    });
});

systemRouter.post("/heartbeat", HasUndauntedMetagameAuth, async (req: any, res) => {
	const UserId = req.AuthData.userId;

	const UserMap = req.body.map;

	await UpdatePlayerActivity(UserId, UserMap);
	await MarkMatchmakingHeartbeat(UserId);
	await TouchDeployserverForPlayerActivity(UserId);

    res.status(200).type("text/plain").send("20000");
});

systemRouter.post("/event", (req, res) => {
    res.status(200);
    res.json({});
});

systemRouter.post("/check", (req, res) => {
	logger.info("Chat check (stubbed)");
	const Original = typeof req.body?.string === "string"
		? req.body.string
		: typeof req.body?.text === "string"
			? req.body.text
			: typeof req.body?.message === "string"
				? req.body.message
				: "";

	res.status(200);
	res.json({
		rating: 0.0,
		sanitized: Original,
		string: Original
	});
});

systemRouter.all("/checkavailable", (req, res) => {
	logger.info("Availability check (stubbed)");

	res.status(200);
	res.json({
		available: true,
		isAvailable: true
	});
});

systemRouter.post("/account/migrate", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Account migration (stubbed)");

	res.status(200);
	res.json({
		migration_failed: false,
		migration_finished: true
	});
});

systemRouter.post("/profile/update", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Leaderboard update profile (stubbed)");

	res.status(200);
	res.send();
});

systemRouter.get("/vivox/login", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Vivox login (stubbed)");

	res.status(404);
	res.send();
});

systemRouter.post("/motd/", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("MOTD (stubbed)");

	res.status(204);
	res.send();
});

systemRouter.get("/entitlementsv2", HasUndauntedMetagameAuth, async (req: any, res) => {
	res.status(200).json({code: null, message: "OK", payload: await GetEntitlements(req.AuthData.userId)});
});

systemRouter.post("/entitlementv2/:userId", HasUndauntedMetagameAuth, async (req: any, res) => {
	if(!req.AuthData.IsGameserver && req.AuthData.userId !== req.params.userId) return res.status(403).send();
	res.status(200).json({code: null, message: "OK", payload: await GetEntitlements(req.params.userId)});
});

systemRouter.get("/playertreatments/:userId", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Cohorts (stubbed)");

	res.status(200);
	res.json({
		treatments: [
			"CohortTreatment.Dojo.B"
		]
	});
});

systemRouter.get("/eventstats/", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Event stats (stubbed)");

	res.status(200);
	res.json({
		stats: []
	});
});

systemRouter.get("/progression/config", HasUndauntedMetagameAuth, (req, res) => {
	logger.info("Progression Config (stubbed)");

	res.status(200);
	res.json(progressionconfig);
});

function OwnsAccount(req: any, res: any) {
	if(req.AuthData.IsGameserver || req.AuthData.userId === req.params.userId) return true;
	res.status(403).send();
	return false;
}

function RequestedHuntPass(body: any) {
	if(typeof body === "string") return body;
	return body?.hunt_pass_id ?? body?.huntPassId ?? body?.selected_hunt_pass_id ?? body?.progression_id;
}

systemRouter.get("/huntpass/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	if(!OwnsAccount(req, res)) return;
	res.status(200).json({code: null, message: "OK", payload: ACTIVE_HUNTPASS});
});

systemRouter.post("/huntpass/:userId", HasUndauntedMetagameAuth, (req: any, res) => {
	if(!OwnsAccount(req, res)) return;
	const HuntPassId = RequestedHuntPass(req.body);
	if(HuntPassId !== ACTIVE_HUNTPASS){
		return res.status(400).json({code: "invalid_huntpass", message: "Unknown hunt pass", payload: null});
	}
	res.status(200).json({code: null, message: "OK", payload: ACTIVE_HUNTPASS});
});

// TODO: So far cooldown is only hp daily ramsgate 10 items to collect. Verify this.
systemRouter.get("/cooldown/:userId", HasUndauntedMetagameAuth, async (req: any, res) => {
	if(!req.AuthData.IsGameserver && req.AuthData.userId !== req.params.userId) return res.status(403).send();
	res.status(200).json({code: null, message: "OK", payload: await GetActiveCooldowns(req.params.userId)});
});

systemRouter.put("/cooldown/batch/:userId", HasUndauntedMetagameAuth, async (req: any, res) => {
	if(req.AuthData.IsGameserver !== true) return res.status(403).send();
	const Ids = Array.isArray(req.body?.cooldowns) ? req.body.cooldowns : [];
	for(const Entry of Ids) StartCooldown(req.params.userId, String(Entry.cooldown_id ?? Entry.cooldownId ?? Entry));
    res.status(200).json({code: null, message: "OK", payload: await GetActiveCooldowns(req.params.userId)});
});

systemRouter.put("/cooldown/:userId", HasUndauntedMetagameAuth, async (req: any, res) => {
	if(req.AuthData.IsGameserver !== true) return res.status(403).send();
	const Entry = req.body?.cooldown ?? req.body;
	const CooldownId = typeof Entry === "string" ? Entry : String(Entry?.cooldown_id ?? Entry?.cooldownId ?? Entry?.id ?? "");
	const Result = StartCooldown(req.params.userId, CooldownId);
	res.status(Result.success ? 200 : 400).json({
		code: Result.success ? null : Result.error,
		message: Result.success ? "OK" : Result.error,
		payload: Result.success ? await GetActiveCooldowns(req.params.userId) : null
	});
});

systemRouter.put("/cooldown/:userId/:cooldownId", HasUndauntedMetagameAuth, (req: any, res) => {
    if(req.AuthData.IsGameserver !== true) return res.status(403).send();
    const Result = StartCooldown(req.params.userId, req.params.cooldownId);
    res.status(Result.success ? 200 : 400).json({code: Result.success ? null : Result.error, message: Result.success ? "OK" : Result.error, payload: Result.success ? {expires_at: Result.expiresAt} : null});
});

systemRouter.get("/bounty/game-data", HasUndauntedMetagameAuth, (req: any, res) => {
	logger.info("Bounty game data (stubbed)");

	res.status(200);
	res.json({
    code: null,
    message: "OK",
    payload: {
      max_slots: 4,
      num_draft_options: 3,
      num_spicy_options: 1,
      bounty_token_id: "TOKEN_BOUNTY_DRAFT",
      premium_bounty_token_id: "TOKEN_BOUNTY_DRAFT_PREMIUM",
      num_tokens_hp_start: 4,
      num_tokens_per_day: 0,
      bounty_token_grant_hour: 0,
      history_length: 10,
      bronze_count: 9,
      silver_count: 3,
      gold_count: 1,
      new_season_reset_bounties: false,
      bounty_data: [],
      item_grant_data: [],
      token_rollover_warning_days: 1000,
      automatic_draft: false,
      automatic_claim: false,
      delete_claimed_bounties: false,
    },
  });
});

systemRouter.get("/bounty/:userId", HasUndauntedMetagameAuth, (req: any, res) => { // TODO: This masks /bounty/game-data Right now they seem to have compatible schema, but I could be wrong about that.
	logger.info("Bounties (stubbed)");

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: {
			bounties: [],
			draft_data: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			},
			draft_data_daily: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			},
			draft_data_weekly: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			}
		}
	})
});

systemRouter.post("/bounty/:userId", HasUndauntedMetagameAuth, (req: any, res) => { // TODO: This masks /bounty/game-data Right now they seem to have compatible schema, but I could be wrong about that.
	logger.info("Set Bounties (stubbed)");

	res.status(200);
	res.json({
		code: null,
		message: "OK",
		payload: {
			bounties: [],
			draft_data: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			},
			draft_data_daily: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			},
			draft_data_weekly: {
				current_draft_choices: [],
    			previous_draft_selections: [],
    			bronze_count: 0,
    			silver_count: 0,
    			gold_count: 0,
			}
		}
	})
});

systemRouter.get("/all/", HasUndauntedMetagameAuth, (req: any, res) => {
	logger.info("Mailbox (stubbed)");

	res.json({
		code: null,
		message: "OK",
		payload: {
			messages: []
		}
	});
});
