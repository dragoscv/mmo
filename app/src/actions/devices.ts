"use server";

import { db } from "@/db";
import { devices, deviceFolders, tracks } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";

// ─── Get all devices for current user ───────────────────────────────────────

export async function getDevices() {
    const session = await auth();
    if (!session?.user?.id) return [];

    return db
        .select()
        .from(devices)
        .where(eq(devices.userId, session.user.id))
        .all();
}

// ─── Get device by ID ───────────────────────────────────────────────────────

export async function getDevice(deviceId: string) {
    const session = await auth();
    if (!session?.user?.id) return null;

    return db
        .select()
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)))
        .get() || null;
}

// ─── Register a new device ──────────────────────────────────────────────────

export async function registerDevice(data: {
    name: string;
    apiUrl: string;
}): Promise<{ deviceId: string; token: string } | { error: string }> {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not authenticated" };

    const token = crypto.randomUUID() + "-" + crypto.randomUUID();
    const deviceId = crypto.randomUUID();

    await db.insert(devices).values({
        id: deviceId,
        userId: session.user.id,
        name: data.name,
        apiUrl: data.apiUrl,
        token,
        status: "offline",
    });

    revalidatePath("/devices");
    return { deviceId, token };
}

// ─── Update device info (called by companion heartbeat) ─────────────────────

export async function updateDeviceStatus(
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
            lastSeenAt: new Date().toISOString(),
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

export async function getDeviceFolders(deviceId: string) {
    return db
        .select()
        .from(deviceFolders)
        .where(eq(deviceFolders.deviceId, deviceId))
        .all();
}

export async function addDeviceFolder(deviceId: string, folderPath: string, label?: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not authenticated" };

    await db.insert(deviceFolders).values({
        deviceId,
        path: folderPath,
        label: label || folderPath.split(/[/\\]/).pop() || folderPath,
    });

    revalidatePath("/devices");
    return { success: true };
}

export async function removeDeviceFolder(folderId: number) {
    await db.delete(deviceFolders).where(eq(deviceFolders.id, folderId));
    revalidatePath("/devices");
    return { success: true };
}

// ─── Remote scan via companion ──────────────────────────────────────────────

export async function scanDeviceFolder(deviceId: string, folderPath: string) {
    const session = await auth();
    if (!session?.user?.id) return { error: "Not authenticated" };

    const device = await db
        .select()
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, session.user.id)))
        .get();

    if (!device) return { error: "Device not found" };

    try {
        const resp = await fetch(`${device.apiUrl}/scan`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Device-Token": device.token,
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

        // Insert scanned tracks into DB
        let inserted = 0;
        let skipped = 0;

        for (const t of data.tracks) {
            const existing = db
                .select({ id: tracks.id })
                .from(tracks)
                .where(eq(tracks.filepath, t.filepath))
                .get();

            if (existing) {
                skipped++;
                continue;
            }

            await db.insert(tracks).values({
                filepath: t.filepath,
                filename: t.filename,
                artist: t.artist,
                title: t.title,
                album: t.album,
                bpm: t.bpm,
                keyCamelot: t.key,
                duration: t.duration,
                genre: t.genre,
                format: t.format,
                bitrate: t.bitrate,
                sampleRate: t.sampleRate,
                fileSize: t.fileSize,
                year: t.year,
                deviceId: deviceId,
            });
            inserted++;
        }

        // Update folder stats
        await db
            .update(deviceFolders)
            .set({
                trackCount: data.count,
                lastScannedAt: new Date().toISOString(),
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
    const device = await db
        .select()
        .from(devices)
        .where(eq(devices.id, deviceId))
        .get();

    if (!device) return { online: false };

    try {
        const resp = await fetch(`${device.apiUrl}/health`, {
            signal: AbortSignal.timeout(5_000),
        });
        if (resp.ok) {
            const info = await resp.json();
            await updateDeviceStatus(deviceId, {
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

    await updateDeviceStatus(deviceId, { status: "offline" });
    return { online: false };
}

// ─── Get track count per device ─────────────────────────────────────────────

export async function getDeviceTrackCount(deviceId: string): Promise<number> {
    const result = db
        .select({ count: sql<number>`count(*)` })
        .from(tracks)
        .where(eq(tracks.deviceId, deviceId))
        .get();
    return result?.count || 0;
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
    const all = db
        .select()
        .from(devices)
        .where(eq(devices.userId, session.user.id))
        .all();
    const local = all.find(d => d.apiUrl && localPrefixes.some(p => d.apiUrl!.startsWith(p)));
    if (!local || !local.token || !local.apiUrl) return null;
    return { apiUrl: local.apiUrl, token: local.token, deviceId: local.id };
}

