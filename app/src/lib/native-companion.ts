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

/**
 * Candidate ports tried by `discoverCompanion()` when probing the local
 * machine. The companion's stored port is user-configurable (older builds
 * defaulted to 9876, current build defaults to 17899). We probe both so
 * users with legacy installs don't have to reconfigure.
 */
export const COMPANION_CANDIDATE_PORTS: readonly number[] = [17899, 9876] as const;
/**
 * Hosts tried in parallel for each port. `127.0.0.1` is required on
 * Windows because Chromium often resolves `localhost` to IPv6 `::1`
 * first, but the companion server binds to IPv4 (`0.0.0.0`) only — so a
 * pure `localhost` probe times out / connection-refuses while the app is
 * actually reachable on `127.0.0.1`.
 */
export const COMPANION_CANDIDATE_HOSTS: readonly string[] = ["127.0.0.1", "localhost"] as const;
const COMPANION_URL_CACHE_KEY = "mmo-companion-url";


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
    /** Smoothed input peak (0..1). Available on companion ≥ 0.5.4. */
    inPeak?: number;
    /** Smoothed output peak (0..1). */
    outPeak?: number;
    /** Smoothed input RMS (0..1). */
    inRms?: number;
    /** Smoothed output RMS (0..1). */
    outRms?: number;
}

/** Realtime audio levels pushed over WS at ~30 Hz while the engine runs. */
export interface NativeLevels {
    inPeak: number;
    outPeak: number;
    inRms: number;
    outRms: number;
}

/** Realtime engine perf snapshot pushed alongside `NativeLevels`. */
export interface NativePerf {
    streamLatencyMs: number;
    dspBlockAvgMs: number;
    dspBlockMaxMs: number;
    underruns: number;
}

/** FX types the native engine implements. Inserts of any other type
 *  are silently dropped server-side when pushed via setFxChain(). The
 *  browser keeps its full effect catalogue and continues running those
 *  in the Web Audio path when native mode is OFF; in native mode they
 *  simply don't take effect. */
export type NativeFxType =
    | "gate"
    | "noiseSuppression"
    | "compressor"
    | "limiter"
    | "eq3"
    | "delay"
    | "reverb";

export interface NativeFxChainItem {
    /** Stable insert id — the engine reuses DSP instances by id when
     *  the type doesn't change, preserving state (delay buffers, comb
     *  histories, envelope followers) across knob tweaks. */
    id: string;
    type: NativeFxType;
    enabled: boolean;
    params: Record<string, number>;
}

export interface NativeStartConfig {
    inputDeviceId?: number;
    outputDeviceId?: number;
    /** Stable name reference resolved server-side at start time. Survives
     *  reboots / hot-plug, unlike RtAudio's numeric ids. When both an id
     *  and a name are provided, the explicit id wins. */
    inputDeviceName?: string;
    inputBackend?: AudioBackend;
    outputDeviceName?: string;
    outputBackend?: AudioBackend;
    sampleRate?: number;
    frameSize?: number;
    backend?: AudioBackend;
    autoCorrect?: boolean;
    formantPreserve?: boolean;
    scale?: { keyIndex: number; intervals: number[] | null; amount?: number };
    minimizeLatency?: boolean;
    realtimeSchedule?: boolean;
    /** Request exclusive access to the audio device (WASAPI exclusive on
     *  Windows). Bypasses the OS mixer; saves ~2 ms. Locks the device. */
    exclusiveMode?: boolean;
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
    timeoutMs = 1500,
): Promise<{ version: string; platform: string; capabilities: string[] } | null> {
    // Bound every probe so a hung TCP connection (firewall, captive
    // portal, half-open companion) can't stall discovery for seconds.
    // Compose the caller's abort signal with our own timeout.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    if (signal) {
        if (signal.aborted) ac.abort();
        else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
        const res = await fetch(`${apiUrl}/audio/native/probe`, {
            signal: ac.signal,
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
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
    }
}

/**
 * Discover a running companion on this machine. Tries (in order):
 *   1. `NEXT_PUBLIC_COMPANION_URL` env override (only that URL)
 *   2. The URL last seen working (cached in localStorage)
 *   3. Each port in `COMPANION_CANDIDATE_PORTS` on http://localhost
 *
 * Returns the working URL + beacon, or null. Persists the winning URL so
 * subsequent page loads short-circuit straight to the right port.
 */
export async function discoverCompanion(
    signal?: AbortSignal,
): Promise<{ apiUrl: string; beacon: { version: string; platform: string; capabilities: string[] } } | null> {
    const tried = new Set<string>();
    // Per-attempt outcomes so the user can paste a single summary into
    // a bug report instead of guessing why discovery failed. Exposed on
    // `window.__mmoCompanionDiscovery` after each run and logged once
    // at the end. Each entry is `{ url, ok, error? }`.
    const report: Array<{ url: string; ok: boolean; error?: string; stage: string }> = [];
    const tryOne = async (apiUrl: string, stage: string) => {
        if (tried.has(apiUrl)) return null;
        tried.add(apiUrl);
        try {
            const beacon = await probeCompanion(apiUrl, signal);
            report.push({ url: apiUrl, ok: !!beacon, stage });
            return beacon ? { apiUrl, beacon } : null;
        } catch (err) {
            report.push({ url: apiUrl, ok: false, error: err instanceof Error ? err.message : String(err), stage });
            return null;
        }
    };

    // 1. Env override wins outright.
    const envUrl = typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_COMPANION_URL : undefined;
    if (envUrl) {
        const hit = await tryOne(envUrl, "env");
        if (hit) { publishDiscoveryReport(report, hit); return hit; }
    }

    // 2. Cached URL from a previous session.
    if (typeof window !== "undefined") {
        try {
            const cached = window.localStorage.getItem(COMPANION_URL_CACHE_KEY);
            if (cached) {
                const hit = await tryOne(cached, "cache");
                if (hit) { publishDiscoveryReport(report, hit); return hit; }
                // Cached URL no longer works — purge it so we don't keep
                // trying it first on every probe (e.g. after the user's
                // OS resolver flips `localhost` from IPv4 to IPv6).
                try { window.localStorage.removeItem(COMPANION_URL_CACHE_KEY); } catch { /* ignore */ }
            }
        } catch { /* localStorage may be unavailable */ }
    }

    // 3. Brute-force the candidate hosts × ports in parallel — first to
    //    answer wins. Probing both 127.0.0.1 AND localhost is REQUIRED on
    //    Windows where Chromium resolves `localhost` to IPv6 `::1` first
    //    while the companion only binds to IPv4 — making the localhost
    //    probe fail even though the app is reachable on 127.0.0.1.
    const candidates: string[] = [];
    for (const host of COMPANION_CANDIDATE_HOSTS) {
        for (const port of COMPANION_CANDIDATE_PORTS) {
            candidates.push(`http://${host}:${port}`);
        }
    }
    const results = await Promise.all(candidates.map((u) => tryOne(u, "loopback")));
    let hit = results.find((r) => r !== null);

    // 4. LAN fallback. If no loopback hit, ask the cloud for the
    //    signed-in user's other companions' self-announced LAN URLs
    //    (tablet on the couch reaching the desktop companion in the
    //    home office). The endpoint is best-effort — silent failure
    //    keeps offline-first browsing working when the cloud is
    //    unreachable.
    if (!hit && typeof window !== "undefined") {
        try {
            const res = await fetch("/api/devices/peers", { cache: "no-store" });
            if (res.ok) {
                const body = (await res.json()) as { peers?: Array<{ lanUrl: string }> };
                const peerUrls = (body.peers ?? [])
                    .map((p) => p.lanUrl)
                    .filter((u): u is string => typeof u === "string" && !!u);
                if (peerUrls.length > 0) {
                    const peerResults = await Promise.all(peerUrls.map((u) => tryOne(u, "lan-peer")));
                    hit = peerResults.find((r) => r !== null);
                }
            }
        } catch { /* offline or unauthenticated — drop through */ }
    }

    if (hit && typeof window !== "undefined") {
        try { window.localStorage.setItem(COMPANION_URL_CACHE_KEY, hit.apiUrl); } catch { /* ignore */ }
    }
    publishDiscoveryReport(report, hit ?? null);
    return hit ?? null;
}

/** Publish the discovery report on window + console for debugging. The
 *  user can paste `window.__mmoCompanionDiscovery` from devtools into a
 *  bug report and we see exactly which candidates were tried, which
 *  failed, and which (if any) succeeded — no guessing. */
function publishDiscoveryReport(
    attempts: Array<{ url: string; ok: boolean; error?: string; stage: string }>,
    hit: { apiUrl: string } | null,
): void {
    if (typeof window === "undefined") return;
    const payload = {
        timestamp: new Date().toISOString(),
        result: hit ? { ok: true, apiUrl: hit.apiUrl } : { ok: false },
        attempts,
    };
    (window as unknown as { __mmoCompanionDiscovery: typeof payload }).__mmoCompanionDiscovery = payload;
    const label = hit ? `[companion] discovered ${hit.apiUrl}` : "[companion] no companion reachable";
    // eslint-disable-next-line no-console
    console.info(label, payload);
}

export class NativeCompanionClient {
    private apiUrl: string;
    private ws: WebSocket | null = null;
    private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private wsClosed = true;
    private pitchListeners = new Set<(p: NativePitch, s: NativeStatus | null) => void>();
    private levelListeners = new Set<(l: NativeLevels, p: NativePerf) => void>();
    private connectionListeners = new Set<(connected: boolean) => void>();
    private syncAppliedListeners = new Set<(entities: ReadonlySet<string>) => void>();

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
        return this.req<{
            backend: string;
            devices: NativeDeviceInfo[];
            /** All supported backends with their devices. Newer companions
             *  return this so the client can match an `authorized` entry
             *  against its source backend (e.g. WASAPI authorizations while
             *  `backend` auto-picked ASIO). Absent on older builds. */
            backends?: Array<{
                backend: string;
                available: boolean;
                devices: NativeDeviceInfo[];
            }>;
            /** Devices the user has authorized in the desktop UI. May be absent
             *  on older companion builds. */
            authorized?: Array<{
                name: string;
                direction: "input" | "output";
                backend: string;
                preferredSampleRate?: number;
            }>;
        }>(
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

    /**
     * Fire-and-forget stop using `navigator.sendBeacon`. Intended for use
     * inside `pagehide` / `beforeunload` handlers, where the regular
     * `stop()` Promise is killed by the page unload before the request
     * actually leaves the renderer (which is exactly the bug that lets
     * sound keep playing after closing or refreshing the tab).
     *
     * `sendBeacon` is the only HTTP transport the browser guarantees to
     * deliver during unload. Returns true on successful queueing; if it
     * returns false the caller has nothing to do — the next companion
     * start request will reset the engine anyway.
     */
    stopBeacon(): boolean {
        if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
            return false;
        }
        try {
            // sendBeacon ignores Content-Type unless we wrap the body in a
            // Blob; an empty body is fine for /audio/native/stop.
            const blob = new Blob([], { type: "application/json" });
            return navigator.sendBeacon(`${this.apiUrl}/audio/native/stop`, blob);
        } catch {
            return false;
        }
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

    /**
     * Replace the engine's FX chain. Mirrors the user's browser voice
     * chain into the native engine so they hear the same processed sound
     * at the lower native latency. Browser-only effect types (chorus,
     * pingPongDelay, vocoderLite, …) are silently dropped server-side;
     * this method always succeeds when the companion is reachable.
     *
     * Items must use STABLE ids — the engine reuses existing FX
     * instances by id when their type doesn't change, preserving DSP
     * state (delay buffers, reverb tails, envelope followers). That's
     * what makes per-knob automation glitch-free.
     */
    setFxChain(items: NativeFxChainItem[]) {
        return this.req<{ success: true; count: number }>("/audio/native/chain", {
            method: "POST",
            body: JSON.stringify({ items }),
        });
    }

    // ── WebSocket telemetry ─────────────────────────────────────────

    connectWs(): void {
        if (this.ws) return;
        this.wsClosed = false;
        const wsUrl = this.apiUrl.replace(/^http/, "ws") + "/ws";
        try {
            const ws = new WebSocket(wsUrl);
            // Receive binary level frames (32 B Float32Array) as ArrayBuffer
            // so we can read them with zero copies and skip JSON.parse on
            // the hot path. The default would give us a Blob, which forces
            // an async .arrayBuffer() round-trip per frame.
            ws.binaryType = "arraybuffer";
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
                // Companion ≥ 0.7.0 ships levels as a 32-byte binary frame:
                //   Float32 [inPeak, outPeak, inRms, outRms,
                //            streamLatencyMs, dspAvgMs, dspMaxMs, underruns]
                // Older companions (< 0.7.0) still send JSON; the string
                // branch below handles both pitch + the old levels shape.
                if (ev.data instanceof ArrayBuffer) {
                    if (ev.data.byteLength < 32) return;
                    const v = new Float32Array(ev.data, 0, 8);
                    const levels: NativeLevels = {
                        inPeak: v[0], outPeak: v[1], inRms: v[2], outRms: v[3],
                    };
                    const perf: NativePerf = {
                        streamLatencyMs: v[4],
                        dspBlockAvgMs: v[5],
                        dspBlockMaxMs: v[6],
                        underruns: v[7],
                    };
                    for (const fn of this.levelListeners) fn(levels, perf);
                    return;
                }
                try {
                    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
                    if (msg && msg.type === "audio.pitch" && msg.pitch) {
                        for (const fn of this.pitchListeners) fn(msg.pitch, msg.status ?? null);
                    } else if (msg && msg.type === "audio.levels" && msg.levels) {
                        const perf: NativePerf = msg.perf ?? {
                            streamLatencyMs: 0, dspBlockAvgMs: 0, dspBlockMaxMs: 0, underruns: 0,
                        };
                        for (const fn of this.levelListeners) fn(msg.levels, perf);
                    } else if (msg && msg.type === "sync:applied" && Array.isArray(msg.entities)) {
                        // Companion finished pulling cloud changes for this
                        // device. Fan out to subscribers (typically a hook
                        // that invalidates affected React Query / SWR keys)
                        // so the UI refreshes without polling.
                        const entities = new Set<string>(msg.entities.map(String));
                        for (const fn of this.syncAppliedListeners) fn(entities);
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

    /** Subscribe to ~30 Hz level + perf snapshots pushed while the engine
     *  is running. Cheap to subscribe; auto-stops when the engine stops. */
    addLevelListener(fn: (l: NativeLevels, p: NativePerf) => void): () => void {
        this.levelListeners.add(fn);
        return () => this.levelListeners.delete(fn);
    }

    addConnectionListener(fn: (connected: boolean) => void): () => void {
        this.connectionListeners.add(fn);
        return () => this.connectionListeners.delete(fn);
    }

    /** Subscribe to `sync:applied` hints broadcast by the companion at
     *  the end of a successful pull tick. The set contains the entity
     *  names (`tracks`, `playlists`, …) that were touched, so callers
     *  can invalidate selectively. */
    addSyncAppliedListener(fn: (entities: ReadonlySet<string>) => void): () => void {
        this.syncAppliedListeners.add(fn);
        return () => this.syncAppliedListeners.delete(fn);
    }
}
