/**
 * Home Assistant bridge — drives any `media_player.*` entity through the
 * HA REST API (`/api/states`, `/api/services/media_player/*`).
 *
 * Config resolution order: `HA_URL` / `HA_TOKEN` env vars, then the
 * companion settings store keys `haUrl` / `haToken` (the store is an
 * untyped `Record<string, unknown>`, so no schema change was needed —
 * the keys can be set via `POST /settings` or by editing config.json).
 *
 * Every call is a no-op / throws a clear error when HA is not configured;
 * `isConfigured()` lets the router return `haConfigured:false` instead.
 */

import { store } from "../store";

export interface HaConfig { url: string; token: string }

export function getHaConfig(): HaConfig | null {
    const url = (process.env.HA_URL?.trim() || (store.get("haUrl") as string | undefined)?.trim() || "").replace(/\/+$/, "");
    const token = process.env.HA_TOKEN?.trim() || (store.get("haToken") as string | undefined)?.trim() || "";
    if (!url || !token) return null;
    return { url, token };
}

export function isConfigured(): boolean { return getHaConfig() !== null; }

async function ha<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const cfg = getHaConfig();
    if (!cfg) throw new Error("Home Assistant not configured (HA_URL / HA_TOKEN)");
    const res = await fetch(`${cfg.url}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${cfg.token}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Home Assistant ${method} ${path} failed (${res.status})${text ? ": " + text.slice(0, 200) : ""}`);
    }
    return (await res.json()) as T;
}

export interface HaMediaPlayer {
    entityId: string;
    name: string;
    state: string;
    /** True when the integration is a Google Cast entity (`cast` platform). */
    supportsCast: boolean;
    /** Bitmask from HA `supported_features`. */
    supportedFeatures: number;
}

interface HaState {
    entity_id: string;
    state: string;
    attributes: Record<string, unknown>;
}

// media_player supported_features bit for PLAY_MEDIA.
const FEATURE_PLAY_MEDIA = 512;

export async function listMediaPlayers(): Promise<HaMediaPlayer[]> {
    const states = await ha<HaState[]>("GET", "/api/states");
    return states
        .filter((s) => s.entity_id.startsWith("media_player."))
        .map((s) => {
            const attrs = s.attributes;
            const features = Number(attrs.supported_features ?? 0);
            const appId = String(attrs.app_id ?? "");
            const deviceClass = String(attrs.device_class ?? "");
            return {
                entityId: s.entity_id,
                name: String(attrs.friendly_name ?? s.entity_id.replace(/^media_player\./, "")),
                state: s.state,
                supportsCast: /cast/i.test(appId) || /cast/i.test(deviceClass) || /chromecast|nest|google/i.test(String(attrs.friendly_name ?? "")),
                supportedFeatures: features,
            };
        })
        .filter((p) => (p.supportedFeatures & FEATURE_PLAY_MEDIA) !== 0 || p.supportedFeatures === 0)
        .sort((a, b) => a.name.localeCompare(b.name));
}

export interface HaPlayOptions {
    mime: string;
    title?: string;
    thumb?: string;
}

export async function playMedia(entityId: string, url: string, opts: HaPlayOptions): Promise<void> {
    await ha("POST", "/api/services/media_player/play_media", {
        entity_id: entityId,
        media_content_id: url,
        // HA's cast integration forwards the raw MIME type to the Default
        // Media Receiver; generic players just need the audio/video class.
        media_content_type: opts.mime,
        extra: {
            ...(opts.title ? { title: opts.title } : {}),
            ...(opts.thumb ? { thumb: opts.thumb } : {}),
        },
    });
}

export type HaMediaCommand =
    | "media_play" | "media_pause" | "media_play_pause" | "media_stop"
    | "media_next_track" | "media_previous_track"
    | "volume_set" | "volume_mute" | "volume_up" | "volume_down"
    | "media_seek" | "turn_on" | "turn_off";

export async function mediaCommand(entityId: string, command: HaMediaCommand, value?: number | boolean): Promise<void> {
    const data: Record<string, unknown> = { entity_id: entityId };
    if (command === "volume_set" && typeof value === "number") data.volume_level = Math.min(1, Math.max(0, value));
    if (command === "volume_mute") data.is_volume_muted = value !== false;
    if (command === "media_seek" && typeof value === "number") data.seek_position = Math.max(0, value);
    await ha("POST", `/api/services/media_player/${command}`, data);
}

export interface HaStatus {
    state: string;
    positionSec: number | null;
    durationSec: number | null;
    title: string | null;
    volume: number | null;
}

export async function getStatus(entityId: string): Promise<HaStatus> {
    const s = await ha<HaState>("GET", `/api/states/${encodeURIComponent(entityId)}`);
    const a = s.attributes;
    return {
        state: s.state,
        positionSec: typeof a.media_position === "number" ? a.media_position : null,
        durationSec: typeof a.media_duration === "number" ? a.media_duration : null,
        title: typeof a.media_title === "string" ? a.media_title : null,
        volume: typeof a.volume_level === "number" ? a.volume_level : null,
    };
}
