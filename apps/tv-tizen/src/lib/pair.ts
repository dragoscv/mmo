/**
 * Quick Connect client — mirrors `server/src/pair/router.ts`:
 *   POST /pair/request {deviceName, platform} → 201 {code, secret, expiresAt, qr, approveUrl}
 *   GET  /pair/poll?code&secret               → {status: pending|approved|expired, deviceToken?, userId?}
 */
import { t } from "../i18n/messages";

export interface PairRequest {
    code: string;
    secret: string;
    expiresAt: number;
    qr: string;
    approveUrl: string;
}

export type PairPoll =
    | { status: "pending" }
    | { status: "expired" }
    | { status: "approved"; deviceToken: string; userId: string | null };

export const DEVICE_NAME = "Samsung TV · MixAI TV";
export const POLL_INTERVAL_MS = 3000;

export function deviceName(): string {
    try {
        const model = typeof webapis !== "undefined" ? webapis?.productinfo?.getModel() : undefined;
        return model ? `Samsung ${model} · MixAI TV` : DEVICE_NAME;
    } catch {
        return DEVICE_NAME;
    }
}

export async function requestPair(baseUrl: string): Promise<PairRequest> {
    const res = await fetch(baseUrl + "/pair/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceName: deviceName(), platform: "tizen" }),
    });
    if (!res.ok) {
        const msg = res.status === 503 ? t("pair.errNoToken") : `${res.status} ${res.statusText}`;
        throw new Error(msg);
    }
    const j = (await res.json()) as Partial<PairRequest>;
    if (typeof j.code !== "string" || typeof j.secret !== "string") throw new Error(t("pair.errInvalid"));
    return {
        code: j.code,
        secret: j.secret,
        expiresAt: typeof j.expiresAt === "number" ? j.expiresAt : Date.now() + 5 * 60_000,
        qr: typeof j.qr === "string" ? j.qr : "",
        approveUrl: typeof j.approveUrl === "string" ? j.approveUrl : "",
    };
}

export async function pollPair(baseUrl: string, code: string, secret: string): Promise<PairPoll> {
    const q = `code=${encodeURIComponent(code)}&secret=${encodeURIComponent(secret)}`;
    const res = await fetch(`${baseUrl}/pair/poll?${q}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const j = (await res.json()) as { status?: string; deviceToken?: string; userId?: string | null };
    if (j.status === "approved" && typeof j.deviceToken === "string") {
        return { status: "approved", deviceToken: j.deviceToken, userId: typeof j.userId === "string" ? j.userId : null };
    }
    if (j.status === "expired") return { status: "expired" };
    return { status: "pending" };
}
