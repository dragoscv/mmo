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
    /** Get the current cached audio inventory. Pass `{ force: true }` to
     *  bypass the freshness window and trigger a full re-enumeration. */
    getAudioDevices: (opts?: { force?: boolean }) => ipcRenderer.invoke("get-audio-devices", opts),
    setAuthorizedAudioDevices: (list: unknown[]) => ipcRenderer.invoke("set-authorized-audio-devices", list),
    getAudioNativeMetrics: () => ipcRenderer.invoke("get-audio-native-metrics"),
    /** Snapshot of the in-memory debug log + environment info. */
    getDebugLog: () => ipcRenderer.invoke("get-debug-log"),
    clearDebugLog: () => ipcRenderer.invoke("clear-debug-log"),
    /** Hard-stop the native audio engine (sound stuck on, web tab closed,
     *  etc.). Returns `{ success, wasRunning }`. */
    killAudioEngine: () => ipcRenderer.invoke("kill-audio-engine"),
    /**
     * Subscribe to audio inventory refreshes pushed by the main process.
     * Returns an unsubscribe function. Fires whenever the cached device
     * inventory changes (initial load, periodic background re-probe, or
     * an explicit IPC refresh from the UI).
     */
    onAudioDevicesUpdated: (callback: (data: Record<string, unknown>) => void) => {
        const handler = (_event: unknown, data: Record<string, unknown>) => callback(data);
        ipcRenderer.on("audio-devices-updated", handler);
        return () => ipcRenderer.off("audio-devices-updated", handler);
    },
    /** Get the current OS theme. Used by the splash overlay so it picks
     *  the right background colour before any IPC roundtrip completes. */
    getTheme: () => ipcRenderer.invoke("get-theme"),
    /** Subscribe to OS theme changes (e.g. user toggles dark mode). */
    onThemeUpdated: (callback: (data: { dark: boolean }) => void) => {
        const handler = (_event: unknown, data: { dark: boolean }) => callback(data);
        ipcRenderer.on("theme-updated", handler);
        return () => ipcRenderer.off("theme-updated", handler);
    },
    onUpdateStatus: (callback: (data: Record<string, unknown>) => void) => {
        ipcRenderer.on("update-status", (_event, data) => callback(data));
    },
});
