import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, dialog, ipcMain, shell, powerSaveBlocker } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { store, getSettings, updateSettings, type CompanionSettings, type AuthorizedAudioDevice } from "./store";
import { listBackends, listDevices, invalidateAudioInventoryCache, type AudioBackend } from "./audio/native-engine";

// ─── Low-latency audio host hardening ────────────────────────────────────────
//
// Realtime audio on a JS runtime is fragile. Anything that pauses the V8
// main thread or the renderer's compositor can produce audible glitches
// — and Chromium aggressively throttles BOTH when the window loses focus,
// which is the textbook cause of "the sound changes when I alt-tab".
//
// The switches below MUST be set before app.whenReady() fires, otherwise
// Chromium has already parsed the command line and ignores them.
//
//   disable-renderer-backgrounding
//     Stops Chromium dropping the renderer's thread priority when the
//     window is hidden / occluded / unfocused.
//
//   disable-background-timer-throttling
//     Stops setTimeout / setInterval being clamped to 1 Hz in background
//     tabs (we use setInterval to push metrics + UI refresh ticks).
//
//   disable-backgrounding-occluded-windows
//     Treats an occluded BrowserWindow as foreground for scheduling
//     purposes. Without this, dragging another app over the companion
//     window is enough to start dropping audio meter updates.
//
// These do NOT affect the realtime audio thread directly (audify runs in
// a native pthread/Win32 thread that Chromium scheduler can't touch) but
// they keep IPC + the renderer's metrics widget responsive so the user
// experience stays consistent across focus changes.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
// Chromium's "native window occlusion" calculation periodically samples
// every visible pixel of every window to figure out which ones to
// suspend rendering for. On Windows this involves a Z-order walk that
// jitters the main thread by ~5-15ms when triggered, which lines up
// suspiciously with audio-thread starvation reports during focus
// changes. Disabling it costs us a tiny bit of CPU efficiency when
// the companion is fully hidden — the realtime audio thread keeps
// running anyway because of disable-renderer-backgrounding above.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
// Tell Chromium that this is an audio-realtime app so it never decides
// the renderer is "idle" and worth throttling. Combined with the
// keep-alive ConstantSourceNode in the browser engines, this is the
// strongest signal we can give the OS scheduler.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");


// ─── Audio inventory cache ───────────────────────────────────────────────────
//
// Enumerating audio devices via RtAudio takes 200–800ms on Windows WASAPI
// and blocks the calling thread. To keep the renderer's first paint snappy
// we:
//   1. Kick off a background enumeration as soon as the app is ready.
//   2. Serve cached results immediately from `get-audio-devices` IPC.
//   3. Re-enumerate on demand AND on a slow background interval, then push
//      the new inventory to every WebContents so the UI re-renders without
//      the user having to click Refresh.
//
// Re-enumeration happens off the V8 main loop via setImmediate() chained
// awaits; that's not a real worker but keeps the main thread responsive
// to IPC messages between probes.

type AudioInventoryGroup = ReturnType<typeof listBackends>[number] & {
    devices: ReturnType<typeof listDevices>["devices"];
};
type AudioInventory = {
    backends: AudioInventoryGroup[];
    authorized: AuthorizedAudioDevice[];
    /** ms epoch when the inventory was last refreshed. */
    refreshedAt: number;
    /** True while a background refresh is in flight. */
    refreshing: boolean;
    /** First-load sentinel — the renderer shows a spinner until this flips. */
    initialLoadComplete: boolean;
    /** Last refresh error (if any). */
    error: string | null;
};

let audioInventory: AudioInventory = {
    backends: [],
    authorized: [],
    refreshedAt: 0,
    refreshing: false,
    initialLoadComplete: false,
    error: null,
};

/**
 * Treat the cached inventory as fresh for this many ms. Renderer mounts
 * within the window get the cached snapshot with no re-enumeration. Tuned
 * empirically: long enough to absorb React re-mounts and tab focus polling,
 * short enough that hot-plugged devices appear on the user's next manual
 * action.
 */
const INVENTORY_FRESH_MS = 30_000;

/**
 * Run a one-shot enumeration of every audio backend. We yield to the event
 * loop between backends so the main thread isn't blocked for the full
 * duration of a multi-backend probe (WASAPI + ASIO can together take
 * upwards of a second).
 */
async function enumerateAudioInventory(): Promise<AudioInventoryGroup[]> {
    const backends = listBackends();
    const groups: AudioInventoryGroup[] = [];
    for (const b of backends) {
        // Yield between backends so IPC handlers can run.
        await new Promise<void>((r) => setImmediate(r));
        if (!b.available) {
            groups.push({ ...b, devices: [] });
            continue;
        }
        try {
            const ld = listDevices(b.backend as AudioBackend);
            groups.push({ ...b, devices: ld.devices });
        } catch (err) {
            logLine("warn", `[audio] listDevices(${b.backend}) failed:`, err as Error);
            groups.push({ ...b, devices: [] });
        }
    }
    return groups;
}

/**
 * Refresh the cached inventory and push it to all renderer windows. Safe to
 * call concurrently — a second invocation while one is in flight is a
 * no-op so we don't pile up RtAudio probes.
 */
async function refreshAudioInventory(reason: string): Promise<void> {
    if (audioInventory.refreshing) return;
    audioInventory = { ...audioInventory, refreshing: true };
    try {
        const groups = await enumerateAudioInventory();
        audioInventory = {
            backends: groups,
            authorized: getSettings().authorizedAudioDevices,
            refreshedAt: Date.now(),
            refreshing: false,
            initialLoadComplete: true,
            error: null,
        };
        logLine("info", `[audio] inventory refreshed (${reason}) — ${groups.reduce((s, g) => s + g.devices.length, 0)} devices`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        audioInventory = {
            ...audioInventory,
            refreshing: false,
            initialLoadComplete: true,
            error: msg,
        };
        logLine("error", `[audio] inventory refresh failed (${reason}):`, err as Error);
    }
    // Notify every open window. The renderer listens for this and re-renders
    // its device list without the user having to press Refresh.
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            win.webContents.send("audio-devices-updated", {
                backends: audioInventory.backends,
                authorized: audioInventory.authorized,
                refreshedAt: audioInventory.refreshedAt,
                error: audioInventory.error,
            });
        }
    }
}

// ─── Crash logging ─────────────────────────────────────────────────────────────
//
// Writes diagnostic output to a known file on disk so we can debug
// startup crashes that happen before any window appears (especially on
// macOS where Console.app sometimes misses very-early failures).
//
// Path:
//   macOS:   ~/Library/Logs/MMO Companion/main.log
//   Windows: %APPDATA%\MMO Companion\logs\main.log
//   Linux:   ~/.config/MMO Companion/logs/main.log
//
// We also surface uncaught exceptions in a dialog so the user can copy
// the error text out instead of staring at a window-that-never-appears.

const LOG_DIR = path.join(
    app.getPath("logs"), // resolves to the platform-appropriate log dir
);
try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
} catch { /* ignore */ }
const LOG_FILE = path.join(LOG_DIR, "main.log");

function logLine(level: "info" | "warn" | "error", ...args: unknown[]): void {
    const line = `[${new Date().toISOString()}] [${level}] ${args
        .map((a) => (a instanceof Error ? `${a.stack ?? a.message}` : typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")}\n`;
    try {
        fs.appendFileSync(LOG_FILE, line);
    } catch { /* ignore */ }
    // Keep an in-memory ring of the most recent lines so the renderer can
    // surface them in a Debug panel without re-reading the log file (which
    // can be many MB after a long session). Capped so the panel never
    // exposes a runaway buffer.
    debugLogRing.push(line.trimEnd());
    if (debugLogRing.length > DEBUG_LOG_MAX) {
        debugLogRing.splice(0, debugLogRing.length - DEBUG_LOG_MAX);
    }
    // Also print to stderr so "open -a 'MMO Companion' --stderr" shows it
    process.stderr.write(line);
}

const DEBUG_LOG_MAX = 500;
const debugLogRing: string[] = [];

// ─── Event-loop lag monitor ──────────────────────────────────────────
//
// The Electron main process drives the renderer over IPC; if the main
// thread stalls (e.g. a synchronous RtAudio probe, a slow native binding
// call, or GC) the renderer's UI freezes. These freezes don't surface in
// any normal log because logging itself runs on the same thread that's
// stuck. By scheduling a recurring no-op timer and measuring how late it
// fires, we can detect blocking work AFTER the fact and write a marker
// into the ring so the user can see exactly when the freeze happened
// when they hit "Copy" in the Debug panel.
//
// Threshold is tuned so normal jitter (GC, IPC bursts) doesn't spam the
// log; only stalls long enough for the user to notice get reported.
const LAG_INTERVAL_MS = 500;
const LAG_REPORT_THRESHOLD_MS = 200;
let lagLastTick = Date.now();
setInterval(() => {
    const now = Date.now();
    const drift = now - lagLastTick - LAG_INTERVAL_MS;
    lagLastTick = now;
    if (drift > LAG_REPORT_THRESHOLD_MS) {
        logLine("warn", `[freeze] event-loop blocked for ~${drift}ms`);
    }
}, LAG_INTERVAL_MS).unref();

logLine("info", "main.ts loaded", {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    appVersion: app.getVersion(),
    execPath: process.execPath,
});

process.on("uncaughtException", (err) => {
    logLine("error", "uncaughtException:", err);
    try {
        dialog.showErrorBox(
            "MMO Companion: uncaught exception",
            `${err.message}\n\nFull log: ${LOG_FILE}\n\n${err.stack ?? ""}`,
        );
    } catch { /* ignore */ }
});

process.on("unhandledRejection", (reason) => {
    logLine("error", "unhandledRejection:", reason as Error);
});

// ─── Lazy-loaded server module ─────────────────────────────────────────────────
//
// We defer requiring "./server" until after the window has been created
// and shown. Reason: server.ts pulls in audify (native module) which
// can crash the main process at require-time if the prebuilt .node
// binary is incompatible with the host's architecture or is missing a
// dynamic dependency (e.g. libopus on macOS). With lazy loading, a
// failure shows a dialog and disables the audio engine but leaves the
// rest of the UI working.

type ServerModule = typeof import("./server");
let serverModule: ServerModule | null = null;
let serverError: Error | null = null;

async function loadServerModule(): Promise<ServerModule | null> {
    if (serverModule) return serverModule;
    if (serverError) return null;
    try {
        logLine("info", "loading ./server module");
        serverModule = await import("./server");
        logLine("info", "./server loaded ok");
        return serverModule;
    } catch (err) {
        serverError = err as Error;
        logLine("error", "./server failed to load:", err);
        try {
            dialog.showErrorBox(
                "MMO Companion: audio engine unavailable",
                `Could not initialize the local server / native audio engine.\n\nThe app will continue running but audio features will be disabled.\n\nLog: ${LOG_FILE}\n\n${(err as Error)?.message ?? err}`,
            );
        } catch { /* ignore */ }
        return null;
    }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
// Set while a Sign-in-with-Google flow is in progress so the renderer can
// abort it (e.g. user closed the OAuth tab). Calling it resolves the
// pending `open-auth-in-browser` promise with `null`.
let pendingAuthCancel: (() => void) | null = null;

// ─── Post-paint task queue ──────────────────────────────────────────
//
// Heavy startup work (importing audify, enumerating audio devices) blocks
// the main thread for hundreds of ms. Running it on the same tick as
// window creation prevented `ready-to-show` from firing in time and froze
// the splash. We now queue these tasks here and drain them ~80 ms after
// the window is shown, by which point the splash has rendered its first
// frame so the user sees the gradient + animation while we probe.
let renderHasPainted = false;
const postPaintQueue: Array<() => void> = [];
function runAfterPaint(task: () => void): void {
    if (renderHasPainted) {
        // Yield once even on the fast path so we don't run two heavy tasks
        // back-to-back on the same tick.
        setImmediate(task);
        return;
    }
    postPaintQueue.push(task);
}

// ─── Single instance lock ────────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        // Always force the window to be visible + focused. The previous
        // implementation only handled `isMinimized()`, which left the user
        // stuck if `mainWindow.show()` had silently failed (e.g. window
        // hidden behind other apps on macOS, or `ready-to-show` never fired).
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
            mainWindow.moveTop();
        } else {
            createWindow();
        }
        // macOS: ensure the dock icon is visible and brings the app forward
        try { app.dock?.show(); } catch { /* ignore */ }
        try { app.focus({ steal: true }); } catch { /* ignore */ }
    });
}

// ─── Window creation ─────────────────────────────────────────────────────────

function getThemeBackground(): string {
    // Companion is a dark-first surface; in light mode we still keep a deep
    // surface tone so the splash gradient + the text-on-dark UI inside
    // remain readable when the window opens. The key win is that this
    // colour matches the splash overlay so there's no white flash before
    // the renderer paints.
    return nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#0f1117";
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 480,
        height: 720,
        minWidth: 400,
        minHeight: 500,
        resizable: true,
        // The default Windows menu (File / Edit / View / Window / Help) eats
        // ~22px of vertical space and isn't useful for this app — hide it
        // and let users press Alt to peek if they ever need it.
        autoHideMenuBar: true,
        icon: path.join(__dirname, "../assets/icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            // Companion is an audio app — the renderer must keep ticking
            // its meter widgets at full rate even when the window isn't
            // focused. Combined with the disable-renderer-backgrounding
            // command-line switch above, this guarantees no perceptual
            // change in metering / UI between foreground and background.
            backgroundThrottling: false,
        },
        // hiddenInset on macOS gives a native frameless look but keeps the
        // traffic-light buttons. On other platforms electron ignores this.
        titleBarStyle: "hiddenInset",
        // Theme-aware background — prevents the white flash that Windows
        // shows for ~50–150 ms between window creation and the renderer's
        // first paint. The splash overlay inside the renderer uses the same
        // tone so the transition is invisible.
        backgroundColor: getThemeBackground(),
        // Hide the window until the renderer has actually painted its
        // first frame. Even with `backgroundColor` set, Windows briefly
        // shows the native frame WITHOUT any client-area paint between
        // window creation and Chromium's first compositor frame, which
        // surfaces as a 50–200 ms white (or theme-coloured) flash. The
        // safer pattern is to keep `show: false` and only show after
        // `ready-to-show`. To avoid the previous bug where that event
        // never fired on macOS ad-hoc builds, we also arm a 1.5 s
        // safety timer that force-shows the window.
        show: false,
        // Force Chromium to render even while hidden so `ready-to-show`
        // fires reliably (the default behaviour skips paints for hidden
        // windows on some platforms).
        paintWhenInitiallyHidden: true,
        center: true,
    });

    const indexPath = path.join(__dirname, "../ui/index.html");
    mainWindow.loadFile(indexPath).catch((err) => {
        console.error("[main] Failed to load UI:", err);
        // Surface the error visibly so the user isn't stuck staring at a
        // blank window.
        dialog.showErrorBox(
            "MMO Companion failed to start",
            `Could not load UI from:\n${indexPath}\n\n${err?.message ?? err}`,
        );
    });

    mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
        console.error(`[main] webContents did-fail-load ${code} ${desc} ${url}`);
    });

    let shown = false;
    const showOnce = (reason: string) => {
        if (shown || !mainWindow || mainWindow.isDestroyed()) return;
        shown = true;
        const settings = getSettings();
        if (settings.startMinimized) return;
        mainWindow.show();
        mainWindow.focus();
        logLine("info", `window shown (${reason})`);
        // Signal that the renderer is now visible, so the heavy startup
        // work (audify load, RtAudio enumeration) can proceed without
        // blocking the splash animation. Without this gate, both ran on
        // the same tick as window creation and surfaced as visible
        // freezes (834 ms + 465 ms in 0.7.2's logs) that prevented
        // `ready-to-show` from firing within the safety window.
        setTimeout(() => {
            renderHasPainted = true;
            for (const cb of postPaintQueue.splice(0)) {
                try { cb(); } catch (err) { logLine("warn", "post-paint task failed:", err as Error); }
            }
        }, 80);
    };
    mainWindow.once("ready-to-show", () => showOnce("ready-to-show"));
    // Safety net: if `ready-to-show` never fires (observed on macOS ad-hoc
    // signed builds in a previous version), force-show after 1.5 s so the
    // user isn't stuck with no visible UI.
    setTimeout(() => showOnce("safety-timeout"), 1500);

    mainWindow.on("close", (event) => {
        const settings = getSettings();
        if (!isQuitting && settings.closeToTray) {
            event.preventDefault();
            mainWindow?.hide();
        }
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    // Repaint the window background when the OS theme changes so the
    // chrome (and any brief reload flash) tracks the user's setting.
    nativeTheme.on("updated", () => {
        try { mainWindow?.setBackgroundColor(getThemeBackground()); } catch { /* ignore */ }
        try { mainWindow?.webContents.send("theme-updated", { dark: nativeTheme.shouldUseDarkColors }); } catch { /* ignore */ }
    });
}

// ─── System Tray ─────────────────────────────────────────────────────────────

function buildTrayMenu(): Electron.Menu {
    return Menu.buildFromTemplate([
        {
            label: "Show Window",
            click: () => {
                mainWindow?.show();
                mainWindow?.focus();
            },
        },
        {
            label: "Open MMO in Browser",
            click: () => {
                const settings = getSettings();
                shell.openExternal(settings.webAppUrl || "http://localhost:3000");
            },
        },
        { type: "separator" },
        {
            label: serverModule ? `Server on port ${serverModule.getServerPort()}` : "Server unavailable",
            enabled: false,
        },
        { type: "separator" },
        {
            label: "Quit",
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);
}

function refreshTrayMenu() {
    if (!tray) return;
    try {
        tray.setContextMenu(buildTrayMenu());
    } catch (err) {
        logLine("warn", "refreshTrayMenu failed:", err as Error);
    }
}

function createTray() {
    const iconPath = path.join(__dirname, "../assets/icon.png");
    let icon: Electron.NativeImage;
    try {
        icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } catch {
        icon = nativeImage.createEmpty();
    }

    tray = new Tray(icon);
    tray.setToolTip("MMO Companion Server");
    tray.setContextMenu(buildTrayMenu());
    tray.on("double-click", () => {
        mainWindow?.show();
        mainWindow?.focus();
    });
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

function setupIPC() {
    ipcMain.handle("get-settings", () => getSettings());

    ipcMain.handle("update-settings", (_event, patch: Partial<CompanionSettings>) => {
        updateSettings(patch);
        // Apply auto-launch setting
        if (patch.startAtLogin !== undefined) {
            app.setLoginItemSettings({
                openAtLogin: patch.startAtLogin,
                openAsHidden: true,
            });
        }
        return getSettings();
    });

    ipcMain.handle("get-status", () => ({
        port: serverModule?.getServerPort() ?? 0,
        serverError: serverError?.message ?? null,
        appVersion: app.getVersion(),
        serverVersion: serverModule?.getServerVersion() ?? null,
        authenticated: !!store.get("deviceToken"),
        deviceId: store.get("deviceId") || null,
        userName: store.get("userName") || null,
        userEmail: store.get("userEmail") || null,
        userImage: store.get("userImage") || null,
    }));

    ipcMain.handle("authenticate", async (_event, data: {
        webAppUrl: string;
        deviceToken: string;
        deviceId: string;
        userName?: string;
        userEmail?: string;
        userImage?: string;
    }) => {
        store.set("deviceToken", data.deviceToken);
        store.set("deviceId", data.deviceId);
        store.set("userName", data.userName || "");
        store.set("userEmail", data.userEmail || "");
        store.set("userImage", data.userImage || "");
        updateSettings({ webAppUrl: data.webAppUrl });
        return { success: true };
    });

    ipcMain.handle("logout", () => {
        store.delete("deviceToken" as never);
        store.delete("deviceId" as never);
        store.delete("userName" as never);
        store.delete("userEmail" as never);
        store.delete("userImage" as never);
        return { success: true };
    });

    ipcMain.handle("select-folder", async () => {
        const result = await dialog.showOpenDialog(mainWindow!, {
            properties: ["openDirectory"],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
    });

    ipcMain.handle("get-version", () => app.getVersion());

    ipcMain.handle("get-theme", () => ({
        dark: nativeTheme.shouldUseDarkColors,
        background: getThemeBackground(),
    }));

    // Mirror of GET /audio/devices on the HTTP server, but routed via IPC so
    // the companion UI doesn't need a device token. Returns the cached
    // inventory immediately and (optionally) kicks off a background refresh;
    // the renderer listens for `audio-devices-updated` to pick up the fresh
    // data.
    //
    // Refresh policy (see logs from 0.7.0 — the previous "refresh on every
    // IPC call + invalidate native cache" behaviour caused two extra
    // 500–1000 ms RtAudio probes on the main thread for every renderer
    // mount, surfacing as `[freeze] event-loop blocked for ~Xms` markers):
    //   - First call (no inventory yet) → always refresh.
    //   - Subsequent calls → skip if inventory is younger than
    //     INVENTORY_FRESH_MS, OR if a refresh is already in flight.
    //   - Caller can pass `{ force: true }` to bypass both guards (the UI
    //     wires this up to the explicit "↻ Refresh" button).
    ipcMain.handle("get-audio-devices", (_event, opts?: { force?: boolean }) => {
        const force = !!opts?.force;
        const ageMs = Date.now() - audioInventory.refreshedAt;
        const stale = force || !audioInventory.initialLoadComplete || ageMs > INVENTORY_FRESH_MS;
        if (stale && !audioInventory.refreshing) {
            // Only bust the native-engine TTL cache when the user explicitly
            // asked for a re-probe — routine renderer mounts must not pay
            // the full RtAudio enumeration cost.
            if (force) invalidateAudioInventoryCache();
            void refreshAudioInventory(
                audioInventory.initialLoadComplete
                    ? (force ? "ipc-refresh" : "ipc-stale")
                    : "first-load",
            );
        }
        if (audioInventory.error && !audioInventory.initialLoadComplete) {
            return { error: audioInventory.error };
        }
        return {
            backends: audioInventory.backends,
            authorized: getSettings().authorizedAudioDevices,
            refreshedAt: audioInventory.refreshedAt,
            initialLoadComplete: audioInventory.initialLoadComplete,
        };
    });

    ipcMain.handle("set-authorized-audio-devices", (_event, list: unknown) => {
        if (!Array.isArray(list)) return { error: "devices must be an array" };
        const cleaned: AuthorizedAudioDevice[] = list
            .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
            .map((d) => ({
                name: String(d.name ?? ""),
                direction: (d.direction === "input" ? "input" : "output") as "input" | "output",
                backend: String(d.backend ?? ""),
                preferredSampleRate: typeof d.preferredSampleRate === "number" ? d.preferredSampleRate : undefined,
            }))
            .filter((d) => d.name.length > 0 && d.backend.length > 0);
        updateSettings({ authorizedAudioDevices: cleaned });
        return { success: true, authorized: cleaned };
    });

    // Live native-engine metrics for the latency widget. Returns
    // `{ running, metrics, status }` or `{ running:false }` if the engine
    // hasn't been started yet (or the server module isn't loaded).
    ipcMain.handle("get-audio-native-metrics", () => {
        try {
            if (!serverModule) return { running: false };
            const eng = serverModule.getNativeEngine();
            if (!eng.isRunning()) return { running: false };
            return {
                running: true,
                metrics: eng.metrics(),
                status: eng.lastStatus(),
            };
        } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
        }
    });

    // Snapshot of the in-memory debug log ring. Used by the Debug panel
    // in the companion UI; gives the user something concrete to copy
    // into a bug report without having to dig out the platform-specific
    // log file path. Returns the most recent lines first — limit is the
    // ring's hard cap (500) so all calls cost the same.
    ipcMain.handle("get-debug-log", () => {
        return {
            logFile: LOG_FILE,
            lines: debugLogRing.slice(),
            // Quick environment dump so the user pastes context, not just
            // log lines. Most fields are static; uptime / memory are live.
            env: {
                appVersion: app.getVersion(),
                electron: process.versions.electron,
                node: process.versions.node,
                platform: process.platform,
                arch: process.arch,
                uptimeSec: Math.round(process.uptime()),
                rssMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
            },
        };
    });

    ipcMain.handle("clear-debug-log", () => {
        debugLogRing.length = 0;
        return { success: true };
    });

    // Hard kill switch for the audio engine. The user can hit this from
    // the companion UI when sound is stuck — typically because the web
    // app crashed or a tab was closed before its stop request reached us.
    // Returns whether the engine was actually running so the UI can give
    // useful feedback ("Engine stopped" vs "Already idle").
    ipcMain.handle("kill-audio-engine", () => {
        if (!serverModule) return { success: false, wasRunning: false, error: "server not loaded" };
        try {
            const eng = serverModule.getNativeEngine();
            const wasRunning = eng.isRunning();
            eng.stop();
            logLine("info", `[audio] engine kill switch fired (wasRunning=${wasRunning})`);
            return { success: true, wasRunning };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logLine("error", "[audio] kill switch failed:", err as Error);
            return { success: false, wasRunning: false, error: msg };
        }
    });

    ipcMain.handle("open-auth-in-browser", async (_event, webAppUrl: string) => {
        if (!serverModule) {
            dialog.showErrorBox("Server unavailable", "Cannot start auth flow because the local server failed to start.");
            return null;
        }
        // Cancel any previous in-flight flow before starting a new one. The
        // user may have clicked Sign in twice, or hit the button after a
        // partial timeout — either way we want exactly one pending promise.
        if (pendingAuthCancel) {
            try { pendingAuthCancel(); } catch { /* ignore */ }
            pendingAuthCancel = null;
        }

        const hostname = os.hostname();
        const platform = process.platform;
        const port = serverModule.getServerPort();
        const localIp = getLocalIp();
        const apiUrl = `http://${localIp}:${port}`;
        const state = serverModule.generateAuthState();
        const callbackUrl = `http://localhost:${port}/auth/callback`;

        const params = new URLSearchParams({
            hostname,
            os: platform,
            port: String(port),
            apiUrl,
            state,
            callbackUrl,
        });

        const authUrl = `${webAppUrl}/api/companion-auth?${params.toString()}`;
        shell.openExternal(authUrl);

        // Wait for auth callback (max 5 minutes) OR explicit cancel from the
        // renderer (user closed the browser tab without finishing OAuth).
        return new Promise((resolve) => {
            const cleanup = () => {
                clearTimeout(timeout);
                serverModule?.authEvents.removeListener("authenticated", handler);
                pendingAuthCancel = null;
            };

            const timeout = setTimeout(() => {
                cleanup();
                resolve(null);
            }, 5 * 60 * 1000);

            function handler(data: Record<string, string>) {
                cleanup();
                resolve(data);
            }

            serverModule!.authEvents.once("authenticated", handler);

            pendingAuthCancel = () => {
                cleanup();
                resolve(null);
            };
        });
    });

    ipcMain.handle("cancel-auth-flow", () => {
        if (pendingAuthCancel) {
            try { pendingAuthCancel(); } catch { /* ignore */ }
            pendingAuthCancel = null;
            return true;
        }
        return false;
    });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getLocalIp(): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]!) {
            if (iface.family === "IPv4" && !iface.internal) {
                return iface.address;
            }
        }
    }
    return "127.0.0.1";
}

// ─── Auto Updater ────────────────────────────────────────────────────────────

function setupAutoUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
        mainWindow?.webContents.send("update-status", {
            status: "available",
            version: info.version,
        });
    });

    autoUpdater.on("download-progress", (progress) => {
        mainWindow?.webContents.send("update-status", {
            status: "downloading",
            percent: Math.round(progress.percent),
        });
    });

    autoUpdater.on("update-downloaded", (info) => {
        mainWindow?.webContents.send("update-status", {
            status: "ready",
            version: info.version,
        });

        // Prompt user and install
        dialog
            .showMessageBox(mainWindow!, {
                type: "info",
                title: "Update Ready",
                message: `Version ${info.version} has been downloaded.`,
                detail: "The app will restart to install the update.",
                buttons: ["Restart Now", "Later"],
                defaultId: 0,
            })
            .then(({ response }) => {
                if (response === 0) {
                    isQuitting = true;
                    autoUpdater.quitAndInstall(false, true);
                }
            });
    });

    autoUpdater.on("error", (err) => {
        console.error("Auto-updater error:", err.message);
    });

    // Check for updates after a short delay
    setTimeout(() => {
        autoUpdater.checkForUpdatesAndNotify().catch(() => { });
    }, 5000);
}

// ─── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    logLine("info", "app whenReady — creating window");
    setupIPC();
    createWindow();
    createTray();

    // Defer the first audio-inventory enumeration until AFTER the splash
    // has painted its first frame. listDevices is a synchronous native
    // RtAudio call (~200–800 ms per backend on Windows WASAPI); running
    // it before paint blocked `ready-to-show` and forced the safety
    // timeout in 0.7.2.
    runAfterPaint(() => {
        void refreshAudioInventory("app-ready");
    });
    // NOTE: a periodic background re-probe was tried but each enumeration
    // is a synchronous RtAudio call (~200–800ms per backend on Windows)
    // that blocks the main thread and visibly froze the UI every 30s. The
    // user can hit "Refresh" if they hot-plug a device; an OS-driven
    // device-change subscription is a better long-term fix but isn't
    // exposed by audify yet.

    // Lazy-load the server, also deferred. Failures here will NOT close
    // the window; they show an error dialog and disable the audio engine.
    runAfterPaint(() => {
        void loadServerModule().then((mod) => {
            if (!mod) {
                refreshTrayMenu();
                return;
            }
            try {
                mod.startServer();
                logLine("info", "server started");
                // Defensive: if a previous companion process or a stale
                // browser tab left the audio engine running (rare but
                // possible if we crashed mid-session and another instance
                // is now starting), stop it here. The web app will start a
                // fresh stream when the user wants one. Without this, the
                // device can stay locked open with seconds of audio
                // buffered up from the last run.
                try { mod.getNativeEngine().stop(); } catch { /* ignore */ }
            } catch (err) {
                logLine("error", "startServer threw:", err as Error);
            } finally {
                // Now that the server is (or isn't) running, update the
                // tray label so the right-click menu reflects reality
                // instead of the stale "Server unavailable" placeholder
                // built at startup.
                refreshTrayMenu();
            }
        });
    });

    setupAutoUpdater();

    const settings = getSettings();
    app.setLoginItemSettings({
        openAtLogin: settings.startAtLogin,
        openAsHidden: true,
    });

    // macOS: ensure the dock icon is visible and the app comes forward
    try {
        app.dock?.show();
    } catch (err) {
        logLine("warn", "app.dock.show() failed:", err as Error);
    }
});

app.on("window-all-closed", () => {
    // Don't quit on window close (tray app)
});

app.on("before-quit", async () => {
    isQuitting = true;
    if (serverModule) {
        try {
            await serverModule.stopServer();
        } catch (err) {
            logLine("warn", "stopServer threw:", err as Error);
        }
    }
});

app.on("activate", () => {
    // Triggered on macOS when the dock icon is clicked.
    if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
        mainWindow.moveTop();
    } else {
        createWindow();
    }
});
