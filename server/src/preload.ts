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
    /** Cancel an in-flight auth flow (user closed the browser tab without
     *  completing the OAuth round-trip). Resolves the pending
     *  `openAuthInBrowser` promise with `null` so the UI can re-enable the
     *  Sign-in button. Safe to call when no flow is active — it's a no-op. */
    cancelAuth: () => ipcRenderer.invoke("cancel-auth-flow"),
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
    /** Manually re-check for updates (Settings → Help button). */
    checkForUpdates: () => ipcRenderer.invoke("updater:check"),
    /** Get the cached updater status (current version, last check ts, last error). */
    getUpdaterStatus: () => ipcRenderer.invoke("updater:status"),
    /** One-click "install now & restart". Renderer calls this after an
     *  `update-status: ready` event to apply the downloaded update. */
    installUpdateNow: () => ipcRenderer.invoke("updater:install"),
    /**
     * Virtual Audio Devices — manage the bundled virtual audio driver
     * (BlackHole on macOS, Virtual-Audio-Driver on Windows, pactl on
     * Linux). Available pre-auth so the user can configure routing
     * before signing in.
     *
     * Every call resolves with `{ ok: true, data }` on success or
     * `{ ok: false, error }` on failure (cancelled UAC, missing
     * binary, driver error, …).
     */
    va: {
        probe: () => ipcRenderer.invoke("va:probe"),
        install: () => ipcRenderer.invoke("va:install"),
        uninstall: () => ipcRenderer.invoke("va:uninstall"),
        list: () => ipcRenderer.invoke("va:list"),
        create: (opts: {
            name: string;
            topology: "independent" | "loopback";
            channels?: number;
            sampleRate?: number;
        }) => ipcRenderer.invoke("va:create", opts),
        rename: (id: string, name: string) => ipcRenderer.invoke("va:rename", id, name),
        setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke("va:set-enabled", id, enabled),
        remove: (id: string) => ipcRenderer.invoke("va:remove", id),
    },
});
