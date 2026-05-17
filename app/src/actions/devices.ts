"use server";

import { db } from "@/db";
import {
    devices,
    deviceFolders,
    companionDevices,
    movies,
    tvShows,
    tvSeasons,
    tvEpisodes,
    videoFiles,
} from "@/db/schema";
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
    try {
        const [row] = await db
            .select({ tunnelId: devices.tunnelId })
            .from(devices)
            .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)))
            .limit(1);
        const cfg = getCloudflareConfig();
        if (cfg && row?.tunnelId) await deleteDeviceTunnel(cfg, { tunnelId: row.tunnelId });
    } catch { /* ignore */ }

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

/** Write-through: replace the cached folder set for a device. Best-effort. */
async function mirrorCompanionFolders(deviceId: string, list: CompanionFolder[]): Promise<void> {
    try {
        await db.transaction(async (tx) => {
            await tx.delete(deviceFolders).where(eq(deviceFolders.deviceId, deviceId));
            if (list.length === 0) return;
            await tx.insert(deviceFolders).values(list.map((f) => ({
                deviceId,
                path: f.path,
                label: f.label ?? null,
                kind: f.kind ?? null,
                watch: f.watch ?? false,
            })));
        });
    } catch (e) {
        console.warn("[folders] mirror failed", e);
    }
}

/** Read the cached folder set without touching the companion. */
export async function getCachedCompanionFolders(deviceId: string): Promise<CompanionFolder[]> {
    if (await assertDeviceOwnership(deviceId)) return [];
    const rows = await db
        .select({
            path: deviceFolders.path,
            label: deviceFolders.label,
            kind: deviceFolders.kind,
            watch: deviceFolders.watch,
        })
        .from(deviceFolders)
        .where(eq(deviceFolders.deviceId, deviceId));
    return rows.map((r) => ({
        path: r.path,
        exists: true,
        label: r.label ?? (r.path.split(/[/\\]/).pop() || r.path),
        kind: (r.kind ?? undefined) as FolderKind | undefined,
        watch: r.watch ?? false,
    }));
}

export async function getCompanionFolders(deviceId: string): Promise<CompanionFolder[]> {
    if (await assertDeviceOwnership(deviceId)) return [];
    const r = await enqueueDeviceCommand<{ folders: CompanionFolder[] }>(
        deviceId, "list_folders", null, { timeoutMs: 8_000 },
    );
    if (r.ok) {
        const list = r.result?.folders ?? [];
        void mirrorCompanionFolders(deviceId, list);
        return list;
    }
    return getCachedCompanionFolders(deviceId);
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
    void mirrorCompanionFolders(deviceId, r.result!.folders);
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
    if (!r.ok) return getCachedCompanionFolders(deviceId);
    const list = r.result?.folders ?? [];
    void mirrorCompanionFolders(deviceId, list);
    return list;
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
    const folders = r.result?.folders ?? [];
    void mirrorCompanionFolders(deviceId, folders);
    return { success: true, folders };
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
    const folders = r.result?.folders ?? [];
    void mirrorCompanionFolders(deviceId, folders);
    return { success: true, folders };
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


// ─── Cloudflare tunnel helpers ──────────────────────────────────────────────

/**
 * Idempotently provision the per-device Cloudflare Tunnel + DNS record.
 * Returns the bootstrap (`tunnelHostname` + `tunnelToken`) the companion
 * needs to start `cloudflared`, or null when CF is not configured or
 * the API call fails. Safe to call on every heartbeat.
 */
export async function ensureDeviceTunnel(
    deviceId: string,
    opts: { port?: number } = {},
): Promise<{ tunnelHostname: string; tunnelToken: string } | null> {
    const cfg = getCloudflareConfig();
    if (!cfg) return null;
    const [row] = await db
        .select({
            id: devices.id,
            tunnelId: devices.tunnelId,
            tunnelHostname: devices.tunnelHostname,
            tunnelTokenEncrypted: devices.tunnelTokenEncrypted,
        })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
    if (!row) return null;
    if (row.tunnelId && row.tunnelHostname && row.tunnelTokenEncrypted) {
        try {
            return {
                tunnelHostname: row.tunnelHostname,
                tunnelToken: decryptDeviceToken(row.tunnelTokenEncrypted),
            };
        } catch { /* fall through and re-provision */ }
    }
    try {
        const t = await createDeviceTunnel(cfg, deviceId, opts);
        await db
            .update(devices)
            .set({
                tunnelId: t.tunnelId,
                tunnelHostname: t.hostname,
                tunnelTokenEncrypted: encryptDeviceToken(t.tunnelToken),
            })
            .where(eq(devices.id, deviceId));
        return { tunnelHostname: t.hostname, tunnelToken: t.tunnelToken };
    } catch (err) {
        console.warn("[devices] ensureDeviceTunnel failed:", err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * Browser-side fast path: return the public tunnel hostname + the
 * device bearer the browser should send as `X-Device-Token`. Returns
 * null when the tunnel isn't provisioned yet — caller falls back to the
 * cloud command queue.
 */
export async function getDeviceDirectAccess(
    deviceId: string,
): Promise<{ tunnelHostname: string; bearer: string } | null> {
    const session = await auth();
    if (!session?.user?.id) return null;
    const [row] = await db
        .select({
            id: devices.id,
            tunnelHostname: devices.tunnelHostname,
            tokenEncrypted: devices.tokenEncrypted,
        })
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)))
        .limit(1);
    if (!row?.tunnelHostname) return null;
    const bearer = await materializeDeviceToken({ id: row.id, tokenEncrypted: row.tokenEncrypted });
    if (!bearer) return null;
    return { tunnelHostname: row.tunnelHostname, bearer };
}


// ─── Companion video scan ingest ────────────────────────────────────────────

/**
 * Pull a completed video-kind scan job from the companion and persist
 * its results into the cloud schema (movies / tvShows / tvSeasons /
 * tvEpisodes / videoFiles).
 *
 * Behaviour:
 *  - Movies folder → group by (lowercased title, year), upsert a single
 *    `movies` row per group. Each scanned file becomes a `videoFiles`
 *    row keyed by `(deviceId, path)`; multiple files for the same movie
 *    (e.g. different resolutions) are preserved naturally because their
 *    paths differ.
 *  - TV shows folder → group by `showHint || parsedTitle`, then season,
 *    then episode. Files missing season/episode metadata count as
 *    `skipped` rather than being silently dropped.
 *
 * No TMDB enrichment in this slice — titles come from the filename
 * parser, `tmdbId` stays null.
 */
export async function ingestCompanionVideoScanJob(
    deviceId: string,
    jobId: string,
): Promise<{
    success: true;
    movies: number;
    shows: number;
    seasons: number;
    episodes: number;
    files: number;
    skipped: number;
} | { error: string }> {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not authenticated" };
    const ownership = await assertDeviceOwnership(deviceId);
    if (ownership) return { error: ownership };

    const [device] = await db
        .select({ id: devices.id, hostname: devices.hostname, os: devices.os })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
    if (!device) return { error: "Device not found" };

    const job = await companionControl.getScanJob(deviceId, jobId).catch(() => null);
    if (!job) return { error: "Scan job not found on companion" };
    if (job.status !== "complete") return { error: `Scan job is ${job.status}` };
    if (job.kind !== "video" || !job.videos) return { error: "Not a video scan job" };

    const folders = await companionControl.listFolders(deviceId).catch(() => [] as CompanionFolder[]);
    const folderCfg = folders.find((f) => f.path === job.folder);
    const folderKind: FolderKind | undefined = folderCfg?.kind;
    if (folderKind !== "movies" && folderKind !== "tv-shows") {
        return { error: `Folder kind ${folderKind ?? "unknown"} is not a video kind` };
    }

    // Reconcile the `companionDevices` row (bigint id) the video schema's
    // FKs point at. Two device tables exist for historical reasons — we
    // key the bigint table by `machineId = devices.id` for a stable 1:1
    // mapping.
    const userId = session.user.id;
    let [cdRow] = await db
        .select({ id: companionDevices.id })
        .from(companionDevices)
        .where(and(eq(companionDevices.userId, userId), eq(companionDevices.machineId, device.id)))
        .limit(1);
    if (!cdRow) {
        const inserted = await db
            .insert(companionDevices)
            .values({
                userId,
                machineId: device.id,
                hostname: device.hostname ?? device.id,
                platform: device.os ?? "unknown",
            })
            .returning({ id: companionDevices.id });
        cdRow = inserted[0];
    }
    const companionDeviceId = cdRow.id;

    const now = new Date();
    let movieCount = 0;
    let showCount = 0;
    let seasonCount = 0;
    let episodeCount = 0;
    let fileCount = 0;
    let skipped = 0;

    if (folderKind === "movies") {
        const groups = new Map<string, { title: string; year: number | null; files: typeof job.videos }>();
        for (const v of job.videos) {
            const title = (v.parsedTitle || v.filename).trim();
            const key = `${title.toLowerCase()}::${v.parsedYear ?? ""}`;
            const existing = groups.get(key);
            if (existing) existing.files.push(v);
            else groups.set(key, { title, year: v.parsedYear, files: [v] });
        }

        for (const g of groups.values()) {
            // No TMDB id → can't use the (userId, tmdbId) unique index.
            // Look up by (userId, title, year) and insert if absent.
            const [existing] = await db
                .select({ id: movies.id })
                .from(movies)
                .where(and(
                    eq(movies.userId, userId),
                    eq(movies.title, g.title),
                    g.year != null ? eq(movies.year, g.year) : sql`${movies.year} is null`,
                ))
                .limit(1);
            let movieId: number;
            if (existing) {
                movieId = existing.id;
            } else {
                const [created] = await db
                    .insert(movies)
                    .values({ userId, title: g.title, year: g.year ?? null })
                    .returning({ id: movies.id });
                movieId = created.id;
                movieCount++;
            }

            for (const v of g.files) {
                const fileValues = {
                    userId,
                    deviceId: companionDeviceId,
                    path: v.filepath,
                    kind: "movie" as const,
                    movieId,
                    episodeId: null,
                    sizeBytes: v.fileSize,
                    durationSec: v.durationSec ?? null,
                    container: v.container ?? null,
                    videoCodec: v.videoCodec ?? null,
                    audioCodec: v.audioCodec ?? null,
                    width: v.width ?? null,
                    height: v.height ?? null,
                    bitrateKbps: v.bitrateKbps ?? null,
                    hdr: v.hdr ?? null,
                    audioTracks: v.audioTracks,
                    subtitleTracks: v.subtitleTracks,
                    mtime: new Date(v.mtime),
                    scannedAt: now,
                };
                await db
                    .insert(videoFiles)
                    .values(fileValues)
                    .onConflictDoUpdate({
                        target: [videoFiles.deviceId, videoFiles.path],
                        set: fileValues,
                    });
                fileCount++;
            }
        }
    } else {
        const showGroups = new Map<string, typeof job.videos>();
        for (const v of job.videos) {
            if (v.parsedSeason == null || v.parsedEpisode == null) { skipped++; continue; }
            const showName = (v.showHint || v.parsedTitle || v.filename).trim();
            const key = showName.toLowerCase();
            const arr = showGroups.get(key);
            if (arr) arr.push(v);
            else showGroups.set(key, [v]);
        }

        for (const files of showGroups.values()) {
            const showName = (files[0].showHint || files[0].parsedTitle || files[0].filename).trim();
            const [existingShow] = await db
                .select({ id: tvShows.id })
                .from(tvShows)
                .where(and(eq(tvShows.userId, userId), eq(tvShows.title, showName)))
                .limit(1);
            let showId: number;
            if (existingShow) {
                showId = existingShow.id;
            } else {
                const [created] = await db
                    .insert(tvShows)
                    .values({ userId, title: showName })
                    .returning({ id: tvShows.id });
                showId = created.id;
                showCount++;
            }

            const bySeason = new Map<number, typeof job.videos>();
            for (const v of files) {
                const s = v.parsedSeason as number;
                const arr = bySeason.get(s);
                if (arr) arr.push(v);
                else bySeason.set(s, [v]);
            }

            for (const [seasonNum, sFiles] of bySeason) {
                // Upsert season; onConflictDoNothing keeps the original
                // row when one already exists for this (show, season).
                await db
                    .insert(tvSeasons)
                    .values({ showId, seasonNumber: seasonNum })
                    .onConflictDoNothing({ target: [tvSeasons.showId, tvSeasons.seasonNumber] });
                seasonCount++;

                const byEpisode = new Map<number, typeof job.videos>();
                for (const v of sFiles) {
                    const e = v.parsedEpisode as number;
                    const arr = byEpisode.get(e);
                    if (arr) arr.push(v);
                    else byEpisode.set(e, [v]);
                }

                for (const [episodeNum, eFiles] of byEpisode) {
                    const [insertedEp] = await db
                        .insert(tvEpisodes)
                        .values({
                            showId,
                            seasonNumber: seasonNum,
                            episodeNumber: episodeNum,
                            title: eFiles[0].parsedTitle || null,
                        })
                        .onConflictDoUpdate({
                            target: [tvEpisodes.showId, tvEpisodes.seasonNumber, tvEpisodes.episodeNumber],
                            // Touch a no-op field so returning() always fires.
                            set: { seasonNumber: seasonNum },
                        })
                        .returning({ id: tvEpisodes.id });
                    const episodeId = insertedEp.id;
                    episodeCount++;

                    for (const v of eFiles) {
                        const fileValues = {
                            userId,
                            deviceId: companionDeviceId,
                            path: v.filepath,
                            kind: "episode" as const,
                            movieId: null,
                            episodeId,
                            sizeBytes: v.fileSize,
                            durationSec: v.durationSec ?? null,
                            container: v.container ?? null,
                            videoCodec: v.videoCodec ?? null,
                            audioCodec: v.audioCodec ?? null,
                            width: v.width ?? null,
                            height: v.height ?? null,
                            bitrateKbps: v.bitrateKbps ?? null,
                            hdr: v.hdr ?? null,
                            audioTracks: v.audioTracks,
                            subtitleTracks: v.subtitleTracks,
                            mtime: new Date(v.mtime),
                            scannedAt: now,
                        };
                        await db
                            .insert(videoFiles)
                            .values(fileValues)
                            .onConflictDoUpdate({
                                target: [videoFiles.deviceId, videoFiles.path],
                                set: fileValues,
                            });
                        fileCount++;
                    }
                }
            }
        }
    }

    await companionControl.ackScanJob(deviceId, jobId).catch(() => null);
    revalidatePath("/devices");
    revalidatePath("/watch");

    return {
        success: true,
        movies: movieCount,
        shows: showCount,
        seasons: seasonCount,
        episodes: episodeCount,
        files: fileCount,
        skipped,
    };
}

