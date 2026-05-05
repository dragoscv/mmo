/**
 * native-engine.ts
 *
 * Cross-platform low-latency audio engine for the MMO Companion.
 * Uses RtAudio (via `audify`) for direct OS audio backend access:
 *   - Windows: WASAPI (shared/exclusive auto), ASIO if present
 *   - macOS:   Core Audio
 *   - Linux:   ALSA, JACK, PulseAudio
 *
 * Input mic frames are routed straight through the PitchDsp module
 * and written to the output device in the SAME thread that RtAudio's
 * native callback runs on. Total round-trip:
 *
 *   input device buffer  +  ~6.7 ms DSP  +  output device buffer
 *
 * On macOS Core Audio with 64-frame buffers @ 48 kHz this is ≈ 5 ms.
 * On Windows WASAPI with 96-frame buffers ≈ 7-9 ms.
 * On Windows ASIO with a Focusrite/UMC interface ≈ 3-5 ms.
 */

import {
    RtAudio,
    RtAudioApi,
    RtAudioFormat,
    RtAudioStreamFlags,
    type RtAudioDeviceInfo,
} from "audify";
import { PitchDsp, type DspStatus, type PitchInfo, type ScaleConfig } from "./pitch-dsp";
import { acquireRealtimeHost, releaseRealtimeHost } from "./realtime-host";
import { NativeFxChain, type NativeFxChainItem } from "./native-fx";

export type AudioBackend = "auto" | "asio" | "wasapi" | "coreaudio" | "alsa" | "jack" | "pulse";

export interface DeviceInfo {
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

export interface BackendInfo {
    backend: AudioBackend;
    apiName: string;
    available: boolean;
}

export interface EngineConfig {
    inputDeviceId?: number;          // omit → default input
    outputDeviceId?: number;         // omit → default output
    sampleRate?: number;             // default 48000
    frameSize?: number;              // default 128 (very low). Use 0 for backend's optimum.
    backend?: AudioBackend;          // default "auto"
    autoCorrect?: boolean;           // start with autocorrect engaged
    formantPreserve?: boolean;
    scale?: ScaleConfig;
    minimizeLatency?: boolean;       // default true (sets RTAUDIO_MINIMIZE_LATENCY)
    realtimeSchedule?: boolean;      // default true (RTAUDIO_SCHEDULE_REALTIME)
    /**
     * Request exclusive access to the audio device (WASAPI exclusive on
     * Windows, kAudioHardwarePropertyHogMode on macOS). Bypasses the OS
     * mixer and shaves ~2 ms off shared-mode latency, at the cost of
     * locking the device so other apps (system sounds, browsers) can't
     * play through it while the engine runs. Default false.
     */
    exclusiveMode?: boolean;
}

export interface EngineMetrics {
    running: boolean;
    backend: string;
    sampleRate: number;
    frameSize: number;
    streamLatencyFrames: number;     // round-trip in frames as reported by RtAudio
    streamLatencyMs: number;
    dspBlockMaxMs: number;           // worst observed DSP CPU time per callback
    dspBlockAvgMs: number;
    underruns: number;
    callbackCount: number;
    /** Negotiated input channel count (1 or 2). */
    inputChannels: number;
    /** Negotiated output channel count (1 or 2). */
    outputChannels: number;
    /** Most recent error from openStream / start / DSP, or null. */
    lastError: string | null;
    /** Real depth of audify's internal output queue, in milliseconds.
     *  This is the *actual* end-to-end latency the user hears — RtAudio's
     *  reported `streamLatency` is the device's hardware buffer only and
     *  ignores the JS-side push queue that grows when input and output
     *  device clocks drift (USB mic + onboard speakers being the classic
     *  case on Windows WASAPI shared mode). */
    outputBufferDepthMs: number;
    /** Number of times the engine has had to flush the output queue to
     *  catch up after drift accumulated past the threshold. Each flush
     *  causes a brief audible glitch but bounds latency. */
    bufferFlushes: number;
    /** Live input peak (0..1, post-EMA decay). Mono engine — same value
     *  for L/R when the UI displays a stereo pair. */
    inPeak: number;
    /** Live output peak (0..1, post-EMA decay). */
    outPeak: number;
    /** Live input RMS (0..1). */
    inRms: number;
    /** Live output RMS (0..1). */
    outRms: number;
}

const FORMAT = RtAudioFormat.RTAUDIO_FLOAT32;
const SAMPLE_BYTES = 4;

function backendToApi(b: AudioBackend): RtAudioApi {
    switch (b) {
        case "asio": return RtAudioApi.WINDOWS_ASIO;
        case "wasapi": return RtAudioApi.WINDOWS_WASAPI;
        case "coreaudio": return RtAudioApi.MACOSX_CORE;
        case "alsa": return RtAudioApi.LINUX_ALSA;
        case "jack": return RtAudioApi.UNIX_JACK;
        case "pulse": return RtAudioApi.LINUX_PULSE;
        case "auto":
        default: return RtAudioApi.UNSPECIFIED;
    }
}

function detectDefaultBackend(): AudioBackend {
    switch (process.platform) {
        case "darwin": return "coreaudio";
        case "win32": return "wasapi";
        case "linux": return "alsa";
        default: return "auto";
    }
}

/** Probe each candidate backend and report whether RtAudio can construct
 *  + lists at least one device. Used by the UI to populate a backend
 *  picker (e.g. show "ASIO" only if user has installed an ASIO driver). */
export function listBackends(): BackendInfo[] {
    return cachedListBackends();
}

// ─── Enumeration cache ─────────────────────────────────────────────
//
// Constructing `new RtAudio(api)` and calling `getDevices()` is a
// SYNCHRONOUS native call that blocks the Node main thread for 200–800 ms
// on Windows (longer for WASAPI than ASIO). When the web app opens the
// /live page React's StrictMode mounts effects twice and the
// /audio/native/devices route used to fan that out into 5 RtAudio
// enumerations per request — 2–4 seconds of main-thread block per call,
// which the renderer surfaces as visible UI freezes.
//
// We dedupe with a tiny TTL cache. Audio device lists don't change at
// sub-second rates; a 60 s TTL is invisible in normal use and the user's
// explicit "Refresh" button can bust the cache via `invalidateAudioInventoryCache`
// when hot-plugging. The OS-level device-change event also busts it.
const CACHE_TTL_MS = 60_000;
let backendsCache: { value: BackendInfo[]; expires: number } | null = null;
const devicesCache = new Map<string, { value: { backend: string; devices: DeviceInfo[] }; expires: number }>();

function cachedListBackends(): BackendInfo[] {
    const now = Date.now();
    if (backendsCache && backendsCache.expires > now) return backendsCache.value;
    const value = enumerateBackends();
    backendsCache = { value, expires: now + CACHE_TTL_MS };
    return value;
}

function enumerateBackends(): BackendInfo[] {
    const candidates: AudioBackend[] = process.platform === "win32"
        ? ["wasapi", "asio"]
        : process.platform === "darwin"
            ? ["coreaudio"]
            : ["alsa", "jack", "pulse"];

    const out: BackendInfo[] = [];
    for (const b of candidates) {
        try {
            const r = new RtAudio(backendToApi(b));
            const apiName = r.getApi();
            const devices = r.getDevices();
            r.closeStream?.();
            out.push({ backend: b, apiName, available: devices.length > 0 });
        } catch {
            out.push({ backend: b, apiName: b, available: false });
        }
    }
    return out;
}

/** Drop the cached enumeration so the next call re-probes RtAudio. The
 *  user's explicit "Refresh" buttons (companion UI + web UI) call this
 *  to pick up hot-plug changes immediately. */
export function invalidateAudioInventoryCache(): void {
    backendsCache = null;
    devicesCache.clear();
}

function mapDevice(d: RtAudioDeviceInfo): DeviceInfo {
    return {
        id: d.id,
        name: d.name,
        inputChannels: d.inputChannels,
        outputChannels: d.outputChannels,
        duplexChannels: d.duplexChannels,
        isDefaultInput: !!d.isDefaultInput,
        isDefaultOutput: !!d.isDefaultOutput,
        sampleRates: d.sampleRates,
        preferredSampleRate: d.preferredSampleRate,
    };
}

export function listDevices(backend: AudioBackend = "auto"): { backend: string; devices: DeviceInfo[] } {
    const now = Date.now();
    const hit = devicesCache.get(backend);
    if (hit && hit.expires > now) return hit.value;
    const r = new RtAudio(backendToApi(backend));
    const devices = r.getDevices().map(mapDevice);
    const value = { backend: r.getApi(), devices };
    devicesCache.set(backend, { value, expires: now + CACHE_TTL_MS });
    // Also cache under the resolved api name so a follow-up call with the
    // explicit backend (e.g. "wasapi") after an "auto" call doesn't re-probe.
    if (backend === "auto") {
        const resolved = value.backend.toLowerCase();
        devicesCache.set(resolved as AudioBackend, { value, expires: now + CACHE_TTL_MS });
    }
    return value;
}

/**
 * Resolve a persisted authorized-device entry (which only stores name +
 * backend + direction since RtAudio's numeric ids change across reboots /
 * hot-plug) to a live numeric device id. Returns null when the device is
 * no longer present on the system.
 */
export function resolveDeviceId(
    backend: AudioBackend,
    direction: "input" | "output",
    name: string,
): number | null {
    try {
        const r = new RtAudio(backendToApi(backend));
        const devices = r.getDevices();
        // Exact match first, then case-insensitive contains as a fallback so
        // minor enumeration differences ("Microphone (USB Audio Device)" vs
        // "Microphone(USB Audio Device)") don't break the lookup.
        const needed = direction === "input"
            ? (d: RtAudioDeviceInfo) => d.inputChannels > 0
            : (d: RtAudioDeviceInfo) => d.outputChannels > 0;
        const exact = devices.find((d) => needed(d) && d.name === name);
        if (exact) return exact.id;
        const lower = name.toLowerCase().trim();
        const fuzzy = devices.find((d) => needed(d) && d.name.toLowerCase().trim() === lower);
        if (fuzzy) return fuzzy.id;
        return null;
    } catch {
        return null;
    }
}

/** Native low-latency audio engine. Single instance per process. */
export class NativeAudioEngine {
    private rt: RtAudio | null = null;
    private dsp: PitchDsp | null = null;
    private cfg: Required<Omit<EngineConfig, "scale" | "inputDeviceId" | "outputDeviceId">> & {
        scale?: ScaleConfig;
        inputDeviceId?: number;
        outputDeviceId?: number;
    };
    private actualFrameSize = 0;
    private actualSampleRate = 0;
    private apiName = "";
    private callbackCount = 0;
    private dspBlockMaxMs = 0;
    private dspBlockAvgMs = 0;
    private dspBlockEMA = 0;
    private underruns = 0;
    private outBuf: Buffer | null = null;
    private inFloat: Float32Array | null = null;
    private outFloat: Float32Array | null = null;
    /** Actual interleaved channel count negotiated with the device. The DSP
     *  always runs on a single mono float buffer; we deinterleave on input
     *  (mean of channels) and duplicate on output. */
    private inChannels = 1;
    private outChannels = 1;
    /** Most recent error from the audio thread or openStream. Surfaced to
     *  the UI through `metrics()` so the user sees something more useful
     *  than "engine running, no audio". */
    private lastErrorMsg: string | null = null;
    /** Output drift bounding. RtAudio's WASAPI duplex path runs input and
     *  output as independent streams with separate sample clocks. When the
     *  clocks differ (USB mic at 44.1k vs onboard speakers at 48k after
     *  the Windows mixer's ASRC), every input callback queues another
     *  frame to output but the output thread drains at a slightly
     *  different rate. Pending = framesQueued - framesPlayed. When this
     *  exceeds `MAX_PENDING_FRAMES` we flush the queue, costing a brief
     *  click but bounding latency at ~10ms instead of letting it grow
     *  into the seconds. */
    private outputFramesQueued = 0;
    private outputFramesPlayed = 0;
    private bufferFlushes = 0;
    /** Counter for the drift-flush hysteresis. The output queue must
     *  exceed the drift threshold for THREE consecutive callbacks before
     *  we actually flush, so a single GC pause or focus-change blip
     *  doesn't produce an audible click. Resets to zero whenever the
     *  queue dips back below threshold. */
    private driftOverCount = 0;

    // Live level tracking. Per-callback we compute peak + sum-of-squares for
    // both input and output buffers, then decay by `LEVEL_DECAY` so the UI
    // sees a smooth meter instead of one-frame spikes. The decay rate is
    // independent of buffer size; ~30 dB/s falloff feels right.
    private inPeakLevel = 0;
    private outPeakLevel = 0;
    private inRmsLevel = 0;
    private outRmsLevel = 0;

    private latestPitch: PitchInfo | null = null;
    private pitchListeners = new Set<(p: PitchInfo) => void>();

    /** Effects chain that runs after PitchDsp on every callback. The
     *  browser pushes its current voice chain into the engine via
     *  POST /audio/native/chain whenever native mode is on; the engine
     *  then mirrors browser-side processing (gate, compressor, EQ,
     *  delay, reverb) at the same low latency as the autotune pass. */
    private fxChain: NativeFxChain | null = null;
    /** Pending chain definition received before the engine is started.
     *  Applied during start() once the sample rate is known. */
    private pendingChainItems: NativeFxChainItem[] | null = null;

    constructor() {
        this.cfg = {
            sampleRate: 48000,
            frameSize: 128,
            backend: detectDefaultBackend(),
            autoCorrect: false,
            formantPreserve: false,
            minimizeLatency: true,
            realtimeSchedule: true,
            exclusiveMode: false,
        };
    }

    isRunning(): boolean {
        return !!(this.rt && this.rt.isStreamRunning());
    }

    start(cfg: EngineConfig = {}): EngineMetrics {
        if (this.isRunning()) this.stop();
        this.lastErrorMsg = null;
        this.outputFramesQueued = 0;
        this.outputFramesPlayed = 0;
        this.bufferFlushes = 0;
        this.driftOverCount = 0;

        this.cfg = {
            sampleRate: cfg.sampleRate ?? 48000,
            frameSize: cfg.frameSize ?? 0,
            backend: cfg.backend ?? detectDefaultBackend(),
            autoCorrect: cfg.autoCorrect ?? false,
            formantPreserve: cfg.formantPreserve ?? false,
            minimizeLatency: cfg.minimizeLatency ?? true,
            realtimeSchedule: cfg.realtimeSchedule ?? true,
            exclusiveMode: cfg.exclusiveMode ?? false,
            inputDeviceId: cfg.inputDeviceId,
            outputDeviceId: cfg.outputDeviceId,
            scale: cfg.scale,
        };

        // Per-backend frame-size auto-pick. Different backends have very
        // different floors for what's stable from a JS callback:
        //
        //   ASIO            — ~64 frames (≈1.3ms) is rock-solid on any
        //                     modern interface; the driver runs in
        //                     kernel-mode and the JS callback is allowed
        //                     to overshoot by a few hundred μs.
        //   WASAPI exclusive — ~128 frames (≈2.7ms) reliably; bypasses
        //                     the OS mixer's 10ms event-driven period.
        //   WASAPI shared    — must match the OS mixer period (10ms ≈ 480
        //                     frames @ 48k). Anything smaller produces
        //                     constant clicks because the JS callback
        //                     races against the Windows mixer's IRP.
        //   Core Audio       — ~64 frames is fine on Apple silicon, 128
        //                     on Intel.
        //   ALSA / PulseAudio — 256 default; PA's resampler eats anything
        //                     finer.
        //
        // The caller can override by passing an explicit non-zero
        // frameSize. We resolve "auto" (0) here, AFTER the device + flags
        // are known so the choice reflects exclusive-mode requests.
        const requestedFrameSize = this.cfg.frameSize;
        if (!requestedFrameSize || requestedFrameSize <= 0) {
            const backend = this.cfg.backend;
            const exclusive = this.cfg.exclusiveMode;
            let pick = 480;
            if (backend === "asio") pick = 64;
            else if (backend === "coreaudio") pick = 128;
            else if (backend === "wasapi") pick = exclusive ? 128 : 480;
            else if (backend === "alsa" || backend === "jack") pick = 256;
            else if (backend === "pulse") pick = 480;
            this.cfg.frameSize = pick;
        }

        const rt = new RtAudio(backendToApi(this.cfg.backend));
        this.rt = rt;

        const inputId = this.cfg.inputDeviceId ?? rt.getDefaultInputDevice();
        const outputId = this.cfg.outputDeviceId ?? rt.getDefaultOutputDevice();

        // Discover real channel counts from the device. WASAPI shared mode
        // refuses mono streams on most hardware (the Windows mix format is
        // stereo float32), so we MUST honor what the device exposes. We cap
        // at 2 channels because the DSP path is mono and we only need a
        // stereo pair on output; routing a 7.1 surround device's full
        // channel set would just waste callback time.
        const devices = rt.getDevices();
        const inDev = devices.find((d) => d.id === inputId);
        const outDev = devices.find((d) => d.id === outputId);
        const inChannels = Math.max(1, Math.min(2, inDev?.inputChannels ?? 1));
        const outChannels = Math.max(1, Math.min(2, outDev?.outputChannels ?? 2));
        this.inChannels = inChannels;
        this.outChannels = outChannels;

        // Honor the device's preferred sample rate when the caller didn't
        // override it explicitly. Mismatching the WASAPI mix format triggers
        // a slow internal resample; matching it removes a whole stage.
        if (cfg.sampleRate == null) {
            const pref = inDev?.preferredSampleRate || outDev?.preferredSampleRate;
            if (pref && pref >= 32000 && pref <= 96000) {
                this.cfg.sampleRate = pref;
            }
        }

        let flags = 0;
        // RTAUDIO_MINIMIZE_LATENCY pushes the backend to its absolute
        // floor. On WASAPI shared this means asking the mixer for a
        // sub-10ms period — which it will refuse and either fall back
        // silently or, worse, accept and then underrun every callback.
        // We only set it when the backend can actually honour it: ASIO,
        // Core Audio, or WASAPI in exclusive mode.
        const lowLatencyBackend =
            this.cfg.backend === "asio" ||
            this.cfg.backend === "coreaudio" ||
            (this.cfg.backend === "wasapi" && this.cfg.exclusiveMode);
        if (this.cfg.minimizeLatency && lowLatencyBackend) {
            flags |= RtAudioStreamFlags.RTAUDIO_MINIMIZE_LATENCY;
        }
        if (this.cfg.realtimeSchedule) flags |= RtAudioStreamFlags.RTAUDIO_SCHEDULE_REALTIME;
        // RTAUDIO_HOG_DEVICE → WASAPI exclusive on Windows, hog mode on
        // macOS, and a no-op on backends that don't support it. Bypassing
        // the OS mixer is the only software-level win still on the table
        // for reducing platform-floor latency, but it locks the device:
        // system sounds, browser tabs and other apps can't play through it
        // while the engine runs. Strictly opt-in.
        if (this.cfg.exclusiveMode) flags |= RtAudioStreamFlags.RTAUDIO_HOG_DEVICE;

        // Allocate scratch buffers. DSP processes mono; the IO buffers are
        // sized for the actual interleaved channel layout.
        const frameSize = this.cfg.frameSize;
        this.inFloat = new Float32Array(frameSize);
        this.outFloat = new Float32Array(frameSize);
        this.outBuf = Buffer.alloc(frameSize * outChannels * SAMPLE_BYTES);

        // Build DSP
        this.dsp = new PitchDsp({ sampleRate: this.cfg.sampleRate });
        if (this.cfg.scale) this.dsp.setScale(this.cfg.scale);
        this.dsp.setFormantPreserve(this.cfg.formantPreserve);
        this.dsp.setBypass(!this.cfg.autoCorrect);
        this.dsp.onPitch = (p) => {
            this.latestPitch = p;
            for (const fn of this.pitchListeners) {
                try { fn(p); } catch { /* listener errors must not poison audio thread */ }
            }
        };

        // Build the FX chain at the negotiated sample rate. If the
        // browser pushed a chain config before start (typical sequence
        // when user already had FX configured before flipping native on),
        // apply it now.
        this.fxChain = new NativeFxChain(this.cfg.sampleRate);
        if (this.pendingChainItems) {
            this.fxChain.setItems(this.pendingChainItems);
            this.pendingChainItems = null;
        }

        const inputCallback = (inputData: Buffer): void => {
            this.callbackCount++;
            const t0 = process.hrtime.bigint();

            const inF = this.inFloat!;
            const outF = this.outFloat!;
            const samples = inF.length;
            const inCh = this.inChannels;
            const outCh = this.outChannels;

            // Deinterleave input into mono. For mono streams this is a
            // straight memcpy; for stereo we average L+R so the DSP has a
            // clean mono signal regardless of how the mic is wired.
            const inView = new Float32Array(
                inputData.buffer,
                inputData.byteOffset,
                inputData.byteLength / SAMPLE_BYTES,
            );
            if (inCh === 1) {
                inF.set(inView.subarray(0, samples));
            } else {
                const inv = 1 / inCh;
                for (let i = 0; i < samples; i++) {
                    let sum = 0;
                    const base = i * inCh;
                    for (let c = 0; c < inCh; c++) sum += inView[base + c];
                    inF[i] = sum * inv;
                }
            }

            try {
                this.dsp!.process(inF, outF);
            } catch (err) {
                outF.set(inF);
                this.underruns++;
                this.lastErrorMsg = `dsp: ${err instanceof Error ? err.message : String(err)}`;
            }

            // Native FX chain (gate, compressor, EQ, delay, reverb …).
            // Runs in-place on outF after the autotune pass so the user
            // gets the same processed sound through the native engine
            // that the browser provides — at native low latency. The
            // chain is owned by the engine; the browser pushes config
            // via POST /audio/native/chain whenever the user edits it.
            if (this.fxChain && this.fxChain.count > 0) {
                try {
                    this.fxChain.process(outF, samples);
                } catch (err) {
                    // Don't underrun on FX errors — just zero this block
                    // and surface the message. The audio thread MUST
                    // never throw out of the native callback.
                    outF.fill(0);
                    this.lastErrorMsg = `fx: ${err instanceof Error ? err.message : String(err)}`;
                }
            }

            // Per-callback peak + RMS for both buffers, then EMA decay so the
            // UI sees a smooth meter instead of one-frame spikes.
            let inPeak = 0;
            let inSum = 0;
            for (let i = 0; i < samples; i++) {
                const v = inF[i];
                const a = v < 0 ? -v : v;
                if (a > inPeak) inPeak = a;
                inSum += v * v;
            }
            const inRms = Math.sqrt(inSum / samples);
            let outPeak = 0;
            let outSum = 0;
            for (let i = 0; i < samples; i++) {
                const v = outF[i];
                const a = v < 0 ? -v : v;
                if (a > outPeak) outPeak = a;
                outSum += v * v;
            }
            const outRms = Math.sqrt(outSum / samples);
            const decay = 0.85;
            this.inPeakLevel = inPeak > this.inPeakLevel ? inPeak : this.inPeakLevel * decay;
            this.outPeakLevel = outPeak > this.outPeakLevel ? outPeak : this.outPeakLevel * decay;
            this.inRmsLevel = this.inRmsLevel * 0.7 + inRms * 0.3;
            this.outRmsLevel = this.outRmsLevel * 0.7 + outRms * 0.3;

            // Interleave mono DSP output into the device's channel layout.
            // Duplicating mono → stereo gives centered playback, which is
            // what users expect from a single-mic vocal path.
            const outBuf = this.outBuf!;
            const outView = new Float32Array(
                outBuf.buffer,
                outBuf.byteOffset,
                outBuf.byteLength / SAMPLE_BYTES,
            );
            if (outCh === 1) {
                outView.set(outF);
            } else {
                for (let i = 0; i < samples; i++) {
                    const v = outF[i];
                    const base = i * outCh;
                    for (let c = 0; c < outCh; c++) outView[base + c] = v;
                }
            }

            // Bound the audify output queue. If it has grown beyond a
            // configured ceiling (drift between input and output device
            // clocks, or scheduling jitter from a focus change / GC
            // pause), flush it before pushing the new frame so latency
            // doesn't accumulate into the seconds.
            //
            // Two safeguards against producing audible clicks every few
            // seconds:
            //
            //   1. The threshold is generous (160ms). USB audio devices
            //      drift relative to one another by 5–30 ms / sec; a
            //      tight threshold means a flush every couple of
            //      seconds, which is exactly what the user reported as
            //      "the sound is choppy". A wider threshold trades a
            //      few extra ms of monitoring latency (still well under
            //      the 100ms speech monitoring budget) for far rarer
            //      glitches.
            //
            //   2. The flush only fires after the queue has been over
            //      threshold for THREE consecutive callbacks. A single
            //      momentary GC pause shouldn't cost the user an
            //      audible click — only a sustained drift trend
            //      should. Three callbacks at 128 samples / 48kHz =
            //      ~8 ms confirmation window, invisible.
            const pending = this.outputFramesQueued - this.outputFramesPlayed;
            const maxPendingFrames = Math.ceil((this.cfg.sampleRate * 160) / 1000);
            if (pending > maxPendingFrames) {
                this.driftOverCount++;
                if (this.driftOverCount >= 3) {
                    try { this.rt?.clearOutputQueue?.(); } catch { /* ignore */ }
                    this.outputFramesQueued = this.outputFramesPlayed;
                    this.bufferFlushes++;
                    this.driftOverCount = 0;
                }
            } else {
                this.driftOverCount = 0;
            }
            this.rt?.write(outBuf);
            this.outputFramesQueued += samples;

            const t1 = process.hrtime.bigint();
            const dtMs = Number(t1 - t0) / 1e6;
            if (dtMs > this.dspBlockMaxMs) this.dspBlockMaxMs = dtMs;
            this.dspBlockEMA = this.dspBlockEMA === 0 ? dtMs : this.dspBlockEMA * 0.95 + dtMs * 0.05;
            this.dspBlockAvgMs = this.dspBlockEMA;
        };

        // Frame-finished callback. Called by audify each time the device
        // consumes a `frameSize`-sized block from the queue. Used to track
        // real output latency for the drift-bounding logic above.
        const outputDoneCallback = (): void => {
            this.outputFramesPlayed += this.actualFrameSize || this.cfg.frameSize;
        };

        const errorCallback = (type: number, msg: string): void => {
            this.lastErrorMsg = `rtaudio[${type}]: ${msg}`;
            // eslint-disable-next-line no-console
            console.warn(`[native-engine] RtAudio error type=${type}: ${msg}`);
        };

        let actualFrameSize: number;
        try {
            actualFrameSize = rt.openStream(
                { deviceId: outputId, nChannels: outChannels, firstChannel: 0 },
                { deviceId: inputId, nChannels: inChannels, firstChannel: 0 },
                FORMAT,
                this.cfg.sampleRate,
                frameSize,
                "MMOCompanion",
                inputCallback,
                outputDoneCallback,
                flags,
                errorCallback,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.lastErrorMsg = `openStream: ${msg} (in=${inputId}/${inChannels}ch, out=${outputId}/${outChannels}ch, sr=${this.cfg.sampleRate})`;
            this.rt = null;
            this.dsp = null;
            throw new Error(this.lastErrorMsg);
        }

        this.actualFrameSize = actualFrameSize;
        this.actualSampleRate = rt.getStreamSampleRate();
        this.apiName = rt.getApi();

        // Re-allocate if backend chose a different frame size (ASIO often does)
        if (actualFrameSize !== frameSize) {
            this.inFloat = new Float32Array(actualFrameSize);
            this.outFloat = new Float32Array(actualFrameSize);
            this.outBuf = Buffer.alloc(actualFrameSize * outChannels * SAMPLE_BYTES);
        }

        try {
            rt.start();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.lastErrorMsg = `start: ${msg}`;
            try { rt.closeStream(); } catch { /* ignore */ }
            this.rt = null;
            this.dsp = null;
            throw new Error(this.lastErrorMsg);
        }

        // Engine is live — pin the host process at HIGH priority and
        // hold a power-save blocker so OS-level sleep/throttling can't
        // glitch the audio. Both are released in stop().
        acquireRealtimeHost();

        return this.metrics();
    }

    stop(): void {
        if (this.rt) {
            try {
                if (this.rt.isStreamRunning()) this.rt.stop();
                if (this.rt.isStreamOpen()) this.rt.closeStream();
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn("[native-engine] stop error:", err);
            }
            this.rt = null;
        }
        this.dsp = null;
        this.latestPitch = null;
        this.inPeakLevel = 0;
        this.outPeakLevel = 0;
        this.inRmsLevel = 0;
        this.outRmsLevel = 0;
        this.outputFramesQueued = 0;
        this.outputFramesPlayed = 0;
        // Drop the FX chain so a subsequent start() doesn't inherit
        // stale delay buffers / reverb tails. The browser pushes the
        // chain again on next start.
        this.fxChain = null;
        // Drop the realtime-host pins so the OS can sleep / throttle
        // normally now that the audio path is idle.
        releaseRealtimeHost();
    }

    setAutoCorrectEnabled(on: boolean): void {
        this.cfg.autoCorrect = on;
        this.dsp?.setBypass(!on);
    }

    /** Replace the FX chain. Idempotent and safe to call repeatedly —
     *  used by the browser to mirror its voice chain into the native
     *  engine while native mode is active. If the engine isn't running
     *  yet, the items are stashed and applied on the next start(). */
    setFxChain(items: NativeFxChainItem[]): void {
        if (this.fxChain) {
            this.fxChain.setItems(items);
        } else {
            this.pendingChainItems = items;
        }
    }

    /** Active FX count for diagnostics. */
    getFxChainCount(): number {
        return this.fxChain?.count ?? 0;
    }

    setScale(scale: ScaleConfig): void {
        this.cfg.scale = scale;
        this.dsp?.setScale(scale);
    }

    setFormantPreserve(on: boolean): void {
        this.cfg.formantPreserve = on;
        this.dsp?.setFormantPreserve(on);
    }

    addPitchListener(fn: (p: PitchInfo) => void): () => void {
        this.pitchListeners.add(fn);
        return () => this.pitchListeners.delete(fn);
    }

    lastPitch(): PitchInfo | null {
        return this.latestPitch;
    }

    lastStatus(): DspStatus | null {
        return this.dsp?.lastStatus() ?? null;
    }

    metrics(): EngineMetrics {
        const sr = this.actualSampleRate || this.cfg.sampleRate;
        const fr = this.actualFrameSize || this.cfg.frameSize;
        const lat = this.rt?.getStreamLatency?.() ?? 0;
        const pending = Math.max(0, this.outputFramesQueued - this.outputFramesPlayed);
        const outputBufferDepthMs = sr > 0 ? (pending / sr) * 1000 : 0;
        return {
            running: this.isRunning(),
            backend: this.apiName,
            sampleRate: sr,
            frameSize: fr,
            streamLatencyFrames: lat,
            streamLatencyMs: sr > 0 ? (lat / sr) * 1000 : 0,
            dspBlockMaxMs: this.dspBlockMaxMs,
            dspBlockAvgMs: this.dspBlockAvgMs,
            underruns: this.underruns,
            callbackCount: this.callbackCount,
            inputChannels: this.inChannels,
            outputChannels: this.outChannels,
            lastError: this.lastErrorMsg,
            outputBufferDepthMs,
            bufferFlushes: this.bufferFlushes,
            inPeak: this.inPeakLevel,
            outPeak: this.outPeakLevel,
            inRms: this.inRmsLevel,
            outRms: this.outRmsLevel,
        };
    }

    resetMetrics(): void {
        this.dspBlockMaxMs = 0;
        this.dspBlockEMA = 0;
        this.dspBlockAvgMs = 0;
        this.underruns = 0;
        this.callbackCount = 0;
    }
}
