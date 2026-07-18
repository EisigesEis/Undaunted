import { GetDb } from "../db";
import * as schema from "../db/schema";

// Test-only cleanup for the shared in-memory connection. Production database
// modules expose no reset operation.
export async function ClearTestDatabase() {
    const Db = GetDb();
    for (const Table of Object.values(schema).reverse()) {
        await Db.delete(Table as any);
    }
}
