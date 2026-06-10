"use server";

import { z } from "zod";
import { generateText } from "ai";
import { auth } from "@/auth";
import { resolveModel } from "@/lib/maestro/model-resolver";
import type { VoiceSampleAnalysis } from "@/lib/companion-voice";

const verdictSchema = z.object({
    key: z.string().max(40),
    status: z.enum(["pass", "warn", "fail"]),
    msg: z.string().max(300),
});

const analysisSchema: z.ZodType<VoiceSampleAnalysis> = z.object({
    audio: z.object({
        durationSec: z.number(),
        sampleRate: z.number(),
        peakDb: z.number(),
        rmsDb: z.number(),
        clippingPct: z.number(),
        silencePct: z.number(),
        rmsVariance: z.number(),
        pitchMedianHz: z.number(),
        pitchRangeSemitones: z.number(),
        voicedPct: z.number(),
    }),
    transcript: z.object({
        transcript: z.string().optional(),
        wer: z.number().optional(),
        substitutions: z.number().optional(),
        deletions: z.number().optional(),
        insertions: z.number().optional(),
        error: z.string().optional(),
    }).nullable(),
    verdicts: z.array(verdictSchema),
    overall: z.enum(["pass", "warn", "fail"]),
    intent: z.string().max(40),
    language: z.string().max(8),
    expectedText: z.string().max(500),
});

const coachSchema = z.object({
    prompt: z.string().max(500),
    intent: z.string().max(40),
    language: z.string().max(8),
    uiLanguage: z.string().max(8).optional(),
    analysis: analysisSchema,
});

export type CoachVoiceSampleInput = z.infer<typeof coachSchema>;

export interface CoachVoiceSampleResult {
    text: string | null;
    modelId?: string;
    error?: string;
}

const SYSTEM_PROMPT = `You are a warm, expert voice-training coach helping the user clone their own voice for a DJ / DAW app.
You receive:
  - The exact line the user was asked to read (prompt).
  - The intended speaking style (intent: neutral, phonetic, warm, excited, intimate, question).
  - The target language and the user's UI language.
  - Deterministic measurements (loudness, clipping, silence, pitch range, pitch median, voiced %, transcription + word error rate).
Write EXACTLY two short sentences in the user's UI language:
  1. One specific encouraging observation about what they did well (cite a concrete number when it makes the praise feel real, e.g. "your peak hit a safe -6 dB" or "pitch range of 9 semitones gave great expression").
  2. One concrete, actionable suggestion for the next take if anything could be better. If everything is great, give a small advanced tip for the chosen intent.
Stay under 220 characters total. No emojis. No markdown. No preamble like "Here is..." — just the two sentences.`;

export async function coachVoiceSample(raw: CoachVoiceSampleInput): Promise<CoachVoiceSampleResult> {
    const s = await auth();
    const userId = s?.user?.id;
    if (!userId) throw new Error("Not signed in");
    let input: CoachVoiceSampleInput;
    try {
        input = coachSchema.parse(raw);
    } catch (e) {
        return { text: null, error: e instanceof Error ? e.message : "invalid-input" };
    }
    try {
        const { model, modelId } = await resolveModel({ userId, role: "chat" });
        const { text } = await generateText({
            model,
            system: SYSTEM_PROMPT,
            messages: [{
                role: "user",
                content: JSON.stringify({
                    prompt: input.prompt,
                    intent: input.intent,
                    language: input.language,
                    uiLanguage: input.uiLanguage ?? input.language,
                    measurements: input.analysis.audio,
                    transcript: input.analysis.transcript,
                    verdicts: input.analysis.verdicts,
                    overall: input.analysis.overall,
                }),
            }],
        });
        return { text: text.trim(), modelId };
    } catch (e) {
        return { text: null, error: e instanceof Error ? e.message : String(e) };
    }
}
