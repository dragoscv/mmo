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
};

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
