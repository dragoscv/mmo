"use server";

import { db } from "@/db";
import { devices, deviceFolders } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { companionLibrary, getCompanionLink, getCompanionLinkForDevice } from "@/lib/companion-library";
import {
    companionControl,
    type AuthorizedAudioDevice,
    type CompanionFolder,
    type CompanionAudioInventory,
    type CompanionScanJob,
} from "@/lib/companion-control";
import { issueDeviceToken, materializeDeviceToken } from "@/lib/device-token";

// NOTE: Next.js 16 forbids re-exporting types from `"use server"` files —
// every export must be an async function. Client components import the
// type definitions directly from `@/lib/companion-control` instead.

// ─── Get all devices for current user ───────────────────────────────────────

export async function getDevices() {
    const session = await auth();
    if (!session?.user?.id) return [];

    return db
        .select()
        .from(devices)
        .where(eq(devices.userId, session.user.id));
}

// ─── Get device by ID ─────────────────────────────────────────────

export async function getDevice(deviceId: string) {
    const session = await auth();
    if (!session?.user?.id) return null;

    const rows = await db
        .select()
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)))
        .limit(1);
    return rows[0] ?? null;
}

// ─── Register a new device ──────────────────────────────────────────────────

export async function registerDevice(data: {
    name: string;
    apiUrl: string;
}): Promise<{ deviceId: string; token: string } | { error: string }> {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not authenticated" };

    const issued = issueDeviceToken();
    const deviceId = crypto.randomUUID();

    await db.insert(devices).values({
        id: deviceId,
        userId: session.user.id,
        name: data.name,
        apiUrl: data.apiUrl,
        tokenHash: issued.hash,
        tokenEncrypted: issued.encrypted,
        status: "offline",
    });

    revalidatePath("/devices");
    return { deviceId, token: issued.plaintext };
}

// ─── Update device info (internal helper for pingDevice) ───────────────────
//
// Intentionally NOT exported: it would otherwise be reachable as a server
// action by any signed-in user with no auth gate and no ownership scope —
// letting anyone enumerate device IDs and rewrite their `apiUrl` to an
// attacker-controlled server (which the companion-control client then
// dutifully calls with the user's session). Internal callers below already
// hold a session and have scoped the deviceId before reaching us, so the
// missing checks are safe here; outside callers must go through a
// dedicated server action that does its own auth + ownership.

async function updateDeviceStatusInternal(
    deviceId: string,
    data: {
        status?: string;
        hostname?: string;
        os?: string;
        version?: string;
        apiUrl?: string;
    }
) {
    await db
        .update(devices)
        .set({
            ...data,
            lastSeenAt: new Date(),
        })
        .where(eq(devices.id, deviceId));
}

// ─── Remove device ──────────────────────────────────────────────────────────

export async function removeDevice(deviceId: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not authenticated" };

    await db
        .delete(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)));

    revalidatePath("/devices");
    return { success: true };
}

// ─── Rename device ──────────────────────────────────────────────────────────

export async function renameDevice(deviceId: string, name: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not authenticated" };

    await db
        .update(devices)
        .set({ name })
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)));

    revalidatePath("/devices");
    return { success: true };
}

// ─── Device Folders ─────────────────────────────────────────────────────────
//
// All three helpers gate on `auth()` AND verify the target device belongs to
// the signed-in user. Without these checks any signed-in caller could:
//   - enumerate another tenant's folder list (cross-tenant disclosure),
//   - plant attacker-chosen scan paths on a victim's device row (the victim's
//     companion would walk them on next refresh — local-FS recon),
//   - delete folder rows by sequential id enumeration.
// Same trust-boundary pattern as batches 19 / 22.

async function userOwnsDevice(deviceId: string, userId: string): Promise<boolean> {
    const rows = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
        .limit(1);
    return rows.length > 0;
}

export async function getDeviceFolders(deviceId: string) {
    const session = await auth();
    if (!session?.user?.id) return [];
    if (!(await userOwnsDevice(deviceId, session.user.id))) return [];

    return db
        .select()
        .from(deviceFolders)
        .where(eq(deviceFolders.deviceId, deviceId));
}

export async function addDeviceFolder(deviceId: string, folderPath: string, label?: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not authenticated" };
    if (!(await userOwnsDevice(deviceId, session.user.id))) return { error: "Device not found" };

    await db.insert(deviceFolders).values({
        deviceId,
        path: folderPath,
        label: label || folderPath.split(/[/\\]/).pop() || folderPath,
    });

    revalidatePath("/devices");
    return { success: true };
}

export async function removeDeviceFolder(folderId: number) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not authenticated" };

    // Scope the DELETE through a join on devices.userId so the caller can
    // only remove folders that belong to one of their own devices. Use a
    // single statement (no read-then-write race) by filtering deviceId
    // against a sub-select of the user's device IDs.
    const ownedDeviceIds = db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.userId, session.user.id));

    await db.delete(deviceFolders).where(
        and(
            eq(deviceFolders.id, folderId),
            sql`${deviceFolders.deviceId} IN ${ownedDeviceIds}`,
        ),
    );
    revalidatePath("/devices");
    return { success: true };
}

// ─── Remote scan via companion ──────────────────────────────────────────────

export async function scanDeviceFolder(deviceId: string, folderPath: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not authenticated" };

    const deviceRows = await db
        .select()
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)))
        .limit(1);
    const device = deviceRows[0];

    if (!device) return { error: "Device not found" };

    const bearer = await materializeDeviceToken(device);
    if (!bearer) return { error: "Device token unavailable" };

    try {
        const resp = await fetch(`${device.apiUrl}/scan`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Device-Token": bearer,
            },
            body: JSON.stringify({ folder: folderPath }),
            signal: AbortSignal.timeout(120_000),
        });

        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: "Scan failed" }));
            return { error: err.error || "Scan failed" };
        }

        const data = await resp.json() as {
            tracks: Array<{
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
            }>;
            count: number;
        };

        // Ingest scanned tracks into the companion's library DB.
        // The companion ingest is idempotent on (user_id, filepath), so we
        // forward everything and let it dedupe.
        const link = await getCompanionLinkForDevice(deviceId);
        let inserted = 0;
        let skipped = 0;
        if (link) {
            try {
                const r = await companionLibrary.ingestTracks(link, data.tracks.map((t) => ({
                    filepath: t.filepath,
                    filename: t.filename,
                    artist: t.artist ?? null,
                    title: t.title ?? null,
                    album: t.album ?? null,
                    bpm: t.bpm ?? null,
                    keyCamelot: t.key ?? null,
                    duration: t.duration ?? null,
                    genre: t.genre ?? null,
                    format: t.format ?? null,
                    bitrate: t.bitrate ?? null,
                    sampleRate: t.sampleRate ?? null,
                    fileSize: t.fileSize,
                    year: t.year ?? null,
                    deviceId,
                })));
                inserted = r.inserted;
                skipped = r.skipped;
            } catch (e) {
                return { error: `Companion ingest failed: ${e instanceof Error ? e.message : String(e)}` };
            }
        } else {
            return { error: "Companion not connected — cannot persist scanned tracks." };
        }

        // Update folder stats
        await db
            .update(deviceFolders)
            .set({
                trackCount: data.count,
                lastScannedAt: new Date(),
            })
            .where(and(
                eq(deviceFolders.deviceId, deviceId),
                eq(deviceFolders.path, folderPath)
            ));

        revalidatePath("/devices");
        revalidatePath("/library");
        return { success: true, inserted, skipped, total: data.count };
    } catch (err) {
        return { error: `Connection failed: ${err instanceof Error ? err.message : "Unknown"}` };
    }
}

// ─── Check device online status ─────────────────────────────────────────────

export async function pingDevice(deviceId: string): Promise<{ online: boolean; info?: Record<string, unknown> }> {
    // Auth + ownership scope: this action issues a server-side fetch to the
    // device's `apiUrl`, which is user-controlled. Without a session check
    // any caller could trigger an SSRF against arbitrary URLs and read /health
    // responses from internal services; without an ownership check a signed-in
    // user could ping (and probe + reclassify) any other user's device row.
    const session = await auth();
    if (!session?.user?.id) return { online: false };

    const rows = await db
        .select()
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)))
        .limit(1);
    const device = rows[0];

    if (!device) return { online: false };

    try {
        const resp = await fetch(`${device.apiUrl}/health`, {
            signal: AbortSignal.timeout(5_000),
        });
        if (resp.ok) {
            const info = await resp.json();
            await updateDeviceStatusInternal(deviceId, {
                status: "online",
                hostname: info.hostname,
                os: info.platform,
                version: info.version,
            });
            return { online: true, info };
        }
    } catch {
        // offline
    }

    await updateDeviceStatusInternal(deviceId, { status: "offline" });
    return { online: false };
}

// ─── Get track count per device ─────────────────────────────────────────────

export async function getDeviceTrackCount(deviceId: string): Promise<number> {
    // Track counts now live on the companion. We approximate by paging
    // /library/tracks (companion has no per-device count endpoint yet).
    const link = await getCompanionLinkForDevice(deviceId);
    if (!link) return 0;
    try {
        // Use a small page just to read `total`, then JS-filter by deviceId
        // from a wider sample. Acceptable for the device list UI.
        const r = await companionLibrary.getTracks(link, { page: 1, pageSize: 500 });
        return r.tracks.filter((t) => t.deviceId === deviceId).length;
    } catch { return 0; }
}

// ─── Local companion (for native low-latency audio) ────────────────────────
//
// Returns credentials for a companion running on localhost. The web app uses
// these to drive the native audio engine (mic in -> DSP -> speakers out)
// directly through the companion's HTTP+WS API, bypassing Web Audio for
// the lowest possible round-trip latency.

export async function getLocalCompanion(): Promise<{ apiUrl: string; token: string; deviceId: string } | null> {
    const session = await auth();
    if (!session?.user?.id) return null;

    const localPrefixes = ["http://localhost:", "http://127.0.0.1:"];
    const all = await db
        .select()
        .from(devices)
        .where(eq(devices.userId, session.user.id));
    const local = all.find((d) => d.apiUrl && localPrefixes.some((p) => d.apiUrl!.startsWith(p)));
    if (!local || !local.apiUrl) return null;
    const bearer = await materializeDeviceToken(local);
    if (!bearer) return null;
    return { apiUrl: local.apiUrl, token: bearer, deviceId: local.id };
}

// ─── Companion-owned folders ───────────────────────────────────────────────
//
// Folders live ON the companion (truth = scanFolders in electron-store).
// The web app no longer mirrors them in its own DB — these actions are
// thin proxies. The legacy `deviceFolders` table is kept only for stale
// per-folder stats; new flows ignore it.

export async function getCompanionFolders(deviceId: string): Promise<CompanionFolder[]> {
    try { return await companionControl.listFolders(deviceId); }
    catch { return []; }
}

/** Triggers the companion's native OS folder picker. Returns the new
 *  full list (or `canceled: true`). The web action does NOT take a path
 *  argument — that's the whole point: no manual entry. */
export async function pickCompanionFolder(
    deviceId: string,
): Promise<
    | { canceled: true }
    | { canceled: false; picked: string; folders: CompanionFolder[] }
    | { error: string }
> {
    try {
        const r = await companionControl.pickFolder(deviceId);
        if (r.canceled) return { canceled: true };
        return { canceled: false, picked: r.picked!, folders: r.folders };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

export async function removeCompanionFolder(
    deviceId: string,
    folderPath: string,
): Promise<CompanionFolder[]> {
    try { return await companionControl.removeFolder(deviceId, folderPath); }
    catch { return []; }
}

/**
 * Toggle the chokidar-backed watcher on a folder. When enabled the
 * companion streams new-file events that the web app picks up via
 * `pollCompanionWatchEvents` and ingests through `companionLibrary`.
 */
export async function setCompanionFolderWatch(
    deviceId: string,
    folderPath: string,
    watch: boolean,
): Promise<{ success: true; folders: CompanionFolder[] } | { error: string }> {
    try {
        const folders = await companionControl.setFolderWatch(deviceId, folderPath, watch);
        return { success: true, folders };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

// ─── Async scan jobs (refresh-resilient progress) ──────────────────────────

/** Kick off a scan. Returns the freshly-created job (status:"pending"). */
export async function startCompanionScan(
    deviceId: string,
    folderPath: string,
): Promise<{ success: true; job: CompanionScanJob } | { error: string }> {
    try {
        const job = await companionControl.startScan(deviceId, folderPath);
        return { success: true, job };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

/** Poll a job for progress / completion. */
export async function getCompanionScanJob(
    deviceId: string,
    jobId: string,
): Promise<{ success: true; job: CompanionScanJob } | { error: string }> {
    try {
        const job = await companionControl.getScanJob(deviceId, jobId);
        return { success: true, job };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

/** List all scan jobs known to this companion. Used on devices-page mount
 *  to recover in-flight scans after a tab refresh. */
export async function listCompanionScanJobs(
    deviceId: string,
): Promise<CompanionScanJob[]> {
    try { return await companionControl.listScanJobs(deviceId); }
    catch { return []; }
}

/**
 * Drain a completed scan job: pulls its tracks payload + ingests into the
 * companion library DB through the normal /library/tracks/ingest path,
 * then ACKs the job so the companion can free memory.
 *
 * Returns ingest stats. Idempotent on (user_id, filepath) — re-calling
 * for the same job is safe (companion just returns 404 after the ack).
 */
export async function ingestCompanionScanJob(
    deviceId: string,
    jobId: string,
): Promise<
    | { success: true; inserted: number; skipped: number; total: number }
    | { error: string }
> {
    try {
        const job = await companionControl.getScanJob(deviceId, jobId);
        if (job.status !== "complete" || !job.tracks) return { error: "Job not complete" };
        // Per-device lookup (not getCompanionLink) so this works for
        // LAN/Tailscale companions whose api_url isn't on localhost.
        const link = await getCompanionLinkForDevice(deviceId);
        if (!link) return { error: "Companion not connected — cannot persist scanned tracks." };
        const r = await companionLibrary.ingestTracks(link, job.tracks.map((t) => ({
            filepath: t.filepath,
            filename: t.filename,
            artist: t.artist ?? null,
            title: t.title ?? null,
            album: t.album ?? null,
            bpm: t.bpm ?? null,
            keyCamelot: t.key ?? null,
            duration: t.duration ?? null,
            genre: t.genre ?? null,
            format: t.format ?? null,
            bitrate: t.bitrate ?? null,
            sampleRate: t.sampleRate ?? null,
            fileSize: t.fileSize,
            year: t.year ?? null,
            deviceId,
        })));
        // Best-effort ack — failure here is harmless (the GC will clean up).
        try { await companionControl.ackScanJob(deviceId, jobId); } catch { /* ignore */ }
        // Update folder stats so the existing UI/legacy table stays warm.
        await db
            .update(deviceFolders)
            .set({
                trackCount: job.tracks.length,
                lastScannedAt: new Date(),
            })
            .where(and(
                eq(deviceFolders.deviceId, deviceId),
                eq(deviceFolders.path, job.folder),
            ));
        revalidatePath("/devices");
        revalidatePath("/library");
        return { success: true, inserted: r.inserted, skipped: r.skipped, total: job.tracks.length };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Drain queued watcher events from the companion and ingest each as a
 * single-track add. Returns the new highWatermark so the caller can
 * paginate forward without re-ingesting events it has already seen.
 *
 * For `unlink` events we currently no-op (track stays in library, just
 * marked as offline by the existing /check-files reconciliation flow).
 */
export async function pollCompanionWatchEvents(
    deviceId: string,
    since: number,
): Promise<
    | { success: true; processed: number; highWatermark: number }
    | { error: string }
> {
    try {
        const { events, highWatermark } = await companionControl.pollWatchEvents(deviceId, since);
        const adds = events.filter((e) => (e.kind === "add" || e.kind === "change") && e.payload);
        if (adds.length === 0) return { success: true, processed: 0, highWatermark };
        const link = await getCompanionLinkForDevice(deviceId);
        if (!link) return { error: "Companion not connected" };
        await companionLibrary.ingestTracks(link, adds.map((e) => {
            const t = e.payload!;
            return {
                filepath: t.filepath,
                filename: t.filename,
                artist: t.artist ?? null,
                title: t.title ?? null,
                album: t.album ?? null,
                bpm: t.bpm ?? null,
                keyCamelot: t.key ?? null,
                duration: t.duration ?? null,
                genre: t.genre ?? null,
                format: t.format ?? null,
                bitrate: t.bitrate ?? null,
                sampleRate: t.sampleRate ?? null,
                fileSize: t.fileSize,
                year: t.year ?? null,
                deviceId,
            };
        }));
        revalidatePath("/library");
        return { success: true, processed: adds.length, highWatermark };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

// ─── Companion audio device authorization ──────────────────────────────────

export async function getCompanionAudioInventory(
    deviceId: string,
): Promise<CompanionAudioInventory | { error: string }> {
    try { return await companionControl.getAudioInventory(deviceId); }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

export async function setCompanionAuthorizedAudioDevices(
    deviceId: string,
    list: AuthorizedAudioDevice[],
): Promise<{ success: true; authorized: AuthorizedAudioDevice[] } | { error: string }> {
    try {
        const authorized = await companionControl.setAuthorizedAudioDevices(deviceId, list);
        return { success: true, authorized };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}
