import http2 from "node:http2";
import { JWT } from "google-auth-library";
import { signEs256Jwt } from "@/lib/apple/client-secret";

/**
 * Native push senders (WP16-51). Both are env-gated and report `unconfigured` without env:
 *
 * FCM HTTP v1 — FCM_SERVICE_ACCOUNT_JSON (raw JSON or base64; Secret Manager `mixai-web-fcm-sa`),
 *   optional FCM_PROJECT_ID (defaults to the key's project_id).
 * APNs token auth — APNS_KEY_ID + APNS_PRIVATE_KEY (.p8 PEM, `mixai-web-apns-p8`),
 *   APNS_TEAM_ID (default S6D533QSV2), APNS_TOPIC (default ro.mixai.app).
 */

export interface NativePushMessage {
    title: string;
    body: string;
    deepLink?: string | null;
    /** Flat map; values are stringified for FCM (data must be string → string). */
    data?: Record<string, string | number | boolean | null>;
    /** Collapse key (FCM collapse_key / apns-collapse-id, max 64 bytes). */
    collapseId?: string;
}

/** `dead` = the token is gone for good (delete it); `retry` = transient; `error` = permanent for this message. */
export type SendOutcome = "ok" | "dead" | "retry" | "error" | "unconfigured";

export interface PushSender {
    send(token: string, msg: NativePushMessage, opts?: { sandbox?: boolean }): Promise<SendOutcome>;
}

const flatData = (msg: NativePushMessage): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(msg.data ?? {})) if (v !== null && v !== undefined) out[k] = String(v);
    if (msg.deepLink) out.deepLink = msg.deepLink;
    return out;
};

// ─── FCM ─────────────────────────────────────────────────────────────────────

interface ServiceAccount { client_email: string; private_key: string; project_id: string }

export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
    if (!raw?.trim()) return null;
    const text = raw.trim().startsWith("{") ? raw.trim() : Buffer.from(raw.trim(), "base64").toString("utf8");
    try {
        const j = JSON.parse(text) as Partial<ServiceAccount>;
        if (j.client_email && j.private_key && j.project_id) return j as ServiceAccount;
    } catch { /* fall through */ }
    return null;
}

/** Map an FCM v1 error to an outcome (https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode). */
export function classifyFcm(status: number, body: string): SendOutcome {
    if (status >= 200 && status < 300) return "ok";
    if (/UNREGISTERED/.test(body) || status === 404) return "dead";
    if (status === 400 && /registration token|INVALID_ARGUMENT/.test(body) && /token/i.test(body)) return "dead";
    if (status === 429 || status >= 500) return "retry";
    return "error";
}

export function createFcmSender(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): PushSender | null {
    const sa = parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON);
    if (!sa) return null;
    const projectId = env.FCM_PROJECT_ID?.trim() || sa.project_id;
    const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
    return {
        async send(token, msg) {
            let access: string | null | undefined;
            try {
                access = (await jwt.getAccessToken()).token;
            } catch {
                return "retry";
            }
            if (!access) return "retry";
            const message = {
                token,
                notification: { title: msg.title, body: msg.body },
                data: flatData(msg),
                android: { priority: "HIGH", ...(msg.collapseId ? { collapse_key: msg.collapseId.slice(0, 64) } : {}) },
            };
            try {
                const res = await fetchImpl(url, {
                    method: "POST",
                    headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
                    body: JSON.stringify({ message }),
                    signal: AbortSignal.timeout(8000),
                });
                return classifyFcm(res.status, res.ok ? "" : await res.text());
            } catch {
                return "retry";
            }
        },
    };
}

// ─── APNs ────────────────────────────────────────────────────────────────────

const APNS_PROD = "https://api.push.apple.com";
const APNS_SANDBOX = "https://api.sandbox.push.apple.com";

/** Map an APNs response (status + `reason`) to an outcome. */
export function classifyApns(status: number, reason: string | undefined): SendOutcome {
    if (status === 200) return "ok";
    if (status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic") return "dead";
    if (status === 429 || status >= 500 || reason === "ExpiredProviderToken") return "retry";
    return "error";
}

export function buildApnsPayload(msg: NativePushMessage): string {
    return JSON.stringify({
        aps: { alert: { title: msg.title, body: msg.body }, sound: "default", "mutable-content": 1 },
        ...flatData(msg),
    });
}

export type Http2Post = (origin: string, path: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>;

/** One short-lived HTTP/2 session per call; fan-outs here are a handful of phones per event. */
const http2Post: Http2Post = (origin, path, headers, body) =>
    new Promise((resolve, reject) => {
        const client = http2.connect(origin);
        const done = (fn: () => void) => { client.close(); fn(); };
        client.on("error", (e) => done(() => reject(e)));
        client.setTimeout(10_000, () => done(() => reject(new Error("apns timeout"))));
        const req = client.request({ ":method": "POST", ":path": path, ...headers });
        let status = 0;
        let data = "";
        req.setEncoding("utf8");
        req.on("response", (h) => { status = Number(h[":status"]) || 0; });
        req.on("data", (c: string) => { data += c; });
        req.on("end", () => done(() => resolve({ status, body: data })));
        req.on("error", (e) => done(() => reject(e)));
        req.end(body);
    });

export function createApnsSender(env: NodeJS.ProcessEnv = process.env, post: Http2Post = http2Post, nowSec = () => Math.floor(Date.now() / 1000)): PushSender | null {
    const keyId = env.APNS_KEY_ID?.trim();
    const key = env.APNS_PRIVATE_KEY?.trim();
    if (!keyId || !key) return null;
    const teamId = env.APNS_TEAM_ID?.trim() || "S6D533QSV2";
    const topic = env.APNS_TOPIC?.trim() || "ro.mixai.app";
    let cached: { jwt: string; iat: number } | null = null;
    // Apple refuses provider tokens older than 1 h and throttles ones refreshed more than every 20 min.
    const providerToken = () => {
        const now = nowSec();
        if (!cached || now - cached.iat > 50 * 60) cached = { jwt: signEs256Jwt(keyId, { iss: teamId, iat: now }, key), iat: now };
        return cached.jwt;
    };
    return {
        async send(token, msg, opts) {
            const headers: Record<string, string> = {
                authorization: `bearer ${providerToken()}`,
                "apns-topic": topic,
                "apns-push-type": "alert",
                "apns-priority": "10",
                "content-type": "application/json",
            };
            if (msg.collapseId) headers["apns-collapse-id"] = msg.collapseId.slice(0, 64);
            try {
                const res = await post(opts?.sandbox ? APNS_SANDBOX : APNS_PROD, `/3/device/${encodeURIComponent(token)}`, headers, buildApnsPayload(msg));
                let reason: string | undefined;
                try { reason = res.body ? (JSON.parse(res.body) as { reason?: string }).reason : undefined; } catch { reason = undefined; }
                return classifyApns(res.status, reason);
            } catch {
                return "retry";
            }
        },
    };
}
