/**
 * Server-side client for the companion's `/cast/*` routes.
 *
 * Mirrors the private `call()` in `lib/companion-control.ts` but targets
 * the user's current companion (via `getCompanionLink`, online-first).
 * Media URLs passed to `play` are built by `renderer-url.ts` from the
 * companion's LAN URL — this client only carries them.
 */

import "server-only";
import { getCompanionLink } from "@/lib/companion-library";

export type CastDeviceKind = "dlna" | "home-assistant" | "google-cast-ha";

export interface CastDevice {
    id: string;
    kind: CastDeviceKind;
    name: string;
    state?: string;
    model?: string;
}

export interface CastDevicesResponse {
    devices: CastDevice[];
    haConfigured: boolean;
    errors?: string[];
}

export interface CastPlayBody {
    deviceId: string;
    url: string;
    mime: string;
    title: string;
    thumb?: string;
    subtitleUrl?: string;
    startSec?: number;
}

export type CastCommandAction = "play" | "pause" | "stop" | "seek" | "volume_set" | "volume_mute" | "next" | "previous";

export interface CastStatus {
    state: string;
    positionSec: number | null;
    durationSec: number | null;
}

async function castCall<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const link = await getCompanionLink();
    if (!link) throw new Error("No companion online");
    const res = await fetch(`${link.apiUrl}/cast${path}`, {
        method,
        headers: {
            "X-Device-Token": link.token,
            "X-User-Id": link.userId,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
        let detail = "";
        try { detail = ((await res.json()) as { error?: string }).error ?? ""; } catch { /* ignore */ }
        throw new Error(`Companion ${method} /cast${path} failed (${res.status})${detail ? ": " + detail : ""}`);
    }
    return (await res.json()) as T;
}

export const companionCast = {
    devices(refresh = false): Promise<CastDevicesResponse> {
        return castCall<CastDevicesResponse>("GET", `/devices${refresh ? "?refresh=1" : ""}`);
    },
    play(body: CastPlayBody): Promise<{ ok: true }> {
        return castCall("POST", "/play", body, 20_000);
    },
    command(deviceId: string, action: CastCommandAction, value?: number | boolean): Promise<{ ok: true }> {
        return castCall("POST", "/command", { deviceId, action, value });
    },
    status(deviceId: string): Promise<CastStatus> {
        return castCall<CastStatus>("GET", `/status/${encodeURIComponent(deviceId)}`);
    },
};
