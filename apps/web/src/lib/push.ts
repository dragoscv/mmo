/**
 * Server-side Web Push helper.
 *
 * Other server code (server actions, webhooks, cron jobs) calls
 * {@link sendPushToUser} to fan a notification out to every subscription
 * the user has registered. The helper is no-op safe when VAPID env vars
 * are missing — that way devs running the app without push configured
 * don't see crashes, just silently-dropped notifications.
 *
 * Failure pruning: when the push provider returns 404/410 (Gone) we drop
 * the subscription row immediately. For transient 4xx/5xx we bump a
 * counter; once a subscription has 5 consecutive failures we drop it.
 */

import "server-only";
import webpush from "web-push";
import { db } from "@/db";
import { pushSubscriptions } from "@/db/schema";
import { eq, and, sql as drizzleSql } from "drizzle-orm";

const MAX_FAILURES = 5;
const MAX_PAYLOAD_BYTES = 4096; // Web Push protocol soft limit

let configured: boolean | null = null;

function ensureConfigured(): boolean {
    if (configured !== null) return configured;
    const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    const subj = process.env.VAPID_SUBJECT;
    if (!pub || !priv || !subj) {
        configured = false;
        return false;
    }
    try {
        webpush.setVapidDetails(subj, pub, priv);
        configured = true;
    } catch {
        configured = false;
    }
    return configured;
}

export interface PushPayload {
    title: string;
    body?: string;
    /** Absolute path starting with `/`. Other origins are rejected by the SW. */
    url?: string;
    icon?: string;
    badge?: string;
    /** Coalesce key — newer notifications with the same tag replace older ones. */
    tag?: string;
    actions?: Array<{ action: string; title: string; icon?: string }>;
}

export interface SendResult {
    sent: number;
    pruned: number;
    skipped: boolean;
}

/**
 * Sends a push to every subscription registered for `userId`. Returns
 * `{ skipped: true }` when VAPID isn't configured — callers can ignore.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<SendResult> {
    if (!ensureConfigured()) return { sent: 0, pruned: 0, skipped: true };

    const subs = await db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId));
    if (subs.length === 0) return { sent: 0, pruned: 0, skipped: false };

    // Clamp + JSON-encode once.
    const safePayload: PushPayload = {
        title: String(payload.title).slice(0, 200),
        body: payload.body ? String(payload.body).slice(0, 500) : undefined,
        url: typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/",
        icon: payload.icon,
        badge: payload.badge,
        tag: payload.tag ? String(payload.tag).slice(0, 64) : undefined,
        actions: Array.isArray(payload.actions) ? payload.actions.slice(0, 2) : undefined,
    };
    const body = JSON.stringify(safePayload);
    if (Buffer.byteLength(body, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new Error("Push payload exceeds 4 KB.");
    }

    let sent = 0;
    let pruned = 0;

    await Promise.all(
        subs.map(async (sub) => {
            try {
                await webpush.sendNotification(
                    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                    body,
                );
                sent++;
                await db
                    .update(pushSubscriptions)
                    .set({ lastSeenAt: new Date(), consecutiveFailures: 0 })
                    .where(eq(pushSubscriptions.id, sub.id));
            } catch (err: unknown) {
                const status = (err as { statusCode?: number })?.statusCode;
                // 404 = endpoint never existed; 410 = endpoint revoked.
                if (status === 404 || status === 410) {
                    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
                    pruned++;
                    return;
                }
                // Bump failure counter; prune at threshold.
                const next = (sub.consecutiveFailures ?? 0) + 1;
                if (next >= MAX_FAILURES) {
                    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
                    pruned++;
                } else {
                    await db
                        .update(pushSubscriptions)
                        .set({ consecutiveFailures: next })
                        .where(eq(pushSubscriptions.id, sub.id));
                }
            }
        }),
    );

    return { sent, pruned, skipped: false };
}

/** Cheap health check for `/api/push/subscribe` GETs and settings UI. */
export function isPushConfigured(): boolean {
    return ensureConfigured();
}

// Re-export so callers don't need to know about the drizzle helper.
export { and, drizzleSql };
