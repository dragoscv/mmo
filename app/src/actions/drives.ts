"use server";

/**
 * Drive detection — proxies to the companion's `/library/drives` endpoint
 * because drives are inherently local to the user's machine and the web
 * runtime (Vercel / Cloud Run) would otherwise see container-scoped
 * mounts that mean nothing to the user.
 *
 * Falls back to the deployment-host enumeration only when no companion
 * is reachable, which lets `pnpm dev` on the user's own laptop still
 * see drives during local development.
 */

import { z } from "zod";
import { getCompanionLink, companionLibrary } from "@/lib/companion-library";
import { getConnectedDrives, type DriveInfo } from "@/lib/drives";
import { log } from "@/lib/logger";

export async function detectDrives(): Promise<DriveInfo[]> {
    const link = await getCompanionLink();
    if (link) {
        try {
            const drives = await companionLibrary.getDrives(link);
            return drives.map((d) => ({
                path: d.path,
                label: d.label,
                format: d.format,
                totalSize: d.totalSize,
                freeSpace: d.freeSpace,
                usedSpace: d.usedSpace,
            }));
        } catch (err) {
            log.warn("drives.detectDrives: companion request failed, falling back to host enumeration", {
                error: err instanceof Error ? err.message : String(err),
            });
            // Fall through to the local enumeration below.
        }
    }
    return getConnectedDrives();
}

export interface SavedDrive {
    id: number;
    path: string;
    label: string | null;
    type: string;
    format: string | null;
    isActive: boolean | null;
}

export async function getSavedDrives(): Promise<SavedDrive[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    try {
        const rows = await companionLibrary.getSavedDrives(link);
        return rows.map((r) => ({
            id: r.id,
            path: r.path,
            label: r.label,
            type: r.type,
            format: r.format,
            isActive: r.isActive,
        }));
    } catch (err) {
        log.warn("drives.getSavedDrives failed", { error: err instanceof Error ? err.message : String(err) });
        return [];
    }
}

// Drive metadata is persisted on the companion DB; cap each field length
// so an unbounded string can't bloat the row or break downstream UI lists.
// Reject control characters in the path (\x00 truncates many path APIs).
const driveInputSchema = z.object({
    path: z.string().min(1).max(4096).refine((p) => !/[\x00-\x1f]/.test(p), {
        message: "path must not contain control characters",
    }),
    label: z.string().min(1).max(120),
    type: z.string().min(1).max(32),
    format: z.string().max(32).optional(),
}).strict();

export async function addDrive(data: {
    path: string; label: string; type: string; format?: string;
}): Promise<{ success: boolean; error?: string }> {
    const check = driveInputSchema.safeParse(data);
    if (!check.success) {
        return { success: false, error: check.error.issues[0]?.message ?? "Invalid input" };
    }
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.addSavedDrive(link, check.data);
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Save failed" };
    }
}

export async function removeDrive(id: number): Promise<{ success: boolean; error?: string }> {
    if (!Number.isInteger(id)) return { success: false, error: "Invalid id" };
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.removeSavedDrive(link, id);
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Remove failed" };
    }
}
