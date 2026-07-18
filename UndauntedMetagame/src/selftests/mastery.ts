import "./testEnvironment";
import assert from "node:assert";
import crypto from "node:crypto";
import http from "node:http";
import { app } from "../app";
import { GetDb } from "../db";
import { gameserverapikeys, users } from "../db/schema";
import { SignMetagameJWTForUid } from "../controllers/auth";
import progressionConfig from "../vendor/progression_config.json";
import { RankForTrackProgress } from "../controllers/mastery";

export async function runSelftest() {
  await GetDb().insert(users).values([
    { userId: "mastery-user", name: "Mastery", notes: 0, isAdmin: false },
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
    // Player mastery starts at displayed level 1 without inventing one XP: its
    // configured rank-1 threshold is zero. Other mastery tracks remain rank 0.
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
      ProgresstrackEvents: [{ Track: "MasteryTrack_Behemoth", Amount: 10 }]
    };
    const firstResponse = await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(first) });
    assert.strictEqual(firstResponse.status, 200);
    assert.deepStrictEqual(firstResponse.json.payload, {});
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 10);
    const storedObjective = await request("mastery-user", `/progression/objectives/mastery-user/${charroggObjectives[0]}`);
    assert.strictEqual(storedObjective.json.payload.progress, 1);
    assert.strictEqual(storedObjective.json.payload.completed_count, 1);

    // Identical legacy spam is acknowledged but cannot apply XP twice.
    const replayedFirst = await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(first) });
    assert.strictEqual(replayedFirst.status, 200);
    assert.deepStrictEqual(replayedFirst.json.payload, {});
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 10);

    const higher = {
      playerObjectives: [{ ObjectiveId: charroggObjectives[0], Value: 5, CompletedCount: 2 }],
      ProgresstrackEvents: [{ Track: "MasteryTrack_Behemoth", Amount: 10 }]
    };
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(higher) })).status, 200);
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 20);
    const allObjectives = await request("mastery-user", "/progression/objectives/mastery-user");
    assert.ok(Array.isArray(allObjectives.json.payload));
    assert.strictEqual(allObjectives.json.payload.find((entry: any) => entry.objective_id === charroggObjectives[0]).completed_count, 2);
    assert.strictEqual((await request("other-user", "/progression/objectives/mastery-user")).status, 403);
    // The native endpoint historically acknowledges empty and not-yet-known
    // wire shapes.  Returning 400 here suppresses its subsequent mastery flow.
    for (const body of [{}, { nativeShapeStillUnderInvestigation: true }]) {
      const compatible = await request("mastery-user", "/progression/mastery-user", { method: "POST", body: JSON.stringify(body) });
      assert.strictEqual(compatible.status, 200);
      assert.deepStrictEqual(compatible.json, { code: null, message: "OK", payload: {} });
    }
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 20);
    const directGrant = await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth/10", { method: "POST" });
    assert.strictEqual(directGrant.status, 200);
    assert.strictEqual(directGrant.json.payload.progress, 30);

    // Native game servers authenticate with their API key and identify the
    // affected player in the URL; they do not always forward a player bearer.
    const serverGrantResponse = await fetch(base + "/progression/mastery-user", {
      method: "POST",
      headers: { "x-undaunted-gameserver-apikey": gameserverKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        PlayerObjectives: [{ ObjectiveId: charroggObjectives[1], Value: 1, CompletedCount: 0 }],
        ProgressEvents: [{ Track: "MasteryTrack_Behemoth", Amount: 5 }]
      })
    });
    assert.strictEqual(serverGrantResponse.status, 200);
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 35);

    // Exact captured GrantProgressionWithObjectives REST shape. Track progress
    // is an absolute result, and the following GET must return the stored value.
    const capturedSnapshot = {
      objectives: [{ objective_id: "MasteryObjective_Behemoth_Embermane_Kill", value: 1, completed_count: 1 }],
      progress_tracks: [
        { progression_id: "MasteryTrack_PlayerLevel", progress: 12 },
        { progression_id: "MasteryTrack_Behemoth", progress: 62 }
      ]
    };
    const capturedResponse = await fetch(base + "/progression/mastery-user", {
      method: "POST",
      headers: { "x-undaunted-gameserver-apikey": gameserverKey, "Content-Type": "application/json" },
      body: JSON.stringify(capturedSnapshot)
    });
    assert.strictEqual(capturedResponse.status, 200);
    const capturedResponseBody = await capturedResponse.json() as any;
    assert.deepStrictEqual(capturedResponseBody.payload, {});
    assert.strictEqual((await request("mastery-user", "/progression/objectives/mastery-user/MasteryObjective_Behemoth_Embermane_Kill")).json.payload.progress, 1);
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 62);
    
    // Replay snapshot should not trigger notifications
    const replayedSnapshot = await fetch(base + "/progression/mastery-user", {
      method: "POST",
      headers: { "x-undaunted-gameserver-apikey": gameserverKey, "Content-Type": "application/json" },
      body: JSON.stringify(capturedSnapshot)
    });
    assert.strictEqual(replayedSnapshot.status, 200);
    assert.deepStrictEqual((await replayedSnapshot.json() as any).payload, {});
    assert.strictEqual((await request("mastery-user", "/progression/mastery-user/MasteryTrack_Behemoth")).json.payload.progress, 62);

  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
if (require.main === module) void runSelftest().catch((error) => { console.error(error); process.exitCode = 1; });
