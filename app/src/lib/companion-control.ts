/**
 * Companion control HTTP client (server-side only).
 *
 * Sibling to `companion-library.ts`. Where that file talks to
 * `/library/*` (per-user music data), this one talks to the companion's
 * machine-level control surface:
 *
 *   - `/folders`             — list/add/remove music folders
 *   - `/folders/pick`        — open native OS folder dialog
 *   - `/audio/devices`       — enumerate physical audio devices (RtAudio)
 *   - `/audio/devices/authorize` — persist user opt-in for the engine
 *
 * The request is authed against a SPECIFIC device (by id), not "the local
 * companion", because the devices page lets the user manage every
 * companion they've registered (e.g. a desktop + laptop + studio rig).
 */

import "server-only";
import { auth } from "@/auth";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export interface AuthorizedAudioDevice {
    name: string;
    direction: "input" | "output";
    backend: string;
    preferredSampleRate?: number;
}

export interface CompanionFolder {
    path: string;
    exists: boolean;
    label: string;
    /** True when the user has toggled "Auto-watch" for this folder. */
    watch?: boolean;
    /** True when a chokidar watcher is currently running for it. */
    watchActive?: boolean;
    /** Cumulative watcher events seen since the watcher started. */
    watchEvents?: number;
    /** Last error reported by the watcher (e.g. EACCES). */
    watchError?: string | null;
}

/** Mirrors `ScanJob` on the companion. Polled every ~750 ms while a job
 *  is active. The `tracks` field is only populated once `status === "complete"`. */
export interface CompanionScanJob {
    id: string;
    folder: string;
    status: "pending" | "discovering" | "scanning" | "complete" | "error" | "canceled";
    discovered: number;
    scanned: number;
    errored: number;
    currentFile: string | null;
    total: number;
    startedAt: number;
    finishedAt: number | null;
    error: string | null;
    origin: "manual" | "watcher";
    tracks?: CompanionScannedTrack[] | null;
}

export interface CompanionScannedTrack {
    filepath: string;
    filename: string;
    artist?: string;
    title?: string;
    album?: string;
    bpm?: number;
    key?: string;
    duration?: number;
    genre?: string;
    format?: string;
    bitrate?: number;
    sampleRate?: number;
    fileSize: number;
    year?: number;
}

export interface CompanionWatchEvent {
    id: number;
    folder: string;
    kind: "add" | "change" | "unlink";
    filepath: string;
    payload: CompanionScannedTrack | null;
    timestamp: number;
}

export interface CompanionAudioDevice {
    id: number;
    name: string;
    inputChannels: number;
    outputChannels: number;
    duplexChannels: number;
    isDefaultInput: boolean;
    isDefaultOutput: boolean;
    sampleRates: number[];
    preferredSampleRate: number;
}

export interface CompanionAudioBackendGroup {
    backend: string;
    apiName: string;
    available: boolean;
    devices: CompanionAudioDevice[];
}

export interface CompanionAudioInventory {
    backends: CompanionAudioBackendGroup[];
    authorized: AuthorizedAudioDevice[];
}

interface DeviceRow {
    id: string;
    apiUrl: string | null;
    token: string | null;
}

async function resolveDevice(deviceId: string): Promise<DeviceRow | null> {
    const session = await auth();
    if (!session?.user?.id) return null;
    const rows = await db.select().from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)))
        .limit(1);
    const row = rows[0];
    if (!row || !row.apiUrl || !row.token) return null;
    return { id: row.id, apiUrl: row.apiUrl, token: row.token };
}

async function call<T>(
    deviceId: string,
    method: "GET" | "POST",
    pathAndQuery: string,
    body?: unknown,
    timeoutMs = 60_000,
): Promise<T> {
    const dev = await resolveDevice(deviceId);
    if (!dev) throw new Error("Device not found or not authorized");
    const headers: Record<string, string> = { "X-Device-Token": dev.token! };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${dev.apiUrl}${pathAndQuery}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
    });
    if (!res.ok) {
        let detail = "";
        try { detail = (await res.json()).error ?? ""; } catch { /* ignore */ }
        throw new Error(`Companion ${method} ${pathAndQuery} failed (${res.status})${detail ? ": " + detail : ""}`);
    }
    return (await res.json()) as T;
}

export const companionControl = {
    async listFolders(deviceId: string): Promise<CompanionFolder[]> {
        const r = await call<{ folders: CompanionFolder[] | string[] }>(deviceId, "GET", "/folders");
        // The companion may return either rich entries or legacy string[].
        // Normalize to CompanionFolder[].
        return (r.folders ?? []).map((f) =>
            typeof f === "string"
                ? { path: f, exists: true, label: f.split(/[\\/]/).pop() || f, watch: false }
                : { watch: false, ...f },
        );
    },
    async pickFolder(deviceId: string): Promise<{ canceled: boolean; picked?: string; folders: CompanionFolder[] }> {
        const r = await call<{ canceled: boolean; picked?: string; folders: Array<string | CompanionFolder> }>(
            deviceId, "POST", "/folders/pick",
        );
        return {
            canceled: r.canceled,
            picked: r.picked,
            folders: (r.folders ?? []).map((f) =>
                typeof f === "string"
                    ? { path: f, exists: true, label: f.split(/[\\/]/).pop() || f, watch: false }
                    : { watch: false, ...f },
            ),
        };
    },
    async removeFolder(deviceId: string, folderPath: string): Promise<CompanionFolder[]> {
        const r = await call<{ folders: Array<string | CompanionFolder> }>(deviceId, "POST", "/folders/remove", { path: folderPath });
        return (r.folders ?? []).map((f) =>
            typeof f === "string"
                ? { path: f, exists: true, label: f.split(/[\\/]/).pop() || f, watch: false }
                : { watch: false, ...f },
        );
    },
    async setFolderWatch(deviceId: string, folderPath: string, watch: boolean): Promise<CompanionFolder[]> {
        const r = await call<{ folders: Array<string | CompanionFolder> }>(
            deviceId, "POST", "/folders/watch", { path: folderPath, watch },
        );
        return (r.folders ?? []).map((f) =>
            typeof f === "string"
                ? { path: f, exists: true, label: f.split(/[\\/]/).pop() || f, watch: false }
                : { watch: false, ...f },
        );
    },
    async getAudioInventory(deviceId: string): Promise<CompanionAudioInventory> {
        return call<CompanionAudioInventory>(deviceId, "GET", "/audio/devices", undefined, 10_000);
    },
    async setAuthorizedAudioDevices(
        deviceId: string,
        list: AuthorizedAudioDevice[],
    ): Promise<AuthorizedAudioDevice[]> {
        const r = await call<{ authorized: AuthorizedAudioDevice[] }>(
            deviceId, "POST", "/audio/devices/authorize", { devices: list },
        );
        return r.authorized;
    },
    async startScan(deviceId: string, folderPath: string): Promise<CompanionScanJob> {
        const r = await call<{ jobId: string; job: CompanionScanJob }>(
            deviceId, "POST", "/scan", { folder: folderPath }, 15_000,
        );
        return r.job;
    },
    async getScanJob(deviceId: string, jobId: string): Promise<CompanionScanJob> {
        const r = await call<{ job: CompanionScanJob }>(deviceId, "GET", `/scan/jobs/${encodeURIComponent(jobId)}`, undefined, 10_000);
        return r.job;
    },
    async ackScanJob(deviceId: string, jobId: string): Promise<void> {
        await call<{ success: boolean }>(deviceId, "POST", `/scan/jobs/${encodeURIComponent(jobId)}/ack`, {}, 10_000);
    },
    async listScanJobs(deviceId: string): Promise<CompanionScanJob[]> {
        const r = await call<{ jobs: CompanionScanJob[] }>(deviceId, "GET", "/scan/jobs", undefined, 10_000);
        return r.jobs;
    },
    async pollWatchEvents(deviceId: string, since: number): Promise<{ events: CompanionWatchEvent[]; highWatermark: number }> {
        const r = await call<{ events: CompanionWatchEvent[]; highWatermark: number }>(
            deviceId, "GET", `/watch/events?since=${since}`, undefined, 10_000,
        );
        return { events: r.events, highWatermark: r.highWatermark };
    },
};
