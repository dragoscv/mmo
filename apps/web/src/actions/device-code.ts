"use server";

/**
 * Device-code login — the phone side (/activate).
 *
 *   lookupDeviceCode(userCode)   → who is asking (device name / platform)
 *   approveDeviceCode(userCode)  → status='approved', user_id=me
 *   denyDeviceCode(userCode)     → status='denied'
 *
 * Zod → session → execute. Only a live `pending` row can be decided.
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { deviceAuthCodes } from "@/db/schema";
import { canDecide, isValidUserCode, normalizeUserCode } from "@/lib/device-code";

export type DeviceCodeActionError = "unauthenticated" | "invalid" | "not_found" | "expired" | "already_decided";

export interface DeviceCodeInfo {
    deviceName: string;
    platform: string;
    expiresAt: string;
}

export type DeviceCodeLookup =
    | { ok: true; info: DeviceCodeInfo }
    | { ok: false; error: DeviceCodeActionError };

export type DeviceCodeDecision =
    | { ok: true; deviceName: string }
    | { ok: false; error: DeviceCodeActionError };

const CodeSchema = z.string().trim().min(1).max(16).transform(normalizeUserCode)
    .refine(isValidUserCode, "8 chars");

async function requireUserId(): Promise<string | null> {
    const s = await auth();
    return s?.user?.id ?? null;
}

async function loadPending(code: string) {
    const [row] = await db.select().from(deviceAuthCodes)
        .where(eq(deviceAuthCodes.userCode, code)).limit(1);
    return row ?? null;
}

export async function lookupDeviceCode(input: string): Promise<DeviceCodeLookup> {
    if (!(await requireUserId())) return { ok: false, error: "unauthenticated" };
    const parsed = CodeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" };
    const row = await loadPending(parsed.data);
    if (!row) return { ok: false, error: "not_found" };
    if (!canDecide(row)) {
        return { ok: false, error: row.status === "pending" ? "expired" : "already_decided" };
    }
    return {
        ok: true,
        info: { deviceName: row.deviceName, platform: row.platform, expiresAt: row.expiresAt.toISOString() },
    };
}

async function decide(input: string, status: "approved" | "denied"): Promise<DeviceCodeDecision> {
    const userId = await requireUserId();
    if (!userId) return { ok: false, error: "unauthenticated" };
    const parsed = CodeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" };
    const row = await loadPending(parsed.data);
    if (!row) return { ok: false, error: "not_found" };
    if (!canDecide(row)) {
        return { ok: false, error: row.status === "pending" ? "expired" : "already_decided" };
    }
    // Guard the transition in SQL too, so two phones can't both "win".
    const updated = await db.update(deviceAuthCodes)
        .set({ status, userId: status === "approved" ? userId : null })
        .where(and(eq(deviceAuthCodes.id, row.id), eq(deviceAuthCodes.status, "pending")))
        .returning({ id: deviceAuthCodes.id });
    if (updated.length === 0) return { ok: false, error: "already_decided" };
    return { ok: true, deviceName: row.deviceName };
}

export async function approveDeviceCode(userCode: string): Promise<DeviceCodeDecision> {
    return decide(userCode, "approved");
}

export async function denyDeviceCode(userCode: string): Promise<DeviceCodeDecision> {
    return decide(userCode, "denied");
}
