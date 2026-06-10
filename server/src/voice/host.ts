/**
 * Voice-cloning host (companion side).
 *
 * Owns the long-lived Python sidecar (`server/python/voice_clone.py`)
 * that hosts XTTS-v2 (and optionally F5-TTS). Models stay resident in
 * RAM across requests so each inference is real-time instead of the
 * ~10s cold-start a one-shot spawn would cost.
 *
 * Filesystem layout (under <userData>/voices/):
 *   <voiceId>/
 *     meta.json           ← {id, name, engine, language, createdAt, samples:[...]}
 *     reference.wav       ← 6–10s mono 16k WAV used for cloning
 *     samples/<n>.wav     ← raw clips uploaded by the user (kept for re-training)
 *     renders/<id>.wav    ← cached synthesis outputs served via HTTP
 *
 * The Express layer (server/src/voice/router.ts) writes/reads voices
 * and asks this host for inference. This file knows nothing about HTTP.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { app } from "electron";
import { log } from "../lib/logger";
import { FFMPEG_BIN } from "../library/ffmpeg-paths";
import { Sidecar, type SidecarProgress } from "./sidecar";
import { gpuSerial } from "./gpu-serial";

// ─── Types ───────────────────────────────────────────────────────────

export type VoiceEngine = "xtts" | "f5";

export interface VoiceMeta {
    id: string;
    name: string;
    engine: VoiceEngine;
    language: string;
    /** Sample paths (relative to the voice dir) preserved for re-training. */
    samples: string[];
    /** Optional speaker notes written by the wizard (range, accent, gender). */
    notes?: string;
    createdAt: number;
    updatedAt: number;
}

export interface VoiceMelodyNote {
    beat: number;
    durationBeats: number;
    midiPitch: number;
}

export interface SynthesizeOptions {
    voiceId: string;
    text: string;
    engine?: VoiceEngine;
    language?: string;
    speed?: number;
}

export interface SingOptions extends SynthesizeOptions {
    tempo: number;
    melody: VoiceMelodyNote[];
    /** When true (default) the sing pipeline applies vibrato, polished
     *  attack/release, breath inserts, and a de-esser to the rendered
     *  vocal. Disable to audition the dry per-note synth. */
    polish?: boolean;
    vibratoCents?: number;
    vibratoRateHz?: number;
}

export interface SynthesisResult {
    /** Render id — output file lives at `<voiceDir>/renders/<renderId>.wav`. */
    renderId: string;
    path: string;
    durationSec: number;
    sampleRate: number;
    engine: VoiceEngine;
    language?: string;
}

export interface VoiceHealth {
    engines: { xtts: boolean; f5: boolean };
    languages: string[];
    romanianFallback: string;
    sidecarReady: boolean;
    pendingJobs: number;
}

type ProgressFn = (p: SidecarProgress) => void;

// ─── Singleton ──────────────────────────────────────────

class VoiceHost extends EventEmitter {
    private sidecar: Sidecar | null = null;
    private health: VoiceHealth | null = null;

    private voicesRoot(): string {
        const base = (() => {
            try { return app.getPath("userData"); } catch { return process.cwd(); }
        })();
        const root = path.join(base, "voices");
        if (!existsSync(root)) mkdirSync(root, { recursive: true });
        return root;
    }

    voiceDir(voiceId: string): string {
        if (!/^[A-Za-z0-9_-]+$/.test(voiceId)) {
            throw new Error(`invalid voiceId: ${voiceId}`);
        }
        return path.join(this.voicesRoot(), voiceId);
    }

    private stagingDir(): string {
        const dir = path.join(this.voicesRoot(), ".staging");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return dir;
    }

    /** Shared scratch dir for Demucs/ACE-Step outputs (alongside voices/). */
    stemsRoot(): string {
        const dir = path.join(this.voicesRoot(), ".stems");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return dir;
    }

    /** Root of trained ACE-Step LoRA checkpoints. Layout:
     *    <lorasRoot>/<expName>/ckpts/*.ckpt
     *  Populated by scripts/train-acestep-lora.ps1. */
    lorasRoot(): string {
        const dir = path.join(this.voicesRoot(), "..", "lora-training", "exps");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return dir;
    }

    /** Root of trained RVC v2 voice-conversion models. Layout:
     *    <rvcModelsRoot>/<modelId>/{model.pth, added_*.index?}
     *  Users drop trained models in here. */
    rvcModelsRoot(): string {
        const dir = path.join(this.voicesRoot(), ".rvc-models");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return dir;
    }

    /** Persist a raw upload to the staging area and return a stable id
     *  the client can later pass to `createVoiceFromStaged`. Stale
     *  staged files older than 1h are GC'd whenever this is called. */
    stageSample(buffer: Buffer, filename?: string): { stagedId: string; bytes: number } {
        this.gcStaging();
        const stagedId = `s-${randomUUID()}`;
        const ext = (filename?.split(".").pop() || "wav").toLowerCase().replace(/[^a-z0-9]/g, "") || "wav";
        const p = path.join(this.stagingDir(), `${stagedId}.${ext}`);
        writeFileSync(p, buffer);
        return { stagedId, bytes: buffer.length };
    }

    /** Resolve a staged sample id back to its absolute path on disk.
     *  Returns null if the id is malformed or the file has been GC'd. */
    stagedSamplePath(stagedId: string): string | null {
        return this.resolveStaged(stagedId);
    }

    private resolveStaged(stagedId: string): string | null {
        if (!/^s-[A-Za-z0-9-]+$/.test(stagedId)) return null;
        const dir = this.stagingDir();
        for (const f of readdirSync(dir)) {
            if (f.startsWith(`${stagedId}.`)) return path.join(dir, f);
        }
        return null;
    }

    private gcStaging(): void {
        const dir = this.stagingDir();
        const cutoff = Date.now() - 60 * 60_000;
        try {
            for (const f of readdirSync(dir)) {
                const p = path.join(dir, f);
                try {
                    const st = statSync(p);
                    if (st.mtimeMs < cutoff) unlinkSync(p);
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }

    private metaPath(voiceId: string): string {
        return path.join(this.voiceDir(voiceId), "meta.json");
    }

    private rendersDir(voiceId: string): string {
        const dir = path.join(this.voiceDir(voiceId), "renders");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return dir;
    }

    // ─── Voice CRUD ─────────────────────────────────────────────────

    listVoices(): VoiceMeta[] {
        const root = this.voicesRoot();
        if (!existsSync(root)) return [];
        const voices: VoiceMeta[] = [];
        for (const name of readdirSync(root)) {
            const metaP = path.join(root, name, "meta.json");
            if (!existsSync(metaP)) continue;
            try {
                const meta = JSON.parse(readFileSync(metaP, "utf8")) as VoiceMeta;
                voices.push(meta);
            } catch {
                // skip corrupt
            }
        }
        return voices.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    getVoice(voiceId: string): VoiceMeta | null {
        const metaP = this.metaPath(voiceId);
        if (!existsSync(metaP)) return null;
        try {
            return JSON.parse(readFileSync(metaP, "utf8")) as VoiceMeta;
        } catch {
            return null;
        }
    }

    referencePath(voiceId: string): string {
        return path.join(this.voiceDir(voiceId), "reference.wav");
    }

    // Browser MediaRecorder dumps WebM/Opus with a .wav extension, which
    // soundfile/torchaudio refuse to parse ("Format not recognised"). We
    // transcode the first sample to true 24kHz mono 16-bit PCM WAV so the
    // Python side gets a clean file and skips per-preview ffmpeg fallback.
    // Falls back to writing the raw bytes if ffmpeg isn't available.
    private writeReferenceFromBuffer(voiceId: string, src: Buffer): void {
        const dest = this.referencePath(voiceId);
        mkdirSync(path.dirname(dest), { recursive: true });
        try {
            const r = spawnSync(
                FFMPEG_BIN,
                ["-hide_banner", "-loglevel", "error", "-y", "-i", "pipe:0", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-f", "wav", dest],
                { input: src, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
            );
            if (r.status !== 0 || !existsSync(dest) || statSync(dest).size < 44) {
                throw new Error(`ffmpeg exit=${r.status} ${r.stderr?.toString().slice(0, 200) ?? ""}`);
            }
        } catch (e) {
            log.warn("voice.reference.transcode-failed", { err: e instanceof Error ? e.message : String(e) });
            writeFileSync(dest, src);
        }
    }

    /**
     * Create a new voice from one or more uploaded WAV samples.
     * The first sample is used as the canonical `reference.wav` (XTTS
     * works best with 6–10s of clean speech). All samples are kept
     * under `samples/` for re-training.
     *
     * Returns the new voice meta.
     */
    createVoiceFromStaged(input: {
        name: string;
        engine: VoiceEngine;
        language: string;
        stagedIds: string[];
        notes?: string;
    }): VoiceMeta {
        if (!input.stagedIds.length) throw new Error("at-least-one-sample-required");
        const samples: Array<{ buffer: Buffer; filename?: string }> = [];
        for (const sid of input.stagedIds) {
            const p = this.resolveStaged(sid);
            if (!p) throw new Error(`staged-sample-missing: ${sid}`);
            samples.push({ buffer: readFileSync(p), filename: path.basename(p) });
        }
        const meta = this.createVoice({
            name: input.name,
            engine: input.engine,
            language: input.language,
            samples,
            notes: input.notes,
        });
        for (const sid of input.stagedIds) {
            const p = this.resolveStaged(sid);
            if (p) try { unlinkSync(p); } catch { /* ignore */ }
        }
        return meta;
    }

    appendStagedSamples(voiceId: string, stagedIds: string[]): VoiceMeta {
        const samples: Array<{ buffer: Buffer; filename?: string }> = [];
        for (const sid of stagedIds) {
            const p = this.resolveStaged(sid);
            if (!p) throw new Error(`staged-sample-missing: ${sid}`);
            samples.push({ buffer: readFileSync(p), filename: path.basename(p) });
        }
        const meta = this.addSamples(voiceId, samples);
        for (const sid of stagedIds) {
            const p = this.resolveStaged(sid);
            if (p) try { unlinkSync(p); } catch { /* ignore */ }
        }
        return meta;
    }

    createVoice(input: {
        name: string;
        engine: VoiceEngine;
        language: string;
        samples: Array<{ buffer: Buffer; filename?: string }>;
        notes?: string;
    }): VoiceMeta {
        if (!input.samples.length) throw new Error("at-least-one-sample-required");
        const voiceId = `v-${randomUUID()}`;
        const dir = this.voiceDir(voiceId);
        const samplesDir = path.join(dir, "samples");
        mkdirSync(samplesDir, { recursive: true });

        const sampleRelPaths: string[] = [];
        for (let i = 0; i < input.samples.length; i++) {
            const ext = (input.samples[i].filename?.split(".").pop() || "wav").toLowerCase();
            const rel = path.join("samples", `${i.toString().padStart(2, "0")}.${ext}`);
            writeFileSync(path.join(dir, rel), input.samples[i].buffer);
            sampleRelPaths.push(rel);
        }
        // Reference = first sample, transcoded to true 24kHz mono PCM WAV.
        // The router can call updateReference() later if the user picks a
        // different one in the wizard.
        this.writeReferenceFromBuffer(voiceId, input.samples[0].buffer);

        const now = Date.now();
        const meta: VoiceMeta = {
            id: voiceId,
            name: input.name.trim() || "Untitled voice",
            engine: input.engine,
            language: input.language || "en",
            samples: sampleRelPaths,
            notes: input.notes,
            createdAt: now,
            updatedAt: now,
        };
        writeFileSync(this.metaPath(voiceId), JSON.stringify(meta, null, 2), "utf8");
        return meta;
    }

    /** Replace `reference.wav` with one of the existing samples. */
    setReference(voiceId: string, sampleIndex: number): VoiceMeta {
        const meta = this.getVoice(voiceId);
        if (!meta) throw new Error("voice-not-found");
        if (sampleIndex < 0 || sampleIndex >= meta.samples.length) {
            throw new Error("sample-index-out-of-range");
        }
        const src = path.join(this.voiceDir(voiceId), meta.samples[sampleIndex]);
        if (!existsSync(src)) throw new Error("sample-file-missing");
        this.writeReferenceFromBuffer(voiceId, readFileSync(src));
        meta.updatedAt = Date.now();
        writeFileSync(this.metaPath(voiceId), JSON.stringify(meta, null, 2), "utf8");
        return meta;
    }

    /** Append additional samples to an existing voice. */
    addSamples(voiceId: string, samples: Array<{ buffer: Buffer; filename?: string }>): VoiceMeta {
        const meta = this.getVoice(voiceId);
        if (!meta) throw new Error("voice-not-found");
        const dir = this.voiceDir(voiceId);
        const samplesDir = path.join(dir, "samples");
        mkdirSync(samplesDir, { recursive: true });
        const start = meta.samples.length;
        for (let i = 0; i < samples.length; i++) {
            const ext = (samples[i].filename?.split(".").pop() || "wav").toLowerCase();
            const rel = path.join("samples", `${(start + i).toString().padStart(2, "0")}.${ext}`);
            writeFileSync(path.join(dir, rel), samples[i].buffer);
            meta.samples.push(rel);
        }
        meta.updatedAt = Date.now();
        writeFileSync(this.metaPath(voiceId), JSON.stringify(meta, null, 2), "utf8");
        return meta;
    }

    renameVoice(voiceId: string, name: string): VoiceMeta {
        const meta = this.getVoice(voiceId);
        if (!meta) throw new Error("voice-not-found");
        meta.name = name.trim() || meta.name;
        meta.updatedAt = Date.now();
        writeFileSync(this.metaPath(voiceId), JSON.stringify(meta, null, 2), "utf8");
        return meta;
    }

    deleteVoice(voiceId: string): void {
        const dir = this.voiceDir(voiceId);
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    renderOutputPath(voiceId: string, renderId: string): string | null {
        if (!/^[A-Za-z0-9_-]+$/.test(renderId)) return null;
        const p = path.join(this.rendersDir(voiceId), `${renderId}.wav`);
        return existsSync(p) ? p : null;
    }

    referenceFilePath(voiceId: string): string | null {
        const p = this.referencePath(voiceId);
        return existsSync(p) ? p : null;
    }

    // ─── Sidecar lifecycle (delegated to ./sidecar.ts) ──────────────

    private scriptPath(): string {
        const candidates = [
            path.join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? "", "python", "voice_clone.py"),
            path.join(__dirname, "..", "..", "python", "voice_clone.py"),
            path.join(process.cwd(), "python", "voice_clone.py"),
        ];
        return candidates.find((c) => c && existsSync(c)) ?? candidates[candidates.length - 1];
    }

    private getSidecar(): Sidecar {
        if (this.sidecar) return this.sidecar;
        const sc = new Sidecar({
            name: "voice",
            scriptPath: this.scriptPath(),
            // COQUI_TOS_AGREED auto-accepts XTTS-v2's non-commercial prompt
            // (we're cloning the user's own voice). PYTHONIOENCODING=utf-8
            // is required on Windows so non-ASCII transcripts survive the
            // NDJSON hop where the default codepage is cp1252.
            env: { COQUI_TOS_AGREED: "1", PYTHONIOENCODING: "utf-8" },
            // Heavy GPU sidecar (XTTS ~1.8 GB + F5 ~1.3 GB + Whisper ~500 MB).
            // Evict after 5 min of idleness so VRAM goes back to the GPU for
            // ACE-Step / Demucs / RVC. Reload cost is ~10–15 s, paid once.
            idleEvictMs: 300_000,
        });
        sc.on("hello", (evt: Record<string, unknown>) => {
            this.health = {
                engines: (evt.engines as VoiceHealth["engines"]) ?? { xtts: false, f5: false },
                languages: (evt.languages as string[]) ?? [],
                romanianFallback: (evt.romanianFallback as string) ?? "it",
                sidecarReady: true,
                pendingJobs: 0,
            };
        });
        sc.on("exit", () => {
            // Force a fresh Sidecar on the next ensure-call so re-spawn paths
            // (dev script-restart, crash recovery) get a clean instance.
            this.sidecar = null;
        });
        this.sidecar = sc;
        return sc;
    }

    private async sendCommand(
        payload: Record<string, unknown>,
        timeoutMs: number,
        onProgress?: ProgressFn,
    ): Promise<Record<string, unknown>> {
        const sc = this.getSidecar();
        const { kind, ...args } = payload as { kind?: string } & Record<string, unknown>;
        if (!kind) throw new Error("voice-command-missing-kind");
        // Heavy GPU kinds share the single-GPU mutex with ace-step/demucs/rvc
        // so we never have two sidecars allocating CUDA memory at once.
        // Cheap kinds (ping, voice.health) bypass it.
        const heavy = kind === "voice.synthesize" || kind === "voice.sing"
            || kind === "voice.analyze" || kind === "voice.pitch-coverage";
        if (!heavy) return sc.send(kind, args, timeoutMs, onProgress);
        return gpuSerial.run(`voice:${kind}`, () => sc.send(kind, args, timeoutMs, onProgress));
    }

    async getHealth(): Promise<VoiceHealth> {
        const sc = this.getSidecar();
        try {
            await sc.ready();
        } catch {
            return {
                engines: { xtts: false, f5: false },
                languages: [],
                romanianFallback: "it",
                sidecarReady: false,
                pendingJobs: sc.pendingCount,
            };
        }
        const live = this.health ?? {
            engines: { xtts: false, f5: false },
            languages: [],
            romanianFallback: "it",
            sidecarReady: sc.isReady,
            pendingJobs: 0,
        };
        return { ...live, sidecarReady: sc.isReady, pendingJobs: sc.pendingCount };
    }

    // ─── Inference ──────────────────────────────────────────────────

    async synthesize(opts: SynthesizeOptions, onProgress?: ProgressFn): Promise<SynthesisResult> {
        const meta = this.getVoice(opts.voiceId);
        if (!meta) throw new Error("voice-not-found");
        const reference = this.referencePath(opts.voiceId);
        if (!existsSync(reference)) throw new Error("voice-reference-missing");
        const renderId = randomUUID();
        const outPath = path.join(this.rendersDir(opts.voiceId), `${renderId}.wav`);
        const engine = opts.engine ?? meta.engine;
        const language = opts.language ?? meta.language ?? "en";
        const data = await this.sendCommand({
            kind: "voice.synthesize",
            engine,
            referencePath: reference,
            text: opts.text,
            language,
            speed: opts.speed ?? 1.0,
            outPath,
        }, 120_000, onProgress);
        return {
            renderId,
            path: outPath,
            durationSec: Number(data.durationSec ?? 0),
            sampleRate: Number(data.sampleRate ?? 24000),
            engine,
            language: String(data.language ?? language),
        };
    }

    async sing(opts: SingOptions, onProgress?: ProgressFn): Promise<SynthesisResult> {
        const meta = this.getVoice(opts.voiceId);
        if (!meta) throw new Error("voice-not-found");
        const reference = this.referencePath(opts.voiceId);
        if (!existsSync(reference)) throw new Error("voice-reference-missing");
        if (!opts.melody.length) throw new Error("empty-melody");
        const renderId = randomUUID();
        const outPath = path.join(this.rendersDir(opts.voiceId), `${renderId}.wav`);
        const engine = opts.engine ?? meta.engine;
        const language = opts.language ?? meta.language ?? "en";
        // Singing is N synth calls + N pitch/time shifts. Budget liberally
        // so a 32-bar verse doesn't time out on CPU-only machines.
        const timeout = Math.max(180_000, opts.melody.length * 8_000);
        const data = await this.sendCommand({
            kind: "voice.sing",
            engine,
            referencePath: reference,
            text: opts.text,
            language,
            tempo: opts.tempo,
            melody: opts.melody,
            polish: opts.polish !== false,
            vibratoCents: typeof opts.vibratoCents === "number" ? opts.vibratoCents : 22.0,
            vibratoRateHz: typeof opts.vibratoRateHz === "number" ? opts.vibratoRateHz : 5.2,
            outPath,
        }, timeout, onProgress);
        return {
            renderId,
            path: outPath,
            durationSec: Number(data.durationSec ?? 0),
            sampleRate: Number(data.sampleRate ?? 24000),
            engine,
            language,
        };
    }

    // ─── Sample analysis (training coach) ───────────────────────────

    async analyzeStagedSample(opts: {
        stagedId: string;
        expectedText?: string;
        language?: string;
        intent?: string;
    }, onProgress?: ProgressFn): Promise<Record<string, unknown>> {
        const audioPath = this.resolveStaged(opts.stagedId);
        if (!audioPath) throw new Error("staged-clip-not-found");
        return await this.sendCommand({
            kind: "voice.analyze",
            audioPath,
            expectedText: opts.expectedText ?? "",
            language: opts.language ?? "",
            intent: opts.intent ?? "",
        }, 60_000, onProgress);
    }

    async analyzeVoiceSample(opts: {
        voiceId: string;
        sampleIndex: number;
        expectedText?: string;
        language?: string;
        intent?: string;
    }, onProgress?: ProgressFn): Promise<Record<string, unknown>> {
        const meta = this.getVoice(opts.voiceId);
        if (!meta) throw new Error("voice-not-found");
        if (opts.sampleIndex < 0 || opts.sampleIndex >= meta.samples.length) {
            throw new Error("sample-not-found");
        }
        const audioPath = path.join(this.voiceDir(opts.voiceId), meta.samples[opts.sampleIndex]);
        return await this.sendCommand({
            kind: "voice.analyze",
            audioPath,
            expectedText: opts.expectedText ?? "",
            language: opts.language ?? meta.language ?? "",
            intent: opts.intent ?? "",
        }, 60_000, onProgress);
    }

    /** Aggregate f0 across N staged or saved clips into a per-semitone
     *  coverage histogram. The wizard uses this to coach the user toward
     *  pitches they haven't recorded enough of yet. */
    async analyzePitchCoverage(opts: {
        stagedIds?: string[];
        voiceId?: string;
    }, onProgress?: ProgressFn): Promise<Record<string, unknown>> {
        const audioPaths: string[] = [];
        for (const sid of opts.stagedIds ?? []) {
            const p = this.resolveStaged(sid);
            if (p) audioPaths.push(p);
        }
        if (opts.voiceId) {
            const meta = this.getVoice(opts.voiceId);
            if (meta) {
                const dir = this.voiceDir(opts.voiceId);
                for (const s of meta.samples) audioPaths.push(path.join(dir, s));
            }
        }
        if (!audioPaths.length) throw new Error("no-audio-paths");
        return await this.sendCommand({
            kind: "voice.pitch-coverage",
            audioPaths,
        }, 120_000, onProgress);
    }

    shutdown() {
        if (this.sidecar) {
            this.sidecar.dispose();
            this.sidecar = null;
        }
    }
}

export const voiceHost = new VoiceHost();

// Hash util used by callers that want to dedupe identical synthesis
// requests (e.g. the web app caches generated assets by content hash).
export function hashWavFile(p: string): string {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
}

export function getVoiceFileSize(p: string): number {
    try { return statSync(p).size; } catch { return 0; }
}
