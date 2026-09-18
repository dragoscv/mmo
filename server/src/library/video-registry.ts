/**
 * Persisted video file registry: opaque fileId → absolute path + probed meta.
 *
 * Populated ONLY by explicit scan jobs (`runVideoScanJob`) and by
 * `/video/lookup`. Read by every `/video/*` streaming route and by
 * `POST /video/scan`, which now answers from this cache instead of running
 * ffprobe inline. Persisted so streaming URLs survive companion restarts.
 */

import { SettingsStore as Store } from "../platform/settings-store";

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

/** Cached entries under the given roots, in `/video/scan` response shape. No I/O. */
export function listRegistered(roots: string[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const [fileId, e] of fileRegistry.entries()) {
        if (!roots.some((r) => underRoot(e.absPath, r))) continue;
        out.push({ fileId, ...e.meta });
    }
    return out;
}
