import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import * as schema from "./db/schema"

const Database = require("better-sqlite3");
const sqlite = new Database(process.env.DB_FILENAME!);

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("temp_store = MEMORY");

const db = drizzle(sqlite, {schema});

let didMigration = false;

export function GetDb(){
    if(!didMigration){
        didMigration = true;

        migrate(db, {migrationsFolder: "./src/drizzle"});
    }

    return db;
}
