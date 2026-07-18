import "dotenv/config";
import { generateKeyPairSync } from "node:crypto";

const Colors = {
    reset: "\u001b[0m",
    green: "\u001b[32m",
    yellow: "\u001b[33m",
    red: "\u001b[31m"
};

function color(color: string, values: unknown[]) {
    return `${color}${values.map(String).join(" ")}${Colors.reset}`;
}

// Keep selftest output scannable both when running one suite and when running all suites.
const OriginalConsole = {log: console.log, warn: console.warn, error: console.error};
console.log = (...values) => {
    const message = values.map(String).join(" ");
    if (message.toLowerCase().includes("passed")) OriginalConsole.log(color(Colors.green, values));
    else OriginalConsole.log(...values);
};
console.warn = (...values) => OriginalConsole.warn(color(Colors.yellow, values));
console.error = (...values) => OriginalConsole.error(color(Colors.red, values));

// Imported first by every selftest.
// Provides in-memory test db separate from user db.
const TestKeys = generateKeyPairSync("rsa", {modulusLength: 2048});

export function ResetTestEnvironment() {
    process.env.DB_FILENAME = ":memory:";
    process.env.PROTOCOL_FILE_LOG = "false";
    process.env.DEFAULT_USER_ID = "UB";
    process.env.LOCAL_USER_ID = "UB";
    process.env.SOCIAL_FRIEND_USER_IDS = "UB,UE";
}

ResetTestEnvironment();
process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(TestKeys.privateKey.export({type: "pkcs1", format: "pem"}).toString()).toString("base64");
process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(TestKeys.publicKey.export({type: "pkcs1", format: "pem"}).toString()).toString("base64");

export {};
