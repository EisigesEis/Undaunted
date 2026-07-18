import "dotenv/config";
import { generateKeyPairSync } from "node:crypto";

// Imported first by every selftest.
//  Provides in-memory test db separate from user db.
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
