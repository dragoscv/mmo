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
import fsp from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { getSettings, store, FOLDER_KINDS, type FolderKind } from "./store";
import { listBackends, listDevices, type AudioBackend } from "./audio/native-engine";
import { listWatcherStatuses, startWatcher, stopWatcher } from "./library/watcher";
import { log } from "./logger";

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

    list_drives: async () => ({ drives: await listDrivesCached() }),

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
        try { stat = await fsp.stat(folderPath); }
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
        invalidateDirectoryCache(path.dirname(resolved));
        return { added: true, picked: resolved, folders: listFolders() };
    },
};

// ─── Filesystem browser cache ────────────────────────────────────────────
// Drive list and per-directory listings are stable for minutes — a folder
// the user just opened is overwhelmingly likely to be re-opened in the
// same picker session, and drives don't sprout and vanish every few
// seconds. We use long TTLs and rely on explicit invalidation
// (`invalidateDirectoryCache`) when our own `add_folder` mutates state.
// Stale entries from the OS adding a USB drive or the user creating a
// folder externally are corrected on the next picker open after TTL.

const DRIVES_TTL_MS = 5 * 60_000;
const DIR_TTL_MS = 5 * 60_000;
const DIR_LRU_MAX = 200;

let drivesCache: { at: number; value: DriveInfo[] } | null = null;
let drivesInflight: Promise<DriveInfo[]> | null = null;

type DirListing = Awaited<ReturnType<typeof listDirectory>>;
// Map preserves insertion order → cheap LRU: delete + re-insert on hit.
const dirCache = new Map<string, { at: number; value: DirListing }>();
const dirInflight = new Map<string, Promise<DirListing>>();

export async function listDrivesCached(): Promise<DriveInfo[]> {
    const now = Date.now();
    if (drivesCache && now - drivesCache.at < DRIVES_TTL_MS) return drivesCache.value;
    if (drivesInflight) return drivesInflight;
    drivesInflight = (async () => {
        try {
            const value = await listDrives();
            drivesCache = { at: Date.now(), value };
            return value;
        } finally {
            drivesInflight = null;
        }
    })();
    return drivesInflight;
}

export async function listDirectoryCached(requested: string): Promise<DirListing> {
    const key = path.resolve(requested);
    const now = Date.now();
    const hit = dirCache.get(key);
    if (hit && now - hit.at < DIR_TTL_MS) {
        // LRU touch.
        dirCache.delete(key);
        dirCache.set(key, hit);
        return hit.value;
    }
    // Coalesce concurrent requests for the same directory.
    const pending = dirInflight.get(key);
    if (pending) return pending;
    const promise = (async () => {
        try {
            const value = await listDirectory(requested);
            dirCache.set(key, { at: Date.now(), value });
            if (dirCache.size > DIR_LRU_MAX) {
                const oldest = dirCache.keys().next().value;
                if (oldest !== undefined) dirCache.delete(oldest);
            }
            return value;
        } finally {
            dirInflight.delete(key);
        }
    })();
    dirInflight.set(key, promise);
    return promise;
}

export function invalidateDirectoryCache(p: string): void {
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

function listDrives(): Promise<DriveInfo[]> {
    if (process.platform === "win32") return listDrivesWin();
    if (process.platform === "darwin") return listDrivesMac();
    return listDrivesLinux();
}

// Windows: probe drive letters in parallel via async `fs.access`. This
// completes in ~5-20 ms on a normal system — orders of magnitude faster
// than spawning `powershell.exe` (which has a 300-1500 ms cold start) or
// `wmic` (deprecated and missing on Win11 24H2+). We give up volume
// labels and free-space numbers (cosmetic only — the picker only needs
// the root paths to navigate), and kick off a background label refresh
// that updates the cache transparently for the next picker open.
async function listDrivesWin(): Promise<DriveInfo[]> {
    const home = os.homedir();
    const letters: string[] = [];
    for (let c = "A".charCodeAt(0); c <= "Z".charCodeAt(0); c++) letters.push(String.fromCharCode(c));
    const probes = await Promise.all(letters.map(async (letter) => {
        const root = `${letter}:\\`;
        try { await fsp.access(root); return root; } catch { return null; }
    }));
    const drives: DriveInfo[] = [];
    for (const root of probes) {
        if (root) drives.push({ path: root, label: root, type: "fixed" });
    }
    drives.push({ path: home, label: `Home (${path.basename(home)})`, type: "home" });
    // Best-effort background enrichment: ask PowerShell for friendly
    // labels + sizes. When it returns we splice the data into the cache
    // so the *next* picker open gets the nicer labels. Failure is silent.
    void enrichWindowsDrives(drives);
    return drives;
}

function enrichWindowsDrives(current: DriveInfo[]): void {
    execFile(
        "powershell.exe",
        [
            "-NoProfile", "-NonInteractive", "-Command",
            "Get-PSDrive -PSProvider FileSystem | Select-Object Name,Root,DisplayRoot,Description,Used,Free | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", timeout: 4_000, maxBuffer: 1 << 20 },
        (err, stdout) => {
            if (err || !stdout) return;
            try {
                const trimmed = stdout.trim();
                if (!trimmed) return;
                const parsed = JSON.parse(trimmed.startsWith("[") ? trimmed : `[${trimmed}]`) as Array<{
                    Name?: string; Root?: string; DisplayRoot?: string | null;
                    Description?: string | null; Used?: number | null; Free?: number | null;
                }>;
                const byRoot = new Map<string, DriveInfo>();
                for (const d of parsed) {
                    const root = (d.Root ?? (d.Name ? `${d.Name}:\\` : "")).trim();
                    if (!root) continue;
                    const label = d.Description?.toString().trim() || d.DisplayRoot?.toString().trim() || root;
                    const used = typeof d.Used === "number" ? d.Used : 0;
                    const free = typeof d.Free === "number" ? d.Free : undefined;
                    const total = free !== undefined ? used + free : undefined;
                    byRoot.set(root, {
                        path: root,
                        label: `${label} (${root.replace(/\\$/, "")})`,
                        type: d.DisplayRoot ? "network" : "fixed",
                        free, total,
                    });
                }
                if (byRoot.size === 0) return;
                const enriched = current.map((d) => byRoot.get(d.path) ?? d);
                drivesCache = { at: Date.now(), value: enriched };
            } catch { /* ignore parse failures */ }
        },
    );
}

async function listDrivesMac(): Promise<DriveInfo[]> {
    const home = os.homedir();
    const drives: DriveInfo[] = [
        { path: "/", label: "Macintosh HD (/)", type: "root" },
        { path: home, label: `Home (${path.basename(home)})`, type: "home" },
    ];
    try {
        const volumes = (await fsp.readdir("/Volumes", { withFileTypes: true }))
            .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."));
        for (const v of volumes) {
            drives.push({ path: path.join("/Volumes", v.name), label: v.name, type: "removable" });
        }
    } catch { /* ignore */ }
    return drives;
}

async function listDrivesLinux(): Promise<DriveInfo[]> {
    const home = os.homedir();
    const drives: DriveInfo[] = [
        { path: "/", label: "Root (/)", type: "root" },
        { path: home, label: `Home (${path.basename(home)})`, type: "home" },
    ];
    for (const base of ["/mnt", "/media"]) {
        try {
            await fsp.access(base);
            const dirs = (await fsp.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory());
            for (const d of dirs) {
                drives.push({ path: path.join(base, d.name), label: `${d.name} (${base})`, type: "removable" });
            }
        } catch { /* ignore */ }
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

async function listDirectory(requested: string): Promise<{
    path: string; parent: string | null; entries: Array<{ name: string; path: string; hasChildren: boolean | null }>; partial?: boolean;
}> {
    const target = path.resolve(requested);
    let dirents: fs.Dirent[];
    try {
        dirents = await fsp.readdir(target, { withFileTypes: true });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Cannot read "${target}": ${msg}`);
    }
    let partial = false;
    const entries: Array<{ name: string; path: string; hasChildren: boolean | null }> = [];
    // We deliberately do NOT probe each subdirectory for children: on
    // Windows/USB/network drives that was N synchronous readdir calls per
    // listing (a folder with 100 subdirs blocked the event loop for
    // hundreds of ms to seconds). The UI shows every directory as
    // potentially-expandable; the cost of one wasted click on a leaf
    // folder is far cheaper than blocking every listing.
    const symlinkChecks = dirents.map(async (d) => {
        if (d.isDirectory()) return d;
        if (!d.isSymbolicLink()) return null;
        try {
            const s = await fsp.stat(path.join(target, d.name));
            return s.isDirectory() ? d : null;
        } catch { partial = true; return null; }
    });
    const resolved = await Promise.all(symlinkChecks);
    for (const d of resolved) {
        if (!d) continue;
        if (isHiddenName(d.name)) continue;
        entries.push({ name: d.name, path: path.join(target, d.name), hasChildren: true });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
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
            log("warn", `[cmd] unknown kind=${cmd.kind} id=${cmd.id}`);
            out.push({ id: cmd.id, ok: false, error: `Unknown command: ${cmd.kind}` });
            continue;
        }
        const t0 = Date.now();
        try {
            const result = await handler(cmd.payload);
            const ms = Date.now() - t0;
            log("info", `[cmd] ok kind=${cmd.kind} id=${cmd.id} in ${ms}ms`);
            out.push({ id: cmd.id, ok: true, result });
        } catch (e) {
            const ms = Date.now() - t0;
            log("error", `[cmd] fail kind=${cmd.kind} id=${cmd.id} in ${ms}ms`, e as Error);
            out.push({ id: cmd.id, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    }
    return out;
}
