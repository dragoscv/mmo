"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { videoFiles } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getPlaybackHandle } from "@/lib/companion-video";

/** Shape of a single job as returned by the companion's
 *  `/video/preremux/:fileId` endpoint. Mirrored from `pre-remux.ts`. */
export interface PreRemuxJobView {
    fileId: string;
    sourcePath: string;
    sidecarPath: string;
    status: "queued" | "running" | "done" | "failed" | "skipped";
    progress: number;
    durationSec: number | null;
    error: string | null;
    enqueuedAt: number;
    startedAt: number | null;
    finishedAt: number | null;
}

interface CompanionContext {
    apiUrl: string;
    token: string;
    userId: string;
    companionFileId: string;
}

/** Resolves the DB `videoFiles.id` into the opaque companion fileId, by
 *  looking up the absolute path against the companion's path-indexed
 *  registry. Returns null when the user is unauthenticated, the file
 *  doesn't exist, or the companion is offline / unpaired. */
async function resolveCompanionContext(dbFileId: number): Promise<CompanionContext | null> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;

    const dbFile = await db.select().from(videoFiles)
        .where(and(eq(videoFiles.userId, userId), eq(videoFiles.id, dbFileId)))
        .limit(1).then(r => r[0]);
    if (!dbFile) return null;

    const handle = await getPlaybackHandle();
    if (!handle) return null;

    const lookupResp = await fetch(
        `${handle.apiUrl}/video/lookup?path=${encodeURIComponent(dbFile.path)}`,
        {
            headers: { "X-Device-Token": handle.token, "X-User-Id": handle.userId },
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
        },
    ).catch(() => null);
    if (!lookupResp || !lookupResp.ok) return null;
    const lookup = await lookupResp.json() as { fileId: string };

    return {
        apiUrl: handle.apiUrl,
        token: handle.token,
        userId: handle.userId,
        companionFileId: lookup.fileId,
    };
}

async function callCompanion<T>(
    ctx: CompanionContext,
    method: "GET" | "POST" | "DELETE",
    suffix: string,
): Promise<T | null> {
    try {
        const res = await fetch(`${ctx.apiUrl}/video/preremux/${ctx.companionFileId}${suffix}`, {
            method,
            headers: { "X-Device-Token": ctx.token, "X-User-Id": ctx.userId },
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        return await res.json() as T;
    } catch {
        return null;
    }
}

export async function triggerPreRemux(dbFileId: number): Promise<{ job: PreRemuxJobView } | null> {
    const ctx = await resolveCompanionContext(dbFileId);
    if (!ctx) return null;
    return callCompanion(ctx, "POST", "");
}

export async function getPreRemuxStatus(dbFileId: number): Promise<{ job: PreRemuxJobView | null; hasSidecar?: boolean } | null> {
    const ctx = await resolveCompanionContext(dbFileId);
    if (!ctx) return null;
    return callCompanion(ctx, "GET", "");
}

export async function cancelPreRemuxAction(dbFileId: number): Promise<{ ok: boolean } | null> {
    const ctx = await resolveCompanionContext(dbFileId);
    if (!ctx) return null;
    return callCompanion(ctx, "DELETE", "");
}

/** Toggle the companion-wide "auto pre-remux on scan" flag. */
export async function setPreRemuxAutoOnScan(enabled: boolean): Promise<boolean | null> {
    const handle = await getPlaybackHandle();
    if (!handle) return null;
    const res = await fetch(`${handle.apiUrl}/video/flags`, {
        method: "POST",
        headers: {
            "X-Device-Token": handle.token,
            "X-User-Id": handle.userId,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ preRemuxAutoOnScan: enabled }),
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const j = await res.json() as { preRemuxAutoOnScan?: boolean };
    return typeof j.preRemuxAutoOnScan === "boolean" ? j.preRemuxAutoOnScan : null;
}
