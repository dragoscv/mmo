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
    type FolderKind,
} from "@/lib/companion-control";
import { issueDeviceToken, materializeDeviceToken, encryptDeviceToken, decryptDeviceToken } from "@/lib/device-token";
import { enqueueDeviceCommand } from "@/lib/device-commands";
import { createDeviceTunnel, deleteDeviceTunnel, getCloudflareConfig, updateDeviceTunnelIngress } from "@/lib/cloudflare";

/** Confirm the caller owns this device. Used by every command-queue
 *  action below so a signed-in user can't enqueue work for someone
 *  else's device. */
async function assertDeviceOwnership(deviceId: string): Promise<string | null> {
    const session = await auth();
    if (!session?.user?.id) return "Not authenticated";
    const rows = await db.select({ id: devices.id }).from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)))
        .limit(1);
    return rows[0] ? null : "Device not found";
}

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

    // Best-effort CF teardown BEFORE the row goes away — we need the
    // tunnelId. Failure here leaves an orphan tunnel on the CF account
    // but never blocks the user-visible removal.
    try { await destroyDeviceTunnel(deviceId); } catch { /* ignore */ }

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
    // Auth + ownership scope: pingDevice runs server-side from Vercel,
    // which cannot reach the user's LAN. We rely on the push-based
    // heartbeat written by POST /api/devices/announce (the companion
    // calls it every 30 s). Online = heartbeat within the last 90 s.
    const session = await auth();
    if (!session?.user?.id) return { online: false };

    const rows = await db
        .select()
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)))
        .limit(1);
    const device = rows[0];
    if (!device) return { online: false };

    const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
    const fresh = Date.now() - lastSeen < 90_000;
    return {
        online: fresh,
        info: {
            hostname: device.hostname,
            platform: device.os,
            version: device.version,
            lastSeenAt: device.lastSeenAt,
        },
    };
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
    if (await assertDeviceOwnership(deviceId)) return [];
    const r = await enqueueDeviceCommand<{ folders: CompanionFolder[] }>(
        deviceId, "list_folders", null, { timeoutMs: 8_000 },
    );
    return r.ok ? (r.result?.folders ?? []) : [];
}

/** Legacy: triggers the companion's native OS folder picker. Kept for
 *  backwards compat but the UI now uses the in-web browser (listCompanionDrives
 *  / listCompanionDirectory / addCompanionFolder) so the user never has to
 *  switch focus to the companion app. */
export async function pickCompanionFolder(
    deviceId: string,
    kind: FolderKind = "music",
): Promise<
    | { canceled: true }
    | { canceled: false; picked: string; folders: CompanionFolder[] }
    | { error: string }
> {
    const err = await assertDeviceOwnership(deviceId);
    if (err) return { error: err };
    const r = await enqueueDeviceCommand<
        { canceled: true } | { canceled: false; picked: string; folders: CompanionFolder[] }
    >(deviceId, "pick_folder", { kind }, { timeoutMs: 120_000 });
    if (!r.ok) return { error: r.error ?? "Pick folder failed" };
    return r.result!;
}

// ─── In-web filesystem browser ────────────────────────────────────────────
// Three small server actions back the modal's folder tree: list mounted
// drives once, list a directory on each navigation step, finalise with
// add. All routed through the command queue so they work over the same
// NAT-traversing announce loop as everything else.

export async function listCompanionDrives(deviceId: string): Promise<
    | { drives: import("@/lib/companion-types").CompanionDrive[] }
    | { error: string }
> {
    const err = await assertDeviceOwnership(deviceId);
    if (err) return { error: err };
    const r = await enqueueDeviceCommand<{ drives: import("@/lib/companion-types").CompanionDrive[] }>(
        deviceId, "list_drives", null, { timeoutMs: 15_000 },
    );
    if (!r.ok) return { error: r.error ?? "Failed to list drives" };
    return { drives: r.result?.drives ?? [] };
}

export async function listCompanionDirectory(
    deviceId: string,
    folderPath: string,
): Promise<
    | import("@/lib/companion-types").CompanionDirectoryListing
    | { error: string }
> {
    const err = await assertDeviceOwnership(deviceId);
    if (err) return { error: err };
    const r = await enqueueDeviceCommand<import("@/lib/companion-types").CompanionDirectoryListing>(
        deviceId, "list_directory", { path: folderPath }, { timeoutMs: 20_000 },
    );
    if (!r.ok) return { error: r.error ?? "Failed to list directory" };
    return r.result!;
}

export async function addCompanionFolder(
    deviceId: string,
    folderPath: string,
    kind: FolderKind,
): Promise<
    | { added: boolean; picked: string; folders: CompanionFolder[] }
    | { error: string }
> {
    const err = await assertDeviceOwnership(deviceId);
    if (err) return { error: err };
    const r = await enqueueDeviceCommand<{ added: boolean; picked: string; folders: CompanionFolder[] }>(
        deviceId, "add_folder", { path: folderPath, kind }, { timeoutMs: 15_000 },
    );
    if (!r.ok) return { error: r.error ?? "Failed to add folder" };
    return r.result!;
}

export async function removeCompanionFolder(
    deviceId: string,
    folderPath: string,
): Promise<CompanionFolder[]> {
    if (await assertDeviceOwnership(deviceId)) return [];
    const r = await enqueueDeviceCommand<{ folders: CompanionFolder[] }>(
        deviceId, "remove_folder", { path: folderPath }, { timeoutMs: 8_000 },
    );
    return r.ok ? (r.result?.folders ?? []) : [];
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
    const err = await assertDeviceOwnership(deviceId);
    if (err) return { error: err };
    const r = await enqueueDeviceCommand<{ folders: CompanionFolder[] }>(
        deviceId, "set_folder_watch", { path: folderPath, watch }, { timeoutMs: 8_000 },
    );
    if (!r.ok) return { error: r.error ?? "Failed to toggle watcher" };
    return { success: true, folders: r.result?.folders ?? [] };
}

/** Update the purpose label of a folder (music / movies / tv-shows / ...). */
export async function setCompanionFolderKind(
    deviceId: string,
    folderPath: string,
    kind: FolderKind,
): Promise<{ success: true; folders: CompanionFolder[] } | { error: string }> {
    const err = await assertDeviceOwnership(deviceId);
    if (err) return { error: err };
    const r = await enqueueDeviceCommand<{ folders: CompanionFolder[] }>(
        deviceId, "set_folder_kind", { path: folderPath, kind }, { timeoutMs: 8_000 },
    );
    if (!r.ok) return { error: r.error ?? "Failed to update folder kind" };
    return { success: true, folders: r.result?.folders ?? [] };
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
    const err = await assertDeviceOwnership(deviceId);
    if (err) return { error: err };
    const r = await enqueueDeviceCommand<CompanionAudioInventory>(
        deviceId, "list_audio_devices", null, { timeoutMs: 15_000 },
    );
    if (!r.ok) return { error: r.error ?? "Audio enumeration failed" };
    return r.result!;
}

export async function setCompanionAuthorizedAudioDevices(
    deviceId: string,
    list: AuthorizedAudioDevice[],
): Promise<{ success: true; authorized: AuthorizedAudioDevice[] } | { error: string }> {
    const err = await assertDeviceOwnership(deviceId);
    if (err) return { error: err };
    const r = await enqueueDeviceCommand<{ authorized: AuthorizedAudioDevice[] }>(
        deviceId, "set_authorized_audio_devices", { devices: list }, { timeoutMs: 8_000 },
    );
    if (!r.ok) return { error: r.error ?? "Failed to authorize audio devices" };
    return { success: true, authorized: r.result?.authorized ?? [] };
}


// ─── Cloudflare Tunnel (per-device fast path) ─────────────────────────────
//
// Each device gets its own named tunnel + DNS record so the browser can
// fetch the companion's HTTP API at https://device-xxx.<base> — bypassing
// the 1.5-6s announce-queue round-trip for hot operations (folder
// browsing, drive listing). The functions below are imported by the
// announce route (auto-provision on first heartbeat) and the devices
// client (fetch bearer + tunnel hostname for direct fetches).

/**
 * Provision a Cloudflare Tunnel for the given device. Idempotent:
 * returns the existing tunnel info if one is already attached. Safe to
 * call from the announce route on first heartbeat. Returns null when
 * Cloudflare env vars are not configured (graceful fallback to queue
 * transport — existing pairings stay functional with zero CF setup).
 *
 * When opts.port is provided, the existing tunnel's ingress config
 * is updated to point at that port (deduped per-process so the 3s
 * announce loop doesn't burn CF API quota).
 */
export async function ensureDeviceTunnel(
    deviceId: string,
    opts: { port?: number } = {},
): Promise<
    { tunnelHostname: string; tunnelToken: string } | null
> {
    const cfg = getCloudflareConfig();
    if (!cfg) return null;

    const row = (await db.select({
        id: devices.id,
        tunnelId: devices.tunnelId,
        tunnelHostname: devices.tunnelHostname,
        tunnelTokenEncrypted: devices.tunnelTokenEncrypted,
    }).from(devices).where(eq(devices.id, deviceId)).limit(1))[0];
    if (!row) return null;

    if (row.tunnelId && row.tunnelHostname && row.tunnelTokenEncrypted) {
        try {
            const decoded = {
                tunnelHostname: row.tunnelHostname,
                tunnelToken: decryptDeviceToken(row.tunnelTokenEncrypted),
            };
            if (opts.port && shouldUpdateIngress(deviceId, opts.port)) {
                try {
                    await updateDeviceTunnelIngress(cfg, {
                        tunnelId: row.tunnelId,
                        hostname: row.tunnelHostname,
                        port: opts.port,
                    });
                    rememberIngressPort(deviceId, opts.port);
                    console.log("[devices] tunnel ingress updated device=" + deviceId + " port=" + opts.port);
                } catch (err) {
                    console.warn("[devices] tunnel ingress update failed:", err instanceof Error ? err.message : err);
                }
            }
            return decoded;
        } catch {
            // Corrupt envelope — fall through and re-provision.
        }
    }

    try {
        const t = await createDeviceTunnel(cfg, deviceId, opts.port ? { port: opts.port } : {});
        await db.update(devices).set({
            tunnelId: t.tunnelId,
            tunnelHostname: t.hostname,
            tunnelTokenEncrypted: encryptDeviceToken(t.tunnelToken),
        }).where(eq(devices.id, deviceId));
        if (opts.port) rememberIngressPort(deviceId, opts.port);
        console.log("[devices] tunnel provisioned device=" + deviceId + " host=" + t.hostname + " port=" + (opts.port ?? 17899));
        return { tunnelHostname: t.hostname, tunnelToken: t.tunnelToken };
    } catch (err) {
        console.warn("[devices] tunnel provision failed:", err instanceof Error ? err.message : err);
        return null;
    }
}

// Per-process memo of the last ingress port written per device, so the
// announce-route hot path doesn't fire a CF API call on every 3s tick.
const ingressPortByDevice = new Map<string, number>();
function shouldUpdateIngress(deviceId: string, port: number): boolean {
    return ingressPortByDevice.get(deviceId) !== port;
}
function rememberIngressPort(deviceId: string, port: number): void {
    ingressPortByDevice.set(deviceId, port);
}

/**
 * Returns the data the browser needs to call the companion directly
 * over the tunnel: { hostname, bearer }. Auth-gated to the device's
 * owner. Same trust boundary as the queue-based actions.
 */
export async function getDeviceDirectAccess(deviceId: string): Promise<
    { tunnelHostname: string; bearer: string } | null
> {
    const err = await assertDeviceOwnership(deviceId);
    if (err) {
        console.log("[devices] getDeviceDirectAccess: ownership denied device=" + deviceId);
        return null;
    }
    const row = (await db.select({
        tokenEncrypted: devices.tokenEncrypted,
        tunnelHostname: devices.tunnelHostname,
    }).from(devices).where(eq(devices.id, deviceId)).limit(1))[0];
    if (!row) {
        console.log("[devices] getDeviceDirectAccess: device row missing device=" + deviceId);
        return null;
    }
    if (!row.tunnelHostname) {
        console.log("[devices] getDeviceDirectAccess: no tunnelHostname (not provisioned) device=" + deviceId + " cfConfigured=" + (getCloudflareConfig() !== null));
        return null;
    }
    if (!row.tokenEncrypted) {
        console.log("[devices] getDeviceDirectAccess: no bearer token device=" + deviceId);
        return null;
    }
    try {
        return { tunnelHostname: row.tunnelHostname, bearer: decryptDeviceToken(row.tokenEncrypted) };
    } catch (e) {
        console.warn("[devices] getDeviceDirectAccess: bearer decrypt failed device=" + deviceId, e instanceof Error ? e.message : e);
        return null;
    }
}

/**
 * Drop the CF tunnel + DNS record when a device is unpaired. Best
 * effort — failures here leave orphan tunnels on the CF account but
 * don't break the user-visible removal flow.
 */
export async function destroyDeviceTunnel(deviceId: string): Promise<void> {
    const cfg = getCloudflareConfig();
    if (!cfg) return;
    const row = (await db.select({ tunnelId: devices.tunnelId }).from(devices)
        .where(eq(devices.id, deviceId)).limit(1))[0];
    if (!row?.tunnelId) return;
    await deleteDeviceTunnel(cfg, { tunnelId: row.tunnelId });
}