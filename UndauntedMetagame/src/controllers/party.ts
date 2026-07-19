import { randomBytes } from "node:crypto";
import { GetUsernameForUserId } from "./login";
import { logger } from "../logger";

export const MAX_PARTY_MEMBERS = 4;

export type PartyMember = {
    playerId: string;
    displayName: string | null;
    platform: string | null;
    consoleSessionId: string | null;
    joinedAt: number;
};

export type Party = {
    partyId: string;
    buildId: string;
    leaderPlayerId: string;
    members: Map<string, PartyMember>;
    revision: number;
    serializedRevision: number;
    serializedBase: SerializedPartyBase | undefined;
};

export type PartyInvite = {
    partyId: string;
    recipientPlayerId: string;
    sendingDisplayName: string | null;
    sendingPlatform: string;
    sendingPlayerId: string;
    createdAt: number;
};

export type PartyEvent = {
    partyId: string;
    leaderPlayerId: string | null;
    memberPlayerIds: string[];
    removedPlayerIds: string[];
    revision: number;
};

type PartyListener = (event: PartyEvent) => void;

type SerializedPartyBase = {
    gauntletLevel: null;
    leaderPlayerId: string;
    partyId: string;
    playerStates: Array<{
        consoleSessionId: string | null;
        displayName: string | null;
        platform: string | null;
        playerId: string;
    }>;
};

const PartiesById = new Map<string, Party>();
const PartyIdByPlayerId = new Map<string, string>();
const InvitesByRecipient = new Map<string, Map<string, PartyInvite>>();
const Listeners = new Set<PartyListener>();

export function AddPartyEventListener(listener: PartyListener) {
    Listeners.add(listener);
    return () => Listeners.delete(listener);
}

export async function GetOrCreatePartyForPlayer(playerId: string, buildId: string) {
    const ExistingParty = GetPartyForPlayer(playerId);
    if (ExistingParty != undefined) {
        return ExistingParty;
    }

    const PartyId = CreatePartyId(buildId);
    const Now = Date.now();
    const Member = await BuildPartyMember(playerId, Now);
    const Party: Party = {
        partyId: PartyId,
        buildId,
        leaderPlayerId: playerId,
        members: new Map(),
        revision: 0,
        serializedRevision: -1,
        serializedBase: undefined
    };

    PartiesById.set(PartyId, Party);
    AttachMemberToParty(Party, Member, false);
    logger.info({ playerId, partyId: PartyId, buildId }, "Created party");

    return Party;
}

export function GetPartyForPlayer(playerId: string) {
    const PartyId = PartyIdByPlayerId.get(playerId);
    const IndexedParty = PartyId == undefined ? undefined : PartiesById.get(PartyId);
    if (IndexedParty?.members.has(playerId) === true) {
        return IndexedParty;
    }

    PartyIdByPlayerId.delete(playerId);

    const ContainingParty = FindPartyContainingPlayer(playerId);
    if (ContainingParty == undefined) {
        PartyIdByPlayerId.delete(playerId);
        return undefined;
    }

    PartyIdByPlayerId.set(playerId, ContainingParty.partyId);
    return ContainingParty;
}

export function GetPartyById(partyId: string | undefined) {
    if (partyId == undefined || partyId.length === 0) {
        return undefined;
    }

    return PartiesById.get(partyId);
}

export function GetPartyMembersForPlayer(playerId: string) {
    const Party = GetPartyForPlayer(playerId);
    return Party == undefined ? [playerId] : [...Party.members.keys()];
}

export function IsPlayerInPartyRoom(playerId: string, partyId: string) {
    return PartiesById.get(partyId)?.members.has(playerId) === true;
}

export async function CreatePartyInvite(senderPlayerId: string, recipientPlayerId: string, buildId: string) {
    const Party = await GetOrCreatePartyForPlayer(senderPlayerId, buildId);

    if (Party.members.has(recipientPlayerId)) {
        return { ok: true as const, invite: undefined };
    }

    if (Party.members.size >= MAX_PARTY_MEMBERS) {
        return { ok: false as const, status: 409, error: "party_full" };
    }

    const Invite: PartyInvite = {
        partyId: Party.partyId,
        recipientPlayerId,
        sendingDisplayName: await ResolveDisplayName(senderPlayerId),
        sendingPlatform: "win",
        sendingPlayerId: senderPlayerId,
        createdAt: Date.now()
    };

    StoreInvite(Invite);
    return { ok: true as const, invite: Invite };
}

export function GetInvitesForPlayer(playerId: string) {
    return [...(InvitesByRecipient.get(playerId)?.values() ?? [])]
        .map((Invite) => ({
            partyId: "none",
            recipientPlayerId: Invite.recipientPlayerId,
            sendingDisplayName: Invite.sendingDisplayName,
            sendingPlatform: Invite.sendingPlatform,
            sendingPlayerId: Invite.sendingPlayerId
        }));
}

export function DeletePartyInvite(recipientPlayerId: string, sendingPlayerId: string) {
    return DeleteInvite(recipientPlayerId, sendingPlayerId);
}

// TODO: What is vanilly expired age?
export function CleanupExpiredPartyInvites(now = Date.now(), maxAgeMs = 15 * 60 * 1000) {
    let Removed = 0;
    for (const [RecipientPlayerId, RecipientInvites] of InvitesByRecipient) {
        for (const [SendingPlayerId, Invite] of RecipientInvites) {
            if (now - Invite.createdAt > maxAgeMs) {
                RecipientInvites.delete(SendingPlayerId);
                Removed++;
            }
        }

        if (RecipientInvites.size === 0) {
            InvitesByRecipient.delete(RecipientPlayerId);
        }
    }

    return Removed;
}

export async function AcceptPartyInvite(recipientPlayerId: string, sendingPlayerId: string) {
    const Invite = InvitesByRecipient.get(recipientPlayerId)?.get(sendingPlayerId);
    if (Invite == undefined) {
        return { ok: false as const, status: 404, error: "invite_not_found" };
    }

    const Party = PartiesById.get(Invite.partyId);
    if (Party == undefined || !Party.members.has(sendingPlayerId)) {
        DeleteInvite(recipientPlayerId, sendingPlayerId);
        return { ok: false as const, status: 404, error: "party_not_found" };
    }

    if (Party.members.size >= MAX_PARTY_MEMBERS && !Party.members.has(recipientPlayerId)) {
        return { ok: false as const, status: 409, error: "party_full" };
    }

    AttachMemberToParty(Party, await BuildPartyMember(recipientPlayerId, Date.now()), true);
    DeleteInvitesForPlayer(recipientPlayerId);
    logger.info({
        partyId: Party.partyId,
        recipientPlayerId,
        sendingPlayerId,
        memberCount: Party.members.size
    }, "Accepted party invite");

    return { ok: true as const, party: Party };
}

export function LeaveParty(playerId: string) {
    return RemovePlayerFromCurrentParty(playerId);
}

export function ClearPlayerPartyForFreshLogin(playerId: string) {
    const Party = GetPartyForPlayer(playerId);
    const PartyId = Party?.partyId;
    const MemberCount = Party?.members.size ?? 0;

    DeleteInvitesForPlayer(playerId);
    RemovePlayerFromCurrentParty(playerId);

    return {
        removedFromParty: Party != undefined,
        partyId: PartyId,
        previousMemberCount: MemberCount
    };
}

export function KickPartyMember(requesterPlayerId: string, targetPlayerId: string) {
    const Party = GetPartyForPlayer(requesterPlayerId);
    if (Party == undefined || !Party.members.has(targetPlayerId)) {
        return { ok: false as const, status: 404, error: "party_member_not_found" };
    }

    RemoveMemberFromParty(Party, targetPlayerId, requesterPlayerId);
    return { ok: true as const };
}

export function PromotePartyMember(requesterPlayerId: string, targetPlayerId: string) {
    const Party = GetPartyForPlayer(requesterPlayerId);
    if (Party == undefined || !Party.members.has(targetPlayerId)) {
        return { ok: false as const, status: 404, error: "party_member_not_found" };
    }

    if (Party.leaderPlayerId !== requesterPlayerId) {
        return { ok: false as const, status: 403, error: "not_party_leader" };
    }

    Party.leaderPlayerId = targetPlayerId;
    MarkPartyChanged(Party);
    EmitPartyEvent(Party, []);
    return { ok: true as const };
}

export function SerializeParty(Party: Party, Candidate: {
    candidateId: string | null;
    candidateState: string | null;
    gauntletLevel?: number | null;
    playerHuntId: string | null;
    activePlayerIds?: string[];
} | undefined) {
    const ActivePlayers = new Set(Candidate?.activePlayerIds ?? []);
    const Base = GetSerializedPartyBase(Party);

    return {
        candidateId: Candidate?.candidateId ?? null,
        candidateState: Candidate?.candidateState ?? null,
        gauntletLevel: Candidate?.gauntletLevel ?? Base.gauntletLevel,
        leaderPlayerId: Base.leaderPlayerId,
        partyId: Base.partyId,
        playerHuntId: Candidate?.playerHuntId ?? null,
        playerStates: Base.playerStates.map((Member) => ({
            ...Member,
            isMemberOfCandidate: ActivePlayers.size > 0 ? ActivePlayers.has(Member.playerId) : false,
        }))
    };
}

export function ResetPartyStateForTests() {
    PartiesById.clear();
    PartyIdByPlayerId.clear();
    InvitesByRecipient.clear();
}

export function DrainPartyState(reason: string) {
    const PartyCount = PartiesById.size;
    const InviteCount = CountInvites();

    PartiesById.clear();
    PartyIdByPlayerId.clear();
    InvitesByRecipient.clear();

    return { reason, partyCount: PartyCount, inviteCount: InviteCount };
}

function RemovePlayerFromCurrentParty(playerId: string) {
    const Party = GetPartyForPlayer(playerId);
    if (Party == undefined) {
        RemovePlayerFromDuplicateParties(playerId, undefined);
        return { ok: true as const };
    }

    RemoveMemberFromParty(Party, playerId, undefined);
    return { ok: true as const };
}

function RemoveMemberFromParty(party: Party, playerId: string, requesterPlayerId: string | undefined) {
    if (!party.members.has(playerId)) {
        return;
    }

    party.members.delete(playerId);
    PartyIdByPlayerId.delete(playerId);
    DeleteInvitesForPlayer(playerId);
    MarkPartyChanged(party);

    if (party.members.size === 0) {
        PartiesById.delete(party.partyId);
        logger.info({ partyId: party.partyId, removedPlayerId: playerId }, "Dissolved empty party");
    }
    else if (party.leaderPlayerId === playerId) {
        party.leaderPlayerId = requesterPlayerId != undefined && party.members.has(requesterPlayerId)
            ? requesterPlayerId
            : OldestMember(party).playerId;
        logger.info({
            partyId: party.partyId,
            removedPlayerId: playerId,
            newLeaderPlayerId: party.leaderPlayerId,
            memberCount: party.members.size
        }, "Removed party leader");
    }
    else {
        logger.info({
            partyId: party.partyId,
            removedPlayerId: playerId,
            leaderPlayerId: party.leaderPlayerId,
            memberCount: party.members.size
        }, "Removed party member");
    }

    EmitPartyEvent(party, [playerId]);
}

function AttachMemberToParty(party: Party, member: PartyMember, removeExistingMembership: boolean) {
    if (removeExistingMembership) {
        RemovePlayerFromDuplicateParties(member.playerId, party.partyId);
    }

    party.members.set(member.playerId, member);
    PartyIdByPlayerId.set(member.playerId, party.partyId);
    MarkPartyChanged(party);
    EmitPartyEvent(party, []);
}

function OldestMember(party: Party) {
    let Oldest: PartyMember | undefined;
    for (const Member of party.members.values()) {
        if (Oldest == undefined || Member.joinedAt < Oldest.joinedAt) {
            Oldest = Member;
        }
    }

    return Oldest!;
}

function FindPartyContainingPlayer(playerId: string) {
    return [...PartiesById.values()].find((Party) => Party.members.has(playerId));
}

function RemovePlayerFromDuplicateParties(playerId: string, keepPartyId: string | undefined) {
    for (const Party of PartiesById.values()) {
        if (Party.partyId === keepPartyId || !Party.members.has(playerId)) {
            continue;
        }

        logger.warn({
            playerId,
            stalePartyId: Party.partyId,
            keepPartyId
        }, "Removing duplicate party membership");
        RemoveMemberFromParty(Party, playerId, undefined);
    }

    if (keepPartyId == undefined) {
        PartyIdByPlayerId.delete(playerId);
    }
}

function MarkPartyChanged(party: Party) {
    party.revision++;
}

function GetSerializedPartyBase(party: Party): SerializedPartyBase {
    if (party.serializedBase != undefined && party.serializedRevision === party.revision) {
        return party.serializedBase;
    }

    party.serializedBase = {
        gauntletLevel: null,
        leaderPlayerId: party.leaderPlayerId,
        partyId: party.partyId,
        playerStates: [...party.members.values()].map((Member) => ({
            consoleSessionId: Member.consoleSessionId,
            displayName: Member.displayName,
            platform: Member.platform,
            playerId: Member.playerId
        }))
    };
    party.serializedRevision = party.revision;
    return party.serializedBase;
}

function CreatePartyId(buildId: string) {
    return `${randomBytes(16).toString("hex")}_${Buffer.from(buildId).toString("base64")}`;
}

function StoreInvite(invite: PartyInvite) {
    const RecipientInvites = InvitesByRecipient.get(invite.recipientPlayerId) ?? new Map<string, PartyInvite>();
    RecipientInvites.set(invite.sendingPlayerId, invite);
    InvitesByRecipient.set(invite.recipientPlayerId, RecipientInvites);
}

function DeleteInvite(recipientPlayerId: string, sendingPlayerId: string) {
    const RecipientInvites = InvitesByRecipient.get(recipientPlayerId);
    if (RecipientInvites == undefined) {
        return false;
    }

    const Removed = RecipientInvites.delete(sendingPlayerId);
    if (RecipientInvites.size === 0) {
        InvitesByRecipient.delete(recipientPlayerId);
    }

    return Removed;
}

function DeleteInvitesForPlayer(playerId: string) {
    InvitesByRecipient.delete(playerId);

    for (const [RecipientPlayerId, RecipientInvites] of InvitesByRecipient.entries()) {
        RecipientInvites.delete(playerId);
        if (RecipientInvites.size === 0) {
            InvitesByRecipient.delete(RecipientPlayerId);
        }
    }
}

function CountInvites() {
    return [...InvitesByRecipient.values()].reduce((Count, RecipientInvites) => Count + RecipientInvites.size, 0);
}

async function BuildPartyMember(playerId: string, joinedAt: number): Promise<PartyMember> {
    return {
        playerId,
        displayName: await ResolveDisplayName(playerId),
        platform: "win",
        consoleSessionId: null,
        joinedAt
    };
}

async function ResolveDisplayName(playerId: string) {
    try {
        return await GetUsernameForUserId(playerId);
    }
    catch {
        return playerId;
    }
}

function EmitPartyEvent(party: Party, removedPlayerIds: string[]) {
    const IsDissolved = !PartiesById.has(party.partyId);
    const Event: PartyEvent = {
        partyId: party.partyId,
        leaderPlayerId: IsDissolved ? null : party.leaderPlayerId,
        memberPlayerIds: IsDissolved ? [] : [...party.members.keys()],
        removedPlayerIds,
        revision: party.revision
    };
    for (const Listener of Listeners) {
        Listener(Event);
    }
}
