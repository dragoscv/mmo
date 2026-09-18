"use server";

/**
 * TV / mobile pairing server actions.
 *
 *   approvePairing({host, port, code})   phone scanned the TV's QR → approve on the matching companion
 *   approvePairingOnDevice({deviceId, code})   devices page → approve on an explicit companion
 *   listPendingPairings()                aggregate /pair/pending across the user's online companions
 *
 * All inputs are Zod-validated and every action requires a session.
 */

import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { materializeDeviceToken } from "@/lib/device-token";
import { pickCompanionUrl } from "@/lib/companion-url";
import { aggregateAcrossCompanions } from "@/lib/companion-library";
import { companionPair, matchCompanionByHost, PairError, PAIR_CODE_RE, type PairErrorCode } from "@/lib/companion-pair";

export type PairActionError = PairErrorCode | "unauthenticated" | "invalid";
export type PairResult =
    | { ok: true; deviceId: string; deviceName: string }
    | { ok: false; error: PairActionError; message?: string };

const CodeSchema = z.string().trim().regex(PAIR_CODE_RE, "6 digits");

const ApprovePairingSchema = z.object({
    host: z.string().trim().min(1).max(253),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    code: CodeSchema,
});

const ApproveOnDeviceSchema = z.object({
    deviceId: z.string().min(1).max(64),
    code: CodeSchema,
});

export interface PendingPairing {
    deviceId: string;
    deviceName: string;
    code: string;
    requester: string;
    platform: string;
    expiresAt: string;
}

async function requireUserId(): Promise<string | null> {
    const s = await auth();
    return s?.user?.id ?? null;
}

function fail(e: unknown): PairResult {
    if (e instanceof PairError) return { ok: false, error: e.code, message: e.message };
    return { ok: false, error: "failed", message: e instanceof Error ? e.message : String(e) };
}

async function approveOnRow(row: typeof devices.$inferSelect, code: string): Promise<PairResult> {
    const token = await materializeDeviceToken(row);
    const apiUrl = pickCompanionUrl(row);
    if (!token || !apiUrl) return { ok: false, error: "unreachable" };
    try {
        await companionPair.approve({ apiUrl, token }, code);
        return { ok: true, deviceId: row.id, deviceName: row.name };
    } catch (e) {
        return fail(e);
    }
}

export async function approvePairing(input: z.input<typeof ApprovePairingSchema>): Promise<PairResult> {
    const userId = await requireUserId();
    if (!userId) return { ok: false, error: "unauthenticated" };
    const parsed = ApprovePairingSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" };
    const { host, port, code } = parsed.data;

    const rows = await db.select().from(devices).where(eq(devices.userId, userId));
    const usable = rows.filter((d) => d.tokenEncrypted && (d.apiUrl || d.lanUrl || d.tunnelHostname));
    const target = matchCompanionByHost(usable, host, port ?? null);
    if (!target) return { ok: false, error: "not_found" };
    return approveOnRow(target, code);
}

export async function approvePairingOnDevice(input: z.input<typeof ApproveOnDeviceSchema>): Promise<PairResult> {
    const userId = await requireUserId();
    if (!userId) return { ok: false, error: "unauthenticated" };
    const parsed = ApproveOnDeviceSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "invalid" };

    const rows = await db.select().from(devices)
        .where(and(eq(devices.id, parsed.data.deviceId), eq(devices.userId, userId)))
        .limit(1);
    const row = rows[0];
    if (!row) return { ok: false, error: "not_found" };
    return approveOnRow(row, parsed.data.code);
}

export async function listPendingPairings(): Promise<PendingPairing[]> {
    if (!(await requireUserId())) return [];
    const { results } = await aggregateAcrossCompanions((link) =>
        companionPair.pending({ apiUrl: link.apiUrl, token: link.token }),
    );
    const out: PendingPairing[] = [];
    for (const { link, value } of results) {
        for (const r of value) {
            out.push({
                deviceId: link.deviceId,
                deviceName: link.name,
                code: r.code,
                requester: r.deviceName,
                platform: r.platform,
                expiresAt: r.expiresAt,
            });
        }
    }
    out.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    return out;
}
