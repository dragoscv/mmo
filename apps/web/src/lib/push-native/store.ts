import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { pushRelayEvents, pushTokens, type PushTokenRow } from "@/db/schema";

/**
 * Data access for `push_tokens` / `push_relay_events` (drizzle/0031_push_tokens.sql).
 * Every call surfaces a missing table as `PushUnavailableError` so the routes can answer
 * 503 push_unavailable while the migration is still pending (code may ship first).
 */

export class PushUnavailableError extends Error {
    constructor() { super("push_unavailable"); }
}

/** Postgres `undefined_table` (42P01), possibly wrapped by Drizzle's query error. */
export function isUndefinedTable(e: unknown): boolean {
    for (let cur: unknown = e, i = 0; cur && i < 4; i++) {
        const c = cur as { code?: unknown; message?: unknown; cause?: unknown };
        if (c.code === "42P01") return true;
        if (typeof c.message === "string" && /relation "push_(tokens|relay_events)" does not exist/.test(c.message)) return true;
        cur = c.cause;
    }
    return false;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        if (isUndefinedTable(e)) throw new PushUnavailableError();
        throw e;
    }
}

export interface RegisterInput {
    userId: string;
    platform: "android" | "ios";
    token: string;
    environment: "production" | "sandbox";
    deviceName: string | null;
    profileId: string | null;
    liveActivityToken: string | null;
}

/** Upsert by token: a token moving to another account (re-login) is re-owned, never duplicated. */
export function upsertPushToken(input: RegisterInput): Promise<void> {
    return guard(async () => {
        const now = new Date();
        await db.insert(pushTokens).values({ ...input, updatedAt: now }).onConflictDoUpdate({
            target: pushTokens.token,
            set: {
                userId: input.userId,
                platform: input.platform,
                environment: input.environment,
                deviceName: input.deviceName,
                profileId: input.profileId,
                liveActivityToken: input.liveActivityToken,
                updatedAt: now,
            },
        });
    });
}

export function deletePushToken(userId: string, token: string): Promise<number> {
    return guard(async () => {
        const rows = await db.delete(pushTokens)
            .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)))
            .returning({ id: pushTokens.id });
        return rows.length;
    });
}

/** Tokens to notify: all of the user's phones, or only those bound to `profileId` plus unbound ones. */
export function tokensForUser(userId: string, profileId?: string | null): Promise<PushTokenRow[]> {
    return guard(() => {
        const where = profileId
            ? and(eq(pushTokens.userId, userId), or(eq(pushTokens.profileId, profileId), isNull(pushTokens.profileId)))
            : eq(pushTokens.userId, userId);
        return db.select().from(pushTokens).where(where);
    });
}

export function deleteTokensById(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return guard(async () => { await db.delete(pushTokens).where(inArray(pushTokens.id, ids)); });
}

export function touchTokens(ids: string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return guard(async () => { await db.update(pushTokens).set({ lastUsedAt: new Date() }).where(inArray(pushTokens.id, ids)); });
}

/** Records the event; `false` = already seen (duplicate retry from the companion). */
export function claimRelayEvent(eventId: string, deviceId: string, event: string): Promise<boolean> {
    return guard(async () => {
        const rows = await db.insert(pushRelayEvents).values({ eventId, deviceId, event })
            .onConflictDoNothing().returning({ eventId: pushRelayEvents.eventId });
        // Opportunistic pruning keeps the ledger small (idempotency only needs minutes).
        if (rows.length > 0 && Math.random() < 0.02) {
            await db.delete(pushRelayEvents).where(lt(pushRelayEvents.createdAt, sql`now() - interval '7 days'`));
        }
        return rows.length > 0;
    });
}

/** Releases a claimed event so a retry after a total send failure is not swallowed. */
export function releaseRelayEvent(eventId: string): Promise<void> {
    return guard(async () => { await db.delete(pushRelayEvents).where(eq(pushRelayEvents.eventId, eventId)); });
}
