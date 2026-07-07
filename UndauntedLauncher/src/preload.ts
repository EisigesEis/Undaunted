// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
    MigrateLegacyUndauntedInstall: () => ipcRenderer.invoke("MigrateLegacyUndauntedInstall"),
    PatchUndauntedInstall: () => ipcRenderer.invoke("PatchUndauntedInstall"),
    DownloadAndInstallUndaunted: (ApiKey: string) => ipcRenderer.send("DownloadAndInstallUndaunted"),
    OnDownloadUpdate: (callback: any) => {
        ipcRenderer.on("DownloadUpdate", (_event, state, value) => callback(state, value));
    },
    GetUsername: async () => await ipcRenderer.invoke("GetUndauntedUsername"),
    GetIsAdmin: async () => await ipcRenderer.invoke("GetIsAdmin"),
    GetState: async () => await ipcRenderer.invoke("GetState"),
    RegisterAccount: async (Username: string, InviteCode: string | undefined) => await ipcRenderer.invoke("RegisterAccount", Username, InviteCode),
    GetCurrentRegistrationMode: async () => await ipcRenderer.invoke("GetCurrentRegistrationMode"),
    SetCurrentRegistrationMode: async (mode: string) => await ipcRenderer.invoke("SetCurrentRegistrationMode", mode),
    GetInviteCodes: async () => await ipcRenderer.invoke("GetInviteCodes"),
    GetPlayerCount: async () => await ipcRenderer.invoke("GetPlayerCount"),
    GetVersion: async () => await ipcRenderer.invoke("GetVersion"),
    GetIsUndauntedRunning: async () => await ipcRenderer.invoke("GetIsUndauntedRunning"),
    RegisterInviteCode: async (InviteCode: string, Uses: number, IsInfinite: boolean) => await ipcRenderer.invoke("RegisterInviteCode", InviteCode, Uses, IsInfinite),
    DeleteInviteCode: async (InviteCode: string) => await ipcRenderer.invoke("DeleteInviteCode", InviteCode),
    PlayUndaunted: () => ipcRenderer.invoke("PlayUndaunted"),
    StopUndaunted: () => ipcRenderer.invoke("StopUndaunted"),
    Login: async (ApiKey: string) => await ipcRenderer.invoke("Login", ApiKey),
    Logout: () => ipcRenderer.invoke("Logout"),
})