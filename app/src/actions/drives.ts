"use server";

/**
 * Drive detection — system-level call, no DB. Drive persistence has
 * moved to the companion (drives are inherently local to a machine).
 * `getSavedDrives` / `addDrive` / `removeDrive` are kept as no-ops so
 * existing imports don't break; full implementation requires a
 * /library/drives companion endpoint which isn't shipped yet.
 */

import { getConnectedDrives, type DriveInfo } from "@/lib/drives";

export async function detectDrives(): Promise<DriveInfo[]> {
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
    // TODO(companion): expose /library/drives. Returning empty keeps the
    // drives page rendering without a crash.
    return [];
}

export async function addDrive(_data: {
    path: string; label: string; type: string; format?: string;
}): Promise<{ success: boolean; error?: string }> {
    void _data;
    return { success: false, error: "Drive persistence requires the companion drives API (not yet shipped)" };
}

export async function removeDrive(_id: number): Promise<{ success: boolean; error?: string }> {
    void _id;
    return { success: false, error: "Drive persistence requires the companion drives API (not yet shipped)" };
}
