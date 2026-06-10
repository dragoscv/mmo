/**
 * Companion voice-cloning HTTP client (server-side only).
 *
 * Mirrors `companion-library.ts`. Wraps the companion's `/voice/*`
 * endpoints with the same X-Device-Token + X-User-Id auth pattern.
 *
 * All voice samples and rendered audio live on the user's local
 * machine; this module never persists training data anywhere else.
 */

import "server-only";
import { getCompanionLink, type CompanionLink } from "@/lib/companion-library";

export type VoiceEngine = "xtts" | "f5";

export interface VoiceMeta {
    id: string;
    name: string;
    engine: VoiceEngine;
    language: string;
    samples: string[];
    notes?: string;
    createdAt: number;
    updatedAt: number;
}

export interface VoiceMelodyNote {
    beat: number;
    durationBeats: number;
    midiPitch: number;
}

export interface VoiceHealth {
    engines: { xtts: boolean; f5: boolean };
    languages: string[];
    romanianFallback: string;
    sidecarReady: boolean;
    pendingJobs: number;
}

export interface VoiceSampleVerdict {
    key: string;
    status: "pass" | "warn" | "fail";
    msg: string;
}

export interface VoiceSampleAnalysis {
    audio: {
        durationSec: number;
        sampleRate: number;
        peakDb: number;
        rmsDb: number;
        clippingPct: number;
        silencePct: number;
        rmsVariance: number;
        pitchMedianHz: number;
        pitchRangeSemitones: number;
        voicedPct: number;
    };
    transcript: {
        transcript?: string;
        wer?: number;
        substitutions?: number;
        deletions?: number;
        insertions?: number;
        error?: string;
    } | null;
    verdicts: VoiceSampleVerdict[];
    overall: "pass" | "warn" | "fail";
    intent: string;
    language: string;
    expectedText: string;
}

export interface VoiceRenderResponse {
    renderId: string;
    durationSec: number;
    sampleRate: number;
    engine: VoiceEngine;
    language?: string;
    /** Relative path on the companion; combine with apiUrl to fetch. */
    streamUrl: string;
}

async function call<T>(
    link: CompanionLink,
    method: "GET" | "POST" | "DELETE",
    pathAndQuery: string,
    body?: unknown,
    timeoutMs = 180_000,
): Promise<T> {
    const url = `${link.apiUrl}/voice${pathAndQuery}`;
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
        let err = `companion-voice ${method} ${pathAndQuery} → ${res.status}`;
        try {
            const j = await res.json() as { error?: string };
            if (j?.error) err += `: ${j.error}`;
        } catch { /* ignore */ }
        throw new Error(err);
    }
    return (await res.json()) as T;
}

async function stageRawSample(link: CompanionLink, audio: ArrayBuffer | Uint8Array, filename = "sample.wav"): Promise<{ stagedId: string; bytes: number }> {
    const ab: ArrayBuffer = audio instanceof Uint8Array
        ? (audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer)
        : audio;
    const blob = new Blob([ab], { type: "application/octet-stream" });
    const res = await fetch(`${link.apiUrl}/voice/staged`, {
        method: "POST",
        headers: {
            "X-Device-Token": link.token,
            "X-User-Id": link.userId,
            "X-Filename": filename,
            "Content-Type": "application/octet-stream",
        },
        body: blob,
        signal: AbortSignal.timeout(60_000),
        cache: "no-store",
    });
    if (!res.ok) {
        let err = `voice/staged → ${res.status}`;
        try { const j = await res.json() as { error?: string }; if (j?.error) err += `: ${j.error}`; } catch { /* ignore */ }
        throw new Error(err);
    }
    return await res.json() as { stagedId: string; bytes: number };
}

// ─── Public API ────────────────────────────────────────────────────

export async function listVoices(): Promise<VoiceMeta[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    try {
        const j = await call<{ voices: VoiceMeta[] }>(link, "GET", "/", undefined, 8_000);
        return j.voices ?? [];
    } catch {
        return [];
    }
}

export async function getVoiceHealth(): Promise<VoiceHealth | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    try {
        return await call<VoiceHealth>(link, "GET", "/health", undefined, 35_000);
    } catch {
        return null;
    }
}

export async function getVoice(voiceId: string): Promise<VoiceMeta | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    try {
        return await call<VoiceMeta>(link, "GET", `/${encodeURIComponent(voiceId)}`, undefined, 8_000);
    } catch {
        return null;
    }
}

export async function stageSample(audio: ArrayBuffer | Buffer | Uint8Array, filename?: string): Promise<{ stagedId: string; bytes: number } | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return await stageRawSample(link, audio, filename);
}

export async function createClonedVoice(input: {
    name: string;
    engine: VoiceEngine;
    language: string;
    notes?: string;
    stagedIds: string[];
}): Promise<VoiceMeta | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return await call<VoiceMeta>(link, "POST", "/", input, 30_000);
}

export async function appendStagedSamples(voiceId: string, stagedIds: string[]): Promise<VoiceMeta | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return await call<VoiceMeta>(link, "POST", `/${encodeURIComponent(voiceId)}/append`, { stagedIds }, 30_000);
}

export async function setReferenceSample(voiceId: string, sampleIndex: number): Promise<VoiceMeta | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return await call<VoiceMeta>(link, "POST", `/${encodeURIComponent(voiceId)}/reference`, { sampleIndex }, 8_000);
}

export async function renameVoice(voiceId: string, name: string): Promise<VoiceMeta | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return await call<VoiceMeta>(link, "POST", `/${encodeURIComponent(voiceId)}/rename`, { name }, 8_000);
}

export async function deleteVoice(voiceId: string): Promise<boolean> {
    const link = await getCompanionLink();
    if (!link) return false;
    try {
        await call(link, "DELETE", `/${encodeURIComponent(voiceId)}`, undefined, 8_000);
        return true;
    } catch {
        return false;
    }
}

export interface SynthesizeInput {
    voiceId: string;
    text: string;
    engine?: VoiceEngine;
    language?: string;
    speed?: number;
}
export async function synthesizeWithVoice(input: SynthesizeInput): Promise<VoiceRenderResponse | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    const { voiceId, ...rest } = input;
    return await call<VoiceRenderResponse>(link, "POST", `/${encodeURIComponent(voiceId)}/synthesize`, rest, 180_000);
}

export interface SingInput extends SynthesizeInput {
    tempo: number;
    melody: VoiceMelodyNote[];
    /** Polished singing chain: vibrato + cos² attack/release + breath
     *  inserts + post-mix de-esser. Default true. Disable for raw
     *  per-note synth previews. */
    polish?: boolean;
    vibratoCents?: number;
    vibratoRateHz?: number;
}
export async function singWithVoice(input: SingInput): Promise<VoiceRenderResponse | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    const { voiceId, ...rest } = input;
    // Singing dispatches one synth call per note; budget liberally.
    const timeout = Math.max(180_000, input.melody.length * 12_000);
    return await call<VoiceRenderResponse>(link, "POST", `/${encodeURIComponent(voiceId)}/sing`, rest, timeout);
}

export interface AnalyzeInput {
    expectedText?: string;
    language?: string;
    intent?: string;
}

// ─── RVC voice-conversion ──────────────────────────────────────────

export interface RVCModelMeta {
    id: string;
    path: string;
    pth: string;
    index?: string;
    sizeMB: number;
}

export interface RVCConvertInput {
    /** Absolute path of the source audio on the companion machine. */
    inputPath?: string;
    /** Or a stagedId previously returned by stageRawSample. */
    inputStagedId?: string;
    modelId: string;
    pitchSemitones?: number;
    indexRate?: number;
    f0Method?: "rmvpe" | "pm" | "harvest" | "crepe";
    protect?: number;
    /** Median filter radius for pitch smoothing (1..7, sidecar default 3). */
    filterRadius?: number;
    /** Run Demucs first to isolate vocals, convert, then re-mix. */
    isolateVocalsFirst?: boolean;
}

export interface RVCConvertResult {
    jobId: string;
    outputDir: string;
    /** Relative path under downloadBase of the converted vocals. */
    converted: string;
    /** Relative path of the re-mixed full song (only when isolateVocalsFirst). */
    mix?: string;
    stems?: Record<string, string>;
    sampleRate: number;
    durationSec: number;
    device: string;
    /** Prefix to combine with `converted`/`mix` to fetch artifacts. */
    downloadBase: string;
}

export async function listRVCModels(): Promise<RVCModelMeta[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    try {
        const j = await call<{ models: RVCModelMeta[] }>(link, "GET", "/engines/rvc/models", undefined, 15_000);
        return j.models ?? [];
    } catch {
        return [];
    }
}

export async function convertVocalWithRVC(input: RVCConvertInput): Promise<RVCConvertResult | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    // RVC inference is fast on GPU (~5-10s for a 30s vocal) but can take
    // a minute on CPU. The optional Demucs pre-pass adds ~20s for a 3min
    // song. Budget conservatively.
    return await call<RVCConvertResult>(link, "POST", "/engines/rvc/convert", input, 900_000);
}

export async function analyzeStagedSampleOnCompanion(stagedId: string, input: AnalyzeInput = {}): Promise<VoiceSampleAnalysis | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return await call<VoiceSampleAnalysis>(link, "POST", `/staged/${encodeURIComponent(stagedId)}/analyze`, input, 60_000);
}

export async function analyzeVoiceSampleOnCompanion(voiceId: string, sampleIndex: number, input: AnalyzeInput = {}): Promise<VoiceSampleAnalysis | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return await call<VoiceSampleAnalysis>(link, "POST", `/${encodeURIComponent(voiceId)}/sample/${sampleIndex}/analyze`, input, 60_000);
}

export interface PitchCoverageReport {
    coveragePct: number;
    coveredBins: number;
    totalBins: number;
    lowMidi: number;
    highMidi: number;
    histogram: Array<{ midi: number; voicedSec: number }>;
    biggestGaps: Array<{ fromMidi: number; toMidi: number; lengthSemis: number }>;
    voicedSecTotal: number;
    audioSecTotal: number;
    verdict: "pass" | "warn" | "fail";
    failed?: string[];
}

export async function analyzePitchCoverageOnCompanion(input: { stagedIds?: string[]; voiceId?: string }): Promise<PitchCoverageReport | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    try {
        return await call<PitchCoverageReport>(link, "POST", "/pitch-coverage", input, 120_000);
    } catch {
        return null;
    }
}

/** Pull a render from the companion as a Buffer (server-side use). */
export async function fetchVoiceRender(streamUrl: string): Promise<{ buffer: Buffer; sampleRate?: number; durationSec?: number } | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    const full = streamUrl.startsWith("http") ? streamUrl : `${link.apiUrl}${streamUrl}`;
    const res = await fetch(full, {
        method: "GET",
        headers: {
            "X-Device-Token": link.token,
            "X-User-Id": link.userId,
        },
        signal: AbortSignal.timeout(120_000),
        cache: "no-store",
    });
    if (!res.ok) return null;
    const arr = await res.arrayBuffer();
    return { buffer: Buffer.from(arr) };
}

// ── ACE-Step song generation ────────────────────────────────────────

export interface SongGenerationInput {
    prompt: string;
    lyrics?: string;
    durationSec?: number;
    inferStep?: number;
    guidanceScale?: number;
    seeds?: number[];
    loraPath?: string;
    loraWeight?: number;
    /** Default true: also run Demucs split into 4 stems. */
    splitStems?: boolean;
}

export interface SongGenerationResponse {
    jobId: string;
    outputDir: string;
    /** Relative path under downloadBase, e.g. "song.wav". */
    song: string;
    /** Relative paths under downloadBase, by stem name. */
    stems: Record<string, string>;
    sampleRate: number;
    device: string;
    /** Companion path prefix, e.g. "/voice/engines/jobs/<jobId>/". Combine with apiUrl. */
    downloadBase: string;
}

/** Generate a song with ACE-Step (optionally split into 4 stems by Demucs).
 *  Long-running (≈40s for a 15s song on RTX 3060 Ti). */
export async function generateSongOnCompanion(
    input: SongGenerationInput,
): Promise<SongGenerationResponse | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    // Budget: ace-step is ~3× real-time at default infer_step. Add 30s for load.
    const dur = input.durationSec ?? 30;
    const factor = input.splitStems === false ? 4 : 5;
    const timeout = Math.max(120_000, 30_000 + dur * 1000 * factor);
    return await call<SongGenerationResponse>(link, "POST", "/engines/ace-step/song", input, timeout);
}

/** List all available companion engines (demucs, rvc, ace-step, fish-speech)
 *  with their install state + capabilities. */
export interface CompanionEngineStatus {
    id: "demucs" | "rvc" | "ace-step" | "fish-speech";
    ready: boolean;
    installed: boolean;
    capabilities: string[];
    version?: string;
    installHint?: string | null;
    extra?: Record<string, unknown>;
}

export async function listCompanionEngines(): Promise<CompanionEngineStatus[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    const r = await call<{ engines?: CompanionEngineStatus[] }>(link, "GET", "/engines", undefined, 10_000)
        .catch(() => ({ engines: [] }));
    return r.engines ?? [];
}

export interface CompanionLora {
    exp: string;
    ckpts: Array<{ name: string; absPath: string; sizeMB: number }>;
}

/** List trained ACE-Step LoRA checkpoints discovered on the companion.
 *  Populated by `scripts/train-acestep-lora.ps1`. */
export async function listCompanionAceLoras(): Promise<CompanionLora[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    const r = await call<{ loras?: CompanionLora[] }>(link, "GET", "/engines/ace-step/loras", undefined, 10_000)
        .catch(() => ({ loras: [] }));
    return r.loras ?? [];
}

/** Fetch a song or stem artifact produced by /engines/ace-step/song. */
export async function fetchEngineJobFile(
    jobId: string,
    file: string,
): Promise<Buffer | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    const res = await fetch(`${link.apiUrl}/voice/engines/jobs/${encodeURIComponent(jobId)}/${encodeURIComponent(file)}`, {
        method: "GET",
        headers: { "X-Device-Token": link.token, "X-User-Id": link.userId },
        signal: AbortSignal.timeout(120_000),
        cache: "no-store",
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
}

export interface DemucsSeparateResponse {
    jobId: string;
    outputDir: string;
    stems: Record<string, string>;
    sampleRate?: number;
    downloadBase: string;
}

/** Demucs-split an arbitrary input file (absolute path the companion can read)
 *  into 4 stems. Returns the same job-relative URLs as generateSongOnCompanion's
 *  stems. */
export async function separateOnCompanion(
    inputPath: string,
    opts: { model?: string; twoStems?: boolean } = {},
): Promise<DemucsSeparateResponse | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    return await call<DemucsSeparateResponse>(
        link,
        "POST",
        "/engines/demucs/separate",
        { inputPath, model: opts.model ?? "htdemucs", twoStems: opts.twoStems ?? false },
        300_000,
    );
}
