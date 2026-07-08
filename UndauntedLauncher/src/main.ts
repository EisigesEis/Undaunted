import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron';
import path, { relative } from 'node:path';
import started from 'electron-squirrel-startup';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, promises, readdirSync, readFileSync, rm, rmSync, statfs, statfsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yauzl from "yauzl";
import { spawn } from 'node:child_process';
import { kill } from 'node:process';

const DAUNTLESS_144_EXE_HASH = "d3d41e614908d2befd518b27046d9822d6130ef12ba3504babbdb786bef9cff4";
const DAUNTLESS_144_BASEGAME_ZIP_HASH = "556b9a648a5e5e7e11b6f8dd3d80ff8e88fceb0d3448297aaf47ce7bf756bc6d";
const BYTES_REQUIRED_TO_INSTALL = 25 * 1024 * 1024 * 1024; // 25 GB
const BASE_GAME_CDN_LINK = "https://undauntedcdn.nyc3.cdn.digitaloceanspaces.com/BaseGame144.zip"; // TODO: Swap to cdn.stayundaunted.com
const CONST_LAUNCH_ARGS = ["-AUTH_LOGIN=unused", "-AUTH_TYPE=exchangecode", "-epicapp=appidlol", "-epicenv=Prod", "-EpicPortal", "-epicusername=usernamelol", "-epicuserid=useridlol", "-epiclocale=en-US", "-epicsandboxid=sandboxidlol", "-epicdeploymentid=deploymentidlol"];
const BASE_API_URL = MAIN_WINDOW_VITE_DEV_SERVER_URL ? "http://127.0.0.1:60000" : "http://api.stayundaunted.com";
const METAGAME_BASE_URL = MAIN_WINDOW_VITE_DEV_SERVER_URL ? "127.0.0.1:60000" : "api.stayundaunted.com";

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

nativeTheme.themeSource = "dark"; // Force dark mode to fixup launcher rendering issues

let MainWindow: BrowserWindow;

const createWindow = () => {
  // Create the browser window.
  MainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    icon: path.join(__dirname, "assets", "hootrly.png"),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });



  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    MainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    MainWindow.removeMenu();
    MainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.

type UserInfo = {
    UserId: string;
    Username: string;
    IsAdmin: boolean;
}

type PublicOnlineStatsResponse = {
  NumActivePlayers: number
}

let DauntlessPID: number | undefined;

let DauntlessWin64Path: string | undefined;
let UndauntedUserAPIKey: string | undefined;

async function MakeUndauntedApiRequest(Path: string, Method: string, Body: any | undefined){
  let PostBody: string | undefined;
  let ContentType = {};
  let UserApiKey = {};

  if(Body != undefined){
    PostBody = JSON.stringify(Body)
    ContentType = {
      "content-type": "application/json"
    };
  }

  if(UndauntedUserAPIKey != null){
    UserApiKey = {
      "x-undaunted-user-api-key": UndauntedUserAPIKey
    };
  }

  const Response = await fetch(BASE_API_URL + Path, {
    method: Method,
    body: PostBody,
    headers: {
      ...UserApiKey,
      ...ContentType
    }
  });

  if(Response.status !== 200){
    return {};
  }

  let RetResponse = {};

  try{
    RetResponse = await Response.json();
  }
  catch{

  }

  return RetResponse;
}

async function GetMyUserInfo(): Promise<UserInfo | undefined>{
  if(UndauntedUserAPIKey == undefined){
    return undefined;
  }

  const MyUserInfo: UserInfo = await MakeUndauntedApiRequest("/undaunted/api/GetUserInfo", "GET", undefined);

  return MyUserInfo;
}

async function GetCurrentRegistrationMode(): Promise<string | undefined>{
  const RegistrationModeResponse = await MakeUndauntedApiRequest("/undaunted/api/RegistrationStatus", "GET", undefined);

  return RegistrationModeResponse?.RegistrationMode;
}

async function SetCurrentRegistrationMode(RegistrationStatus: string){
  LoadDataFile();

  if(UndauntedUserAPIKey == undefined){
    return;
  }

  await MakeUndauntedApiRequest("/undaunted/api/RegistrationStatus", "POST", {
    RegistrationStatus: RegistrationStatus
  });
}

type InviteCode = {
  inviteCode: string;
  usesRemaining: number;
  infiniteUses: boolean;
}

async function AddInviteCode(InviteCode: string, Uses: number, InfiniteUses: boolean){
  await MakeUndauntedApiRequest("/undaunted/api/RegisterInviteCode", "POST", {
    NewInviteCode: InviteCode,
    Uses: Uses,
    InfiniteUses: InfiniteUses
  });
}

async function DeleteInviteCode(InviteCode: string){
  await MakeUndauntedApiRequest(`/undaunted/api/InviteCode/${InviteCode}`, "DELETE", undefined);
}

async function GetInviteCodes(): Promise<InviteCode[] | undefined>{
  if(UndauntedUserAPIKey == undefined){
    return undefined;
  }

  const InviteCodes = await MakeUndauntedApiRequest("/undaunted/api/InviteCodes", "GET", undefined);
  
  return InviteCodes.InviteCodes;
}

async function GetPublicStats(): Promise<PublicOnlineStatsResponse | undefined>{
  if(UndauntedUserAPIKey == undefined){
    return undefined;
  }

  const PublicOnlineStats: PublicOnlineStatsResponse = await MakeUndauntedApiRequest("/undaunted/api/PublicOnlineStats", "GET", undefined);

  return PublicOnlineStats;
}

function LoadDataFile(){
  const UserDataPath = path.join(app.getPath("userData"), "config.json");

  if(!existsSync(UserDataPath)){
    return;
  }

  const UserData = JSON.parse(readFileSync(UserDataPath).toString());

  DauntlessWin64Path = UserData.DauntlessWin64Path;
  UndauntedUserAPIKey = UserData.UndauntedUserAPIKey;
}

function WriteDataFile(){
  const UserDataPath = path.join(app.getPath("userData"), "config.json");

  const UserData = JSON.stringify({
    DauntlessWin64Path: DauntlessWin64Path,
    UndauntedUserAPIKey: UndauntedUserAPIKey,
  });

  writeFileSync(UserDataPath, UserData);
}

function HashFile(FilePath: string){
  const File = readFileSync(FilePath);

  return createHash("sha256").update(File).digest("hex");
}

function HashFileAsync(FilePath: string){
  return new Promise((Resolve, Reject) => {
    const Hash = createHash("sha256");
    const Stream = createReadStream(FilePath);

    Stream.on("data", Chunk => Hash.update(Chunk));
    Stream.on("error", Reject);
    Stream.on("end", () => Resolve(Hash.digest("hex")));
  })
}

async function MigrateLegacyUndauntedInstall(){
  const DialogResult = dialog.showOpenDialogSync({properties: ["openDirectory"], title: "Select where your Legacy Undaunted install is, the folder you select should contain the \"Archon\", \"EasyAntiCheat\", and \"Engine\" folders."});

  if(DialogResult == undefined){
    return false;
  }

  const LegacyUndauntedDirectory = DialogResult[0];

  const ExePath = path.join(LegacyUndauntedDirectory, "Archon", "Binaries", "Win64", "Dauntless-Win64-Shipping.exe");

  if(!existsSync(ExePath)){
    return false;
  }

  const ExeHash = HashFile(ExePath);

  if(ExeHash !== DAUNTLESS_144_EXE_HASH){
    return false;
  }

  const Win64Folder = path.join(LegacyUndauntedDirectory, "Archon", "Binaries", "Win64");

  const BatFileResults = readdirSync(Win64Folder, {withFileTypes: true}).filter((FileOrFolder) => {
    return FileOrFolder.isFile() && FileOrFolder.name.includes(".bat");
  });
  
  if(BatFileResults.length !== 1){
    return false;
  }

  const BatFilePath = path.join(Win64Folder, BatFileResults[0].name);

  const BatFileConents = readFileSync(BatFilePath, "utf-8");

  const Args = BatFileConents.split(" ");

  let UserApiKey;

  for(const Arg of Args){
    if(Arg.includes("UUK")){
      UserApiKey = Arg.split("=")[1];
      break;
    }
  }

  if(UserApiKey == undefined){
    return false;
  }

  UndauntedUserAPIKey = UserApiKey;
  DauntlessWin64Path = Win64Folder;

  WriteDataFile();
  
  return await PatchUndauntedInstall();
}

function PatchUndauntedInstall(){
  if(DauntlessWin64Path == undefined){
    return false;
  }

  const ResourcesPath = app.isPackaged ? process.resourcesPath : path.join(process.cwd(), "assets");

  const DxgiInResources = path.join(ResourcesPath, "dxgi.dll");
  const UndauntedInternalServerInResource = path.join(ResourcesPath, "UndauntedInternalServer.dll");

  const DxgiDest = path.join(DauntlessWin64Path, "dxgi.dll");
  const UndauntedInternalServerDest = path.join(DauntlessWin64Path, "UndauntedInternalServer.dll");

  copyFileSync(DxgiInResources, DxgiDest);
  copyFileSync(UndauntedInternalServerInResource, UndauntedInternalServerDest);

  return true;
}

async function ValidateUndauntedUserApiKey(ApiKey: string){
  UndauntedUserAPIKey = ApiKey;

  const Ret = (await GetMyUserInfo())?.UserId != undefined;

  return Ret;
}

function HasEnoughFreeSpace(InstallPath: string){
  const Stats = statfsSync(InstallPath, {
    bigint: true
  });

  const FreeBytes = Stats.bfree * Stats.bsize;

  return FreeBytes >= BYTES_REQUIRED_TO_INSTALL;
}

async function DownloadAndInstallUndaunted(){
  const DialogResult = dialog.showOpenDialogSync({properties: ["openDirectory"], title: "Select the folder where you want to install Undaunted!"});

  if(DialogResult?.length !== 1){
    return false;
  }

  const InstallLocation = DialogResult[0];

  if(existsSync(path.join(InstallLocation, "Archon", "Binaries", "Win64"))){
    if(await HashFileAsync(path.join(InstallLocation, "Archon", "Binaries", "Win64", "Dauntless-Win64-Shipping.exe")) !== DAUNTLESS_144_EXE_HASH){
      return false;
    }
    
    DauntlessWin64Path = path.join(InstallLocation, "Archon", "Binaries", "Win64");

    WriteDataFile();

    const Return = await PatchUndauntedInstall();

    if(Return){
      MainWindow.webContents.send("DownloadUpdate", "Done", 0);
    }

    return Return;
  }

  if(!HasEnoughFreeSpace(InstallLocation)){
    return false;
  }

  const TempFile = path.join(InstallLocation, "temp.zip");
  const TempFileStream = createWriteStream(TempFile);

  const Response = await fetch(BASE_GAME_CDN_LINK);
  const TotalBytes = Number(Response.headers.get("content-length"));
  let DownloadedBytes = 0;
  let LastSentAt = Date.now();

  const ProgressStream = new TransformStream({
    transform(Chunk, Controller){
      DownloadedBytes = DownloadedBytes + Chunk.byteLength;

      const Now = Date.now();

      if(Now - LastSentAt > 250){
        LastSentAt = Now;

        const Progress = Math.round((DownloadedBytes / TotalBytes) * 100);

        MainWindow.webContents.send("DownloadUpdate", "Download", Progress);
      }

      Controller.enqueue(Chunk);
    }
  });

  await pipeline(Response.body!.pipeThrough(ProgressStream), TempFileStream);

  MainWindow.webContents.send("DownloadUpdate", "Verify", 0);

  const ZipHash = await HashFileAsync(TempFile);

  if(ZipHash !== DAUNTLESS_144_BASEGAME_ZIP_HASH){
    rmSync(TempFile);

    return false;
  }

  const TempZipFile = await yauzl.openPromise(TempFile, {lazyEntries: true});

  const TotalNumEntries = TempZipFile.entryCount;
  let NumEntriesExtracted = 0;

  for await (const Entry of TempZipFile.eachEntry()){
    const EntryFileName = Entry.fileName;

    const BaseInstallDir = path.resolve(InstallLocation);

    const Destination = path.resolve(InstallLocation, EntryFileName);

    const RelativePath = path.relative(BaseInstallDir, Destination);

    if(RelativePath === "" || RelativePath.startsWith("..") || path.isAbsolute(RelativePath)){
      TempZipFile.close();

      rmSync(TempFile);

      return false;
    }

    console.log(Destination);

    if(EntryFileName.endsWith("/")){
      mkdirSync(Destination, {recursive: true});

      continue;
    }

    mkdirSync(path.dirname(Destination), {recursive: true});

    const ReadStream = await TempZipFile.openReadStreamPromise(Entry);
    const WriteStream = createWriteStream(Destination);

    await pipeline(ReadStream, WriteStream);

    NumEntriesExtracted = NumEntriesExtracted + 1;

    MainWindow.webContents.send("DownloadUpdate", "Install", Math.round((NumEntriesExtracted / TotalNumEntries) * 100));
  }

  TempZipFile.close();

  rmSync(TempFile);

  const InstalledWin64 = path.join(InstallLocation, "Dauntless", "Archon", "Binaries", "Win64");

  DauntlessWin64Path = InstalledWin64;

  WriteDataFile();

  const Return = await PatchUndauntedInstall();

  if(Return){
    MainWindow.webContents.send("DownloadUpdate", "Done", 0);
  }

  return Return;
}

function RunUndaunted(){
  const DauntlessProcess = spawn(path.join(DauntlessWin64Path!, "Dauntless-Win64-Shipping.exe"), [METAGAME_BASE_URL, `-AUTH_PASSWORD=${UndauntedUserAPIKey!}`, ...CONST_LAUNCH_ARGS]);

  DauntlessPID = DauntlessProcess.pid!;
}

function StopUndaunted(){
  kill(DauntlessPID!);
}

function IsUndauntedRunning(){
  if(DauntlessPID == undefined){
    return false;
  }

  let Running = true;

  try{
    kill(DauntlessPID!, 0);
  }catch(e){
    Running = false;
    DauntlessPID = undefined;
  }

  return Running;
}

async function Login(ApiKey: string){
  if(await ValidateUndauntedUserApiKey(ApiKey)){
    UndauntedUserAPIKey = ApiKey;

    WriteDataFile();
  }
}

function Logout(){
  UndauntedUserAPIKey = undefined;

  WriteDataFile();
}

type RegistrationResponse = {
  UUK: string
}

async function RegisterAccount(Username: string, InviteCode: string | undefined): Promise<string | undefined>{
  const RegistrationResponse: RegistrationResponse | undefined = await MakeUndauntedApiRequest("/undaunted/api/Register", "POST", {
    Username: Username,
    InviteCode: InviteCode
  }) as RegistrationResponse;

  const UUK = RegistrationResponse?.UUK;

  await Login(UUK);

  return UUK;
}

async function ValidateWin64Path(Path: string){
  const ExePath = path.join(Path, "Dauntless-Win64-Shipping.exe");

  if(!existsSync(Path) || !existsSync(ExePath)){
    return false;
  }

  if(await HashFileAsync(ExePath) !== DAUNTLESS_144_EXE_HASH){
    return false;
  }

  return true;
}

async function GetState(){
  if(UndauntedUserAPIKey == undefined || !await ValidateUndauntedUserApiKey(UndauntedUserAPIKey)){
    return "LOGIN";
  }
  else if(DauntlessWin64Path == undefined || !(await ValidateWin64Path(DauntlessWin64Path))){
    return "INSTALL";
  }
  else{
    return "PLAY";
  }
}

async function GetVersion(){
  const Response = await MakeUndauntedApiRequest("/dauntless-status", "GET", undefined);

  const VersionString = (Response as any).en as string;

  return VersionString.substring(10).slice(0, -1);
}

ipcMain.handle("MigrateLegacyUndauntedInstall", async () => {
  if(await MigrateLegacyUndauntedInstall()){
    console.log("Migrated");
  }
  else{
    console.log("Failed");
  }
});

ipcMain.handle("PatchUndauntedInstall", async () => {
  LoadDataFile();

  if(PatchUndauntedInstall()){
    console.log("Patched");
  }
  else{
    console.log("Failed");
  }
})

ipcMain.on("DownloadAndInstallUndaunted", async (event) => {
  if(await DownloadAndInstallUndaunted()){
    console.log("Download Complete");
  }
  else{
    console.log("Failed");
  }
})

ipcMain.handle("PlayUndaunted", async (event) => {
  LoadDataFile();

  RunUndaunted();

  console.log("Launched Undaunted!");
})

ipcMain.handle("GetUndauntedUsername", async (event) => {
  LoadDataFile();

  const MyUserInfo: UserInfo | undefined = await GetMyUserInfo();

  return MyUserInfo?.Username;
})

ipcMain.handle("GetCurrentRegistrationMode", async (event) => {
  const RegistrationModeResponse = await GetCurrentRegistrationMode();

  return RegistrationModeResponse;
})

ipcMain.handle("SetCurrentRegistrationMode", async (event, mode: string) => {
  await SetCurrentRegistrationMode(mode);
})

ipcMain.handle("GetInviteCodes", async (event) => {
  const InviteCodes = await GetInviteCodes();

  return InviteCodes;
})

ipcMain.handle("GetIsAdmin", async (event) => {
  LoadDataFile();

  const MyUserInfo: UserInfo | undefined = await GetMyUserInfo();

  return MyUserInfo?.IsAdmin;
})

ipcMain.handle("GetPlayerCount", async (event) => {
  LoadDataFile();

  const PublicOnlineStats: PublicOnlineStatsResponse | undefined = await GetPublicStats();

  return PublicOnlineStats?.NumActivePlayers;
})

ipcMain.handle("StopUndaunted", async (event) => {
  LoadDataFile();

  StopUndaunted();

  console.log("Exited Undaunted Process!");
})

ipcMain.handle("RegisterInviteCode", async (event, InviteCode: string, Uses: number, IsInfinite: boolean) => {
  await AddInviteCode(InviteCode, Uses, IsInfinite);
})

ipcMain.handle("DeleteInviteCode", async (event, InviteCode: string) => {
  await DeleteInviteCode(InviteCode);
})

ipcMain.handle("Login", async (event, ApiKey: string) => {
  await Login(ApiKey);
})

ipcMain.handle("Logout", async (event) => {
  Logout();
})

ipcMain.handle("GetState", async (event) => {
  LoadDataFile();

  return GetState();
})

ipcMain.handle("GetIsUndauntedRunning", async (event) => {
  return await IsUndauntedRunning();
})

ipcMain.handle("GetVersion", async (event) => {
  return await GetVersion();
})

ipcMain.handle("RegisterAccount", async (event, Username, InviteCode) => {
  return await RegisterAccount(Username, InviteCode);
})