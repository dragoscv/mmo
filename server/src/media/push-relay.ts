/**
 * Push relay hook (WP16-50, D37): companion events → `POST {webAppUrl}/api/push/relay`, which fans
 * out to FCM v1 / APNs for the household's phones. Contract: server/README.md § "Push relay".
 *
 * - Auth: `Authorization: Bearer <deviceToken>` (same as `/api/media/sync`).
 * - Body: `{event, eventId, profileId?, title, body, deepLink, data?, serverId, at}`.
 * - No-op when webAppUrl or the device token is unset.
 * - Debounce: identical (event, dedupeKey) within `debounceMs` (default 60 s) collapse into one push.
 * - Retry: up to 3 attempts (1 s, 4 s backoff by default) on network errors / 5xx / 429;
 *   4xx (other than 429) are final; 401/403 pause the relay until the token changes.
 */

import crypto from "node:crypto";
import type { MediaLogger } from "./types";

export const PUSH_EVENTS = ["recording.done", "recording.failed", "download.ready", "episode.new"] as const;
export type PushEvent = (typeof PUSH_EVENTS)[number];

export interface PushMessage {
    event: PushEvent;
    profileId?: string;
    title: string;
    body: string;
    deepLink: string;
    data?: Record<string, string | number | boolean | null>;
    /** Collapses repeats inside the debounce window (default: event + deepLink + profileId). */
    dedupeKey?: string;
    /** Overrides the relay's debounce window for this message. */
    windowMs?: number;
}

export interface PushRelayBody extends Omit<PushMessage, "dedupeKey" | "windowMs"> {
    eventId: string;
    serverId: string;
    at: number;
}

export type RelayFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
    Promise<{ ok: boolean; status: number }>;

export interface PushRelayOptions {
    getWebAppUrl: () => string | undefined;
    getDeviceToken: () => string | undefined;
    getServerId: () => string;
    fetch?: RelayFetch;
    log?: MediaLogger;
    now?: () => number;
    debounceMs?: number;
    /** Delays before attempt 2 and 3. */
    retryDelaysMs?: number[];
    sleep?: (ms: number) => Promise<void>;
}

export type PushResult = { sent: boolean; status: number | "offline" | "skipped" | "debounced"; attempts: number };

export class PushRelay {
    private readonly recent = new Map<string, { at: number; window: number }>();
    private pausedForToken: string | null = null;
    private readonly fetchImpl: RelayFetch;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    readonly history: { event: PushEvent; result: PushResult; at: number }[] = [];

    constructor(private readonly opts: PushRelayOptions) {
        this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
        this.now = opts.now ?? Date.now;
        this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
    }

    async notify(msg: PushMessage): Promise<PushResult> {
        const result = await this.send(msg);
        this.history.push({ event: msg.event, result, at: this.now() });
        if (this.history.length > 50) this.history.shift();
        return result;
    }

    private async send(msg: PushMessage): Promise<PushResult> {
        const base = this.opts.getWebAppUrl()?.trim().replace(/\/+$/, "");
        const token = this.opts.getDeviceToken();
        if (!base || !token) return { sent: false, status: "skipped", attempts: 0 };
        if (this.pausedForToken === token) return { sent: false, status: "skipped", attempts: 0 };
        const t = this.now();
        const window = msg.windowMs ?? this.opts.debounceMs ?? 60_000;
        for (const [k, v] of this.recent) if (t - v.at > v.window) this.recent.delete(k);
        const key = `${msg.event}|${msg.dedupeKey ?? `${msg.deepLink}|${msg.profileId ?? ""}`}`;
        if (this.recent.has(key)) return { sent: false, status: "debounced", attempts: 0 };
        this.recent.set(key, { at: t, window });

        const { dedupeKey: _d, windowMs: _w, ...rest } = msg;
        const body: PushRelayBody = { ...rest, eventId: crypto.randomUUID(), serverId: this.opts.getServerId(), at: t };
        const delays = this.opts.retryDelaysMs ?? [1000, 4000];
        let last: number | "offline" = "offline";
        for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
            try {
                const res = await this.fetchImpl(`${base}/api/push/relay`, {
                    method: "POST",
                    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(15_000),
                });
                last = res.status;
                if (res.ok) return { sent: true, status: res.status, attempts: attempt };
                if (res.status === 401 || res.status === 403) {
                    this.pausedForToken = token;
                    this.opts.log?.warn("[push] relay rejected the device token — paused until it changes", { status: res.status });
                    return { sent: false, status: res.status, attempts: attempt };
                }
                if (res.status !== 429 && res.status < 500) return { sent: false, status: res.status, attempts: attempt };
            } catch {
                last = "offline";
            }
            if (attempt <= delays.length) await this.sleep(delays[attempt - 1]!);
        }
        this.opts.log?.warn("[push] relay failed after retries", { event: msg.event, status: last });
        return { sent: false, status: last, attempts: delays.length + 1 };
    }
}
