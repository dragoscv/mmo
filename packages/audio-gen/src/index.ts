/**
 * Generative audio core. Stub barrel — concrete implementations land
 * in P5 (T0 in-browser DSP) and P7 (T1/T2 model-backed).
 */

export const AUDIO_GEN_VERSION = "0.0.1";

export interface GenerationManifest {
    id: string;
    kind: "one-shot" | "drum-loop" | "midi" | "loop" | "stem" | "song" | "vocal";
    tier: "T0" | "T1" | "T2";
    model?: string;
    params: Record<string, unknown>;
    seed?: number;
    promptText?: string;
    durationSec?: number;
    sampleRate?: number;
    license: "commercial-clean" | "personal-use" | "unknown";
    createdAt: Date;
    /** Path relative to app/data/generated/<userId>/. */
    filePath?: string;
}
