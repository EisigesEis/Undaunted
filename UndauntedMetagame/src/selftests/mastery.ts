import "./testEnvironment";
import assert from "node:assert";
import crypto from "node:crypto";
import http from "node:http";
import { app } from "../app";
import { GetDb } from "../db";
import { gameserverapikeys, users } from "../db/schema";
import { SignMetagameJWTForUid } from "../controllers/auth";
import progressionConfig from "../vendor/progression_config.json";
import { ApplyMasterySnapshot, RankForTrackProgress } from "../controllers/mastery";

export async function runSelftest() {
  await GetDb().insert(users).values([
    { userId: "mastery-user", name: "Mastery", notes: 0, isAdmin: false },
    { userId: "captured-mastery-user", name: "Captured Mastery", notes: 0, isAdmin: false },
    { userId: "other-user", name: "Other", notes: 0, isAdmin: false }
  ]).onConflictDoNothing();
  const gameserverKey = "isolated-mastery-gameserver";
  await GetDb().insert(gameserverapikeys).values({ keyHash: crypto.createHash("sha256").update(gameserverKey).digest("hex") }).onConflictDoNothing();
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const request = async (userId: string, url: string, init?: RequestInit) => {
    const response = await fetch(base + url, { ...init, headers: { Authorization: `Bearer ${SignMetagameJWTForUid(userId)}`, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) as any : undefined };
  };
  const charroggObjectives = [
    "MasteryObjective_Behemoth_Charrogg_Craft_Armor",
    "MasteryObjective_Behemoth_Charrogg_Craft_Armor_5",
    "MasteryObjective_Behemoth_Charrogg_Craft_Armor_10"
  ];
  try {
    const initialTracks = (await request("mastery-user", "/progression/mastery-user")).json.payload;
    const returnedTrackIds = new Set(initialTracks.map((track: any) => track.progression_id));
    for (const configuredTrack of progressionConfig.payload.paths as { progression_id: string }[])
      assert.ok(returnedTrackIds.has(configuredTrack.progression_id));
    assert.ok(initialTracks.some((track: any) => track.progression_id === "MasteryTrack_Behemoth" && track.progress === 0));
    // Player level starts at rank 1 with zero XP
    assert.strictEqual(RankForTrackProgress("MasteryTrack_PlayerLevel", 0), 1);
    assert.strictEqual(RankForTrackProgress("MasteryTrack_Behemoth", 0), 0);
    for (const objectiveId of charroggObjectives) {
      const response = await request("mastery-user", `/progression/objectives/mastery-user/${objectiveId}`);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.json.payload, {
        phx_account_id: "mastery-user", objective_id: objectiveId, progress: 0, completed_count: 0,
        created_date: response.json.payload.created_date, last_modified_date: response.json.payload.last_modified_date
      });
    }

    const first = {
      playerObjectives: [{ ObjectiveId: charroggObjectives[0], Value: 1, CompletedCount: 1 }],
      ProgresstrackEvents: [
        { Track: "MasteryTrack_PlayerLevel", Amount: 1 },
        { Track: "MasteryTrack_Behemoth", Amount: 1 }
      ]
    };
    const firstResponse = await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(first) });
    assert.strictEqual(firstResponse.status, 200);
    assert.deepStrictEqual(firstResponse.json, {
      code: null,
      message: "OK",
      payload: {
        progress_tracks: [
          { phx_account_id: "mastery-user", progression_id: "MasteryTrack_PlayerLevel", progress: 1, confirmed_fremium_rank: 0, confirmed_premium_rank: 0, confirmed_date: null },
          { phx_account_id: "mastery-user", progression_id: "MasteryTrack_Behemoth", progress: 1, confirmed_fremium_rank: 0, confirmed_premium_rank: 0, confirmed_date: null }
        ],
        objectives: [{
          phx_account_id: "mastery-user", objective_id: charroggObjectives[0], progress: 1, completed_count: 1,
          created_date: firstResponse.json.payload.objectives[0].created_date,
          last_modified_date: firstResponse.json.payload.objectives[0].last_modified_date
        }]
      }
    });
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_PlayerLevel")).json.payload.progress, 1);
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 1);
    assert.strictEqual(RankForTrackProgress("MasteryTrack_PlayerLevel", 1), 2);
    const storedObjective = await request("mastery-user", `/progression/objectives/mastery-user/${charroggObjectives[0]}`);
    assert.strictEqual(storedObjective.json.payload.progress, 1);
    assert.strictEqual(storedObjective.json.payload.completed_count, 1);

    // Every accepted delta is a grant
    const replayedFirst = await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(first) });
    assert.strictEqual(replayedFirst.status, 200);
    assert.deepStrictEqual(replayedFirst.json.payload.progress_tracks.map((track: any) => [track.progression_id, track.progress]), [
      ["MasteryTrack_PlayerLevel", 2],
      ["MasteryTrack_Behemoth", 2]
    ]);
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_PlayerLevel")).json.payload.progress, 2);
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 2);

    const higher = {
      playerObjectives: [{ ObjectiveId: charroggObjectives[0], Value: 5, CompletedCount: 2 }],
      ProgresstrackEvents: [
        { Track: "MasteryTrack_PlayerLevel", Amount: 1 },
        { Track: "MasteryTrack_Behemoth", Amount: 1 }
      ]
    };
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(higher) })).status, 200);
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_PlayerLevel")).json.payload.progress, 3);
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 3);
    const allObjectives = await request("mastery-user", "/progression/objectives/mastery-user");
    assert.ok(Array.isArray(allObjectives.json.payload));
    assert.strictEqual(allObjectives.json.payload.find((entry: any) => entry.objective_id === charroggObjectives[0]).completed_count, 2);
    assert.strictEqual((await request("other-user", "/progression/objectives/mastery-user")).status, 403);

    // Identical grants both count
    const hammerTrack = "MasteryTrack_Weapon_Hammer";
    const progressOnly = { ProgressEvents: [{ Track: hammerTrack, Amount: 7 }] };
    const progressOnlyResponse = await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(progressOnly) });
    assert.deepStrictEqual(progressOnlyResponse.json.payload, {
      progress_tracks: [{ phx_account_id: "mastery-user", progression_id: hammerTrack, progress: 7, confirmed_fremium_rank: 0, confirmed_premium_rank: 0, confirmed_date: null }],
      objectives: []
    });
    assert.strictEqual((await request("mastery-user", `/progression/mastery-user/${hammerTrack}`)).json.payload.progress, 7);
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(progressOnly) })).status, 200);
    assert.strictEqual((await request("mastery-user", `/progression/mastery-user/${hammerTrack}`)).json.payload.progress, 14);

    // Objectives can update without track XP
    const objectiveOnlyId = "MasteryObjective_Test_ObjectiveOnly";
    const objectiveOnly = { PlayerObjectives: [{ ObjectiveId: objectiveOnlyId, Value: 3, CompletedCount: 1 }] };
    const objectiveOnlyResponse = await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(objectiveOnly) });
    assert.deepStrictEqual(objectiveOnlyResponse.json.payload, {
      progress_tracks: [],
      objectives: [{
        phx_account_id: "mastery-user", objective_id: objectiveOnlyId, progress: 3, completed_count: 1,
        created_date: objectiveOnlyResponse.json.payload.objectives[0].created_date,
        last_modified_date: objectiveOnlyResponse.json.payload.objectives[0].last_modified_date
      }]
    });
    assert.strictEqual((await request("mastery-user", `/progression/objectives/mastery-user/${objectiveOnlyId}`)).json.payload.progress, 3);

    // Unchanged objectives must not block XP
    const unchangedObjectiveWithEvent = {
      PlayerObjectives: [{ ObjectiveId: objectiveOnlyId, Value: 3, CompletedCount: 1 }],
      ProgressEvents: [{ Track: hammerTrack, Amount: 4 }]
    };
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(unchangedObjectiveWithEvent) })).status, 200);
    assert.strictEqual((await request("mastery-user", `/progression/mastery-user/${hammerTrack}`)).json.payload.progress, 18);

    // Changed objectives make this a new grant
    const changedObjectiveWithRepeatedEvent = {
      PlayerObjectives: [{ ObjectiveId: objectiveOnlyId, Value: 4, CompletedCount: 2 }],
      ProgressEvents: [{ Track: hammerTrack, Amount: 4 }]
    };
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(changedObjectiveWithRepeatedEvent) })).status, 200);
    assert.strictEqual((await request("mastery-user", `/progression/mastery-user/${hammerTrack}`)).json.payload.progress, 22);
    assert.strictEqual((await request("mastery-user", `/progression/objectives/mastery-user/${objectiveOnlyId}`)).json.payload.progress, 4);

    // Duplicate rows are merged before writing
    const batchedTrack = "MasteryTrack_Weapon_Axe";
    const batched = {
      PlayerObjectives: [
        { ObjectiveId: "MasteryObjective_Test_Batched", Value: 2, CompletedCount: 3 },
        { ObjectiveId: "MasteryObjective_Test_Batched", Value: 7, CompletedCount: 1 }
      ],
      ProgressEvents: [
        { Track: batchedTrack, Amount: 2 },
        { Track: batchedTrack, Amount: 5 }
      ]
    };
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(batched) })).status, 200);
    const batchedObjective = (await request("mastery-user", "/progression/objectives/mastery-user/MasteryObjective_Test_Batched")).json.payload;
    assert.strictEqual(batchedObjective.progress, 7);
    assert.strictEqual(batchedObjective.completed_count, 3);
    assert.strictEqual((await request("mastery-user", `/progression/mastery-user/${batchedTrack}`)).json.payload.progress, 7);

    const suffixedNative = {
      playerObjectives_9_508B7A614866684F67DD7D831D92E669: [],
      ProgresstrackEvents_12_B543EB8344EC249BE21E0489F54C8161: [{ Track: batchedTrack, Amount: 1 }]
    };
    const suffixedResponse = await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(suffixedNative) });
    assert.deepStrictEqual(suffixedResponse.json.payload, {
      progress_tracks: [{ phx_account_id: "mastery-user", progression_id: batchedTrack, progress: 8, confirmed_fremium_rank: 0, confirmed_premium_rank: 0, confirmed_date: null }],
      objectives: []
    });
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(batched) })).status, 200);
    assert.strictEqual((await request("mastery-user", `/progression/mastery-user/${batchedTrack}`)).json.payload.progress, 15);

    // Zero XP is a no-op
    const zeroDelta = { ProgressEvents: [{ Track: batchedTrack, Amount: 0 }] };
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(zeroDelta) })).status, 200);
    assert.strictEqual((await request("mastery-user", `/progression/mastery-user/${batchedTrack}`)).json.payload.progress, 15);

    // Confirmation works without receipt storage
    const confirmation = await request("mastery-user", `/progression/mastery-user/${batchedTrack}/1/confirm/freemium`, { method: "POST" });
    assert.strictEqual(confirmation.status, 200);
    assert.strictEqual(confirmation.json.payload.confirmed_fremium_rank, 1);

    // Snapshots never lower saved totals
    const objectivesOnlySnapshot = { objectives: [{ objectiveId: "MasteryObjective_Test_SnapshotObjective", value: 8, completedCount: 2 }], progressTracks: [] };
    ApplyMasterySnapshot("mastery-user", objectivesOnlySnapshot);
    assert.strictEqual((await request("mastery-user", "/progression/objectives/mastery-user/MasteryObjective_Test_SnapshotObjective")).json.payload.progress, 8);
    const tracksOnlySnapshot = { objectives: [], progressTracks: [{ track: hammerTrack, progress: 20 }] };
    ApplyMasterySnapshot("mastery-user", tracksOnlySnapshot);
    assert.strictEqual((await request("mastery-user", `/progression/mastery-user/${hammerTrack}`)).json.payload.progress, 22);
    const lowerSnapshot = { objectives: [{ objectiveId: "MasteryObjective_Test_SnapshotObjective", value: 2, completedCount: 0 }], progressTracks: [{ track: hammerTrack, progress: 1 }] };
    ApplyMasterySnapshot("mastery-user", lowerSnapshot);
    assert.strictEqual((await request("mastery-user", "/progression/objectives/mastery-user/MasteryObjective_Test_SnapshotObjective")).json.payload.progress, 8);
    assert.strictEqual((await request("mastery-user", `/progression/mastery-user/${hammerTrack}`)).json.payload.progress, 22);

    // Bad mastery values are rejected
    for (const invalid of [
      { ProgressEvents: [{ Track: hammerTrack, Amount: -1 }] },
      { ProgressEvents: [{ Track: hammerTrack, Amount: 1.5 }] },
      { PlayerObjectives: [{ ObjectiveId: "MasteryObjective_Test_Invalid", Value: Number.MAX_SAFE_INTEGER + 1, CompletedCount: 0 }] },
      { objectives: [{ objective_id: "MasteryObjective_Test_Invalid", value: 1, completed_count: 0 }], progress_tracks: [{ progression_id: hammerTrack, progress: -1 }] }
    ]) {
      const invalidResponse = await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(invalid) });
      assert.strictEqual(invalidResponse.status, 400);
    }

    // Keep old handshake requests working
    for (const body of [{}, { nativeShapeStillUnderInvestigation: true }]) {
      const compatible = await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(body) });
      assert.strictEqual(compatible.status, 200);
      assert.deepStrictEqual(compatible.json, { code: null, message: "OK", payload: {} });
    }
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 3);
    const directGrant = await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth/10", { method: "POST" });
    assert.strictEqual(directGrant.status, 200);
    assert.strictEqual(directGrant.json.payload.progress, 13);

    // Game servers may only send their API key
    const serverGrantResponse = await fetch(base + "/progression/mastery-user", {
      method: "POST",
      headers: { "x-undaunted-gameserver-apikey": gameserverKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        PlayerObjectives: [{ ObjectiveId: charroggObjectives[1], Value: 1, CompletedCount: 0 }],
        ProgressEvents: [
          { Track: "MasteryTrack_PlayerLevel", Amount: 1 },
          { Track: "MasteryTrack_Behemoth", Amount: 5 }
        ]
      })
    });
    assert.strictEqual(serverGrantResponse.status, 200);
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_PlayerLevel")).json.payload.progress, 4);
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 18);

    // Captured snake-case requests carry track increments, including the initial grant from zero.
    const capturedBootstrap = {
      objectives: [{ objective_id: "MasteryObjective_Behemoth_Charrogg_Craft_Armor", value: 1, completed_count: 1 }],
      progress_tracks: [
        { progression_id: "MasteryTrack_PlayerLevel", progress: 484 },
        { progression_id: "MasteryTrack_Behemoth", progress: 63 },
        { progression_id: "MasteryTrack_Weapon_Hammer", progress: 61 },
        { progression_id: "MasteryTrack_Weapon_Axe", progress: 58 }
      ]
    };
    const capturedResponse = await fetch(base + "/progression/captured-mastery-user", {
      method: "POST",
      headers: { "x-undaunted-gameserver-apikey": gameserverKey, "Content-Type": "application/json" },
      body: JSON.stringify(capturedBootstrap)
    });
    assert.strictEqual(capturedResponse.status, 200);
    const capturedResponseBody = await capturedResponse.json() as any;
    assert.deepStrictEqual(capturedResponseBody.payload.progress_tracks.map((track: any) => [track.progression_id, track.progress]), [
      ["MasteryTrack_PlayerLevel", 484],
      ["MasteryTrack_Behemoth", 63],
      ["MasteryTrack_Weapon_Hammer", 61],
      ["MasteryTrack_Weapon_Axe", 58]
    ]);
    assert.strictEqual((await request("captured-mastery-user", "/progression/objectives/captured-mastery-user/MasteryObjective_Behemoth_Charrogg_Craft_Armor")).json.payload.progress, 1);

    // A later gameplay request adds its small values instead of treating them as totals.
    const capturedGameplay = {
      progress_tracks: [
        { progression_id: "MasteryTrack_PlayerLevel", progress: 2 },
        { progression_id: "MasteryTrack_Weapon_Hammer", progress: 1 },
        { progression_id: "MasteryTrack_Behemoth", progress: 1 }
      ],
      objectives: [{ objective_id: "MasteryObjective_Behemoth_Quillshot_Kill", value: 1, completed_count: 1 }]
    };
    const gameplayResponse = await request("captured-mastery-user", "/progression/captured-mastery-user", { method: "POST", body: JSON.stringify(capturedGameplay) });
    assert.deepStrictEqual(gameplayResponse.json.payload.progress_tracks.map((track: any) => [track.progression_id, track.progress]), [
      ["MasteryTrack_PlayerLevel", 486],
      ["MasteryTrack_Weapon_Hammer", 62],
      ["MasteryTrack_Behemoth", 64]
    ]);
    assert.strictEqual(gameplayResponse.json.payload.objectives[0].progress, 1);
    assert.strictEqual(gameplayResponse.json.payload.objectives[0].completed_count, 1);
    assert.strictEqual((await request("captured-mastery-user", "/progression/captured-mastery-user/MasteryTrack_Weapon_Axe")).json.payload.progress, 58);

  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
if (require.main === module) void runSelftest().catch((error) => { console.error(error); process.exitCode = 1; });
