import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
    userId: text("userId").notNull().primaryKey(),
    name: text("name").notNull(),
    notes: integer("notes").notNull(),
    isAdmin: integer("isAdmin", {mode: "boolean"}).notNull().default(false)
})

export const characters = sqliteTable("characters", {
    characterId: text("characterId").notNull().primaryKey(),
    userId: text("userId").notNull(),
    createdDate: text("createdDate").notNull(),
    lastModifiedDate: text("lastModifiedDate").notNull(),
    name: text("name").notNull(),
    updateVersion: integer("updateVersion").notNull(),
    data: text("data").notNull()
});

export const inventory = sqliteTable("inventories", {
    characterId: text("characterId").notNull().primaryKey(),
    instancedItems: text("instancedItems").notNull(),
    stackedItems: text("stackedItems").notNull()
});

export const loadouts = sqliteTable("loadouts", {
    characterId: text("characterId").notNull().primaryKey(),
    userId: text("userId").notNull(),
    loadouts: text("loadouts").notNull(),
    persistent: text("persistent").notNull(),
    activeIndex: integer("activeIndex").notNull().default(0)
});

export const gameserverapikeys = sqliteTable("gameserverapikeys", {
    id: integer("id").notNull().primaryKey({autoIncrement: true}),
    keyHash: text("keyHash")
}, (table) => {
    return {
        keyHashIdx: index("gameserverapikeys_keyHash_idx").on(table.keyHash)
    };
});

export const userapikeys = sqliteTable("userapikeys", {
    userId: text("userId").notNull().primaryKey(),
    keyHash: text("keyHash").notNull()
}, (table) => {
    return {
        keyHashIdx: index("userapikeys_keyHash_idx").on(table.keyHash)
    };
});

export const userrefreshtokens = sqliteTable("userrefreshtokens", {
    id: integer("id").notNull().primaryKey({autoIncrement: true}),
    userId: text("userId").notNull(),
    tokenHash: text("tokenHash").notNull(),
    issuedAt: text("issuedAt").notNull(),
    expiresAt: text("expiresAt").notNull(),
    revokedAt: text("revokedAt"),
    replacedByTokenHash: text("replacedByTokenHash")
}, (table) => {
    return {
        tokenHashIdx: index("userrefreshtokens_tokenHash_idx").on(table.tokenHash),
        userIdIdx: index("userrefreshtokens_userId_idx").on(table.userId)
    };
});

export const userapikeystoregister = sqliteTable("userapikeystoregister", {
    userId: text("userId").notNull().primaryKey(),
    key: text("key").notNull()
});

export const gameserverapikeystoregister = sqliteTable("gameserverapikeystoregister", {
    key: text("key").primaryKey()
});

export const breadcrumbs = sqliteTable("breadcrumbs", {
    characterId: text("characterId").notNull().primaryKey(),
    userId: text("userId").notNull(),
    breadcrumbs: text("breadcrumbs").notNull(),
    updateVersion: integer("updateVersion").notNull()
});

export const encounteredcontent = sqliteTable("encounteredcontent", {
    characterId: text("characterId").notNull().primaryKey(),
    userId: text("userId").notNull(),
    encounteredcontent: text("encounteredcontent").notNull()
});

export const escalationprogression = sqliteTable("escalationprogression", {
    userId: text("userId").notNull(),
    escalationSeason: text("escalationSeason").notNull(),
    escalationLevel: integer("escalationLevel").notNull(),
    nextLevelXp: integer("nextLevelXp").notNull(),
    talentsProgress: text("talentsProgress").notNull(),
    unlockProgress: text("unlockProgress").notNull(),
    updateVersion: integer("updateVersion").notNull(),
    lastModifiedDate: text("lastModifiedDate").notNull()
}, (table) => {
    return {
        pk: primaryKey({columns: [table.userId, table.escalationSeason]})
    };
});

export const invitecodes = sqliteTable("invitecodes", {
    inviteCode: text("invitecode").notNull().primaryKey(),
    usesRemaining: integer("usesRemaining").notNull(),
    infiniteUses: integer("infiniteUses", {mode: "boolean"}).notNull()
});
