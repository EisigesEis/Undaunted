/**
 * This file will automatically be loaded by vite and run in the "renderer" context.
 * To learn more about the differences between the "main" and the "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/tutorial/process-model
 *
 * By default, Node.js integration in this file is disabled. When enabling Node.js integration
 * in a renderer process, please be aware of potential security implications. You can read
 * more about security risks here:
 *
 * https://electronjs.org/docs/tutorial/security
 *
 * To enable Node.js integration in this file, open up `main.ts` and enable the `nodeIntegration`
 * flag:
 *
 * ```
 *  // Create the browser window.
 *  mainWindow = new BrowserWindow({
 *    width: 800,
 *    height: 600,
 *    webPreferences: {
 *      nodeIntegration: true
 *    }
 *  });
 * ```
 */

const UserInfoText = document.getElementById("UserInfo");

const AdminPanel = document.getElementById("AdminPanel");
const AdminCurrentRegistrationMode = document.getElementById("AdminCurrentRegistrationMode");
const AdminInviteCodesTable = document.getElementById("AdminInviteCodesTable");

async function UpdateAdmin(){
  const IsAdmin: boolean | undefined = await window.api.GetIsAdmin();

  if(IsAdmin){
    AdminPanel!.hidden = false;

    const RegistrationMode = await window.api.GetCurrentRegistrationMode();

    let HumanReadableName;

    switch(RegistrationMode){
      case "NONE":
        HumanReadableName = "Disabled";
        break;
      case "INVITECODE":
        HumanReadableName = "Invite Code Required";
        break;
      case "OPEN":
        HumanReadableName = "Open";
        break;
      default:
        HumanReadableName = "Unrecognized";
        break;
    }

    AdminCurrentRegistrationMode!.innerText = `Registration Mode: ${HumanReadableName}`;
  
    const InviteCodes = await window.api.GetInviteCodes();

    AdminInviteCodesTable!.replaceChildren()

    for(const InviteCode of InviteCodes){
      const Row = document.createElement("tr");

      Row.innerHTML = `
        <td>${InviteCode.inviteCode}</td>
        <td>${InviteCode.usesRemaining}</td>
        <td>${InviteCode.infiniteUses ? "True" : "False"}</td>
      `

      AdminInviteCodesTable?.appendChild(Row);
    }
  }
  else{
    AdminPanel!.hidden = true;
  }
}

const RegistrationsClosed = document.getElementById("registrationsclosed")!;
const RegistrationsInviteCode = document.getElementById("registrationsinvitecode")!;
const RegistrationsOpen = document.getElementById("registrationsopen")!;
const RegistrationInviteCodePanel = document.getElementById("RegistrationInviteCodePanel")!;
const RegistrationMainPanel = document.getElementById("RegistrationMainPanel")!;

async function UpdateLogin(){
  const RegistrationMode = await window.api.GetCurrentRegistrationMode();

  if(RegistrationMode === "NONE"){
    RegistrationsClosed.hidden = false;
    RegistrationsInviteCode.hidden = true;
    RegistrationsOpen.hidden = true;
  }
  else if(RegistrationMode === "INVITECODE"){
    RegistrationsClosed.hidden = true;
    RegistrationsInviteCode.hidden = false;
    RegistrationsOpen.hidden = true;
  }
  else if(RegistrationMode === "OPEN"){
    RegistrationsClosed.hidden = true;
    RegistrationsInviteCode.hidden = true;
    RegistrationsOpen.hidden = false;
  }
}

const InviteCodePanel = document.getElementById("invitecodepanel");

async function UpdateRegistration(){
  const RegistrationMode = await window.api.GetCurrentRegistrationMode();

  if(RegistrationMode === "INVITECODE"){
    InviteCodePanel!.hidden = false;
  }
  else if(RegistrationMode === "OPEN"){
    InviteCodePanel!.hidden = true;
  }
}

const RegistrationCompleteText = document.getElementById("registrationcompletetext")!;

async function UpdateRegistrationComplete(){
  RegistrationCompleteText.innerText = `Your User API Key is "${ConfirmUUK}". Please keep it safe, it will not be shown again.`;
}

let InstallState = "SELECT";
let InstallPercent = 0;

const SelectInstallFolderPanel = document.getElementById("selectinstallfolderpanel")!;
const InstallProgressPanel = document.getElementById("installundauntedprogressbar")!;

const InstallProgress = document.getElementById("installprogress")!;
const InstallProgressText = document.getElementById("installprogresstext")!;
const InstallProgressBar = document.getElementById("installprogressbar")!;

async function UpdateInstall(){
  if(InstallState === "SELECT"){
    SelectInstallFolderPanel.hidden = false;
    InstallProgressPanel.hidden = true;
  }
  else if(InstallState === "DOWNLOAD"){
    SelectInstallFolderPanel.hidden = true;
    InstallProgressPanel.hidden = false;

    InstallProgressText.innerText = "Downloading Undaunted:";
    InstallProgress.hidden = false;
    InstallProgressBar.style = `width: ${InstallPercent}%`;
  }
  else if(InstallState === "VERIFY"){
    SelectInstallFolderPanel.hidden = true;
    InstallProgressPanel.hidden = false;

    InstallProgressText.innerText = "Verifying Download...";
    InstallProgress.hidden = true;
  }
  else if(InstallState === "INSTALL"){
    SelectInstallFolderPanel.hidden = true;
    InstallProgressPanel.hidden = false;

    InstallProgressText.innerText = "Installing Undaunted:";
    InstallProgress.hidden = false;
    InstallProgressBar.style = `width: ${InstallPercent}%`;
  }
}

const HomeUsernameText = document.getElementById("homeusername")!;
const VersionText = document.getElementById("versiontext")!;
const PlayerCountText = document.getElementById("playercounttext")!;

async function UpdatePlayerCount(){
  const PlayerCount: number | undefined = await window.api.GetPlayerCount();

  PlayerCountText!.innerText = `${PlayerCount!.toString()} Player(s) Online`;
}

const PlayButton = document.getElementById("playbutton")!;
const ExitButton = document.getElementById("exitbutton")!;

PlayButton.addEventListener("click", async () => {
  window.api.PlayUndaunted();

  await UpdatePlayButton();
});

ExitButton.addEventListener("click", async () => {
  window.api.StopUndaunted();

  await UpdatePlayButton();
});

const LogoutButton = document.getElementById("logoutbutton")!;

LogoutButton.addEventListener("click", async () => {
  window.api.Logout();

  await UpdateState();
})

async function UpdatePlayButton(){
  const IsUndauntedRunning: boolean = await window.api.GetIsUndauntedRunning();

  if(IsUndauntedRunning){
    PlayButton.hidden = true;
    ExitButton.hidden = false;
  }
  else{
    PlayButton.hidden = false;
    ExitButton.hidden = true;
  }
}

async function UpdatePlay(){
  const Username: string | undefined = await window.api.GetUsername();

  HomeUsernameText.innerText = `Welcome Back, ${Username}`;

  const Version: string = await window.api.GetVersion();

  VersionText.innerText = Version;

  await UpdatePlayerCount();

  await UpdatePlayButton();

  setInterval(UpdatePlayerCount, 60 * 1000);
  setInterval(UpdatePlayButton, 2 * 1000);
}

let State: string | undefined = undefined;

let ConfirmUUK: string | undefined = undefined;

const LoginPanel = document.getElementById("login")!;
const RegistrationPanel = document.getElementById("register")!;
const RegistrationCompletePanel = document.getElementById("registercomplete")!;
const InstallPanel = document.getElementById("install")!;
const PlayPanel = document.getElementById("play")!;
const LoadingPanel = document.getElementById("loading")!;

async function UpdateState(SetState: string | undefined){
  if(State == undefined){
    LoginPanel.hidden = true;
    RegistrationPanel.hidden = true;
    RegistrationCompletePanel.hidden = true;
    InstallPanel.hidden = true;
    PlayPanel.hidden = true;
    LoadingPanel.hidden = false;
  }

  if(SetState == undefined){
    State = await window.api.GetState();
  }
  else{
    State = SetState;
  }

  console.log(`State is now ${State}`)

  if(State === "LOGIN"){
    LoginPanel.hidden = false;
    RegistrationPanel.hidden = true;
    RegistrationCompletePanel.hidden = true;
    InstallPanel.hidden = true;
    PlayPanel.hidden = true;
    LoadingPanel.hidden = true;
    await UpdateLogin();
  }
  else if(State === "REGISTER"){
    LoginPanel.hidden = true;
    RegistrationPanel.hidden = false;
    RegistrationCompletePanel.hidden = true;
    InstallPanel.hidden = true;
    PlayPanel.hidden = true;
    LoadingPanel.hidden = true;
    await UpdateRegistration();
  }
  else if(State === "REGISTERCOMPLETE"){
    LoginPanel.hidden = true;
    RegistrationPanel.hidden = true;
    RegistrationCompletePanel.hidden = false;
    InstallPanel.hidden = true;
    PlayPanel.hidden = true;
    LoadingPanel.hidden = true;
    await UpdateRegistrationComplete();
  }
  else if(State === "INSTALL"){
    LoginPanel.hidden = true;
    RegistrationPanel.hidden = true;
    RegistrationCompletePanel.hidden = true;
    InstallPanel.hidden = false;
    PlayPanel.hidden = true;
    LoadingPanel.hidden = true;
    await UpdateInstall();
  }
  else if(State === "PLAY"){
    LoginPanel.hidden = true;
    RegistrationPanel.hidden = true;
    RegistrationCompletePanel.hidden = true;
    InstallPanel.hidden = true;
    PlayPanel.hidden = false;
    LoadingPanel.hidden = true;
    await UpdatePlay();
  }
  else{
    LoginPanel.hidden = true;
    RegistrationPanel.hidden = true;
    RegistrationCompletePanel.hidden = true;
    InstallPanel.hidden = true;
    PlayPanel.hidden = true;
    LoadingPanel.hidden = false;
  }
}

const SelectInstallLocationButton = document.getElementById("selectinstallfolderbutton");

SelectInstallLocationButton?.addEventListener("click", async () => {
  window.api.DownloadAndInstallUndaunted();
});

window.addEventListener('DOMContentLoaded', async () => {
  await UpdateState(undefined);

  /*
  await UpdateUsername();

  await UpdatePlayerCount();

  await UpdateAdmin();

  

  setInterval(UpdatePlayerCount, 60 * 1000);
  */
});

const InviteRegisterButton = document.getElementById("inviteregisteraccount");

InviteRegisterButton?.addEventListener("click", async () => {
  await UpdateState("REGISTER");
});

const RegistrationCompleteCloseButton = document.getElementById("registrationcompleteclosebutton");

RegistrationCompleteCloseButton?.addEventListener("click", async () => {
  await UpdateState(undefined);
});

const OpenRegisterButton = document.getElementById("openregisteraccount");

OpenRegisterButton?.addEventListener("click", async () => {
  await UpdateState("REGISTER");
});

const BackToLoginButton = document.getElementById("backtologin");

BackToLoginButton?.addEventListener("click", async () => {
  await UpdateState("LOGIN");
});

const RegisterSubmitButton = document.getElementById("registersubmitbutton");

RegisterSubmitButton?.addEventListener("click", async () => {
  const Username = document.getElementById("username")!.value;
  const InviteCode = document.getElementById("invitecode")!.value;

  const RegistrationResult = await window.api.RegisterAccount(Username, InviteCode);

  if(RegistrationResult != undefined){
    ConfirmUUK = RegistrationResult;
    await UpdateState("REGISTERCOMPLETE");
  }
});

const SetRegistrationModeButton = document.getElementById("AdminUpdateCurrentRegistrationMode");

SetRegistrationModeButton?.addEventListener("click", async () => {
  const RegistrationRadios = [document.getElementById("AdminRegistrationModeRadioDisabled")!, document.getElementById("AdminRegistrationModeRadioInviteCode")!, document.getElementById("AdminRegistrationModeRadioOpen")!]

  const RegistrationMode = RegistrationRadios.filter((e) => e.checked)[0].getAttribute("value");

  await window.api.SetCurrentRegistrationMode(RegistrationMode);

  await UpdateAdmin();

  await UpdateLogin();
});

const RegisterInviteCodeButton = document.getElementById("AdminAddNewInviteCode");

RegisterInviteCodeButton?.addEventListener("click", async () => {
  const InviteCode = document.getElementById("AdminNewInviteCodeText")!.value;
  const Uses = document.getElementById("AdminNewInviteCodeUses")!.value;
  const InfiniteUses = document.getElementById("AdminNewInviteCodeInfiniteUses")!.checked;

  await window.api.RegisterInviteCode(InviteCode, Uses, InfiniteUses);

  await UpdateAdmin();
});

const DeleteInviteCode = document.getElementById("AdminDeleteInviteCode");

DeleteInviteCode?.addEventListener("click", async () => {
  const InviteCode = document.getElementById("AdminDeleteInviteCodeText")!.value;

  await window.api.DeleteInviteCode(InviteCode);

  await UpdateAdmin();
});

const LoginButton = document.getElementById("loginbutton");

LoginButton?.addEventListener("click", async () => {
  const UserApiKey = document.getElementById("userapikey")!.value;

  await window.api.Login(UserApiKey);

  await UpdateState(undefined);
});

const MigrateLegacyInstallButton1 = document.getElementById("migratelegacyinstallbutton1");

MigrateLegacyInstallButton1?.addEventListener("click", async () => {
  window.api.MigrateLegacyUndauntedInstall();
  
  await UpdateState(undefined);
});

const MigrateLegacyInstallButton2 = document.getElementById("migratelegacyinstallbutton2");

MigrateLegacyInstallButton2?.addEventListener("click", async () => {
  window.api.MigrateLegacyUndauntedInstall();
  
  await UpdateState(undefined);
});

window.api.OnDownloadUpdate(async (State: string, PercentDone: number) => {
  if(State === "Download"){
    InstallState = "DOWNLOAD";
    InstallPercent = PercentDone;
    await UpdateState("INSTALL");
  }
  else if(State === "Verify"){
    InstallState = "VERIFY";
    await UpdateState("INSTALL");
  }
  else if(State === "Install"){
    InstallState = "INSTALL";
    InstallPercent = PercentDone;
    await UpdateState("INSTALL");
  }
  else if(State === "Done"){
    await UpdateState(undefined);
  }
});

const RegisterButton = document.getElementById("RegisterButton");
const RegistrationResultText = document.getElementById("RegistrationResultText")!;

RegisterButton?.addEventListener("click", async () => {
  const InviteCode = document.getElementById("RegistrationInviteCodeInput")!.value;

  const Username = document.getElementById("RegistrationUsernameInput")!.value;

  const UUK = await window.api.RegisterAccount(Username, InviteCode);

  if(UUK == undefined){
      RegistrationResultText.innerText = "Registration failed; check your invite code!";
  }
  else{
    RegistrationResultText.innerText = `Registration Succeeded! Your User API Key is "${UUK}". Save it in a safe place, it will not be shown again.`
  }

  await UpdateUsername();
  await UpdatePlayerCount();
});