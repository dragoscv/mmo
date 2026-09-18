/**
 * Typed view of the `window.mmo` bridge exposed by server/src/preload.ts.
 *
 * The preload is the contract: every method here maps 1:1 to a key in
 * `contextBridge.exposeInMainWorld("mmo", …)`. Payload shapes are derived
 * from the corresponding `ipcMain.handle` implementations in main.ts.
 * Do NOT add methods here that the preload does not expose.
 */

export interface CompanionSettings {
    startAtLogin: boolean;
    closeToTray: boolean;
    startMinimized: boolean;
    telemetryEnabled?: boolean;
    webAppUrl?: string;
    scanFolders?: Array<string | { path: string; watch: boolean }>;
    [key: string]: unknown;
}

export interface CompanionStatus {
    port: number;
    serverError: string | null;
    appVersion: string;
    serverVersion: string | null;
    authenticated: boolean;
    deviceId: string | null;
    deviceName: string | null;
    userName: string | null;
    userEmail: string | null;
    userImage: string | null;
}

export interface AudioDeviceInfo {
    name: string;
    inputChannels: number;
    outputChannels: number;
    preferredSampleRate: number;
    isDefaultInput?: boolean;
    isDefaultOutput?: boolean;
}

export interface AudioBackendGroup {
    backend: string;
    apiName: string;
    available: boolean;
    devices: AudioDeviceInfo[];
}

export interface AuthorizedAudioDevice {
    backend: string;
    direction: "input" | "output";
    name: string;
    preferredSampleRate?: number;
}

export interface AudioInventory {
    backends: AudioBackendGroup[];
    authorized: AuthorizedAudioDevice[];
    initialLoadComplete?: boolean;
    error?: string;
}

export interface NativeEngineMetrics {
    streamLatencyMs?: number;
    streamLatencyFrames?: number;
    dspBlockAvgMs?: number;
    dspBlockMaxMs?: number;
    underruns?: number;
    callbackCount?: number;
    outputBufferDepthMs?: number;
    bufferFlushes?: number;
    inPeak?: number;
    outPeak?: number;
    inRms?: number;
    outRms?: number;
}

export interface NativeEngineSnapshot {
    running: boolean;
    metrics?: NativeEngineMetrics;
    status?: { sampleRate?: number; [key: string]: unknown };
    error?: string;
}

export interface DebugLogSnapshot {
    logFile: string;
    lines: string[];
    env: {
        appVersion: string;
        electron: string;
        node: string;
        platform: string;
        arch: string;
        uptimeSec: number;
        rssMB: number;
    };
}

export type UpdateStatusEvent =
    | { status: "checking" }
    | { status: "current"; version: string }
    | { status: "available"; version: string }
    | { status: "downloading"; percent: number; version?: string }
    | { status: "ready"; version: string }
    | { status: "error"; error?: string };

export interface UpdaterCheckResult {
    ok: boolean;
    version?: string;
    error?: string;
    lastCheckTs?: number | null;
    lastError?: string | null;
}

export interface UpdaterStatus {
    currentVersion: string;
    lastCheckTs: number | null;
    lastError: string | null;
}

export type VATopology = "independent" | "loopback";

export interface VirtualDevice {
    id: string;
    name: string;
    topology: VATopology;
    channels: number;
    sampleRate: number;
    enabled: boolean;
    source: "companion" | "preexisting";
}

export interface DriverProbe {
    available: boolean;
    reason?: string;
    version?: string;
    requiresElevation: boolean;
    supportsRuntimeCreate: boolean;
    maxDevices: number;
}

export type VAResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface MmoBridge {
    getSettings: () => Promise<CompanionSettings>;
    updateSettings: (patch: Partial<CompanionSettings>) => Promise<CompanionSettings>;
    getStatus: () => Promise<CompanionStatus>;
    authenticate: (data: Record<string, unknown>) => Promise<{ success: boolean }>;
    logout: () => Promise<{ success: boolean }>;
    selectFolder: () => Promise<string | null>;
    getVersion: () => Promise<string>;
    openAuthInBrowser: (webAppUrl: string) => Promise<unknown | null>;
    cancelAuth: () => Promise<unknown>;
    getAudioDevices: (opts?: { force?: boolean }) => Promise<AudioInventory>;
    setAuthorizedAudioDevices: (list: AuthorizedAudioDevice[]) => Promise<{ authorized?: AuthorizedAudioDevice[] }>;
    getAudioNativeMetrics: () => Promise<NativeEngineSnapshot>;
    getDebugLog: () => Promise<DebugLogSnapshot>;
    clearDebugLog: () => Promise<{ success: boolean }>;
    killAudioEngine: () => Promise<{ success: boolean; wasRunning: boolean; error?: string }>;
    onAudioDevicesUpdated: (cb: (data: Partial<AudioInventory>) => void) => () => void;
    getTheme: () => Promise<{ dark: boolean; background: string }>;
    onThemeUpdated: (cb: (data: { dark: boolean }) => void) => () => void;
    /** NOTE: the preload does not return an unsubscribe for this one. */
    onUpdateStatus: (cb: (data: UpdateStatusEvent) => void) => void;
    onStatusChanged: (cb: () => void) => () => void;
    onAuthInvalidated: (cb: (data: { reason: string }) => void) => () => void;
    checkForUpdates: () => Promise<UpdaterCheckResult>;
    getUpdaterStatus: () => Promise<UpdaterStatus>;
    installUpdateNow: () => Promise<unknown>;
    va: {
        probe: () => Promise<VAResult<DriverProbe>>;
        install: () => Promise<VAResult<unknown>>;
        uninstall: () => Promise<VAResult<unknown>>;
        list: () => Promise<VAResult<VirtualDevice[]>>;
        create: (opts: { name: string; topology: VATopology; channels?: number; sampleRate?: number }) => Promise<VAResult<VirtualDevice>>;
        rename: (id: string, name: string) => Promise<VAResult<unknown>>;
        setEnabled: (id: string, enabled: boolean) => Promise<VAResult<unknown>>;
        remove: (id: string) => Promise<VAResult<unknown>>;
    };
}

declare global {
    interface Window {
        mmo: MmoBridge;
    }
}

/** The bridge, or `undefined` when the page is opened outside Electron (vite dev in a browser). */
export const mmo: MmoBridge | undefined = typeof window !== "undefined" ? window.mmo : undefined;

/** Throwing accessor for call sites that only run once the bridge is known to exist. */
export function ipc(): MmoBridge {
    if (!mmo) throw new Error("window.mmo bridge is not available (not running inside Electron)");
    return mmo;
}

export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Authorization key for a physical device — (backend, direction, name); RtAudio ids change across reboots. */
export function authKey(d: AuthorizedAudioDevice): string {
    return `${d.backend}::${d.direction}::${d.name}`;
}

export const isMac: boolean =
    typeof navigator !== "undefined" &&
    (/Mac/i.test(navigator.platform) || /Macintosh|Mac OS X/i.test(navigator.userAgent));
