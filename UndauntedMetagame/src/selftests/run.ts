import "./testEnvironment";
import { ClearTestDatabase } from "./testDatabase";
import { ResetTestEnvironment } from "./testEnvironment";

type Access = "read" | "write";
type Suite = { name: string; tables: Record<string, Access>; run: () => Promise<void> };
const Run = async (path: string) => (await import(path)).runSelftest();

const suites: Suite[] = [
    {name: "inventory", tables: {users: "write", characters: "write", inventories: "write"}, run: () => Run("./inventory")},
    {name: "friends", tables: {"*": "write"}, run: () => Run("./friends")},
    {name: "loadout", tables: {"*": "write"}, run: () => Run("./loadout")},
    {name: "mastery", tables: {"*": "write"}, run: () => Run("./mastery")},
    {name: "store", tables: {users: "write", characters: "write", inventories: "write", cooldowns: "write", entitlements: "write"}, run: () => Run("./store")},
    {name: "huntpass", tables: {"*": "write"}, run: () => Run("./huntpass")},
    {name: "xmpp", tables: {users: "write"}, run: () => Run("../xmpp/selftest")},
    {name: "stomp", tables: {users: "write"}, run: () => Run("../stomp/selftest")},
    {name: "party", tables: {users: "write"}, run: () => Run("./party")},
];
const failedSuites: string[] = [];

function accessFor(suite: Suite, table: string) {
    return suite.tables[table] ?? suite.tables["*"];
}

function conflicts(left: Suite, right: Suite) {
    const tables = new Set([...Object.keys(left.tables), ...Object.keys(right.tables)]);
    if (left.tables["*"] || right.tables["*"]) tables.add("*");
    for (const table of tables) {
        const leftAccess = accessFor(left, table);
        const rightAccess = accessFor(right, table);
        if (leftAccess && rightAccess && (leftAccess === "write" || rightAccess === "write")) return true;
    }
    return false;
}

function batches() {
    const result: Suite[][] = [];
    for (const suite of suites) {
        const batch = result.find((candidate) => candidate.every((other) => !conflicts(suite, other)));
        (batch ?? result[result.push([]) - 1]).push(suite);
    }
    return result;
}

async function main() {
    for (const batch of batches()) {
        await Promise.all(batch.map(async (suite) => {
            try {
                await suite.run();
                console.log(`${suite.name} selftest passed`);
            } catch (error) {
                failedSuites.push(suite.name);
                console.error(`${suite.name} selftest failed`);
                throw error;
            }
        }));
        if (batch.some((suite) => Object.values(suite.tables).includes("write"))) await ClearTestDatabase();
        ResetTestEnvironment();
    }
    console.log(`PASSED: all ${suites.length} tests passed`);
}

void main().catch(() => {
    console.error(`FAILED: ${failedSuites.join(", ")} failed`);
    process.exitCode = 1;
});
