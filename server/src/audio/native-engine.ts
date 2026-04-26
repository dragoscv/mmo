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
    const r = new RtAudio(backendToApi(backend));
    const devices = r.getDevices().map(mapDevice);
    return { backend: r.getApi(), devices };
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

    private latestPitch: PitchInfo | null = null;
    private pitchListeners = new Set<(p: PitchInfo) => void>();

    constructor() {
        this.cfg = {
            sampleRate: 48000,
            frameSize: 128,
            backend: detectDefaultBackend(),
            autoCorrect: false,
            formantPreserve: false,
            minimizeLatency: true,
            realtimeSchedule: true,
        };
    }

    isRunning(): boolean {
        return !!(this.rt && this.rt.isStreamRunning());
    }

    start(cfg: EngineConfig = {}): EngineMetrics {
        if (this.isRunning()) this.stop();

        this.cfg = {
            sampleRate: cfg.sampleRate ?? 48000,
            frameSize: cfg.frameSize ?? 128,
            backend: cfg.backend ?? detectDefaultBackend(),
            autoCorrect: cfg.autoCorrect ?? false,
            formantPreserve: cfg.formantPreserve ?? false,
            minimizeLatency: cfg.minimizeLatency ?? true,
            realtimeSchedule: cfg.realtimeSchedule ?? true,
            inputDeviceId: cfg.inputDeviceId,
            outputDeviceId: cfg.outputDeviceId,
            scale: cfg.scale,
        };

        const rt = new RtAudio(backendToApi(this.cfg.backend));
        this.rt = rt;

        const inputId = this.cfg.inputDeviceId ?? rt.getDefaultInputDevice();
        const outputId = this.cfg.outputDeviceId ?? rt.getDefaultOutputDevice();

        let flags = 0;
        if (this.cfg.minimizeLatency) flags |= RtAudioStreamFlags.RTAUDIO_MINIMIZE_LATENCY;
        if (this.cfg.realtimeSchedule) flags |= RtAudioStreamFlags.RTAUDIO_SCHEDULE_REALTIME;

        // Allocate scratch buffers (interleaved, 1 channel mono = same as planar)
        const channels = 1;
        const frameSize = this.cfg.frameSize;
        this.inFloat = new Float32Array(frameSize);
        this.outFloat = new Float32Array(frameSize);
        this.outBuf = Buffer.alloc(frameSize * channels * SAMPLE_BYTES);

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

        const inputCallback = (inputData: Buffer): void => {
            this.callbackCount++;
            const t0 = process.hrtime.bigint();

            // Buffer is FLOAT32 interleaved. For mono channels=1, interleaved
            // and planar are identical layout.
            const inF = this.inFloat!;
            const outF = this.outFloat!;
            const samples = inF.length;

            // Copy raw bytes into our Float32Array view (zero-copy via buffer)
            const inView = new Float32Array(
                inputData.buffer,
                inputData.byteOffset,
                Math.min(samples, inputData.byteLength / SAMPLE_BYTES),
            );
            inF.set(inView.subarray(0, samples));

            try {
                this.dsp!.process(inF, outF);
            } catch (err) {
                // Don't kill the audio thread on a DSP exception.
                outF.set(inF);
                this.underruns++;
            }

            // Write back to output. Same layout (mono).
            const outBuf = this.outBuf!;
            // Float32Array → Buffer (copy)
            const outView = new Float32Array(
                outBuf.buffer,
                outBuf.byteOffset,
                outBuf.byteLength / SAMPLE_BYTES,
            );
            outView.set(outF);
            this.rt?.write(outBuf);

            const t1 = process.hrtime.bigint();
            const dtMs = Number(t1 - t0) / 1e6;
            if (dtMs > this.dspBlockMaxMs) this.dspBlockMaxMs = dtMs;
            this.dspBlockEMA = this.dspBlockEMA === 0 ? dtMs : this.dspBlockEMA * 0.95 + dtMs * 0.05;
            this.dspBlockAvgMs = this.dspBlockEMA;
        };

        const errorCallback = (type: number, msg: string): void => {
            // RtAudio emits warnings for shared-mode buffer changes etc.
            // eslint-disable-next-line no-console
            console.warn(`[native-engine] RtAudio error type=${type}: ${msg}`);
        };

        const actualFrameSize = rt.openStream(
            { deviceId: outputId, nChannels: channels, firstChannel: 0 },
            { deviceId: inputId,  nChannels: channels, firstChannel: 0 },
            FORMAT,
            this.cfg.sampleRate,
            frameSize,
            "MMOCompanion",
            inputCallback,
            null,
            flags,
            errorCallback,
        );

        this.actualFrameSize = actualFrameSize;
        this.actualSampleRate = rt.getStreamSampleRate();
        this.apiName = rt.getApi();

        // Re-allocate if backend chose a different frame size (ASIO often does)
        if (actualFrameSize !== frameSize) {
            this.inFloat = new Float32Array(actualFrameSize);
            this.outFloat = new Float32Array(actualFrameSize);
            this.outBuf = Buffer.alloc(actualFrameSize * channels * SAMPLE_BYTES);
        }

        rt.start();

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
    }

    setAutoCorrectEnabled(on: boolean): void {
        this.cfg.autoCorrect = on;
        this.dsp?.setBypass(!on);
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
