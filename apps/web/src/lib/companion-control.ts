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
import { materializeDeviceToken } from "@/lib/device-token";
import type {
    AuthorizedAudioDevice,
    CompanionFolder,
    CompanionScanJob,
    CompanionWatchEvent,
    CompanionAudioInventory,
    FolderKind,
} from "./companion-types";

// Re-export the public types/constants from the client-safe module so
// existing `from "@/lib/companion-control"` imports keep working from
// server actions. Client components must import from `companion-types`
// directly to avoid pulling in `server-only`.
export {
    FOLDER_KINDS,
    type AuthorizedAudioDevice,
    type FolderKind,
    type CompanionFolder,
    type CompanionScannedTrack,
    type CompanionScanJob,
    type CompanionWatchEvent,
    type CompanionAudioDevice,
    type CompanionAudioBackendGroup,
    type CompanionAudioInventory,
    type ScannerCompanion,
} from "./companion-types";

interface DeviceRow {
    id: string;
    apiUrl: string;
    token: string;
}

async function resolveDevice(deviceId: string): Promise<DeviceRow | null> {
    const session = await auth();
    if (!session?.user?.id) return null;
    const rows = await db.select().from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)))
        .limit(1);
    const row = rows[0];
    if (!row) return null;
    const bearer = await materializeDeviceToken(row);
    if (!bearer) return null;
    // Prefer the per-device Cloudflare Tunnel hostname over the
    // companion's announced apiUrl. The announced URL is almost always
    // a LAN address (http://192.168.x.y:9876) which works from a
    // localhost dev server but is UNREACHABLE from Vercel — making
    // every server-action call (scan, audio, folders) time out on the
    // cloud build. Routing through `https://device-<slug>.muzicai.ro`
    // costs ~30-80 ms via the CF edge instead.
    if (row.tunnelHostname) {
        return { id: row.id, apiUrl: `https://${row.tunnelHostname}`, token: bearer };
    }
    if (!row.apiUrl) return null;
    return { id: row.id, apiUrl: row.apiUrl, token: bearer };
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
    const headers: Record<string, string> = { "X-Device-Token": dev.token };
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
    async startScan(deviceId: string, folderPath: string, kind?: FolderKind): Promise<CompanionScanJob> {
        const r = await call<{ jobId: string; job: CompanionScanJob }>(
            deviceId, "POST", "/scan", { folder: folderPath, kind }, 15_000,
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
