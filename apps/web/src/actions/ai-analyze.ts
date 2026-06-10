"use server";

/**
 * AI-powered BPM / key correction.
 *
 * Asks the configured LLM to estimate BPM and Camelot key from the
 * track's metadata + DSP features (no audio is sent — text only). The
 * suggestion is stored in the cloud `tracks` mirror under
 * `ai_bpm` / `ai_key` / `ai_confidence` / `ai_model` / `ai_analyzed_at`
 * so the user can later confirm it from the track-detail modal.
 *
 * Two modes:
 *   - "haiku"  → fast + cheap, default for batch runs
 *   - "sonnet" → slower + pricier, used when the user wants a second
 *                opinion on a specific suggestion
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { tracks } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { aiCall, AiCallError, extractJson } from "@/lib/ai-call";
import { getAiKey } from "@/actions/ai-keys";
import { companionLibrary, getCompanionLink, type CompanionTrack } from "@/lib/companion-library";
import { log } from "@/lib/logger";
import { revalidatePath } from "next/cache";

const trackIdSchema = z.number().int().positive();
const modeSchema = z.enum(["haiku", "sonnet"]).default("haiku");

const MODEL_BY_MODE = {
    haiku: "claude-3-5-haiku-latest",
    sonnet: "claude-3-5-sonnet-latest",
} as const;

const aiResultSchema = z.object({
    bpm: z.number().min(40).max(220).nullable().optional(),
    key: z.string().regex(/^([1-9]|1[0-2])[AB]$/).nullable().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    rationale: z.string().max(400).optional(),
});
export type AiAnalysisResult = z.infer<typeof aiResultSchema>;

const SYSTEM_PROMPT = `You are a senior DJ + electronic-music engineer. Given a
track's metadata, you estimate the most likely BPM and harmonic key (Camelot
notation, 1A..12B). Reply with a single JSON object — no prose, no fences:

{
  "bpm"?: number,         // 40..220, one decimal max
  "key"?: string,         // Camelot, e.g. "8A", "5B"
  "confidence"?: number,  // 0..1, your honest estimate
  "rationale"?: string    // <=2 sentences explaining the picks
}

Use existing BPM and key as strong priors when present. If the existing BPM
is suspiciously round (120, 128) and the genre + label suggest otherwise,
estimate a more refined value. If you cannot improve on what's already
there, return the same values with a confidence reflecting that. Always
prefer Camelot over musical notation. Never invent fields.`;

function buildUserPrompt(t: CompanionTrack): string {
    const parts: string[] = [];
    parts.push(`Artist: ${t.artist ?? "(unknown)"}`);
    parts.push(`Title: ${t.title ?? "(unknown)"}`);
    if (t.album) parts.push(`Album: ${t.album}`);
    if (t.label) parts.push(`Label: ${t.label}`);
    if (t.year) parts.push(`Year: ${t.year}`);
    if (t.genre) parts.push(`Genre: ${t.genre}`);
    if (t.subgenre) parts.push(`Subgenre: ${t.subgenre}`);
    if (typeof t.bpm === "number") parts.push(`Existing BPM: ${t.bpm.toFixed(1)}`);
    if (t.keyCamelot) parts.push(`Existing key (Camelot): ${t.keyCamelot}`);
    if (t.keyMusical) parts.push(`Existing key (musical): ${t.keyMusical}`);
    if (typeof t.loudnessLufs === "number") parts.push(`Loudness: ${t.loudnessLufs.toFixed(1)} LUFS`);
    if (typeof t.duration === "number") parts.push(`Duration: ${Math.round(t.duration)}s`);
    if (typeof t.energy === "number") parts.push(`Energy: ${t.energy}/10`);
    return parts.join("\n");
}

export interface AnalyzeOutcome {
    success: boolean;
    error?: string;
    suggestion?: AiAnalysisResult;
    model?: "haiku" | "sonnet";
}

/**
 * Analyze a single track. Persists the suggestion to the cloud
 * `tracks` mirror keyed by `(userId, sha256)` if the track has a
 * sha256, otherwise returns the suggestion only.
 */
export async function analyzeTrackAi(
    trackId: number,
    mode: "haiku" | "sonnet" = "haiku",
): Promise<AnalyzeOutcome> {
    const idCheck = trackIdSchema.safeParse(trackId);
    if (!idCheck.success) return { success: false, error: "Invalid track id" };
    const modeCheck = modeSchema.safeParse(mode);
    if (!modeCheck.success) return { success: false, error: "Invalid mode" };
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: "Not signed in" };

    const apiKey = await getAiKey("anthropic");
    if (!apiKey) {
        return { success: false, error: "Anthropic API key not configured. Add one in Settings → AI." };
    }

    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };

    const track = await companionLibrary.getTrackById(link, idCheck.data);
    if (!track) return { success: false, error: "Track not found" };

    let raw: string;
    try {
        raw = await aiCall({
            provider: "anthropic",
            apiKey,
            system: SYSTEM_PROMPT,
            user: buildUserPrompt(track),
            model: MODEL_BY_MODE[modeCheck.data],
            json: true,
            maxTokens: 300,
        });
    } catch (err) {
        const status = err instanceof AiCallError ? err.status : undefined;
        log.warn("ai-analyze.aiCall failed", { mode: modeCheck.data, status }, err);
        return {
            success: false,
            error: err instanceof Error ? err.message : "AI call failed",
            model: modeCheck.data,
        };
    }

    const json = extractJson(raw);
    if (!json) {
        return { success: false, error: "Model returned non-JSON", model: modeCheck.data };
    }
    const parsed = aiResultSchema.safeParse(json);
    if (!parsed.success) {
        return { success: false, error: "Model output failed validation", model: modeCheck.data };
    }

    if (track.sha256) {
        await db
            .update(tracks)
            .set({
                aiBpm: parsed.data.bpm ?? null,
                aiKey: parsed.data.key ?? null,
                aiConfidence: parsed.data.confidence ?? null,
                aiModel: modeCheck.data,
                aiAnalyzedAt: new Date(),
            })
            .where(and(eq(tracks.userId, session.user.id), eq(tracks.sha256, track.sha256)));
        revalidatePath("/library");
    }

    return { success: true, suggestion: parsed.data, model: modeCheck.data };
}

/**
 * Apply a previously-stored AI suggestion to the canonical
 * `bpm` / `keyCamelot` fields, propagating the change to the
 * companion through the normal LWW sync path. Clears the staged
 * `ai_*` values once accepted.
 */
export async function acceptAiSuggestion(
    trackId: number,
    accept: { bpm?: boolean; key?: boolean },
): Promise<{ success: boolean; error?: string; applied: string[] }> {
    const applied: string[] = [];
    const idCheck = trackIdSchema.safeParse(trackId);
    if (!idCheck.success) return { success: false, error: "Invalid track id", applied };
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: "Not signed in", applied };

    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected", applied };
    const track = await companionLibrary.getTrackById(link, idCheck.data);
    if (!track || !track.sha256) return { success: false, error: "Track not found", applied };

    const rows = await db
        .select({ aiBpm: tracks.aiBpm, aiKey: tracks.aiKey })
        .from(tracks)
        .where(and(eq(tracks.userId, session.user.id), eq(tracks.sha256, track.sha256)))
        .limit(1);
    const staged = rows[0];
    if (!staged) return { success: false, error: "No AI suggestion stored", applied };

    const patch: Partial<CompanionTrack> = {};
    if (accept.bpm && typeof staged.aiBpm === "number") {
        patch.bpm = staged.aiBpm;
        applied.push("bpm");
    }
    if (accept.key && staged.aiKey) {
        patch.keyCamelot = staged.aiKey;
        applied.push("keyCamelot");
    }
    if (applied.length === 0) return { success: false, error: "Nothing to apply", applied };

    try {
        await companionLibrary.updateTrack(link, idCheck.data, patch);
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Update failed", applied: [] };
    }

    // Clear staged values that were applied so the row stops showing the diff.
    const clear: Record<string, unknown> = {};
    if (accept.bpm) clear.aiBpm = null;
    if (accept.key) clear.aiKey = null;
    if (Object.keys(clear).length > 0) {
        await db
            .update(tracks)
            .set(clear)
            .where(and(eq(tracks.userId, session.user.id), eq(tracks.sha256, track.sha256)));
    }
    revalidatePath("/library");
    return { success: true, applied };
}
