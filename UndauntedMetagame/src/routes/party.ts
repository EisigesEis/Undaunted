import { Router } from "express";
import { HasUndauntedMetagameAuth } from "../middleware/HasUndauntedMetagameAuth";
import { logger } from "../logger";
import {
    AcceptPartyInvite,
    CreatePartyInvite,
    DeletePartyInvite,
    GetInvitesForPlayer,
    GetOrCreatePartyForPlayer,
    GetPartyForPlayer,
    KickPartyMember,
    LeaveParty,
    PromotePartyMember,
    SerializeParty
} from "../controllers/party";
import { GetPartyCandidateView } from "../controllers/matchmaking";

export const partyRouter = Router();

const DEFAULT_ARCHON_BUILD_ID = `${process.env.TARGET_CHANGELIST || "239827"}_1.4.4_shipping`;

partyRouter.post("/party", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const BuildId = RequestBuildId(req.body);
    const Party = await GetOrCreatePartyForPlayer(UserId, BuildId);

    logger.debug({
        userId: UserId,
        buildId: BuildId,
        partyId: Party.partyId,
        memberCount: Party.members.size
    }, "Get party state");

    res.status(200).json(SerializeParty(Party, GetPartyCandidateView(UserId)));
});

partyRouter.get("/party/invites", HasUndauntedMetagameAuth, (req: any, res) => {
    const UserId = req.AuthData.userId;
    const Invitations = GetInvitesForPlayer(UserId);
    if (Invitations.length > 0) {
        logger.info({ userId: UserId, inviteCount: Invitations.length }, "Party invites available");
    }

    res.status(200).json({
        invitations: Invitations
    });
});

partyRouter.put("/party/invite", HasUndauntedMetagameAuth, async (req: any, res) => {
    const SenderPlayerId = req.AuthData.userId;
    const RecipientPlayerId = StringValue(req.body?.recipientPlayerId);

    if (RecipientPlayerId == undefined) {
        res.status(400).json({ error: "recipientPlayerId_required" });
        return;
    }

    const Result = await CreatePartyInvite(SenderPlayerId, RecipientPlayerId, RequestBuildId(req.body));
    if (!Result.ok) {
        logger.warn({
            senderPlayerId: SenderPlayerId,
            recipientPlayerId: RecipientPlayerId,
            status: Result.status,
            error: Result.error
        }, "Party invite rejected");
        res.status(Result.status).json({ error: Result.error });
        return;
    }

    logger.info({ senderPlayerId: SenderPlayerId, recipientPlayerId: RecipientPlayerId }, "Party invite sent");
    res.status(200).json({});
});

partyRouter.put("/party/invite/accept/:playerId", HasUndauntedMetagameAuth, async (req: any, res) => {
    const RecipientPlayerId = req.AuthData.userId;
    const SendingPlayerId = req.params.playerId;
    const Result = await AcceptPartyInvite(RecipientPlayerId, SendingPlayerId);

    if (!Result.ok) {
        logger.warn({
            recipientPlayerId: RecipientPlayerId,
            sendingPlayerId: SendingPlayerId,
            status: Result.status,
            error: Result.error
        }, "Party invite accept rejected");
        res.status(Result.status).json({ error: Result.error });
        return;
    }

    res.status(200).json({});
});

partyRouter.delete("/party/invite/:playerId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RecipientPlayerId = req.AuthData.userId;
    const SendingPlayerId = req.params.playerId;
    const Removed = DeletePartyInvite(RecipientPlayerId, SendingPlayerId);

    logger.debug({ recipientPlayerId: RecipientPlayerId, sendingPlayerId: SendingPlayerId, removed: Removed }, "Party invite deleted");
    res.status(200).json({});
});

partyRouter.delete("/party/member", HasUndauntedMetagameAuth, (req: any, res) => {
    const UserId = req.AuthData.userId;
    LeaveParty(UserId);
    logger.debug({ userId: UserId }, "Player left party");

    res.status(200).json({});
});

partyRouter.delete("/party/member/:playerId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequesterPlayerId = req.AuthData.userId;
    const TargetPlayerId = req.params.playerId;
    const Result = KickPartyMember(RequesterPlayerId, TargetPlayerId);

    if (!Result.ok) {
        logger.warn({
            requesterPlayerId: RequesterPlayerId,
            targetPlayerId: TargetPlayerId,
            status: Result.status,
            error: Result.error
        }, "Party member kick rejected");
        res.status(Result.status).json({ error: Result.error });
        return;
    }

    res.status(200).json({});
});

partyRouter.put("/party/member/promote/:playerId", HasUndauntedMetagameAuth, (req: any, res) => {
    const RequesterPlayerId = req.AuthData.userId;
    const TargetPlayerId = req.params.playerId;
    const Result = PromotePartyMember(RequesterPlayerId, TargetPlayerId);

    if (!Result.ok) {
        logger.warn({
            requesterPlayerId: RequesterPlayerId,
            targetPlayerId: TargetPlayerId,
            status: Result.status,
            error: Result.error
        }, "Party member promote rejected");
        res.status(Result.status).json({ error: Result.error });
        return;
    }

    logger.info({ requesterPlayerId: RequesterPlayerId, targetPlayerId: TargetPlayerId }, "Party member promoted");
    res.status(200).json({});
});

partyRouter.post("/evoice/join/party", HasUndauntedMetagameAuth, async (req: any, res) => {
    const UserId = req.AuthData.userId;
    const Party = GetPartyForPlayer(UserId) ?? await GetOrCreatePartyForPlayer(UserId, DEFAULT_ARCHON_BUILD_ID);
    const PartyIdPrefix = Party.partyId.split("_")[0];

    logger.info({ userId: UserId, partyId: Party.partyId }, "Party voice metadata requested");
    res.status(200).json({
        channel_name: `PARTY.${PartyIdPrefix}`,
        client_base_url: "",
        participant_token: "",
        party_id: Party.partyId
    });
});

function RequestBuildId(body: any) {
    return StringValue(body?.buildId) ?? DEFAULT_ARCHON_BUILD_ID;
}

function StringValue(value: unknown) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
