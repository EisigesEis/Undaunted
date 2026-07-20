import "./testEnvironment";
import assert from "node:assert";

type SocialController = typeof import("../controllers/social");

const DEFAULT_SOCIAL_SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const SocialControllerPath = require.resolve("../controllers/social");

async function withSocialController(envValue: string | undefined, run: (social: SocialController) => Promise<void> | void) {
    const originalValue = process.env.SOCIAL_SESSION_IDLE_MS;
    const restoreEnvironment = () => {
        if(originalValue == undefined){
            delete process.env.SOCIAL_SESSION_IDLE_MS;
            return;
        }

        process.env.SOCIAL_SESSION_IDLE_MS = originalValue;
    };

    if(envValue == undefined){
        delete process.env.SOCIAL_SESSION_IDLE_MS;
    }
    else{
        process.env.SOCIAL_SESSION_IDLE_MS = envValue;
    }

    delete require.cache[SocialControllerPath];
    const social = require(SocialControllerPath) as SocialController;
    social.StopSocialSessionSweep();

    try {
        await run(social);
    }
    finally {
        social.StartSocialSessionSweep();
        restoreEnvironment();
    }
}

function assertNoOpAndIdempotentCalls(social: SocialController) {
    const socialUserSessionId = social.RegisterSocialSession("social-user-idempotent", "xmpp");
    const snapshotBeforeNoop = social.GetSocialDebugState();
    assert.strictEqual(snapshotBeforeNoop.sessions, 1);

    social.TouchSocialSession(undefined);
    social.TouchSocialSession("social-user-missing");
    social.UnregisterSocialSession(undefined);
    social.UnregisterSocialSession("social-user-missing");
    const snapshotAfterNoopCalls = social.GetSocialDebugState();
    assert.strictEqual(snapshotAfterNoopCalls.sessions, snapshotBeforeNoop.sessions);

    social.UnregisterSocialSession(socialUserSessionId);
    social.UnregisterSocialSession(socialUserSessionId);
    const snapshotAfterUnregister = social.GetSocialDebugState();
    assert.strictEqual(snapshotAfterUnregister.sessions, 0);
    assert.strictEqual(snapshotAfterUnregister.usersOnline, 0);
}

function assertSweepLifecycleControls(social: SocialController) {
    social.StopSocialSessionSweep();
    assert.strictEqual(social.GetSocialDebugState().sweepRunning, false);

    social.StopSocialSessionSweep();
    assert.strictEqual(social.GetSocialDebugState().sweepRunning, false);

    social.StartSocialSessionSweep();
    assert.strictEqual(social.GetSocialDebugState().sweepRunning, true);

    social.StartSocialSessionSweep();
    assert.strictEqual(social.GetSocialDebugState().sweepRunning, true);
}

function assertLeaseBehavior(social: SocialController) {
    const socialUserASessionId = social.RegisterSocialSession("social-user-a", "xmpp");
    const socialUserBSessionId = social.RegisterSocialSession("social-user-b", "stomp");
    const baseNow = Date.now();
    const snapshot = social.GetSocialDebugState();
    const socialSessionIdleMs = snapshot.sessionLease.idleMs;

    assert.strictEqual(snapshot.sessions, 2);
    assert.strictEqual(snapshot.usersOnline, 2);
    assert.notStrictEqual(socialUserASessionId, socialUserBSessionId);

    const explicitExpiry = baseNow + socialSessionIdleMs + 1;
    assert.strictEqual(social.SweepExpiredSocialSessions(explicitExpiry), 2);
    assert.strictEqual(social.GetSocialDebugState().sessions, 0);
    assert.strictEqual(social.GetSocialDebugState().usersOnline, 0);

    const socialUserCSessionId = social.RegisterSocialSession("social-user-c", "activity");
    social.TouchSocialSession(socialUserCSessionId);
    const touchNow = Date.now();

    const beforeExpiry = touchNow + socialSessionIdleMs - 1;
    assert.strictEqual(social.SweepExpiredSocialSessions(beforeExpiry), 0);
    assert.strictEqual(social.GetSocialDebugState().sessions, 1);

    const afterExpiry = touchNow + socialSessionIdleMs + 1;
    assert.strictEqual(social.SweepExpiredSocialSessions(afterExpiry), 1);
    assert.strictEqual(social.GetSocialDebugState().sessions, 0);
}

function assertSessionIdleConfig(envValue: string | undefined, expectedIdleMs: number) {
    return withSocialController(envValue, (social) => {
        assert.strictEqual(social.GetSocialDebugState().sessionLease.idleMs, expectedIdleMs);
    });
}

function assertZeroIdleExpiresImmediately() {
    return withSocialController("0", (social) => {
        social.RegisterSocialSession("social-user-zero", "xmpp");
        assert.strictEqual(social.SweepExpiredSocialSessions(Date.now() + 1), 1);
        assert.strictEqual(social.GetSocialDebugState().sessions, 0);
    });
}

export async function runSelftest() {
    await withSocialController(undefined, (social) => {
        assertLeaseBehavior(social);
        assertNoOpAndIdempotentCalls(social);
        assertSweepLifecycleControls(social);
    });

    await assertSessionIdleConfig(undefined, DEFAULT_SOCIAL_SESSION_IDLE_MS);
    await assertSessionIdleConfig("abc", DEFAULT_SOCIAL_SESSION_IDLE_MS);
    await assertSessionIdleConfig("-1", DEFAULT_SOCIAL_SESSION_IDLE_MS);
    await assertSessionIdleConfig("  ", DEFAULT_SOCIAL_SESSION_IDLE_MS);
    await assertSessionIdleConfig("1000.5", DEFAULT_SOCIAL_SESSION_IDLE_MS);
    await assertSessionIdleConfig("0", 0);
    await assertSessionIdleConfig("200", 200);
    await assertZeroIdleExpiresImmediately();
}

if (require.main === module) void runSelftest().catch((error) => { console.error(error); process.exitCode = 1; });
