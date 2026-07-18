import "./testEnvironment";
import assert from "assert";
import http from "http";

type PartyState = {
    candidateId: string | null;
    candidateState: string | null;
    gauntletLevel: null;
    leaderPlayerId: string;
    partyId: string;
    playerHuntId: string | null;
    playerStates: Array<{
        consoleSessionId: null;
        displayName: string | null;
        isMemberOfCandidate: boolean;
        platform: string | null;
        playerId: string;
    }>;
};

type CandidateStatus = {
    candidateId: string;
    candidateStatusPeriodMillis: number;
    gameMode: string;
    huntId: string;
    playerStates: Record<string, unknown>;
    serverInfo?: {
        buildId: string;
        gameSessionId: string;
        host: string;
        port: number;
    };
    status: string;
    statusDuration: number;
    statusReason: string | null;
};

type DeployRequest = {
    GameMode: string;
    GameArgs: string;
    HuntId: string;
    ExpectedPlayers: string[];
};

const A = "3YRXP4UL3BCT7MM2C7Y5ODS4SU";
const B = "U2BLWVTDHZGWLBKKLY2QG6UX4I";
const C = "XQBF5VHGFJHR5AUILEPYI55MUQ";
const D = "OGHJPP7GHNFR3JFNWDZ5PKZK2Q";
const E = "EX2HTT6N75HFRLSYYGQRQWRBAE";
const F = "YDEVXPSWGVH25KVD77DLJEAGYQ";
const G = "K5CLRVB47NDTPKYN5P7EMDOGG4";
const H = "YGCW2QNUTFD4NME2MH4U2HCS2U";

export async function runSelftest() {
    process.env.PROTOCOL_FILE_LOG = "false";
    process.env.MATCHMAKING_MODE = "DEPLOYSERVER";
    process.env.MATCHMAKING_QUEUE_WAIT_SECONDS = "60";
    process.env.DEPLOYSERVER_MATCHMAKING_TIMEOUT_MS = "2000";
    process.env.DEPLOYSERVER_STATUS_TIMEOUT_MS = "2000";

    const DeployRequests: DeployRequest[] = [];
    const DeployServer = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/api/matchmaker/handle-matchmaking-for-player") {
            void readJson<DeployRequest>(req).then((Body) => {
                DeployRequests.push(Body);
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({
                    id: `server-${DeployRequests.length}`,
                    host: "127.0.0.1",
                    port: 7000 + DeployRequests.length
                }));
            });
            return;
        }

        if (req.method === "POST" && req.url === "/api/matchmaker/player-server-status") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({
                found: false,
                joinable: false
            }));
            return;
        }

        if (req.method === "POST" && req.url === "/api/matchmaker/touch-player") {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ touched: false }));
            return;
        }

        res.statusCode = 404;
        res.end();
    });

    await new Promise<void>((resolve) => DeployServer.listen(0, "127.0.0.1", resolve));
    const DeployAddress = DeployServer.address();
    assert(DeployAddress != undefined && typeof DeployAddress !== "string");
    process.env.DEPLOYSERVER_URL = `127.0.0.1:${DeployAddress.port}`;

    const { app } = await import("../app");
    const { SignMetagameJWTForUid } = await import("../controllers/auth");
    const { RememberUsernameForUserId } = await import("../controllers/login");
    const { ResetPartyStateForTests } = await import("../controllers/party");
    const { GetRecentPlayerData } = await import("../controllers/undauntedapi");
    const { GetDb } = await import("../db");
    const { users } = await import("../db/schema");

    ResetPartyStateForTests();
    for (const [PlayerId, Name] of [
        [A, "Player A"],
        [B, "Player B"],
        [C, "Player C"],
        [D, "Player D"],
        [E, "Player E"],
        [F, "Player F"],
        [G, "Player G"],
        [H, "Player H"]
    ] as const) {
        RememberUsernameForUserId(PlayerId, Name);
        await GetDb().insert(users).values({
            userId: PlayerId,
            name: Name,
            notes: 0
        }).onConflictDoUpdate({
            target: users.userId,
            set: {
                name: Name,
                notes: 0
            }
        });
    }

    const Server = http.createServer(app);
    await new Promise<void>((resolve) => Server.listen(0, "127.0.0.1", resolve));

    const Address = Server.address();
    assert(Address != undefined && typeof Address !== "string");
    const BaseUrl = `http://127.0.0.1:${Address.port}`;
    const Token = (PlayerId: string) => SignMetagameJWTForUid(PlayerId);

    try {
        const PartyA = await postJson<PartyState>(`${BaseUrl}/party`, Token(A), PartyRequest());
        assert.strictEqual(PartyA.candidateId, null);
        assert.strictEqual(PartyA.candidateState, null);
        assert.strictEqual(PartyA.leaderPlayerId, A);
        assert.match(PartyA.partyId, /^[a-f0-9]{32}_MjM5ODI3XzEuNC40X3NoaXBwaW5n$/);
        assert.deepStrictEqual(PartyA.playerStates.map((State) => State.playerId), [A]);
        assert.strictEqual(PartyA.playerStates[0].displayName, "Player A");
        assert.strictEqual(PartyA.playerStates[0].isMemberOfCandidate, false);
        const RepeatedPartyA = await postJson<PartyState>(`${BaseUrl}/party`, Token(A), PartyRequest());
        assert.deepStrictEqual(RepeatedPartyA, PartyA);

        await invite(BaseUrl, Token(A), B);
        const InvitesB = await getJson<{ invitations: any[] }>(`${BaseUrl}/party/invites`, Token(B));
        assert.strictEqual(InvitesB.invitations.length, 1);
        assert.deepStrictEqual(InvitesB.invitations[0], {
            partyId: "none",
            recipientPlayerId: B,
            sendingDisplayName: "Player A",
            sendingPlatform: "win",
            sendingPlayerId: A
        });

        const RepolledInvitesB = await getJson<{ invitations: any[] }>(`${BaseUrl}/party/invites`, Token(B));
        assert.deepStrictEqual(RepolledInvitesB, InvitesB);

        await putJson(`${BaseUrl}/party/invite/accept/${A}`, Token(B), AcceptInviteRequest(A));
        const ClearedInvitesB = await getJson<{ invitations: any[] }>(`${BaseUrl}/party/invites`, Token(B));
        assert.deepStrictEqual(ClearedInvitesB.invitations, []);

        let PartyB = await postJson<PartyState>(`${BaseUrl}/party`, Token(B), PartyRequest());
        assert.strictEqual(PartyB.partyId, PartyA.partyId);
        assert.deepStrictEqual(PartyB.playerStates.map((State) => State.playerId), [A, B]);

        await putJson(`${BaseUrl}/party/member/promote/${B}`, Token(A), {});
        PartyB = await postJson<PartyState>(`${BaseUrl}/party`, Token(B), PartyRequest());
        assert.strictEqual(PartyB.leaderPlayerId, B);

        await invite(BaseUrl, Token(B), C);
        await putJson(`${BaseUrl}/party/invite/accept/${B}`, Token(C), AcceptInviteRequest(B));
        await invite(BaseUrl, Token(B), D);
        await putJson(`${BaseUrl}/party/invite/accept/${B}`, Token(D), AcceptInviteRequest(B));
        const FullInvite = await putJsonRaw(`${BaseUrl}/party/invite`, Token(B), {
            recipientPlayerId: E,
            partyId: "",
            ...PartyRequest()
        });
        assert.strictEqual(FullInvite.status, 409);

        await deleteJson(`${BaseUrl}/party/member/${B}`, Token(C));
        let PartyC = await postJson<PartyState>(`${BaseUrl}/party`, Token(C), PartyRequest());
        assert.strictEqual(PartyC.leaderPlayerId, C);
        assert.deepStrictEqual(PartyC.playerStates.map((State) => State.playerId), [A, C, D]);

        await deleteJson(`${BaseUrl}/party/member/${D}`, Token(A));
        PartyC = await postJson<PartyState>(`${BaseUrl}/party`, Token(C), PartyRequest());
        assert.deepStrictEqual(PartyC.playerStates.map((State) => State.playerId), [A, C]);

        await deleteJson(`${BaseUrl}/party/member`, Token(A));
        PartyC = await postJson<PartyState>(`${BaseUrl}/party`, Token(C), PartyRequest());
        assert.deepStrictEqual(PartyC.playerStates.map((State) => State.playerId), [C]);

        await deleteJson(`${BaseUrl}/party/member`, Token(C));
        const NewPartyC = await postJson<PartyState>(`${BaseUrl}/party`, Token(C), PartyRequest());
        assert.notStrictEqual(NewPartyC.partyId, PartyA.partyId);

        const Voice = await postJson<any>(`${BaseUrl}/evoice/join/party`, Token(C), {});
        assert.strictEqual(Voice.party_id, NewPartyC.partyId);
        assert.strictEqual(Voice.channel_name, `PARTY.${NewPartyC.partyId.split("_")[0]}`);
        assert.strictEqual(Voice.client_base_url, "");
        assert.strictEqual(Voice.participant_token, "");

        await invite(BaseUrl, Token(A), B);
        await putJson(`${BaseUrl}/party/invite/accept/${A}`, Token(B), AcceptInviteRequest(A));
        const CleanupPartyA = await postJson<PartyState>(`${BaseUrl}/party`, Token(A), PartyRequest());
        assert.deepStrictEqual(CleanupPartyA.playerStates.map((State) => State.playerId), [A, B]);
        await invite(BaseUrl, Token(C), A);
        const CleanupQueueJoin = await postJson<any>(`${BaseUrl}/candidate/join`, Token(A), {
            ...JoinRequest(CleanupPartyA.partyId, "PublicIsland_LoginCleanup"),
            privateMatch: false,
            isPrivate: false
        });
        assert.strictEqual(CleanupQueueJoin.status, "QUEUED_FOR_START");

        await login(BaseUrl, Token(A), A);
        const ClearedInvitesA = await getJson<{ invitations: any[] }>(`${BaseUrl}/party/invites`, Token(A));
        assert.deepStrictEqual(ClearedInvitesA.invitations, []);
        const PartyBAfterLoginA = await postJson<PartyState>(`${BaseUrl}/party`, Token(B), PartyRequest());
        assert.strictEqual(PartyBAfterLoginA.partyId, CleanupPartyA.partyId);
        assert.strictEqual(PartyBAfterLoginA.leaderPlayerId, B);
        assert.deepStrictEqual(PartyBAfterLoginA.playerStates.map((State) => State.playerId), [B]);
        const PartyAAfterLogin = await postJson<PartyState>(`${BaseUrl}/party`, Token(A), PartyRequest());
        assert.notStrictEqual(PartyAAfterLogin.partyId, CleanupPartyA.partyId);
        assert.deepStrictEqual(PartyAAfterLogin.playerStates.map((State) => State.playerId), [A]);
        assert.strictEqual((await getRaw(`${BaseUrl}/candidate/status`, Token(A))).status, 404);
        assert.strictEqual((await getRaw(`${BaseUrl}/candidate/status`, Token(B))).status, 404);

        await invite(BaseUrl, Token(F), G);
        await putJson(`${BaseUrl}/party/invite/accept/${F}`, Token(G), AcceptInviteRequest(F));
        const PartyF = await postJson<PartyState>(`${BaseUrl}/party`, Token(F), PartyRequest());
        const PrivateJoin = await postJson<any>(`${BaseUrl}/candidate/join`, Token(F), {
            ...JoinRequest(PartyF.partyId, "PrivateIsland_A"),
            privateMatch: true,
            isPrivate: true
        });
        assert.strictEqual(PrivateJoin.status, "IN_PROGRESS");
        assert.deepStrictEqual(DeployRequests.at(-1)?.ExpectedPlayers, [F, G]);

        const StatusG = await getJson<CandidateStatus>(`${BaseUrl}/candidate/status`, Token(G));
        assert.strictEqual(StatusG.candidateId, PrivateJoin.candidateId);
        assert.strictEqual(StatusG.status, "IN_PROGRESS");
        assert.deepStrictEqual(Object.keys(StatusG.playerStates), [F, G]);
        assert.strictEqual(StatusG.serverInfo?.port, PrivateJoin.serverInfo.port);

        const PartyFInCandidate = await postJson<PartyState>(`${BaseUrl}/party`, Token(F), PartyRequest());
        assert.strictEqual(PartyFInCandidate.candidateId, PrivateJoin.candidateId);
        assert.strictEqual(PartyFInCandidate.candidateState, "IN_PROGRESS");
        assert.deepStrictEqual(PartyFInCandidate.playerStates.map((State) => State.isMemberOfCandidate), [true, true]);

        await invite(BaseUrl, Token(H), E);
        await putJson(`${BaseUrl}/party/invite/accept/${H}`, Token(E), AcceptInviteRequest(H));
        const PartyH = await postJson<PartyState>(`${BaseUrl}/party`, Token(H), PartyRequest());
        const PublicJoin = await postJson<any>(`${BaseUrl}/candidate/join`, Token(H), {
            ...JoinRequest(PartyH.partyId, "PublicIsland_A"),
            privateMatch: false,
            isPrivate: false
        });
        assert.strictEqual(PublicJoin.status, "QUEUED_FOR_START");
        assert.strictEqual(DeployRequests.length, 1);
        const QueuedActivityBeforeStatus = await MatchmakingUpdatedTime(GetRecentPlayerData, E);
        assert.notStrictEqual(QueuedActivityBeforeStatus, undefined);
        await sleep(10);

        const QueuedStatusE = await getJson<CandidateStatus>(`${BaseUrl}/candidate/status`, Token(E));
        assert.strictEqual(QueuedStatusE.candidateId, PublicJoin.candidateId);
        assert.strictEqual(QueuedStatusE.status, "QUEUED_FOR_START");
        assert.deepStrictEqual(Object.keys(QueuedStatusE.playerStates), [H, E]);
        const QueuedActivityAfterStatus = await MatchmakingUpdatedTime(GetRecentPlayerData, E);
        assert.strictEqual(QueuedActivityAfterStatus, QueuedActivityBeforeStatus);

        const RepeatedPublicJoin = await postJson<any>(`${BaseUrl}/candidate/join`, Token(H), {
            ...JoinRequest(PartyH.partyId, "PublicIsland_A"),
            privateMatch: false,
            isPrivate: false
        });
        assert.strictEqual(RepeatedPublicJoin.candidateId, PublicJoin.candidateId);
        assert.strictEqual(RepeatedPublicJoin.status, "QUEUED_FOR_START");
        assert.strictEqual(DeployRequests.length, 1);

        const PublicJoinSecondGroup = await postJson<any>(`${BaseUrl}/candidate/join`, Token(F), {
            ...JoinRequest(PartyF.partyId, "PublicIsland_A"),
            privateMatch: false,
            isPrivate: false
        });
        assert.strictEqual(PublicJoinSecondGroup.status, "IN_PROGRESS");
        assert.deepStrictEqual(DeployRequests.at(-1)?.ExpectedPlayers, [H, E, F, G]);

        const StatusE = await getJson<CandidateStatus>(`${BaseUrl}/candidate/status`, Token(E));
        assert.strictEqual(StatusE.candidateId, PublicJoin.candidateId);
        assert.strictEqual(StatusE.status, "IN_PROGRESS");
        assert.deepStrictEqual(Object.keys(StatusE.playerStates), [H, E]);
        assert.strictEqual(StatusE.serverInfo?.port, PublicJoinSecondGroup.serverInfo.port);

        await login(BaseUrl, Token(F), F);
        const ReadyStatusFAfterLogin = await getJson<CandidateStatus>(`${BaseUrl}/candidate/status`, Token(F));
        assert.strictEqual(ReadyStatusFAfterLogin.candidateId, PublicJoinSecondGroup.candidateId);
        assert.strictEqual(ReadyStatusFAfterLogin.status, "IN_PROGRESS");
    } finally {
        await new Promise<void>((resolve) => Server.close(() => resolve()));
        await new Promise<void>((resolve) => DeployServer.close(() => resolve()));
    }
}

async function MatchmakingUpdatedTime(getRecentPlayerData: typeof import("../controllers/undauntedapi").GetRecentPlayerData, playerId: string) {
    return (await getRecentPlayerData()).find((Player) => Player.UserId === playerId)?.Matchmaking?.UpdatedTime;
}

function sleep(milliseconds: number) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function PartyRequest() {
    return {
        buildId: "239827_1.4.4_shipping",
        featureOverrides: []
    };
}

function AcceptInviteRequest(inviterPlayerId: string) {
    return {
        recipientPlayerId: inviterPlayerId,
        partyId: inviterPlayerId,
        ...PartyRequest()
    };
}

function JoinRequest(partyId: string, playerHuntId: string) {
    return {
        allow_crossplay: true,
        buildId: "239827_1.4.4_shipping",
        gameArgs: "",
        gameMode: "ISLAND",
        gameType: "HUNTING_GROUND",
        partyId,
        playerHuntId,
        playerId: "",
        regionUrlsPings: {},
        session_id: "test-session"
    };
}

async function invite(baseUrl: string, token: string, recipientPlayerId: string) {
    await putJson(`${baseUrl}/party/invite`, token, {
        recipientPlayerId,
        partyId: "",
        ...PartyRequest()
    });
}

async function login(baseUrl: string, token: string, playerId: string) {
    const Response = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            email: playerId
        })
    });

    if (Response.status !== 200) {
        assert.fail(`/login should return 200 but returned ${Response.status}: ${await Response.text()}`);
    }

    const Body = await Response.json() as { error_code: string; state: string };
    assert.strictEqual(Body.error_code, "TicketRateOk");
    assert.strictEqual(Body.state, "OPEN");
}

async function postJson<T>(url: string, token: string, body: Record<string, any>): Promise<T> {
    const Response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (Response.status !== 200) {
        assert.fail(`${url} should return 200 but returned ${Response.status}: ${await Response.text()}`);
    }

    return await Response.json() as T;
}

async function putJson(url: string, token: string, body: Record<string, any>) {
    const Response = await putJsonRaw(url, token, body);
    if (Response.status !== 200) {
        assert.fail(`${url} should return 200 but returned ${Response.status}: ${Response.body}`);
    }
}

async function putJsonRaw(url: string, token: string, body: Record<string, any>) {
    const Response = await fetch(url, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    return {
        status: Response.status,
        body: await Response.text()
    };
}

async function deleteJson(url: string, token: string) {
    const Response = await fetch(url, {
        method: "DELETE",
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    if (Response.status !== 200) {
        assert.fail(`${url} should return 200 but returned ${Response.status}: ${await Response.text()}`);
    }
}

async function getRaw(url: string, token: string) {
    const Response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    return {
        status: Response.status,
        body: await Response.text()
    };
}

async function getJson<T>(url: string, token: string): Promise<T> {
    const Response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`
        }
    });

    if (Response.status !== 200) {
        assert.fail(`${url} should return 200 but returned ${Response.status}: ${await Response.text()}`);
    }

    return await Response.json() as T;
}

function readJson<T>(request: http.IncomingMessage) {
    return new Promise<T>((resolve, reject) => {
        const Chunks: Buffer[] = [];
        request.on("data", (Chunk) => Chunks.push(Buffer.from(Chunk)));
        request.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(Chunks).toString("utf8")) as T);
            }
            catch (Error) {
                reject(Error);
            }
        });
        request.on("error", reject);
    });
}

if (require.main === module) void runSelftest().catch((error) => { console.error(error); process.exitCode = 1; });
