/**
 * native-companion.ts
 *
 * Browser-side client for the MMO Companion's native low-latency audio
 * engine. Talks to the companion's `/audio/native/*` HTTP routes and
 * receives realtime pitch/status events over the existing `/ws`
 * WebSocket.
 *
 * Audio path:
 *   - Mic in goes DIRECTLY into the companion (RtAudio → PitchDsp → speakers)
 *   - Browser owns ZERO audio for the autocorrect path
 *   - Browser only sends control messages (scale, autocorrect on/off, etc.)
 *     and receives pitch/status telemetry for the tuner UI
 *
 * Auth model:
 *   - The /audio/native/* routes are PUBLIC on the companion (no token).
 *   - Security comes from the companion enforcing loopback-only +
 *     Host-header check + Origin-allowlist server-side. The browser
 *     just needs to know the URL.
 *   - Default URL is http://localhost:17899 (the companion's standard
 *     port). Can be overridden via `NEXT_PUBLIC_COMPANION_URL`.
 *
 * Fallback: when `probeCompanion()` fails, the calling code falls back to
 * the Web Audio worklet path in `lib/audio-fx-engine.ts` which still
 * works, just at higher round-trip latency.
 */

export const DEFAULT_COMPANION_PORT = 17899;
export const DEFAULT_COMPANION_URL =
    typeof process !== "undefined" && process.env?.NEXT_PUBLIC_COMPANION_URL
        ? process.env.NEXT_PUBLIC_COMPANION_URL
        : `http://localhost:${DEFAULT_COMPANION_PORT}`;


export type AudioBackend = "auto" | "asio" | "wasapi" | "coreaudio" | "alsa" | "jack" | "pulse";

export interface NativeDeviceInfo {
    id: number;
    name: string;
    inputChannels: number;
    outputChannels: number;
    duplexChannels: number;
    isDefaultInput: boolean;
    isDefaultOutput: boolean;
    sampleRates: number[];
    preferredSampleRate: number;
}

export interface NativeBackendInfo {
    backend: AudioBackend;
    apiName: string;
    available: boolean;
}

export interface NativePitch {
    frequency: number;
    midi: number;
    exactMidi: number;
    confidence: number;
    cents: number;
    rms: number;
}

export interface NativeStatus {
    ratio: number;
    targetRatio: number;
    sourceMidi: number | null;
    targetMidi: number | null;
    rms: number;
}

export interface NativeMetrics {
    running: boolean;
    backend: string;
    sampleRate: number;
    frameSize: number;
    streamLatencyFrames: number;
    streamLatencyMs: number;
    dspBlockMaxMs: number;
    dspBlockAvgMs: number;
    underruns: number;
    callbackCount: number;
}

export interface NativeStartConfig {
    inputDeviceId?: number;
    outputDeviceId?: number;
    sampleRate?: number;
    frameSize?: number;
    backend?: AudioBackend;
    autoCorrect?: boolean;
    formantPreserve?: boolean;
    scale?: { keyIndex: number; intervals: number[] | null; amount?: number };
    minimizeLatency?: boolean;
    realtimeSchedule?: boolean;
}

export interface NativeCompanionCredentials {
    /** Companion base URL. Defaults to `http://localhost:17899`. */
    apiUrl?: string;
}

/** True if a companion is reachable on the given URL. Uses the public
 *  /audio/native/probe endpoint — no token required. Returns the probe
 *  payload (or null if unreachable / not a real companion). */
export async function probeCompanion(
    apiUrl: string = DEFAULT_COMPANION_URL,
    signal?: AbortSignal,
): Promise<{ version: string; platform: string; capabilities: string[] } | null> {
    try {
        const res = await fetch(`${apiUrl}/audio/native/probe`, {
            signal,
            cache: "no-store",
            // No credentials — the route is public localhost-only.
        });
        if (!res.ok) return null;
        const body = await res.json();
        if (body && body.ok && body.product === "MMOCompanion") {
            return {
                version: body.version ?? "",
                platform: body.platform ?? "",
                capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
            };
        }
        return null;
    } catch {
        return null;
    }
}

export class NativeCompanionClient {
    private apiUrl: string;
    private ws: WebSocket | null = null;
    private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private wsClosed = true;
    private pitchListeners = new Set<(p: NativePitch, s: NativeStatus | null) => void>();
    private connectionListeners = new Set<(connected: boolean) => void>();

    constructor(creds: NativeCompanionCredentials = {}) {
        this.apiUrl = creds.apiUrl ?? DEFAULT_COMPANION_URL;
    }

    private async req<T = unknown>(path: string, init?: RequestInit): Promise<T> {
        const res = await fetch(`${this.apiUrl}${path}`, {
            ...init,
            headers: {
                "Content-Type": "application/json",
                ...(init?.headers ?? {}),
            },
            cache: "no-store",
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`${res.status} ${res.statusText}: ${text}`);
        }
        return (await res.json()) as T;
    }

    // ── Discovery ───────────────────────────────────────────────────

    info() {
        return this.req<{
            supported: boolean;
            platform: string;
            backends: NativeBackendInfo[];
            running: boolean;
            metrics: NativeMetrics;
        }>("/audio/native/info");
    }

    devices(backend: AudioBackend = "auto") {
        return this.req<{ backend: string; devices: NativeDeviceInfo[] }>(
            `/audio/native/devices?backend=${encodeURIComponent(backend)}`,
        );
    }

    // ── Lifecycle ───────────────────────────────────────────────────

    start(cfg: NativeStartConfig = {}) {
        return this.req<{ success: true; metrics: NativeMetrics }>("/audio/native/start", {
            method: "POST",
            body: JSON.stringify(cfg),
        });
    }

    stop() {
        return this.req<{ success: true }>("/audio/native/stop", { method: "POST" });
    }

    metrics() {
        return this.req<{
            running: boolean;
            metrics: NativeMetrics;
            status: NativeStatus | null;
            lastPitch: NativePitch | null;
        }>("/audio/native/metrics");
    }

    // ── Control ─────────────────────────────────────────────────────

    setScale(scale: { keyIndex: number; intervals: number[] | null; amount?: number }) {
        return this.req<{ success: true }>("/audio/native/scale", {
            method: "POST",
            body: JSON.stringify(scale),
        });
    }

    setAutoCorrect(opts: { enabled?: boolean; formantPreserve?: boolean }) {
        return this.req<{ success: true }>("/audio/native/autocorrect", {
            method: "POST",
            body: JSON.stringify(opts),
        });
    }

    // ── WebSocket telemetry ─────────────────────────────────────────

    connectWs(): void {
        if (this.ws) return;
        this.wsClosed = false;
        const wsUrl = this.apiUrl.replace(/^http/, "ws") + "/ws";
        try {
            const ws = new WebSocket(wsUrl);
            this.ws = ws;
            ws.onopen = () => {
                for (const fn of this.connectionListeners) fn(true);
            };
            ws.onclose = () => {
                this.ws = null;
                for (const fn of this.connectionListeners) fn(false);
                if (!this.wsClosed) {
                    this.wsReconnectTimer = setTimeout(() => this.connectWs(), 2000);
                }
            };
            ws.onerror = () => { /* close handler does the cleanup */ };
            ws.onmessage = (ev) => {
                try {
                    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
                    if (msg && msg.type === "audio.pitch" && msg.pitch) {
                        for (const fn of this.pitchListeners) fn(msg.pitch, msg.status ?? null);
                    }
                } catch { /* ignore malformed */ }
            };
        } catch {
            this.ws = null;
            if (!this.wsClosed) {
                this.wsReconnectTimer = setTimeout(() => this.connectWs(), 2000);
            }
        }
    }

    disconnectWs(): void {
        this.wsClosed = true;
        if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
        }
    }

    addPitchListener(fn: (p: NativePitch, s: NativeStatus | null) => void): () => void {
        this.pitchListeners.add(fn);
        return () => this.pitchListeners.delete(fn);
    }

    addConnectionListener(fn: (connected: boolean) => void): () => void {
        this.connectionListeners.add(fn);
        return () => this.connectionListeners.delete(fn);
    }
}
