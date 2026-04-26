import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { store, getSettings, updateSettings, type CompanionSettings } from "./store";

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
    // Also print to stderr so "open -a 'MMO Companion' --stderr" shows it
    process.stderr.write(line);
}

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

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 480,
        height: 640,
        minWidth: 400,
        minHeight: 500,
        resizable: true,
        icon: path.join(__dirname, "../assets/icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
        // hiddenInset on macOS gives a native frameless look but keeps the
        // traffic-light buttons. On other platforms electron ignores this.
        titleBarStyle: "hiddenInset",
        backgroundColor: "#0a0a0a",
        // Show the window immediately. The previous `show: false` +
        // `ready-to-show` pattern caused the window to never appear if the
        // event didn't fire (observed on macOS with the ad-hoc signed build).
        show: true,
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

    mainWindow.once("ready-to-show", () => {
        const settings = getSettings();
        if (!settings.startMinimized) {
            mainWindow?.show();
            mainWindow?.focus();
        }
    });

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
}

// ─── System Tray ─────────────────────────────────────────────────────────────

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

    const contextMenu = Menu.buildFromTemplate([
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

    tray.setContextMenu(contextMenu);
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

    ipcMain.handle("open-auth-in-browser", async (_event, webAppUrl: string) => {
        if (!serverModule) {
            dialog.showErrorBox("Server unavailable", "Cannot start auth flow because the local server failed to start.");
            return null;
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

        // Wait for auth callback (max 5 minutes)
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                serverModule?.authEvents.removeListener("authenticated", handler);
                resolve(null);
            }, 5 * 60 * 1000);

            function handler(data: Record<string, string>) {
                clearTimeout(timeout);
                resolve(data);
            }

            serverModule!.authEvents.once("authenticated", handler);
        });
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
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 5000);
}

// ─── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    logLine("info", "app whenReady — creating window");
    setupIPC();
    createWindow();
    createTray();

    // Lazy-load the server. Failures here will NOT close the window;
    // they show an error dialog and disable the audio engine.
    void loadServerModule().then((mod) => {
        if (!mod) return;
        try {
            mod.startServer();
            logLine("info", "server started");
        } catch (err) {
            logLine("error", "startServer threw:", err as Error);
        }
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
