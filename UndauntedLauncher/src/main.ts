import "./styles.css";

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { message, open } from "@tauri-apps/plugin-dialog";
import {
  isCommandError,
  type AdminState,
  type BackgroundAsset,
  type CommandError,
  type Dashboard,
  type LauncherRoute,
  type LauncherState,
  type RegistrationMode,
  type RegistrationResult,
} from "./types";

const get = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const views = {
  loading: get("loading-view"),
  login: get("login-view"),
  register: get("register-view"),
  complete: get("registration-complete-view"),
  install: get("install-view"),
  play: get("play-view"),
  admin: get("admin-view"),
};

const loadingMessage = get("loading-message");
const retryButton = get<HTMLButtonElement>("retry-button");
const editUrlButton = get<HTMLButtonElement>("edit-url-button");
const loginError = get("login-error");
const registerError = get("register-error");
const installError = get("install-error");
const playError = get("play-error");
const adminError = get("admin-error");
const apiUrlInput = get<HTMLInputElement>("api-url");
const playButton = get<HTMLButtonElement>("play-button");
const stopButton = get<HTMLButtonElement>("stop-button");
const adminButton = get<HTMLButtonElement>("admin-button");
const backgroundVideo = get<HTMLVideoElement>("background-video");
const backgroundCanvas = get<HTMLCanvasElement>("background-canvas");
const availableBackgroundContext = backgroundCanvas.getContext("2d", { alpha: false, desynchronized: true });
if (!availableBackgroundContext) throw new Error("Canvas video rendering is unavailable.");
const backgroundContext: CanvasRenderingContext2D = availableBackgroundContext;
const backgroundBlur = get("background-blur");
const backgroundImage = get("background-image");
const chooseBackgroundButton = get<HTMLButtonElement>("choose-background-button");
const clearBackgroundButton = get<HTMLButtonElement>("clear-background-button");
const fitBackgroundButton = get<HTMLButtonElement>("fit-background-button");
const appWindow = getCurrentWindow();

const DEFAULT_WINDOW_SIZE = { width: 1080, height: 608 } as const;
const MINIMUM_WINDOW_SIZE = { width: 900, height: 506 } as const;
const FIT_BACKGROUND_STORAGE_KEY = "fit-background-to-window";

let registrationMode: RegistrationMode | null = null;
let nextRoute: LauncherRoute = "install";
let dashboardTimer: number | undefined;
let processTimer: number | undefined;
let videoFrameCallback: number | undefined;
let fitBackground = localStorage.getItem(FIT_BACKGROUND_STORAGE_KEY) !== "false";
let blurredSidelines = false;
let activeMediaSize: { width: number; height: number } | null = null;

const api = {
  state: () => invoke<LauncherState>("get_launcher_state"),
  config: () => invoke<[string, boolean]>("get_runtime_config"),
  background: () => invoke<BackgroundAsset | null>("get_background"),
  setBackground: (filePath: string) => invoke<BackgroundAsset>("set_background", { filePath }),
  clearBackground: () => invoke<void>("clear_background"),
  registrationMode: (apiUrl: string) =>
    invoke<RegistrationMode>("get_registration_mode", { apiUrl }),
  login: (apiKey: string, apiUrl: string) =>
    invoke<LauncherState>("login", { apiKey, apiUrl }),
  logout: () => invoke<LauncherState>("logout"),
  register: (username: string, inviteCode: string | null, apiUrl: string) =>
    invoke<RegistrationResult>("register_account", { username, inviteCode, apiUrl }),
  migrate: (directory: string) =>
    invoke<LauncherState>("migrate_legacy_install", { directory }),
  useExistingInstall: (directory: string) =>
    invoke<LauncherState>("use_existing_install", { directory }),
  dashboard: () => invoke<Dashboard>("get_dashboard"),
  adminState: () => invoke<AdminState>("get_admin_state"),
  setRegistrationMode: (mode: RegistrationMode) =>
    invoke<AdminState>("set_registration_mode", { mode }),
  createInviteCode: (code: string, uses: number, infinite: boolean) =>
    invoke<AdminState>("create_invite_code", { code, uses, infinite }),
  deleteInviteCode: (code: string) =>
    invoke<AdminState>("delete_invite_code", { code }),
  launch: () => invoke<void>("launch_game"),
  stop: () => invoke<void>("stop_game"),
  running: () => invoke<boolean>("is_game_running"),
};

function show(name: keyof typeof views): void {
  stopPolling();
  Object.entries(views).forEach(([key, node]) => {
    node.hidden = key !== name;
  });
}

function asError(value: unknown): CommandError {
  if (isCommandError(value)) return value;
  if (value instanceof Error) return { code: "frontend", message: value.message, retryable: true };
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isCommandError(parsed)) return parsed;
    } catch {}
    return { code: "unknown", message: value, retryable: true };
  }
  return { code: "unknown", message: "Unexpected launcher error.", retryable: true };
}

function setError(node: HTMLElement, value?: unknown): void {
  node.textContent = value ? asError(value).message : "";
  node.hidden = !value;
}

function setRegistrationMode(mode: RegistrationMode | null): void {
  registrationMode = mode;
  get("registrations-closed").hidden = mode !== "NONE" && mode !== null;
  get("registrations-invite").hidden = mode !== "INVITECODE";
  get("registrations-open").hidden = mode !== "OPEN";
  get("invite-code-panel").hidden = mode !== "INVITECODE";
}

async function applyState(state: LauncherState): Promise<void> {
  setRegistrationMode(state.registrationMode);
  // Never carry admin controls across accounts or routes while the dashboard loads.
  adminButton.hidden = true;
  show(state.route);
  if (state.route === "play") {
    await refreshDashboard(true);
    startPolling();
  }
}

function clearRenderedBackground(): void {
  if (videoFrameCallback !== undefined) {
    backgroundVideo.cancelVideoFrameCallback(videoFrameCallback);
    videoFrameCallback = undefined;
  }
  backgroundVideo.pause();
  backgroundVideo.onloadedmetadata = null;
  backgroundVideo.onloadeddata = null;
  backgroundVideo.oncanplay = null;
  backgroundVideo.onerror = null;
  backgroundVideo.removeAttribute("src");
  backgroundVideo.load();
  backgroundVideo.hidden = true;
  backgroundCanvas.hidden = true;
  backgroundContext.clearRect(0, 0, backgroundCanvas.width, backgroundCanvas.height);
  backgroundBlur.style.removeProperty("background-image");
  backgroundBlur.hidden = true;
  backgroundImage.style.removeProperty("background-image");
  backgroundImage.classList.remove("background-image--contain");
  backgroundImage.hidden = true;
}

function setBlurredSidelines(enabled: boolean): void {
  blurredSidelines = enabled;
  backgroundImage.classList.toggle("background-image--contain", enabled);
  backgroundBlur.hidden = !enabled || backgroundImage.hidden;
}

function updateFitButton(): void {
  fitBackgroundButton.textContent = `Fit: ${fitBackground ? "On" : "Off"}`;
  fitBackgroundButton.setAttribute("aria-pressed", String(fitBackground));
}

async function resizeWindowForBackground(width: number, height: number): Promise<void> {
  activeMediaSize = { width, height };
  if (!fitBackground) {
    setBlurredSidelines(false);
    await appWindow.setSize(new LogicalSize(DEFAULT_WINDOW_SIZE.width, DEFAULT_WINDOW_SIZE.height));
    await appWindow.center();
    return;
  }

  const monitor = await currentMonitor();
  const workArea = monitor?.workArea.size.toLogical(monitor.scaleFactor);
  const maximumWidth = Math.max(1, Math.floor((workArea?.width ?? DEFAULT_WINDOW_SIZE.width) * .94));
  const maximumHeight = Math.max(1, Math.floor((workArea?.height ?? DEFAULT_WINDOW_SIZE.height) * .94));
  const aspectRatio = width / height;

  let targetHeight: number = DEFAULT_WINDOW_SIZE.height;
  let targetWidth: number = targetHeight * aspectRatio;
  if (targetWidth < MINIMUM_WINDOW_SIZE.width) {
    targetWidth = MINIMUM_WINDOW_SIZE.width;
    targetHeight = targetWidth / aspectRatio;
  }
  if (targetHeight < MINIMUM_WINDOW_SIZE.height) {
    targetHeight = MINIMUM_WINDOW_SIZE.height;
    targetWidth = targetHeight * aspectRatio;
  }
  const downscale = Math.min(1, maximumWidth / targetWidth, maximumHeight / targetHeight);
  targetWidth *= downscale;
  targetHeight *= downscale;

  const exactFitIsSafe =
    targetWidth >= MINIMUM_WINDOW_SIZE.width &&
    targetHeight >= MINIMUM_WINDOW_SIZE.height;
  if (!exactFitIsSafe) {
    targetWidth = Math.min(DEFAULT_WINDOW_SIZE.width, maximumWidth);
    targetHeight = Math.min(DEFAULT_WINDOW_SIZE.height, maximumHeight);
  }

  setBlurredSidelines(!exactFitIsSafe);
  await appWindow.setSize(new LogicalSize(Math.round(targetWidth), Math.round(targetHeight)));
  await appWindow.center();
}

function loadImageSize(source: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("The selected background image could not be decoded."));
    image.src = source;
  });
}

function drawBackgroundVideoFrame(): void {
  videoFrameCallback = undefined;
  if (document.hidden || backgroundVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  const sourceWidth = backgroundVideo.videoWidth;
  const sourceHeight = backgroundVideo.videoHeight;
  if (sourceWidth < 1 || sourceHeight < 1) return;

  const targetWidth = Math.max(1, Math.round(window.innerWidth));
  const targetHeight = Math.max(1, Math.round(window.innerHeight));
  if (backgroundCanvas.width !== targetWidth || backgroundCanvas.height !== targetHeight) {
    backgroundCanvas.width = targetWidth;
    backgroundCanvas.height = targetHeight;
  }

  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const cropWidth = targetWidth / scale;
  const cropHeight = targetHeight / scale;
  const cropX = (sourceWidth - cropWidth) / 2;
  const cropY = (sourceHeight - cropHeight) / 2;
  if (blurredSidelines) {
    backgroundContext.save();
    backgroundContext.filter = "blur(24px)";
    backgroundContext.drawImage(
      backgroundVideo,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      -32,
      -32,
      targetWidth + 64,
      targetHeight + 64,
    );
    backgroundContext.restore();
    const containScale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
    const containedWidth = sourceWidth * containScale;
    const containedHeight = sourceHeight * containScale;
    backgroundContext.drawImage(
      backgroundVideo,
      (targetWidth - containedWidth) / 2,
      (targetHeight - containedHeight) / 2,
      containedWidth,
      containedHeight,
    );
  } else {
    backgroundContext.drawImage(
      backgroundVideo,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      0,
      0,
      targetWidth,
      targetHeight,
    );
  }
  backgroundCanvas.hidden = false;
  scheduleBackgroundVideoFrame();
}

function scheduleBackgroundVideoFrame(): void {
  if (
    videoFrameCallback === undefined &&
    !document.hidden &&
    !backgroundVideo.hidden
  ) {
    videoFrameCallback = backgroundVideo.requestVideoFrameCallback(drawBackgroundVideoFrame);
  }
}

async function startBackgroundVideo(source: string): Promise<void> {
  let layoutReady: Promise<void> | null = null;
  const ensureLayout = (): Promise<void> => {
    layoutReady ??= resizeWindowForBackground(
      backgroundVideo.videoWidth,
      backgroundVideo.videoHeight,
    );
    return layoutReady;
  };
  const play = (): void => {
    if (document.hidden || backgroundVideo.error) return;
    backgroundVideo.muted = true;
    backgroundVideo.defaultMuted = true;
    backgroundVideo.volume = 0;
    void ensureLayout()
      .catch(() => setBlurredSidelines(true))
      .then(() => backgroundVideo.play())
      .then(scheduleBackgroundVideoFrame)
      .catch(() => undefined);
  };

  backgroundVideo.preload = "auto";
  backgroundVideo.hidden = false;
  backgroundVideo.onloadedmetadata = play;
  backgroundVideo.onloadeddata = play;
  backgroundVideo.oncanplay = play;
  backgroundVideo.onerror = () => {
    backgroundCanvas.hidden = true;
  };
  backgroundVideo.src = source;
  backgroundVideo.load();
}

async function applyBackground(background: BackgroundAsset | null): Promise<void> {
  clearRenderedBackground();
  clearBackgroundButton.hidden = background === null;
  fitBackgroundButton.hidden = background === null;
  updateFitButton();
  activeMediaSize = null;
  if (!background) {
    setBlurredSidelines(false);
    await appWindow.setSize(new LogicalSize(DEFAULT_WINDOW_SIZE.width, DEFAULT_WINDOW_SIZE.height));
    await appWindow.center();
    return;
  }
  const source = convertFileSrc(background.path);
  if (background.mediaType === "image") {
    const size = await loadImageSize(source);
    backgroundBlur.style.backgroundImage = `url(${JSON.stringify(source)})`;
    backgroundImage.style.backgroundImage = `url(${JSON.stringify(source)})`;
    backgroundImage.hidden = false;
    await resizeWindowForBackground(size.width, size.height);
    return;
  }
  await startBackgroundVideo(source);
}

function syncBackgroundPlaybackWithVisibility(): void {
  if (document.hidden) {
    backgroundVideo.pause();
    stopPolling();
  } else if (!backgroundVideo.hidden) {
    void backgroundVideo.play().then(() => {
      scheduleBackgroundVideoFrame();
    }).catch(() => undefined);
    if (!views.play.hidden) startPolling();
  } else if (!views.play.hidden) {
    startPolling();
  }
}

async function initializeBackground(): Promise<void> {
  try {
    await applyBackground(await api.background());
  } catch {
    clearRenderedBackground();
  }
}

async function loadState(): Promise<void> {
  show("loading");
  retryButton.hidden = true;
  loadingMessage.textContent = "Connecting…";
  try {
    const [apiUrl, hasSavedApiKey] = await api.config();
    apiUrlInput.value = apiUrl;
    get<HTMLInputElement>("api-key").placeholder = hasSavedApiKey
      ? "Saved API key will be used"
      : "UUK••••••••";
    await applyState(await api.state());
  } catch (error) {
    const failure = asError(error);
    show("login");
    setError(loginError, failure);
    editUrlButton.hidden = false;
  }
}

async function choose(title: string): Promise<string | null> {
  const selected = await open({ title, directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

async function chooseBackground(): Promise<void> {
  chooseBackgroundButton.disabled = true;
  try {
    const selected = await open({
      title: "Choose your launcher background",
      multiple: false,
      filters: [{ name: "Images and videos", extensions: ["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "ogv"] }],
    });
    if (typeof selected !== "string") return;
    const background = await api.setBackground(selected);
    await applyBackground(background);
  } catch (error) {
    await message(asError(error).message, { title: "Background", kind: "error" });
  } finally {
    chooseBackgroundButton.disabled = false;
  }
}

async function resetBackground(): Promise<void> {
  clearBackgroundButton.disabled = true;
  try {
    await api.clearBackground();
    await applyBackground(null);
  } catch (error) {
    await message(asError(error).message, { title: "Background", kind: "error" });
  } finally {
    clearBackgroundButton.disabled = false;
  }
}

async function toggleBackgroundFit(): Promise<void> {
  fitBackground = !fitBackground;
  localStorage.setItem(FIT_BACKGROUND_STORAGE_KEY, String(fitBackground));
  updateFitButton();
  if (!activeMediaSize) return;
  fitBackgroundButton.disabled = true;
  try {
    await resizeWindowForBackground(activeMediaSize.width, activeMediaSize.height);
  } catch (error) {
    await message(asError(error).message, { title: "Background Fit", kind: "error" });
  } finally {
    fitBackgroundButton.disabled = false;
  }
}

async function refreshRegistrationMode(): Promise<void> {
  setError(loginError);
  try {
    setRegistrationMode(await api.registrationMode(apiUrlInput.value.trim()));
  } catch (error) {
    setRegistrationMode(null);
    setError(loginError, error);
  }
}

async function migrate(): Promise<void> {
  const target = views.register.hidden ? loginError : registerError;
  setError(target);
  try {
    const directory = await choose(
      'Select the legacy folder containing "Archon", "EasyAntiCheat", and "Engine".',
    );
    if (directory) await applyState(await api.migrate(directory));
  } catch (error) {
    setError(target, error);
  }
}

async function useExistingInstall(): Promise<void> {
  const button = get<HTMLButtonElement>("existing-install-button");
  setError(installError);
  button.disabled = true;
  try {
    const directory = await choose("Select your existing Dauntless installation");
    if (directory) await applyState(await api.useExistingInstall(directory));
  } catch (error) {
    setError(installError, error);
  } finally {
    button.disabled = false;
  }
}

function setRunning(running: boolean): void {
  playButton.hidden = running;
  stopButton.hidden = !running;
}

async function refreshDashboard(showFailure: boolean): Promise<void> {
  try {
    const data = await api.dashboard();
    get("home-username").textContent = `Welcome Back, ${data.username}`;
    get("version-text").textContent = data.version;
    get("player-count-text").textContent =
      `${data.onlinePlayers} Player${data.onlinePlayers === 1 ? "" : "s"} Online`;
    adminButton.hidden = !data.isAdmin;
    setRunning(data.gameRunning);
    setError(playError);
  } catch (error) {
    if (showFailure) setError(playError, error);
  }
}

function startPolling(): void {
  if (document.hidden || (dashboardTimer !== undefined && processTimer !== undefined)) return;
  stopPolling();
  dashboardTimer = window.setInterval(() => void refreshDashboard(false), 60_000);
  processTimer = window.setInterval(
    () => void api.running().then(setRunning).catch(() => undefined),
    2_000,
  );
}

function stopPolling(): void {
  if (dashboardTimer !== undefined) window.clearInterval(dashboardTimer);
  if (processTimer !== undefined) window.clearInterval(processTimer);
  dashboardTimer = processTimer = undefined;
}

function renderAdmin(state: AdminState): void {
  get<HTMLSelectElement>("registration-mode").value = state.registrationMode;
  const list = get("invite-code-list");
  list.replaceChildren();
  get("invite-code-empty").hidden = state.inviteCodes.length !== 0;
  for (const invite of state.inviteCodes) {
    const row = document.createElement("div");
    row.className = "invite-row";
    const code = document.createElement("span");
    code.className = "invite-row__code";
    code.textContent = invite.inviteCode;
    const uses = document.createElement("span");
    uses.className = "muted";
    uses.textContent = invite.infiniteUses ? "Infinite uses" : `${invite.usesRemaining} uses remaining`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button--danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => void removeInvite(invite.inviteCode, remove));
    row.append(code, uses, remove);
    list.append(row);
  }
}

async function openAdmin(): Promise<void> {
  show("admin");
  setError(adminError);
  try {
    renderAdmin(await api.adminState());
  } catch (error) {
    setError(adminError, error);
  }
}

async function removeInvite(code: string, button: HTMLButtonElement): Promise<void> {
  const choice = await message(`Delete invite code “${code}”?`, {
    title: "Delete Invite Code",
    kind: "warning",
    buttons: { ok: "Delete", cancel: "Cancel" },
  });
  if (choice !== "Delete") return;
  button.disabled = true;
  setError(adminError);
  try {
    renderAdmin(await api.deleteInviteCode(code));
  } catch (error) {
    setError(adminError, error);
    button.disabled = false;
  }
}

get<HTMLFormElement>("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = get<HTMLButtonElement>("login-button");
  const input = get<HTMLInputElement>("api-key");
  setError(loginError);
  button.disabled = true;
  try {
    await applyState(await api.login(input.value.trim(), apiUrlInput.value.trim()));
    input.value = "";
  } catch (error) {
    setError(loginError, error);
  } finally {
    button.disabled = false;
  }
});

get<HTMLFormElement>("register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = get<HTMLButtonElement>("register-button");
  const username = get<HTMLInputElement>("username").value.trim();
  const invite = get<HTMLInputElement>("invite-code").value.trim();
  setError(registerError);
  if (!username) return setError(registerError, "Enter a username.");
  if (registrationMode === "INVITECODE" && !invite)
    return setError(registerError, "Enter an invite code.");
  button.disabled = true;
  try {
    const result = await api.register(username, invite || null, apiUrlInput.value.trim());
    nextRoute = result.nextRoute;
    get("registration-complete-text").textContent =
      `Your User API Key is "${result.apiKey}". Keep it safe; it will not be shown again.`;
    show("complete");
  } catch (error) {
    setError(registerError, error);
  } finally {
    button.disabled = false;
  }
});

get<HTMLFormElement>("registration-mode-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = get<HTMLButtonElement>("save-registration-mode");
  const mode = get<HTMLSelectElement>("registration-mode").value as RegistrationMode;
  button.disabled = true;
  setError(adminError);
  try {
    renderAdmin(await api.setRegistrationMode(mode));
  } catch (error) {
    setError(adminError, error);
  } finally {
    button.disabled = false;
  }
});

get<HTMLFormElement>("invite-code-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = get<HTMLButtonElement>("add-invite-code");
  const codeInput = get<HTMLInputElement>("new-invite-code");
  const usesInput = get<HTMLInputElement>("new-invite-uses");
  const infinite = get<HTMLInputElement>("new-invite-infinite").checked;
  const uses = Number.parseInt(usesInput.value, 10);
  setError(adminError);
  if (!codeInput.value.trim()) return setError(adminError, "Enter an invite code.");
  if (!infinite && (!Number.isInteger(uses) || uses < 1))
    return setError(adminError, "Invite codes need at least one use.");
  button.disabled = true;
  try {
    renderAdmin(await api.createInviteCode(codeInput.value.trim(), infinite ? 0 : uses, infinite));
    codeInput.value = "";
  } catch (error) {
    setError(adminError, error);
  } finally {
    button.disabled = false;
  }
});

get("registration-complete-close-button").addEventListener("click", () => {
  get("registration-complete-text").textContent = "";
  void applyState({ route: nextRoute, registrationMode: null });
});
get("invite-register-button").addEventListener("click", () => show("register"));
get("open-register-button").addEventListener("click", () => show("register"));
get("back-to-login-button").addEventListener("click", () => show("login"));
get("migrate-login-button").addEventListener("click", () => void migrate());
get("migrate-register-button").addEventListener("click", () => void migrate());
get("existing-install-button").addEventListener("click", () => void useExistingInstall());
apiUrlInput.addEventListener("change", () => void refreshRegistrationMode());
editUrlButton.addEventListener("click", () => {
  editUrlButton.hidden = true;
  setError(loginError);
  show("login");
  apiUrlInput.focus();
});
retryButton.addEventListener("click", () => void loadState());
adminButton.addEventListener("click", () => void openAdmin());
get("back-to-play-button").addEventListener("click", () => {
  show("play");
  startPolling();
});
chooseBackgroundButton.addEventListener("click", () => void chooseBackground());
clearBackgroundButton.addEventListener("click", () => void resetBackground());
fitBackgroundButton.addEventListener("click", () => void toggleBackgroundFit());
document.addEventListener("visibilitychange", syncBackgroundPlaybackWithVisibility);
window.addEventListener("focus", syncBackgroundPlaybackWithVisibility);

get<HTMLButtonElement>("minimize-window-button").addEventListener("click", () => {
  void appWindow.minimize();
});
get<HTMLButtonElement>("close-window-button").addEventListener("click", () => {
  void appWindow.close();
});

playButton.addEventListener("click", async () => {
  playButton.disabled = true;
  setError(playError);
  try {
    await api.launch();
    setRunning(true);
  } catch (error) {
    setError(playError, error);
  } finally {
    playButton.disabled = false;
  }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  try {
    await api.stop();
    setRunning(false);
  } catch (error) {
    if (asError(error).code === "not_running") setRunning(false);
    else setError(playError, error);
  } finally {
    stopButton.disabled = false;
  }
});

get<HTMLButtonElement>("logout-button").addEventListener("click", async () => {
  try {
    await applyState(await api.logout());
  } catch (error) {
    show("loading");
    const failure = asError(error);
    loadingMessage.textContent = failure.message;
    retryButton.hidden = !failure.retryable;
  }
});

window.addEventListener("beforeunload", stopPolling);

Promise.all([initializeBackground(), loadState()]).catch((error) => {
  show("loading");
  loadingMessage.textContent = asError(error).message;
  retryButton.hidden = false;
});
