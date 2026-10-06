/**
 * Platform shim — the ONLY place the core is allowed to touch Electron.
 *
 * The same server code runs (a) inside Electron (Companion shell) and
 * (b) as a headless Node process (Docker on arm64, see ADR-0002). Under
 * Electron we delegate to `app.*` / `dialog.*`; otherwise we derive the
 * same paths from `MMO_DATA` / OS conventions and no-op the UI surfaces.
 *
 * Detection is `process.versions.electron`, which is only defined when
 * the process IS Electron (the `electron` npm package in a plain Node
 * process resolves to a path string and must never be loaded here).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type PlatformPathName = "userData" | "logs" | "temp" | "home" | "downloads" | "documents";

export interface OpenDialogOptions {
    title?: string;
    defaultPath?: string;
    properties?: Array<"openFile" | "openDirectory" | "multiSelections" | "createDirectory" | "showHiddenFiles">;
}

export interface OpenDialogResult {
    canceled: boolean;
    filePaths: string[];
}

export interface Platform {
    readonly isElectron: boolean;
    readonly isPackaged: boolean;
    getPath(name: PlatformPathName): string;
    getVersion(): string;
    showOpenDialog(opts: OpenDialogOptions): Promise<OpenDialogResult>;
    onBeforeQuit(cb: () => void): void;
}

// Minimal structural types so we never import "electron" types into the core.
interface ElectronAppLike {
    getPath(name: string): string;
    setPath(name: string, value: string): void;
    getVersion(): string;
    isPackaged: boolean;
    on(event: string, cb: (...args: unknown[]) => void): unknown;
}
interface ElectronLike {
    app: ElectronAppLike;
    dialog: { showOpenDialog(win: unknown, opts: OpenDialogOptions): Promise<OpenDialogResult>; showOpenDialog(opts: OpenDialogOptions): Promise<OpenDialogResult> };
    BrowserWindow: { getFocusedWindow(): unknown; getAllWindows(): unknown[] };
}

export const isElectron: boolean = typeof process.versions.electron === "string" && !!process.versions.electron;

let electronRef: ElectronLike | null = null;
function electron(): ElectronLike {
    if (!electronRef) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        electronRef = require("electron") as ElectronLike;
    }
    return electronRef;
}

function readPackageVersion(): string {
    const candidates = [
        path.join(__dirname, "..", "..", "package.json"), // dist/platform → server/package.json
        path.join(__dirname, "..", "package.json"),
    ];
    for (const p of candidates) {
        try {
            const pkg = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string };
            if (pkg.version) return pkg.version;
        } catch { /* try next */ }
    }
    return "0.0.0";
}

/** Default data dir when MMO_DATA is not set (headless only). */
function defaultDataDir(): string {
    if (process.platform === "win32") {
        return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "mmo-server");
    }
    return path.join(os.homedir(), ".local", "share", "mmo-server");
}

function headlessDataDir(): string {
    const env = process.env.MMO_DATA?.trim();
    return path.resolve(env && env.length > 0 ? env : defaultDataDir());
}

const beforeQuitCbs: Array<() => void> = [];

const electronPlatform: Platform = {
    isElectron: true,
    get isPackaged() { return electron().app.isPackaged; },
    getPath(name) { return electron().app.getPath(name); },
    getVersion() { return electron().app.getVersion(); },
    async showOpenDialog(opts) {
        const { dialog, BrowserWindow } = electron();
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
    },
    onBeforeQuit(cb) { electron().app.on("before-quit", () => cb()); },
};

const headlessPlatform: Platform = {
    isElectron: false,
    isPackaged: false,
    getPath(name) {
        switch (name) {
            case "userData": return headlessDataDir();
            case "logs": return path.join(headlessDataDir(), "logs");
            case "temp": return os.tmpdir();
            case "home": return os.homedir();
            case "downloads": return path.join(os.homedir(), "Downloads");
            case "documents": return path.join(os.homedir(), "Documents");
            default: return headlessDataDir();
        }
    },
    getVersion: readPackageVersion,
    async showOpenDialog() { return { canceled: true, filePaths: [] }; },
    onBeforeQuit(cb) { beforeQuitCbs.push(cb); },
};

export const platform: Platform = isElectron ? electronPlatform : headlessPlatform;

/** Headless only: run the registered before-quit callbacks (called by headless.ts on SIGTERM). */
export function runBeforeQuit(): void {
    for (const cb of beforeQuitCbs.splice(0)) {
        try { cb(); } catch { /* ignore */ }
    }
}

/**
 * Electron only: pin `userData` to an explicit directory name. No-op headless
 * (MMO_DATA already IS the pinned dir). Returns the effective userData path.
 */
export function pinUserDataDir(dirName: string): string {
    if (!isElectron) return headlessDataDir();
    const { app } = electron();
    const target = path.join(app.getPath("appData"), dirName);
    if (app.getPath("userData") !== target) app.setPath("userData", target);
    return target;
}
