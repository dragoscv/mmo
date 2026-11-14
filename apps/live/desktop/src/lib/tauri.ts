/** Typed wrappers around the Rust commands in src-tauri/src (engine.rs, config.rs, qr.rs). */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DevicesResponse } from "./routing";
import type { RunningInfo } from "./protocol";

export interface EngineConfig {
    host?: string | null;
    input: string;
    output: string;
    rate: number;
    buffer: number;
    inputChannels: number[];
    main: [number, number];
    monitor?: [number, number] | null;
    preset: string;
    lan: boolean;
    port: number;
}

export interface StartResult {
    port: number;
    oscPort: number | null;
    token: string;
    controllerUrl: string;
    performerUrl: string;
    viewerUrl: string;
    lan: boolean;
    info: RunningInfo | null;
}

export interface EngineStatus {
    running: boolean;
    start: StartResult | null;
    lastError: string | null;
}

export interface Settings {
    device: EngineConfig | null;
    lastPreset: string | null;
    lan: boolean;
}

/** One route's declared latency, as `mixai-live-engine routes` reports it. */
export interface RouteTerms {
    input_period_frames: number;
    cushion_frames: number;
    output_period_frames: number;
    declared_ms: number;
}

export interface DeclaredRoute {
    host: string;
    device: string | null;
    terms: RouteTerms;
    /** Where the figure comes from: the driver, Voicemeeter's configuration, or the request. */
    source: "device" | "voicemeeter" | "assumed";
    note: string;
    /** Always null here: a measured round trip needs a loopback (see `measureLatency`). */
    measured_ms: number | null;
}

export interface RoutesResult {
    requested: { rate: number; buffer_frames: number };
    routes: DeclaredRoute[];
}

export interface LatencyResult {
    round_trip_ms: number;
    nominal_ms: number;
    chain_latency_samples?: number;
}

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
        return await invoke<T>(cmd, args);
    } catch (e) {
        throw new Error(errText(e));
    }
}

export const api = {
    listDevices: (host?: string | null) => call<DevicesResponse>("list_devices", { host: host ?? null }),
    startEngine: (config: EngineConfig) => call<StartResult>("start_engine", { config }),
    stopEngine: () => call<void>("stop_engine"),
    engineStatus: () => call<EngineStatus>("engine_status"),
    measureLatency: (config: EngineConfig) => call<LatencyResult>("measure_latency", { config }),
    compareRoutes: (config: EngineConfig) => call<RoutesResult>("compare_routes", { config }),
    fxCatalogue: () => call<unknown>("fx_catalogue"),
    pairingQr: (url: string) => call<string>("pairing_qr", { url }),
    loadSettings: () => call<Settings>("load_settings"),
    saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),
};

export function onEngineExit(cb: (e: { code: number | null; message: string }) => void): Promise<UnlistenFn> {
    return listen<{ code: number | null; message: string }>("engine://exit", (ev) => cb(ev.payload));
}
