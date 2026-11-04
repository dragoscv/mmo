/**
 * Persisted video file registry: opaque fileId → absolute path + probed meta.
 *
 * Populated ONLY by explicit scan jobs (`runVideoScanJob`) and by
 * `/video/lookup`. Read by every `/video/*` streaming route and by
 * `POST /video/scan`, which now answers from this cache instead of running
 * ffprobe inline. Persisted so streaming URLs survive companion restarts.
 */

import { SettingsStore as Store } from "../platform/settings-store";
import fs from "node:fs";
import { mediaLibraryHooks } from "../media/library-hooks";

export type RegistryEntry = { absPath: string; meta: Record<string, unknown> };

const registryStore = new Store<{ entries: Record<string, RegistryEntry> }>({
    name: "video-registry",
    defaults: { entries: {} },
});

export const fileRegistry = new Map<string, RegistryEntry>(
    Object.entries((registryStore.get("entries") ?? {}) as Record<string, RegistryEntry>),
);

let registryDirty = false;
let registryFlushTimer: NodeJS.Timeout | null = null;

function persistRegistry(): void {
    registryDirty = true;
    if (registryFlushTimer) return;
    registryFlushTimer = setTimeout(() => {
        registryFlushTimer = null;
        if (!registryDirty) return;
        registryDirty = false;
        const obj: Record<string, RegistryEntry> = {};
        for (const [k, v] of fileRegistry.entries()) obj[k] = v;
        registryStore.set("entries", obj);
    }, 250);
}

export function registerFile(fileId: string, entry: RegistryEntry): void {
    fileRegistry.set(fileId, entry);
    persistRegistry();
}

/** Stable id: short hash of the absolute path. */
export function makeFileId(absPath: string): string {
    let hash = 0;
    for (let i = 0; i < absPath.length; i++) {
        hash = ((hash << 5) - hash) + absPath.charCodeAt(i);
        hash |= 0;
    }
    return `f${(hash >>> 0).toString(36)}`;
}

export function resolveFileId(fileId: string): string | null {
    return fileRegistry.get(fileId)?.absPath ?? null;
}

function underRoot(absPath: string, root: string): boolean {
    const a = absPath.toLowerCase().replace(/[\\/]+/g, "/");
    const r = root.toLowerCase().replace(/[\\/]+/g, "/").replace(/\/$/, "");
    return a === r || a.startsWith(r + "/");
}

/** Cached entries under the given roots, in `/video/scan` response shape. One `stat` per entry
 *  (cheap, metadata only): files deleted/moved since the scan are dropped from the registry so
 *  TVs never offer a title that 404s. When the ROOT itself is unreachable (drive unplugged,
 *  NAS offline) entries are kept — they come back with the drive. */
export function listRegistered(roots: string[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const rootOnline = new Map<string, boolean>();
    const prunedPaths: string[] = [];
    for (const [fileId, e] of fileRegistry.entries()) {
        const root = roots.find((r) => underRoot(e.absPath, r));
        if (!root) continue;
        if (!fs.existsSync(e.absPath)) {
            let online = rootOnline.get(root);
            if (online === undefined) { online = fs.existsSync(root); rootOnline.set(root, online); }
            if (online) { fileRegistry.delete(fileId); prunedPaths.push(e.absPath); }
            continue;
        }
        out.push({ fileId, ...e.meta });
    }
    if (prunedPaths.length > 0) {
        persistRegistry();
        // Same paths leave the /media library index (TV Home "Continue watching", title files).
        void mediaLibraryHooks().onFilesChanged([], prunedPaths).catch(() => undefined);
    }
    return out;
}
