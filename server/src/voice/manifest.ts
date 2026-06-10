/**
 * Per-voice manifest — extended metadata that sits alongside the
 * legacy `meta.json` and powers training, LoRA, and engine routing.
 *
 *   <voicesRoot>/<voiceId>/
 *     meta.json               ← legacy, never breaking (VoiceHost)
 *     manifest.json           ← THIS file (additive)
 *     reference.wav           ← canonical 24kHz mono PCM
 *     samples/                ← raw recorded clips
 *     training/
 *       corpus/               ← validated clips for LoRA fine-tune
 *         prompts.json        ← {file, prompt, intent}[]
 *       runs/<runId>/         ← per-training logs/checkpoints
 *     models/
 *       ace_lora.safetensors  ← ACE-Step LoRA (~50-200 MB)
 *       rvc.pth               ← RVC v2 model (~50 MB)
 *       rvc.index             ← retrieval index
 *
 * The manifest is created on demand (first time something writes
 * training data or a model file) and stays in sync with meta.json
 * via `syncFromMeta`. Old voices without a manifest still work — the
 * registry treats them as having no models and no training corpus.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MANIFEST_VERSION = 1;

export interface CorpusClip {
    /** File path relative to `<voiceDir>/training/corpus/`. */
    file: string;
    /** Prompt the user read (or "" if free-form / sung). */
    prompt: string;
    /** Wizard-style intent tag (warm, excited, intimate, sung, scale, …). */
    intent: string;
    /** Detected language (BCP-47 short, e.g. "ro", "en"). */
    language?: string;
    /** Seconds (analyzer output). */
    durationSec?: number;
    /** Pitch range in semitones (analyzer output). */
    pitchRangeSemitones?: number;
    /** Audio-analyzer overall verdict (pass | warn | fail). */
    quality?: "pass" | "warn" | "fail";
    /** Unix epoch ms when added. */
    addedAt: number;
}

export interface VoiceModelArtifact {
    /** Engine id (matches `EngineId` in engines.ts). */
    engine: "ace-step" | "rvc" | "fish-speech";
    /** Type of artifact — "lora" | "full" | "index". */
    kind: string;
    /** Path relative to `<voiceDir>/models/`. */
    file: string;
    /** Bytes on disk. */
    bytes: number;
    /** Optional base model ref (e.g. "ace-step/ACE-Step-v1.5"). */
    baseModel?: string;
    /** Training run id this artifact came from. */
    runId?: string;
    createdAt: number;
}

export interface TrainingRun {
    id: string;
    engine: "ace-step" | "rvc";
    /** "local" or "azure-ml" or whatever future host. */
    host: string;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    /** Fraction in [0,1] for UI progress bars. */
    progress: number;
    startedAt: number;
    finishedAt?: number;
    /** Free-form log tail captured from the training script. */
    logTail?: string;
    error?: string;
    /** Hyperparameters captured at submission time. */
    config?: Record<string, unknown>;
}

export interface VoiceManifest {
    version: number;
    voiceId: string;
    /** Mirror of meta.json fields so callers don't need both files. */
    name: string;
    languages: string[];
    /** Notes the wizard captured (range, accent, gender). */
    notes?: string;
    corpus: CorpusClip[];
    models: VoiceModelArtifact[];
    trainingRuns: TrainingRun[];
    /** Per-engine preference: which artifact to load by default. */
    defaults: Partial<Record<"ace-step" | "rvc" | "fish-speech", string>>;
    createdAt: number;
    updatedAt: number;
}

function manifestPath(voiceDir: string): string {
    return path.join(voiceDir, "manifest.json");
}

export function corpusDir(voiceDir: string): string {
    const d = path.join(voiceDir, "training", "corpus");
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
}

export function modelsDir(voiceDir: string): string {
    const d = path.join(voiceDir, "models");
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
}

export function runDir(voiceDir: string, runId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`invalid-run-id: ${runId}`);
    const d = path.join(voiceDir, "training", "runs", runId);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return d;
}

export function readManifest(voiceDir: string): VoiceManifest | null {
    const p = manifestPath(voiceDir);
    if (!existsSync(p)) return null;
    try {
        const m = JSON.parse(readFileSync(p, "utf8")) as VoiceManifest;
        return migrate(m);
    } catch {
        return null;
    }
}

export function writeManifest(voiceDir: string, m: VoiceManifest): void {
    m.updatedAt = Date.now();
    writeFileSync(manifestPath(voiceDir), JSON.stringify(m, null, 2), "utf8");
}

/** Lift older shapes forward without breaking. */
function migrate(m: VoiceManifest): VoiceManifest {
    if (!m.version) m.version = MANIFEST_VERSION;
    if (!Array.isArray(m.corpus)) m.corpus = [];
    if (!Array.isArray(m.models)) m.models = [];
    if (!Array.isArray(m.trainingRuns)) m.trainingRuns = [];
    if (!m.defaults || typeof m.defaults !== "object") m.defaults = {};
    if (!Array.isArray(m.languages)) m.languages = [];
    return m;
}

/** Create a fresh manifest seeded from the legacy meta.json. */
export function createManifest(voiceDir: string, seed: {
    voiceId: string;
    name: string;
    language: string;
    notes?: string;
}): VoiceManifest {
    const now = Date.now();
    const m: VoiceManifest = {
        version: MANIFEST_VERSION,
        voiceId: seed.voiceId,
        name: seed.name,
        languages: seed.language ? [seed.language] : [],
        notes: seed.notes,
        corpus: [],
        models: [],
        trainingRuns: [],
        defaults: {},
        createdAt: now,
        updatedAt: now,
    };
    writeManifest(voiceDir, m);
    return m;
}

/** Get-or-create. */
export function ensureManifest(voiceDir: string, seed: {
    voiceId: string;
    name: string;
    language: string;
    notes?: string;
}): VoiceManifest {
    return readManifest(voiceDir) ?? createManifest(voiceDir, seed);
}

/** Mutate-and-persist helper. Returns the new manifest. */
export function updateManifest(
    voiceDir: string,
    mutator: (m: VoiceManifest) => void,
    seed?: { voiceId: string; name: string; language: string; notes?: string },
): VoiceManifest {
    const m = readManifest(voiceDir) ?? (seed ? createManifest(voiceDir, seed) : null);
    if (!m) throw new Error("manifest-missing-and-no-seed");
    mutator(m);
    writeManifest(voiceDir, m);
    return m;
}
