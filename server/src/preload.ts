import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mmo", {
    getSettings: () => ipcRenderer.invoke("get-settings"),
    updateSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke("update-settings", patch),
    getStatus: () => ipcRenderer.invoke("get-status"),
    authenticate: (data: Record<string, unknown>) => ipcRenderer.invoke("authenticate", data),
    logout: () => ipcRenderer.invoke("logout"),
    selectFolder: () => ipcRenderer.invoke("select-folder"),
    getVersion: () => ipcRenderer.invoke("get-version"),
    openAuthInBrowser: (webAppUrl: string) => ipcRenderer.invoke("open-auth-in-browser", webAppUrl),
    onUpdateStatus: (callback: (data: Record<string, unknown>) => void) => {
        ipcRenderer.on("update-status", (_event, data) => callback(data));
    },
});
