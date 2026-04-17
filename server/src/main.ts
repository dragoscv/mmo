import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import os from "node:os";
import { startServer, stopServer, getServerPort, authEvents, generateAuthState } from "./server";
import { store, getSettings, updateSettings, type CompanionSettings } from "./store";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// ─── Single instance lock ────────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
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
        titleBarStyle: "hiddenInset",
        backgroundColor: "#0a0a0a",
        show: false,
    });

    mainWindow.loadFile(path.join(__dirname, "../ui/index.html"));

    mainWindow.once("ready-to-show", () => {
        const settings = getSettings();
        if (!settings.startMinimized) {
            mainWindow?.show();
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
            label: `Server on port ${getServerPort()}`,
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
        port: getServerPort(),
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
        const hostname = os.hostname();
        const platform = process.platform;
        const port = getServerPort();
        const localIp = getLocalIp();
        const apiUrl = `http://${localIp}:${port}`;
        const state = generateAuthState();
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
                authEvents.removeListener("authenticated", handler);
                resolve(null);
            }, 5 * 60 * 1000);

            function handler(data: Record<string, string>) {
                clearTimeout(timeout);
                resolve(data);
            }

            authEvents.once("authenticated", handler);
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
    setupIPC();
    createWindow();
    createTray();
    await startServer();
    setupAutoUpdater();

    // Apply saved auto-launch setting
    const settings = getSettings();
    app.setLoginItemSettings({
        openAtLogin: settings.startAtLogin,
        openAsHidden: true,
    });
});

app.on("window-all-closed", () => {
    // Don't quit on window close (tray app)
});

app.on("before-quit", async () => {
    isQuitting = true;
    await stopServer();
});

app.on("activate", () => {
    if (mainWindow) {
        mainWindow.show();
    } else {
        createWindow();
    }
});
