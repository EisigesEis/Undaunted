import { eq } from "drizzle-orm";
import { GetDb } from "../db";
import { users } from "../db/schema";
import { GetRememberedUsernameForUserId } from "./login";

export type LinkedAccountPayload = {
    identityProviderId: string;
    accountId: string;
    displayName: string;
    externalAuthEnv?: string;
};

export type CanonicalAccountIdentity = {
    id: string;
    accountId: string;
    displayName: string;
    name: string;
    username: string;
    preferredLanguage: string;
    country: string;
    linkedAccounts: LinkedAccountPayload[];
};

export async function BuildCanonicalAccountIdentity(accountId: string): Promise<CanonicalAccountIdentity> {
    const DisplayName = await GetCanonicalDisplayNameForAccountId(accountId);

    return {
        id: accountId,
        accountId,
        displayName: DisplayName,
        name: DisplayName,
        username: DisplayName,
        preferredLanguage: "en",
        country: "US",
        linkedAccounts: BuildLinkedAccounts(accountId, DisplayName)
    };
}

export async function GetCanonicalDisplayNameForAccountId(accountId: string) {
    const User = await GetDb().query.users.findFirst({
        where: eq(users.userId, accountId)
    });

    const DbName = NormalizeDisplayName(User?.name);
    if (DbName != undefined) {
        return DbName;
    }

    const RememberedName = NormalizeDisplayName(GetRememberedUsernameForUserId(accountId));
    return RememberedName ?? accountId;
}

function NormalizeDisplayName(value: unknown) {
    if (typeof value !== "string") {
        return undefined;
    }

    const Trimmed = value.trim();
    return Trimmed.length > 0 ? Trimmed : undefined;
}

export function BuildLinkedAccounts(accountId: string, displayName: string): LinkedAccountPayload[] {
    return [
        {
            identityProviderId: "epic",
            accountId,
            displayName
        }
    ];
}

export function BuildExternalAuths(accountId: string, displayName: string) {
    return BuildLinkedAccounts(accountId, displayName).map((Account) => ({
        type: Account.identityProviderId,
        accountId: Account.accountId,
        externalAuthId: Account.accountId,
        externalAuthIdType: Account.identityProviderId,
        externalDisplayName: Account.displayName,
        displayName: Account.displayName
    }));
}

export async function BuildPublicAccountPayload(accountId: string) {
    const Identity = await BuildCanonicalAccountIdentity(accountId);
    const Now = "2020-01-01T00:00:00.000Z";

    return {
        id: Identity.accountId,
        accountId: Identity.accountId,
        displayName: Identity.displayName,
        name: Identity.name,
        username: Identity.username,
        lastName: "",
        email: "",
        failedLoginAttempts: 0,
        lastLogin: Now,
        numberOfDisplayNameChanges: 0,
        ageGroup: "ADULT",
        headless: false,
        country: Identity.country,
        lastNameChange: Now,
        preferredLanguage: Identity.preferredLanguage,
        canUpdateDisplayName: false,
        tfaEnabled: false,
        emailVerified: true,
        minorVerified: false,
        minorStatus: "NOT_MINOR",
        linkedAccounts: Identity.linkedAccounts
    };
}

export async function BuildSdkAccountPayload(accountId: string) {
    const Identity = await BuildCanonicalAccountIdentity(accountId);

    return {
        id: Identity.accountId,
        accountId: Identity.accountId,
        displayName: Identity.displayName,
        name: Identity.displayName,
        username: Identity.displayName,
        preferredLanguage: Identity.preferredLanguage,
        country: Identity.country,
        linkedAccounts: Identity.linkedAccounts
    };
}
