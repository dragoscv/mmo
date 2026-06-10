"use server";

import { z } from "zod";
import { auth } from "@/auth";
import { getCompanionLink } from "@/lib/companion-library";
import {
    listVoices,
    getVoiceHealth,
    getVoice,
    stageSample,
    createClonedVoice as createOnCompanion,
    renameVoice as renameOnCompanion,
    deleteVoice as deleteOnCompanion,
    setReferenceSample,
    appendStagedSamples,
    synthesizeWithVoice,
    singWithVoice,
    analyzeStagedSampleOnCompanion,
    analyzeVoiceSampleOnCompanion,
    type VoiceMeta,
    type VoiceHealth,
    type VoiceEngine,
    type VoiceSampleAnalysis,
} from "@/lib/companion-voice";

async function uid(): Promise<string> {
    const s = await auth();
    const id = s?.user?.id;
    if (!id) throw new Error("Not signed in");
    return id;
}

export interface VoiceWizardSnapshot {
    /** Null when no companion is paired. */
    health: VoiceHealth | null;
    voices: VoiceMeta[];
    /** True when at least one engine reports ready. */
    canTrain: boolean;
    /** True when the user has a paired companion at all. */
    hasCompanion: boolean;
}

export async function getVoiceWizardSnapshot(): Promise<VoiceWizardSnapshot> {
    await uid();
    const link = await getCompanionLink();
    if (!link) {
        return { health: null, voices: [], canTrain: false, hasCompanion: false };
    }
    const [health, voices] = await Promise.all([getVoiceHealth(), listVoices()]);
    const canTrain = !!(health?.engines.xtts || health?.engines.f5);
    return { health, voices, canTrain, hasCompanion: true };
}

export async function listMyClonedVoices(): Promise<VoiceMeta[]> {
    await uid();
    return await listVoices();
}

export async function getMyVoice(voiceId: string): Promise<VoiceMeta | null> {
    await uid();
    return await getVoice(voiceId);
}

/** Stage a raw audio blob on the companion. Called once per recorded
 *  clip from the wizard, before `finalizeClonedVoice`. */
export async function stageVoiceSample(audio: ArrayBuffer, filename?: string): Promise<{ stagedId: string; bytes: number }> {
    await uid();
    const res = await stageSample(audio, filename);
    if (!res) throw new Error("Companion not reachable. Open the companion app and pair this browser.");
    return res;
}

const finalizeSchema = z.object({
    name: z.string().min(1).max(80),
    engine: z.enum(["xtts", "f5"]),
    language: z.string().min(2).max(8),
    notes: z.string().max(500).optional(),
    stagedIds: z.array(z.string().regex(/^s-/)).min(1).max(12),
});
export type FinalizeClonedVoiceInput = z.infer<typeof finalizeSchema>;

export async function finalizeClonedVoice(raw: FinalizeClonedVoiceInput): Promise<VoiceMeta> {
    await uid();
    const input = finalizeSchema.parse(raw);
    const meta = await createOnCompanion(input);
    if (!meta) throw new Error("Companion not reachable.");
    return meta;
}

export async function renameClonedVoice(voiceId: string, name: string): Promise<VoiceMeta | null> {
    await uid();
    return await renameOnCompanion(voiceId, name);
}

export async function deleteClonedVoice(voiceId: string): Promise<boolean> {
    await uid();
    return await deleteOnCompanion(voiceId);
}

export async function setClonedVoiceReference(voiceId: string, sampleIndex: number): Promise<VoiceMeta | null> {
    await uid();
    return await setReferenceSample(voiceId, sampleIndex);
}

export async function appendClonedVoiceSamples(voiceId: string, stagedIds: string[]): Promise<VoiceMeta | null> {
    await uid();
    return await appendStagedSamples(voiceId, stagedIds);
}

const previewSchema = z.object({
    voiceId: z.string().min(1),
    text: z.string().min(1).max(500),
    engine: z.enum(["xtts", "f5"]).optional(),
    language: z.string().min(2).max(8).optional(),
});
export type PreviewClonedVoiceInput = z.infer<typeof previewSchema>;

export interface VoicePreviewResult {
    /** Browser-fetchable URL on the Next.js server that proxies the
     *  rendered WAV from the companion (so the device token never
     *  leaves the server). See `app/src/app/api/voice-render/route.ts`. */
    playUrl: string;
    durationSec: number;
    sampleRate: number;
    engine: VoiceEngine;
}

function buildPlayUrl(voiceId: string, streamUrl: string): string {
    // streamUrl is `/voice/<id>/render/<renderId>` per the companion router.
    const m = /\/voice\/([^/]+)\/render\/([^/?#]+)/.exec(streamUrl);
    if (!m) throw new Error("Unexpected streamUrl from companion: " + streamUrl);
    const renderId = m[2];
    return `/api/voice-render?voiceId=${encodeURIComponent(voiceId)}&renderId=${encodeURIComponent(renderId)}`;
}

/**
 * Run a quick preview synth (spoken). The wizard uses this to audition
 * a newly-trained voice in step 4.
 */
export async function previewClonedVoice(raw: PreviewClonedVoiceInput): Promise<VoicePreviewResult> {
    await uid();
    const input = previewSchema.parse(raw);
    const r = await synthesizeWithVoice(input);
    if (!r) throw new Error("Companion not reachable.");
    return {
        playUrl: buildPlayUrl(input.voiceId, r.streamUrl),
        durationSec: r.durationSec,
        sampleRate: r.sampleRate,
        engine: r.engine,
    };
}

const meldoyNoteSchema = z.object({
    beat: z.number().min(0),
    durationBeats: z.number().min(0.05),
    midiPitch: z.number().min(0).max(127),
});
const previewSingSchema = z.object({
    voiceId: z.string().min(1),
    text: z.string().min(1).max(500),
    engine: z.enum(["xtts", "f5"]).optional(),
    language: z.string().min(2).max(8).optional(),
    tempo: z.number().min(20).max(400),
    melody: z.array(meldoyNoteSchema).min(1).max(64),
    polish: z.boolean().optional(),
    vibratoCents: z.number().min(0).max(100).optional(),
    vibratoRateHz: z.number().min(0.1).max(20).optional(),
});

/**
 * Run a quick sung preview (used in wizard step 5 to verify melody
 * alignment in the cloned voice). Same response shape as
 * `previewClonedVoice`. Kept separate for input validation.
 */
export async function previewClonedVoiceSinging(raw: z.infer<typeof previewSingSchema>): Promise<VoicePreviewResult> {
    await uid();
    const input = previewSingSchema.parse(raw);
    const r = await singWithVoice(input);
    if (!r) throw new Error("Companion not reachable.");
    return {
        playUrl: buildPlayUrl(input.voiceId, r.streamUrl),
        durationSec: r.durationSec,
        sampleRate: r.sampleRate,
        engine: r.engine,
    };
}

const analyzeStagedSchema = z.object({
    stagedId: z.string().regex(/^s-/).max(80),
    expectedText: z.string().max(500).optional(),
    language: z.string().max(8).optional(),
    intent: z.enum(["neutral", "phonetic", "warm", "excited", "intimate", "question"]).optional(),
});
export type AnalyzeStagedInput = z.infer<typeof analyzeStagedSchema>;

export async function analyzeStagedVoiceSample(raw: AnalyzeStagedInput): Promise<VoiceSampleAnalysis | null> {
    await uid();
    const { stagedId, ...rest } = analyzeStagedSchema.parse(raw);
    return await analyzeStagedSampleOnCompanion(stagedId, rest);
}

const analyzeSampleSchema = z.object({
    voiceId: z.string().min(1).max(80),
    sampleIndex: z.number().int().min(0).max(64),
    expectedText: z.string().max(500).optional(),
    language: z.string().max(8).optional(),
    intent: z.enum(["neutral", "phonetic", "warm", "excited", "intimate", "question"]).optional(),
});
export type AnalyzeVoiceSampleInput = z.infer<typeof analyzeSampleSchema>;

export async function analyzeClonedVoiceSample(raw: AnalyzeVoiceSampleInput): Promise<VoiceSampleAnalysis | null> {
    await uid();
    const { voiceId, sampleIndex, ...rest } = analyzeSampleSchema.parse(raw);
    return await analyzeVoiceSampleOnCompanion(voiceId, sampleIndex, rest);
}

const pitchCoverageSchema = z.object({
    stagedIds: z.array(z.string().min(1)).max(64).optional(),
    voiceId: z.string().min(1).max(80).optional(),
}).refine((v) => (v.stagedIds?.length ?? 0) > 0 || !!v.voiceId, {
    message: "stagedIds or voiceId required",
});

export async function analyzeVoicePitchCoverage(raw: z.infer<typeof pitchCoverageSchema>) {
    await uid();
    const parsed = pitchCoverageSchema.parse(raw);
    const { analyzePitchCoverageOnCompanion } = await import("@/lib/companion-voice");
    return await analyzePitchCoverageOnCompanion(parsed);
}
