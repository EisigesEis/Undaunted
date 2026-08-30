export type LauncherRoute = "login" | "install" | "play";
export type RegistrationMode = "NONE" | "INVITECODE" | "OPEN";

export interface LauncherState {
  route: LauncherRoute;
  registrationMode: RegistrationMode | null;
}

export interface RegistrationResult {
  apiKey: string;
  nextRoute: LauncherRoute;
}

export interface CredentialProfile {
  id: string;
  apiUrl: string;
  userId: string;
  username: string;
}

export interface CredentialBootstrap {
  apiUrl: string;
  profiles: CredentialProfile[];
  activeProfileId: string | null;
}

export interface Dashboard {
  username: string;
  version: string;
  onlinePlayers: number;
  gameRunning: boolean;
  isAdmin: boolean;
}

export interface BackgroundAsset {
  path: string;
  mediaType: "image" | "video";
}

export interface InviteCode {
  inviteCode: string;
  usesRemaining: number;
  infiniteUses: boolean;
}

export interface AdminState {
  registrationMode: RegistrationMode;
  inviteCodes: InviteCode[];
}

export interface CommandError {
  code: string;
  message: string;
  retryable: boolean;
}

export function isCommandError(value: unknown): value is CommandError {
  if (!value || typeof value !== "object") {
    return false;
  }

  const error = value as Partial<CommandError>;
  return (
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean"
  );
}
