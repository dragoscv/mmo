/**
 * Companion command worker.
 *
 * Background: Vercel cannot reach the user's LAN where this companion
 * runs, and the browser is blocked by mixed-content + Private Network
 * Access from talking to http://192.168.x.x from https://muzicai.ro.
 * So the web app enqueues commands (folder picker, audio enumeration,
 * etc.) into the cloud `device_commands` table; we drain them via the
 * existing /api/devices/announce heartbeat response and post results
 * back on the next announce tick.
 *
 * This module owns the dispatch table. The announce loop in
 * lan-announce.ts collects results to send and passes incoming commands
 * here for execution.
 */

import { BrowserWindow, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { getSettings, store, FOLDER_KINDS, type FolderKind } from "./store";
import { listBackends, listDevices, type AudioBackend } from "./audio/native-engine";
import { listWatcherStatuses, startWatcher, stopWatcher } from "./library/watcher";

export interface InboundCommand {
    id: string;
    kind: string;
    payload: unknown;
}

export interface OutboundResult {
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
}

type Handler = (payload: unknown) => Promise<unknown>;

const handlers: Record<string, Handler> = {
    list_folders: async () => ({ folders: listFolders() }),

    pick_folder: async (payload) => {
        const desiredKind = pickKind(payload);
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const result = win
            ? await dialog.showOpenDialog(win, {
                title: "Pick a music folder",
                properties: ["openDirectory", "createDirectory"],
            })
            : await dialog.showOpenDialog({
                title: "Pick a music folder",
                properties: ["openDirectory", "createDirectory"],
            });
        if (result.canceled || result.filePaths.length === 0) {
            return { canceled: true, folders: listFolders() };
        }
        const picked = path.resolve(result.filePaths[0]);
        const settings = getSettings();
        const folders = settings.scanFolders;
        if (!folders.some((f) => f.path === picked)) {
            folders.push({ path: picked, watch: false, kind: desiredKind });
            store.set("scanFolders", folders);
        }
        return { canceled: false, picked, folders: listFolders() };
    },

    remove_folder: async (payload) => {
        const folderPath = pickString(payload, "path");
        if (!folderPath) throw new Error("path required");
        const settings = getSettings();
        const folders = settings.scanFolders.filter((f) => f.path !== folderPath);
        store.set("scanFolders", folders);
        void stopWatcher(folderPath);
        return { folders: listFolders() };
    },

    set_folder_watch: async (payload) => {
        const folderPath = pickString(payload, "path");
        const watch = !!(payload as { watch?: boolean })?.watch;
        if (!folderPath) throw new Error("path required");
        const settings = getSettings();
        if (!settings.scanFolders.some((f) => f.path === folderPath)) {
            throw new Error("Folder not configured");
        }
        const folders = settings.scanFolders.map((f) =>
            f.path === folderPath ? { ...f, watch } : f,
        );
        store.set("scanFolders", folders);
        if (watch) startWatcher(folderPath);
        else void stopWatcher(folderPath);
        return { folders: listFolders() };
    },

    set_folder_kind: async (payload) => {
        const folderPath = pickString(payload, "path");
        const kind = pickKind(payload);
        if (!folderPath) throw new Error("path required");
        const settings = getSettings();
        if (!settings.scanFolders.some((f) => f.path === folderPath)) {
            throw new Error("Folder not configured");
        }
        const folders = settings.scanFolders.map((f) =>
            f.path === folderPath ? { ...f, kind } : f,
        );
        store.set("scanFolders", folders);
        return { folders: listFolders() };
    },

    list_audio_devices: async () => {
        const backends = listBackends();
        const groups: Array<{ backend: string; apiName: string; available: boolean; devices: unknown[] }> = [];
        for (const b of backends) {
            if (!b.available) { groups.push({ ...b, devices: [] }); continue; }
            try {
                const ld = listDevices(b.backend as AudioBackend);
                groups.push({ ...b, devices: ld.devices });
            } catch {
                groups.push({ ...b, devices: [] });
            }
        }
        return { backends: groups, authorized: getSettings().authorizedAudioDevices };
    },

    set_authorized_audio_devices: async (payload) => {
        const list = (payload as { devices?: unknown })?.devices;
        if (!Array.isArray(list)) throw new Error("devices must be an array");
        const cleaned = list
            .filter((d): d is Record<string, unknown> => typeof d === "object" && d !== null)
            .map((d) => ({
                name: String(d.name ?? ""),
                direction: (d.direction === "input" ? "input" : "output") as "input" | "output",
                backend: String(d.backend ?? ""),
                preferredSampleRate: typeof d.preferredSampleRate === "number" ? d.preferredSampleRate : undefined,
            }))
            .filter((d) => d.name.length > 0 && d.backend.length > 0);
        store.set("authorizedAudioDevices", cleaned);
        return { authorized: cleaned };
    },

    // ── In-web filesystem browser ────────────────────────────────────────
    // The web app drives navigation by issuing `list_drives` once, then
    // `list_directory` per click. `add_folder` finalises the pick. We never
    // open a native dialog so the entire flow stays in the browser.

    list_drives: async () => ({ drives: listDrivesCached() }),

    list_directory: async (payload) => {
        const requested = pickString(payload, "path");
        if (!requested) throw new Error("path required");
        return listDirectoryCached(requested);
    },

    add_folder: async (payload) => {
        const folderPath = pickString(payload, "path");
        if (!folderPath) throw new Error("path required");
        const desiredKind = pickKind(payload);
        let stat: fs.Stats;
        try { stat = fs.statSync(folderPath); }
        catch { throw new Error("Folder does not exist or is not readable"); }
        if (!stat.isDirectory()) throw new Error("Path is not a directory");
        const resolved = path.resolve(folderPath);
        const settings = getSettings();
        const folders = settings.scanFolders;
        if (folders.some((f) => f.path === resolved)) {
            return { added: false, picked: resolved, folders: listFolders() };
        }
        folders.push({ path: resolved, watch: false, kind: desiredKind });
        store.set("scanFolders", folders);
        // The newly-added folder may now display a different "already in library"
        // affordance on the next listing of its parent. Drop the parent so the
        // very next navigate-up returns fresh data.
        invalidateDirectoryCache(path.dirname(resolved));
        return { added: true, picked: resolved, folders: listFolders() };
    },
};

// ─── Filesystem browser cache ────────────────────────────────────────────
// Two reasons this exists:
//   1. Each round-trip through the announce queue adds ~750ms-3s of
//      transport latency. Re-listing the same drive after a back-click
//      shouldn't pay that twice.
//   2. `fs.readdirSync` + per-child `hasChildren` probe is ~5-50 ms on
//      hot dirs and can spike to seconds on a slow USB/network drive.
// Both transports (queue and any future direct LAN call) benefit.

const DRIVES_TTL_MS = 10_000;
const DIR_TTL_MS = 30_000;
const DIR_LRU_MAX = 200;

let drivesCache: { at: number; value: DriveInfo[] } | null = null;

type DirListing = ReturnType<typeof listDirectory>;
// Map preserves insertion order → cheap LRU: delete + re-insert on hit.
const dirCache = new Map<string, { at: number; value: DirListing }>();

function listDrivesCached(): DriveInfo[] {
    const now = Date.now();
    if (drivesCache && now - drivesCache.at < DRIVES_TTL_MS) return drivesCache.value;
    const value = listDrives();
    drivesCache = { at: now, value };
    return value;
}

function listDirectoryCached(requested: string): DirListing {
    const key = path.resolve(requested);
    const now = Date.now();
    const hit = dirCache.get(key);
    if (hit && now - hit.at < DIR_TTL_MS) {
        // LRU touch.
        dirCache.delete(key);
        dirCache.set(key, hit);
        return hit.value;
    }
    const value = listDirectory(requested);
    dirCache.set(key, { at: now, value });
    if (dirCache.size > DIR_LRU_MAX) {
        const oldest = dirCache.keys().next().value;
        if (oldest !== undefined) dirCache.delete(oldest);
    }
    return value;
}

function invalidateDirectoryCache(p: string): void {
    dirCache.delete(path.resolve(p));
}

function listFolders() {
    const settings = getSettings();
    const watcherStatuses = new Map(listWatcherStatuses().map((s) => [s.folder, s] as const));
    return settings.scanFolders.map((f) => ({
        path: f.path,
        exists: fs.existsSync(f.path),
        label: path.basename(f.path) || f.path,
        kind: f.kind ?? "music",
        watch: !!f.watch,
        watchActive: !!watcherStatuses.get(f.path)?.active,
        watchEvents: watcherStatuses.get(f.path)?.eventsSeen ?? 0,
        watchError: watcherStatuses.get(f.path)?.error ?? null,
    }));
}

// ─── Filesystem browser helpers ──────────────────────────────────────────
// The web app calls these via the command queue to render an in-browser
// folder picker. We deliberately list ONLY directories (the picker can't
// add files), skip hidden / system entries on the user's home, and never
// throw on per-child failures — a single unreadable subfolder must not
// kill the whole listing or the user gets stuck.

interface DriveInfo {
    path: string;
    label: string;
    type: "fixed" | "removable" | "network" | "root" | "home" | "unknown";
    free?: number;
    total?: number;
}

function listDrives(): DriveInfo[] {
    const drives: DriveInfo[] = [];
    const home = os.homedir();
    if (process.platform === "win32") {
        // PowerShell is far more reliable than `wmic` on modern Windows
        // (wmic is deprecated and missing on Win11 24H2+). We ask for the
        // bare minimum and parse JSON. If it fails we fall back to a
        // simple A:-Z: probe via fs.existsSync.
        try {
            const out = execFileSync(
                "powershell.exe",
                [
                    "-NoProfile", "-NonInteractive", "-Command",
                    "Get-PSDrive -PSProvider FileSystem | Select-Object Name,Root,DisplayRoot,Description,Used,Free | ConvertTo-Json -Compress",
                ],
                { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
            ).trim();
            const parsed = JSON.parse(out.startsWith("[") ? out : `[${out}]`) as Array<{
                Name?: string; Root?: string; DisplayRoot?: string | null;
                Description?: string | null; Used?: number | null; Free?: number | null;
            }>;
            for (const d of parsed) {
                const root = (d.Root ?? (d.Name ? `${d.Name}:\\` : "")).trim();
                if (!root) continue;
                const label = d.Description?.toString().trim() || d.DisplayRoot?.toString().trim() || root;
                const used = typeof d.Used === "number" ? d.Used : 0;
                const free = typeof d.Free === "number" ? d.Free : undefined;
                const total = free !== undefined ? used + free : undefined;
                drives.push({
                    path: root,
                    label: `${label} (${root.replace(/\\$/, "")})`,
                    type: d.DisplayRoot ? "network" : "fixed",
                    free, total,
                });
            }
        } catch {
            for (let c = "A".charCodeAt(0); c <= "Z".charCodeAt(0); c++) {
                const letter = String.fromCharCode(c);
                const root = `${letter}:\\`;
                try { if (fs.existsSync(root)) drives.push({ path: root, label: root, type: "fixed" }); }
                catch { /* ignore */ }
            }
        }
        drives.push({ path: home, label: `Home (${path.basename(home)})`, type: "home" });
    } else if (process.platform === "darwin") {
        drives.push({ path: "/", label: "Macintosh HD (/)", type: "root" });
        drives.push({ path: home, label: `Home (${path.basename(home)})`, type: "home" });
        try {
            const volumes = fs.readdirSync("/Volumes", { withFileTypes: true })
                .filter((e) => e.isDirectory() || e.isSymbolicLink())
                .filter((e) => !e.name.startsWith("."));
            for (const v of volumes) {
                const p = path.join("/Volumes", v.name);
                drives.push({ path: p, label: v.name, type: "removable" });
            }
        } catch { /* ignore */ }
    } else {
        // Linux / other POSIX.
        drives.push({ path: "/", label: "Root (/)", type: "root" });
        drives.push({ path: home, label: `Home (${path.basename(home)})`, type: "home" });
        for (const base of ["/mnt", "/media"]) {
            try {
                if (!fs.existsSync(base)) continue;
                const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
                for (const d of dirs) {
                    drives.push({ path: path.join(base, d.name), label: `${d.name} (${base})`, type: "removable" });
                }
            } catch { /* ignore */ }
        }
    }
    return drives;
}

const HIDDEN_PREFIXES_POSIX = ["."];
const SKIP_NAMES_WIN = new Set([
    "$Recycle.Bin", "System Volume Information", "Recovery",
    "Config.Msi", "PerfLogs", "$WinREAgent",
]);

function isHiddenName(name: string): boolean {
    if (process.platform === "win32") return SKIP_NAMES_WIN.has(name);
    return HIDDEN_PREFIXES_POSIX.some((p) => name.startsWith(p));
}

function listDirectory(requested: string): {
    path: string; parent: string | null; entries: Array<{ name: string; path: string; hasChildren: boolean | null }>; partial?: boolean;
} {
    const target = path.resolve(requested);
    let dirents: fs.Dirent[];
    try {
        dirents = fs.readdirSync(target, { withFileTypes: true });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Cannot read "${target}": ${msg}`);
    }
    let partial = false;
    const entries: Array<{ name: string; path: string; hasChildren: boolean | null }> = [];
    for (const d of dirents) {
        if (!d.isDirectory()) {
            // Honour symlinks that point at directories. Stat may EACCES — skip silently.
            if (d.isSymbolicLink()) {
                try {
                    const s = fs.statSync(path.join(target, d.name));
                    if (!s.isDirectory()) continue;
                } catch { partial = true; continue; }
            } else continue;
        }
        if (isHiddenName(d.name)) continue;
        const full = path.join(target, d.name);
        let hasChildren: boolean | null = null;
        try {
            const inner = fs.readdirSync(full, { withFileTypes: true });
            hasChildren = inner.some((c) => c.isDirectory() && !isHiddenName(c.name));
        } catch { hasChildren = null; partial = true; }
        entries.push({ name: d.name, path: full, hasChildren });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    // Parent is null at a drive root: on Windows `path.dirname("C:\\")` returns `C:\` again;
    // on POSIX `path.dirname("/")` returns `/`. Compare normalized strings.
    const parentRaw = path.dirname(target);
    const parent = path.resolve(parentRaw) === target ? null : parentRaw;
    return { path: target, parent, entries, partial: partial || undefined };
}

function pickString(payload: unknown, key: string): string | null {
    if (!payload || typeof payload !== "object") return null;
    const v = (payload as Record<string, unknown>)[key];
    return typeof v === "string" && v.length > 0 ? v : null;
}

function pickKind(payload: unknown): FolderKind {
    if (!payload || typeof payload !== "object") return "music";
    const k = (payload as { kind?: unknown }).kind;
    return typeof k === "string" && (FOLDER_KINDS as readonly string[]).includes(k)
        ? k as FolderKind
        : "music";
}

/**
 * Execute a batch of commands sequentially. Returns one result per
 * command. Never throws — handler errors become {ok:false,error}.
 */
export async function executeCommands(cmds: InboundCommand[]): Promise<OutboundResult[]> {
    const out: OutboundResult[] = [];
    for (const cmd of cmds) {
        const handler = handlers[cmd.kind];
        if (!handler) {
            out.push({ id: cmd.id, ok: false, error: `Unknown command: ${cmd.kind}` });
            continue;
        }
        try {
            const result = await handler(cmd.payload);
            out.push({ id: cmd.id, ok: true, result });
        } catch (e) {
            out.push({ id: cmd.id, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    }
    return out;
}
