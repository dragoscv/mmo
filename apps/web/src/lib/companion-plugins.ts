/**
 * Companion plugins HTTP client (server-side only).
 *
 * Wraps the companion's `/plugins/*` endpoints — VST3 / AU / LV2 host
 * powered by Spotify's `pedalboard`. Used by the DAW, Sound Editor,
 * and Live page widgets.
 *
 * Companion auth model is identical to /library — `X-Device-Token` +
 * `X-User-Id`. We reuse `getCompanionLink()` from companion-library.
 */

import "server-only";
import type { CompanionLink } from "./companion-library";

// ─── Types (mirror server/src/plugins/host.ts) ──────────────────────

export interface PluginParameter {
    id: string;
    name: string;
    label?: string;
    type?: string;
    min_value?: number;
    max_value?: number;
    step_size?: number;
    valid_values?: string[];
    string_value?: string;
    raw_value?: number;
    default_raw_value?: number;
}

export interface PluginDescriptor {
    path: string;
    name: string;
    manufacturer: string;
    format: "VST3" | "AU" | "LV2" | "?";
    isInstrument: boolean;
    isEffect: boolean;
    parameters: PluginParameter[];
}

export interface PluginScanResult {
    scannedAt: number;
    inventory: PluginDescriptor[];
    failures: Array<{ path: string; error: string }>;
    roots: string[];
}

export interface PluginChainStep {
    path: string;
    params?: Record<string, number | string | boolean>;
    bypass?: boolean;
}

export interface PluginRenderJobSnapshot {
    id: string;
    stage: "queued" | "render" | "done" | "error";
    progress: number;
    message: string;
    error?: string;
    durationSec?: number;
    startedAt?: number;
    finishedAt?: number;
}

export interface PluginHostStatus {
    inventory: number;
    scannedAt: number | null;
    renders: PluginRenderJobSnapshot[];
}

// ─── Low-level fetch helper ─────────────────────────────────────────

async function call<T>(
    link: CompanionLink,
    method: "GET" | "POST",
    pathAndQuery: string,
    body?: unknown,
    timeoutMs = 60_000,
): Promise<T> {
    const url = `${link.apiUrl}/plugins${pathAndQuery}`;
    const headers: Record<string, string> = {
        "X-Device-Token": link.token,
        "X-User-Id": link.userId,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
    });
    if (!res.ok) {
        let detail = "";
        try { detail = (await res.json()).error ?? ""; } catch { /* ignore */ }
        throw new Error(
            `Companion ${method} /plugins${pathAndQuery} failed (${res.status})${detail ? ": " + detail : ""}`,
        );
    }
    return await res.json() as T;
}

// ─── Public SDK ──────────────────────────────────────────────────────

export const companionPlugins = {
    /** Returns the cached scan result if the companion has scanned at
     *  least once, else `{ cached: null }`. Cheap enough to call on
     *  every plugin-rack render. */
    async list(link: CompanionLink): Promise<{ cached: PluginScanResult | null }> {
        return call(link, "GET", "/");
    },

    /** Triggers a fresh scan. Blocks until completion (set a long
     *  timeout — large libraries can take minutes). For streaming
     *  progress use `scanStream()` from a client component. */
    async scan(link: CompanionLink, paths: string[] = []): Promise<PluginScanResult> {
        return call<PluginScanResult>(
            link,
            "POST",
            "/scan",
            { paths, stream: false },
            10 * 60_000,
        );
    },

    /** Re-introspect a single plugin's parameters. Useful when the
     *  cached parameters are suspected stale or when opening a plugin
     *  the user just installed. */
    async describe(link: CompanionLink, path: string): Promise<PluginDescriptor> {
        return call<PluginDescriptor>(link, "POST", "/describe", { path });
    },

    /** Enqueue an offline render of `input` through `chain`. Returns
     *  the job id; poll `getRender(id)` until `stage === "done"`. */
    async render(
        link: CompanionLink,
        input: string,
        chain: PluginChainStep[],
    ): Promise<{ id: string; stage: string }> {
        return call(link, "POST", "/render", { input, chain });
    },

    async getRender(link: CompanionLink, id: string): Promise<PluginRenderJobSnapshot> {
        return call(link, "GET", `/render/${encodeURIComponent(id)}`);
    },

    /** Build a URL for the rendered audio. Must be fetched with the
     *  device token in headers (same caveat as `companionAnalyzer.stemUrl`). */
    renderAudioUrl(link: CompanionLink, id: string): string {
        return `${link.apiUrl}/plugins/render/${encodeURIComponent(id)}/audio`;
    },

    async status(link: CompanionLink): Promise<PluginHostStatus> {
        return call(link, "GET", "/status");
    },
};
