/**
 * MixAI account sign-in — OAuth-style device-code flow on mixai.ro:
 *   POST {origin}/api/device/code  {deviceName, platform, appVersion}
 *     → 200 {device_code, user_code:"ABCD-1234", verification_uri, verification_uri_complete, expires_in, interval}
 *   POST {origin}/api/device/token {device_code}
 *     → 428 {error:"authorization_pending"} | 403 {error:"slow_down"|"access_denied"} | 410 {error:"expired_token"}
 *     → 200 {session_token, expires, user:{id,name,image}, companions:[{id,name,lanUrl,apiUrl,tunnelHostname,token}]}
 */
import { mixaiOrigin, mixaiHost, type Session } from "./config";
import { deviceName } from "./pair";
import { t } from "../i18n/messages";

export const APP_VERSION = "1.0.0";

export interface DeviceCode {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    /** Absolute epoch ms. */
    expiresAt: number;
    /** Poll interval in ms. */
    intervalMs: number;
}

export interface Companion {
    id: string;
    name: string;
    lanUrl: string | null;
    apiUrl: string | null;
    tunnelHostname: string | null;
    token: string;
}

export type TokenResult =
    | { status: "pending" }
    | { status: "slow_down" }
    | { status: "access_denied" }
    | { status: "expired" }
    | { status: "ok"; session: Session; companions: Companion[] };

export class DeviceAuthError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

async function post(path: string, body: unknown): Promise<Response> {
    const url = mixaiOrigin() + path;
    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(body),
            cache: "no-store",
        });
    } catch {
        throw new DeviceAuthError(t("signin.errNetwork", { host: mixaiHost() }), 0);
    }
    return res;
}

export async function requestDeviceCode(): Promise<DeviceCode> {
    const res = await post("/api/device/code", { deviceName: deviceName(), platform: "tizen", appVersion: APP_VERSION });
    if (!res.ok) throw new DeviceAuthError(t("signin.errStatus", { host: mixaiHost(), status: res.status }), res.status);
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!j || typeof j.device_code !== "string" || typeof j.user_code !== "string") {
        throw new DeviceAuthError(t("signin.errInvalid", { host: mixaiHost() }), res.status);
    }
    const expiresIn = typeof j.expires_in === "number" ? j.expires_in : 900;
    const interval = typeof j.interval === "number" ? j.interval : 5;
    const uri = typeof j.verification_uri === "string" ? j.verification_uri : `${mixaiOrigin()}/activate`;
    return {
        deviceCode: j.device_code,
        userCode: j.user_code,
        verificationUri: uri,
        verificationUriComplete: typeof j.verification_uri_complete === "string" ? j.verification_uri_complete : uri,
        expiresAt: Date.now() + expiresIn * 1000,
        intervalMs: Math.max(1, interval) * 1000,
    };
}

export async function pollDeviceToken(deviceCode: string): Promise<TokenResult> {
    const res = await post("/api/device/token", { device_code: deviceCode });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 200) {
        const user = (j.user ?? {}) as Record<string, unknown>;
        if (typeof j.session_token !== "string" || typeof user.id !== "string") {
            throw new DeviceAuthError(t("signin.errInvalid", { host: mixaiHost() }), 200);
        }
        const companions = Array.isArray(j.companions)
            ? (j.companions as Record<string, unknown>[])
                  .filter((c) => c && typeof c.token === "string")
                  .map((c) => ({
                      id: String(c.id ?? ""),
                      name: typeof c.name === "string" ? c.name : "MMO Server",
                      lanUrl: typeof c.lanUrl === "string" && c.lanUrl ? c.lanUrl.replace(/\/+$/, "") : null,
                      apiUrl: typeof c.apiUrl === "string" && c.apiUrl ? c.apiUrl.replace(/\/+$/, "") : null,
                      tunnelHostname: typeof c.tunnelHostname === "string" ? c.tunnelHostname : null,
                      token: c.token as string,
                  }))
            : [];
        return {
            status: "ok",
            session: {
                sessionToken: j.session_token,
                expires: typeof j.expires === "string" ? j.expires : "",
                user: {
                    id: user.id,
                    name: typeof user.name === "string" ? user.name : null,
                    image: typeof user.image === "string" ? user.image : null,
                },
            },
            companions,
        };
    }
    const err = typeof j.error === "string" ? j.error : "";
    if (res.status === 428 || err === "authorization_pending") return { status: "pending" };
    if (err === "slow_down") return { status: "slow_down" };
    if (res.status === 403 || err === "access_denied") return { status: "access_denied" };
    if (res.status === 410 || err === "expired_token") return { status: "expired" };
    throw new DeviceAuthError(t("signin.errStatus", { host: mixaiHost(), status: res.status }), res.status);
}

/** `GET {base}/health` with a 2 s timeout. */
export async function probeHealth(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(baseUrl + "/health", { signal: ctl.signal, cache: "no-store" });
        return res.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(t);
    }
}

/** First companion whose `lanUrl` (then `apiUrl`) answers `/health`. */
export async function pickReachableCompanion(list: Companion[]): Promise<{ companion: Companion; baseUrl: string } | null> {
    for (const c of list) {
        for (const base of [c.lanUrl, c.apiUrl]) {
            if (base && (await probeHealth(base))) return { companion: c, baseUrl: base };
        }
    }
    return null;
}
