"use client";

/**
 * useAudioDevices — single source of truth for the device picker UIs.
 *
 * Merges two device universes into one shape:
 *   • Browser MediaDevices (navigator.mediaDevices.enumerateDevices)
 *   • Companion native devices (RtAudio backends — ASIO/WASAPI/CoreAudio/…)
 *     fetched once per session via the public `/audio/native/devices` probe.
 *
 * The hook is intentionally lightweight: results are cached in module scope
 * for the lifetime of the page so opening multiple modals doesn't re-probe.
 * A single `refresh()` call invalidates and re-fetches.
 */

import { useCallback, useEffect, useState } from "react";
import {
    discoverCompanion,
    NativeCompanionClient,
    type NativeDeviceInfo,
} from "@/lib/native-companion";

export interface BrowserDevice {
    deviceId: string;
    label: string;
    groupId: string;
    kind: "audioinput" | "audiooutput";
}

export interface CompanionDeviceGroup {
    /** Backend label, e.g. "WASAPI", "ASIO", "CoreAudio". */
    backend: string;
    /** Devices in this backend that have at least one input channel. */
    inputs: NativeDeviceInfo[];
    /** Devices in this backend that have at least one output channel. */
    outputs: NativeDeviceInfo[];
}

export interface AudioDeviceState {
    browserInputs: BrowserDevice[];
    browserOutputs: BrowserDevice[];
    /** All native input devices, flattened (one row per device). */
    nativeInputs: NativeDeviceInfo[];
    /** All native output devices, flattened. */
    nativeOutputs: NativeDeviceInfo[];
    /** Same data, grouped by backend, suitable for `<optgroup>`. */
    companionGroup: CompanionDeviceGroup | null;
    /** True if a companion is reachable on this machine. */
    nativeAvailable: boolean;
    /** Coarse permission state for browser microphones. */
    permission: "prompt" | "granted" | "denied" | "unsupported";
    loading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
    /** Trigger getUserMedia → unlocks browser device labels. Safe to call again. */
    requestPermission: () => Promise<"granted" | "denied" | "prompt">;
}

interface CacheShape {
    browserInputs: BrowserDevice[];
    browserOutputs: BrowserDevice[];
    nativeInputs: NativeDeviceInfo[];
    nativeOutputs: NativeDeviceInfo[];
    companionGroup: CompanionDeviceGroup | null;
    nativeAvailable: boolean;
    permission: "prompt" | "granted" | "denied" | "unsupported";
}

let cache: CacheShape | null = null;
let inflight: Promise<CacheShape> | null = null;
const subscribers = new Set<(c: CacheShape) => void>();

function emptyCache(): CacheShape {
    return {
        browserInputs: [],
        browserOutputs: [],
        nativeInputs: [],
        nativeOutputs: [],
        companionGroup: null,
        nativeAvailable: false,
        permission: "prompt",
    };
}

async function probePermission(): Promise<"prompt" | "granted" | "denied" | "unsupported"> {
    if (typeof navigator === "undefined" || !navigator.permissions) return "unsupported";
    try {
        const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
        return status.state as "prompt" | "granted" | "denied";
    } catch {
        return "unsupported";
    }
}

async function loadBrowserDevices(): Promise<{ inputs: BrowserDevice[]; outputs: BrowserDevice[] }> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
        return { inputs: [], outputs: [] };
    }
    try {
        const all = await navigator.mediaDevices.enumerateDevices();
        const inputs: BrowserDevice[] = [];
        const outputs: BrowserDevice[] = [];
        for (const d of all) {
            if (d.kind === "audioinput") {
                inputs.push({ deviceId: d.deviceId, label: d.label, groupId: d.groupId, kind: "audioinput" });
            } else if (d.kind === "audiooutput") {
                outputs.push({ deviceId: d.deviceId, label: d.label, groupId: d.groupId, kind: "audiooutput" });
            }
        }
        return { inputs, outputs };
    } catch {
        return { inputs: [], outputs: [] };
    }
}

async function loadNativeDevices(): Promise<{
    available: boolean;
    inputs: NativeDeviceInfo[];
    outputs: NativeDeviceInfo[];
    group: CompanionDeviceGroup | null;
}> {
    try {
        const hit = await discoverCompanion();
        if (!hit) return { available: false, inputs: [], outputs: [], group: null };
        const client = new NativeCompanionClient({ apiUrl: hit.apiUrl });
        const resp = await client.devices("auto");
        const auth = resp.authorized ?? [];
        const hasAuth = auth.length > 0;

        // Newer companion returns `backends: [{ backend, available, devices }]`
        // covering ASIO + WASAPI + … so we can resolve authorizations to their
        // source backend even when "auto" picked a different one. Older builds
        // only return `{ backend, devices }` for whichever backend won "auto"
        // — fall back to that.
        type BackendGroup = { backend: string; devices: NativeDeviceInfo[] };
        const groups: BackendGroup[] = resp.backends && resp.backends.length > 0
            ? resp.backends
                .filter(b => b.available && b.devices.length > 0)
                .map(b => ({ backend: b.backend, devices: b.devices }))
            : [{ backend: resp.backend, devices: resp.devices }];

        // Filter each backend by the user's authorized list. Match on
        // (backend, direction, name) — case-insensitive backend compare since
        // the companion stores lowercase ("wasapi") but listDevices reports
        // mixed case via RtAudio's `getApi()`.
        const sameBackend = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        const isAuthorized = (d: NativeDeviceInfo, dir: "input" | "output", backend: string): boolean => {
            if (!hasAuth) return true;
            return auth.some(a => sameBackend(a.backend, backend) && a.direction === dir && a.name === d.name);
        };

        const inputs: NativeDeviceInfo[] = [];
        const outputs: NativeDeviceInfo[] = [];
        for (const g of groups) {
            for (const d of g.devices) {
                if (d.inputChannels > 0 && isAuthorized(d, "input", g.backend)) inputs.push(d);
                if (d.outputChannels > 0 && isAuthorized(d, "output", g.backend)) outputs.push(d);
            }
        }

        // Pick a representative backend label for the dropdown header: prefer
        // the backend that contributed any visible device, else fall back to
        // the auto-picked one.
        const visibleBackend =
            groups.find(g => g.devices.some(d => inputs.includes(d) || outputs.includes(d)))?.backend
            ?? resp.backend;

        return {
            available: true,
            inputs,
            outputs,
            group: {
                backend: visibleBackend.toUpperCase(),
                inputs,
                outputs,
            },
        };
    } catch {
        return { available: false, inputs: [], outputs: [], group: null };
    }
}

async function loadAll(): Promise<CacheShape> {
    if (inflight) return inflight;
    inflight = (async () => {
        const [perm, browser, native] = await Promise.all([
            probePermission(),
            loadBrowserDevices(),
            loadNativeDevices(),
        ]);
        const next: CacheShape = {
            browserInputs: browser.inputs,
            browserOutputs: browser.outputs,
            nativeInputs: native.inputs,
            nativeOutputs: native.outputs,
            companionGroup: native.group,
            nativeAvailable: native.available,
            permission: perm,
        };
        cache = next;
        for (const sub of subscribers) sub(next);
        return next;
    })();
    try {
        return await inflight;
    } finally {
        inflight = null;
    }
}

export function useAudioDevices(): AudioDeviceState {
    const [state, setState] = useState<CacheShape>(() => cache ?? emptyCache());
    const [loading, setLoading] = useState<boolean>(() => cache === null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        const sub = (c: CacheShape) => { if (alive) setState(c); };
        subscribers.add(sub);
        if (cache === null) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- external subscription / async device enumeration
            setLoading(true);
            loadAll()
                .catch(e => alive && setError(e instanceof Error ? e.message : String(e)))
                .finally(() => alive && setLoading(false));
        } else {
            setState(cache);
        }
        return () => {
            alive = false;
            subscribers.delete(sub);
        };
    }, []);

    // Re-enumerate when devices are hot-plugged.
    useEffect(() => {
        if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
        const handler = () => {
            cache = null;
            inflight = null;
            void loadAll();
        };
        navigator.mediaDevices.addEventListener("devicechange", handler);
        return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
    }, []);

    // Auto-refresh so the companion list reflects reality without the user
    // pressing the refresh button. Two cheap triggers + a discovery poll:
    //   • Window focus / tab becomes visible — cheap, no RtAudio cost
    //     because the server's own enumeration cache absorbs back-to-back
    //     /audio/native/devices calls.
    //   • Periodic poll every 8 s WHILE the companion is unreachable so a
    //     freshly-launched companion is detected promptly. Once we are
    //     connected we STOP polling — every probe forces the server to
    //     re-enumerate RtAudio (a 200–800 ms blocking call per backend on
    //     Windows) which surfaces in the renderer as a UI freeze. The
    //     companion's WebSocket already tells us when the connection drops,
    //     and the OS-level `devicechange` event handles hot-plug.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const trigger = () => {
            cache = null;
            inflight = null;
            void loadAll();
        };
        const onFocus = () => trigger();
        const onVisible = () => { if (document.visibilityState === "visible") trigger(); };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisible);
        // Only poll while we're trying to discover a companion. Once
        // discovered, the WS connection in `NativeCompanionClient` is the
        // source of truth for liveness.
        let id: number | null = null;
        if (!state.nativeAvailable) {
            id = window.setInterval(trigger, 8_000);
        }
        return () => {
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVisible);
            if (id !== null) window.clearInterval(id);
        };
    }, [state.nativeAvailable]);

    const refresh = useCallback(async () => {
        cache = null;
        inflight = null;
        setLoading(true);
        try {
            await loadAll();
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    const requestPermission = useCallback(async (): Promise<"granted" | "denied" | "prompt"> => {
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return "denied";
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // Release the tracks immediately — we only wanted the permission.
            for (const track of stream.getTracks()) track.stop();
            await refresh();
            return "granted";
        } catch (err) {
            const name = (err as { name?: string } | null)?.name;
            return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "prompt";
        }
    }, [refresh]);

    return {
        browserInputs: state.browserInputs,
        browserOutputs: state.browserOutputs,
        nativeInputs: state.nativeInputs,
        nativeOutputs: state.nativeOutputs,
        companionGroup: state.companionGroup,
        nativeAvailable: state.nativeAvailable,
        permission: state.permission,
        loading,
        error,
        refresh,
        requestPermission,
    };
}

/**
 * Encode a native device id into the merged select's string-value scheme.
 * Native ids are namespaced with `native:` so they never collide with
 * browser MediaDeviceInfo.deviceId values.
 */
export function encodeNativeValue(id: number): string {
    return `native:${id}`;
}

/** Returns the numeric native id if `value` encodes one, else null. */
export function decodeNativeValue(value: string | null | undefined): number | null {
    if (!value) return null;
    if (!value.startsWith("native:")) return null;
    const n = parseInt(value.slice("native:".length), 10);
    return Number.isFinite(n) ? n : null;
}

export function isNativeValue(value: string | null | undefined): boolean {
    return !!value && value.startsWith("native:");
}
