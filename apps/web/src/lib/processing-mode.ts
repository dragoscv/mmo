/**
 * Per-user processing mode preference.
 *
 *   - "auto"      → try companion first, fall back to cloud (default)
 *   - "companion" → companion only, never cloud
 *   - "cloud"     → cloud only, never companion
 *
 * Stored as a row in `user_preferences` with key = "processing.mode".
 */
import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { userPreferences } from "@/db/schema";

export type ProcessingMode = "auto" | "companion" | "cloud";
export const PROCESSING_MODE_KEY = "processing.mode";
export const DEFAULT_PROCESSING_MODE: ProcessingMode = "auto";

function isMode(v: string): v is ProcessingMode {
    return v === "auto" || v === "companion" || v === "cloud";
}

export async function getProcessingMode(userId: string): Promise<ProcessingMode> {
    const rows = await db
        .select({ value: userPreferences.value })
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, PROCESSING_MODE_KEY)))
        .limit(1);
    const v = rows[0]?.value;
    return v && isMode(v) ? v : DEFAULT_PROCESSING_MODE;
}

export async function setProcessingMode(userId: string, mode: ProcessingMode): Promise<void> {
    const existing = await db
        .select({ id: userPreferences.id })
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, PROCESSING_MODE_KEY)))
        .limit(1);
    if (existing.length > 0) {
        await db
            .update(userPreferences)
            .set({ value: mode, updatedAt: new Date() })
            .where(eq(userPreferences.id, existing[0]!.id));
    } else {
        await db.insert(userPreferences).values({
            userId,
            key: PROCESSING_MODE_KEY,
            value: mode,
        });
    }
}

/** True when the mode permits a companion attempt. */
export function canUseCompanion(mode: ProcessingMode): boolean {
    return mode === "auto" || mode === "companion";
}

/** True when the mode permits a cloud attempt. */
export function canUseCloud(mode: ProcessingMode): boolean {
    return mode === "auto" || mode === "cloud";
}
