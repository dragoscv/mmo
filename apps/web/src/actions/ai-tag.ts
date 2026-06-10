"use server";

/**
 * AI-powered metadata suggestion for tracks.
 *
 * Uses the user's BYO API key (stored encrypted in `user_preferences`)
 * to ask the configured LLM to fill in genre / subgenre / mood / vocal
 * type / set position / mixability / energy from the track's known
 * metadata + DSP features. Never sends audio — text-only.
 *
 * Returns suggestions; the UI decides which fields to apply.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { userPreferences } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { aiCall, AiCallError, extractJson } from "@/lib/ai-call";
import { getAiKey } from "@/actions/ai-keys";
import { SUPPORTED_PROVIDERS, type AiProvider } from "@/lib/ai-providers";
import { companionLibrary, getCompanionLink, type CompanionTrack } from "@/lib/companion-library";
import { log } from "@/lib/logger";
import { revalidatePath } from "next/cache";

const PREFERRED_PROVIDER_KEY = "ai.preferredProvider";

const trackIdSchema = z.number().int().positive();

const suggestionSchema = z.object({
    genre: z.string().max(80).optional().nullable(),
    subgenre: z.string().max(80).optional().nullable(),
    mood: z.string().max(120).optional().nullable(),
    vocalType: z.enum(["instrumental", "male", "female", "duet", "group", "acapella"]).optional().nullable(),
    setPosition: z.enum(["warmup", "peak", "afterhours", "closing", "any"]).optional().nullable(),
    mixability: z.number().int().min(1).max(5).optional().nullable(),
    energy: z.number().int().min(1).max(10).optional().nullable(),
    tags: z.array(z.string().min(1).max(40)).max(8).optional(),
    rationale: z.string().max(400).optional(),
});

export type TrackSuggestion = z.infer<typeof suggestionSchema>;

const SYSTEM_PROMPT = `You are a senior DJ + music librarian. Given a track's
metadata and DSP features, suggest classification fields. Reply with a single
JSON object matching this TypeScript type — no prose, no fences:

{
  "genre"?: string,            // primary genre (Tech House, Techno, Psytrance, Bounce, House, Manele, Latino, Balkan, Acid, Hip-Hop, etc.)
  "subgenre"?: string,
  "mood"?: string,             // 1-3 words (e.g. "dark hypnotic", "uplifting")
  "vocalType"?: "instrumental" | "male" | "female" | "duet" | "group" | "acapella",
  "setPosition"?: "warmup" | "peak" | "afterhours" | "closing" | "any",
  "mixability"?: 1|2|3|4|5,    // 5 = mixes everywhere, 1 = niche / hard to fit
  "energy"?: 1..10,
  "tags"?: string[],           // up to 6 short descriptors
  "rationale"?: string         // <=2 sentences explaining the picks
}

Use the BPM / key / loudness / existing tags as ground truth. Be honest about
uncertainty — leave a field out rather than guess wildly. Prefer Romanian-DJ
genre vocabulary when the artist is clearly Romanian (manele, populara,
balcanica), otherwise standard English. Never include fields the schema
doesn't define.`;

function buildUserPrompt(input: {
    artist: string | null;
    title: string | null;
    album: string | null;
    label: string | null;
    year: number | null;
    bpm: number | null;
    keyCamelot: string | null;
    keyMusical: string | null;
    loudnessLufs: number | null | undefined;
    duration: number | null;
    energyExisting: number | null;
    genreExisting: string | null;
    moodExisting: string | null;
    tagsExisting: string[];
}): string {
    const parts: string[] = [];
    parts.push(`Artist: ${input.artist ?? "(unknown)"}`);
    parts.push(`Title: ${input.title ?? "(unknown)"}`);
    if (input.album) parts.push(`Album: ${input.album}`);
    if (input.label) parts.push(`Label: ${input.label}`);
    if (input.year) parts.push(`Year: ${input.year}`);
    if (input.bpm) parts.push(`BPM: ${input.bpm.toFixed(1)}`);
    if (input.keyCamelot) parts.push(`Key (Camelot): ${input.keyCamelot}`);
    if (input.keyMusical) parts.push(`Key (musical): ${input.keyMusical}`);
    if (typeof input.loudnessLufs === "number") parts.push(`Integrated loudness: ${input.loudnessLufs.toFixed(1)} LUFS`);
    if (input.duration) parts.push(`Duration: ${Math.round(input.duration)}s`);
    if (input.genreExisting) parts.push(`Existing genre tag: ${input.genreExisting}`);
    if (input.moodExisting) parts.push(`Existing mood: ${input.moodExisting}`);
    if (input.energyExisting) parts.push(`Existing energy: ${input.energyExisting}/10`);
    if (input.tagsExisting.length) parts.push(`Existing tags: ${input.tagsExisting.join(", ")}`);
    return parts.join("\n");
}

async function pickProvider(preferred?: AiProvider): Promise<{ provider: AiProvider; key: string } | null> {
    const order: AiProvider[] = preferred
        ? [preferred, ...SUPPORTED_PROVIDERS.filter((p) => p !== preferred)]
        : [...SUPPORTED_PROVIDERS];
    for (const provider of order) {
        const key = await getAiKey(provider);
        if (key) return { provider, key };
    }
    return null;
}

const providerSchema = z.enum(SUPPORTED_PROVIDERS as unknown as [AiProvider, ...AiProvider[]]);

/**
 * Per-user preferred AI provider. Stored as a plain string in
 * `user_preferences` (no secret material). When set, suggestions try
 * this provider first before falling back to whatever else has a key.
 */
export async function getPreferredAiProvider(): Promise<AiProvider | null> {
    const session = await auth();
    if (!session?.user?.id) return null;
    const rows = await db
        .select({ value: userPreferences.value })
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, session.user.id), eq(userPreferences.key, PREFERRED_PROVIDER_KEY)))
        .limit(1);
    const value = rows[0]?.value;
    if (!value) return null;
    const parsed = providerSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export async function setPreferredAiProvider(
    provider: AiProvider | null,
): Promise<{ ok: boolean; error?: string }> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: "Not signed in" };
    if (provider !== null && !providerSchema.safeParse(provider).success) {
        return { ok: false, error: "Unknown provider" };
    }
    if (provider === null) {
        await db.delete(userPreferences)
            .where(and(eq(userPreferences.userId, session.user.id), eq(userPreferences.key, PREFERRED_PROVIDER_KEY)));
        revalidatePath("/settings");
        return { ok: true };
    }
    const existing = await db
        .select({ id: userPreferences.id })
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, session.user.id), eq(userPreferences.key, PREFERRED_PROVIDER_KEY)))
        .limit(1);
    if (existing[0]) {
        await db.update(userPreferences)
            .set({ value: provider, updatedAt: new Date() })
            .where(eq(userPreferences.id, existing[0].id));
    } else {
        await db.insert(userPreferences).values({
            userId: session.user.id, key: PREFERRED_PROVIDER_KEY, value: provider,
        });
    }
    revalidatePath("/settings");
    return { ok: true };
}

export async function suggestTrackTags(
    id: number,
    options?: { provider?: AiProvider },
): Promise<{
    success: boolean;
    error?: string;
    suggestion?: TrackSuggestion;
    provider?: AiProvider;
}> {
    const idCheck = trackIdSchema.safeParse(id);
    if (!idCheck.success) return { success: false, error: "Invalid track id" };
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: "Not signed in" };
    const explicit = options?.provider
        ? providerSchema.safeParse(options.provider).data
        : undefined;
    const stored = explicit ? null : await getPreferredAiProvider();
    const picked = await pickProvider(explicit ?? stored ?? undefined);
    if (!picked) {
        return { success: false, error: "No AI provider key configured. Add one in Settings → AI." };
    }
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    const track = await companionLibrary.getTrackById(link, idCheck.data);
    if (!track) return { success: false, error: "Track not found" };
    return runSuggest(track, picked);
}

interface PickedProvider { provider: AiProvider; key: string }

async function runSuggest(
    track: CompanionTrack,
    picked: PickedProvider,
): Promise<{ success: boolean; error?: string; suggestion?: TrackSuggestion; provider?: AiProvider }> {
    const tagsExisting = (() => {
        if (!track.tags) return [];
        try {
            const parsed = JSON.parse(track.tags);
            return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
        } catch {
            return track.tags.split(",").map((s) => s.trim()).filter(Boolean);
        }
    })();

    const userPrompt = buildUserPrompt({
        artist: track.artist,
        title: track.title,
        album: track.album,
        label: track.label,
        year: track.year,
        bpm: track.bpm,
        keyCamelot: track.keyCamelot,
        keyMusical: track.keyMusical,
        loudnessLufs: track.loudnessLufs,
        duration: track.duration,
        energyExisting: track.energy,
        genreExisting: track.genre,
        moodExisting: track.mood,
        tagsExisting,
    });

    let raw: string;
    try {
        raw = await aiCall({
            provider: picked.provider,
            apiKey: picked.key,
            system: SYSTEM_PROMPT,
            user: userPrompt,
            json: true,
            maxTokens: 500,
        });
    } catch (err) {
        const status = err instanceof AiCallError ? err.status : undefined;
        log.warn("ai-tag.aiCall failed", { provider: picked.provider, status }, err);
        return {
            success: false,
            error: err instanceof Error ? err.message : "AI call failed",
            provider: picked.provider,
        };
    }

    const json = extractJson(raw);
    if (!json) {
        log.warn("ai-tag.parse failed", { provider: picked.provider, sample: raw.slice(0, 200) });
        return { success: false, error: "Model returned non-JSON", provider: picked.provider };
    }
    const parsed = suggestionSchema.safeParse(json);
    if (!parsed.success) {
        log.warn("ai-tag.schema failed", { provider: picked.provider, issues: parsed.error.issues });
        return { success: false, error: "Model output failed validation", provider: picked.provider };
    }
    return { success: true, suggestion: parsed.data, provider: picked.provider };
}

/** Pick the diff between current row and AI suggestion, only for fields that are empty. */
function applicableUpdate(track: CompanionTrack, s: TrackSuggestion): Record<string, unknown> {
    const upd: Record<string, unknown> = {};
    if (s.genre && !track.genre) upd.genre = s.genre.slice(0, 200);
    if (s.subgenre && !track.subgenre) upd.subgenre = s.subgenre.slice(0, 200);
    if (s.mood && !track.mood) upd.mood = s.mood.slice(0, 200);
    if (s.vocalType && !track.vocalType) upd.vocalType = s.vocalType;
    if (s.setPosition && !track.setPosition) upd.setPosition = s.setPosition;
    if (typeof s.mixability === "number" && track.mixability == null) upd.mixability = s.mixability;
    if (typeof s.energy === "number" && track.energy == null) upd.energy = s.energy;
    return upd;
}

const bulkIdsSchema = z.array(trackIdSchema).min(1).max(50);

/**
 * Suggest + auto-apply tags for a batch of tracks. Sequential so we
 * don't hammer the provider's rate limit. Cap is 50 tracks per call;
 * the UI is expected to chunk if the user selects more.
 *
 * Only fills empty fields (never overwrites). Returns a per-track
 * outcome so the toast can show "filled X of Y, skipped Z".
 */
export async function bulkSuggestAndApplyTags(
    ids: number[],
    options?: { provider?: AiProvider },
): Promise<{
    success: boolean;
    error?: string;
    provider?: AiProvider;
    processed: number;
    filled: number;
    skipped: number;
    failed: number;
    perTrack: Array<{ id: number; status: "filled" | "skipped" | "failed"; fields?: string[]; error?: string }>;
}> {
    const empty = { processed: 0, filled: 0, skipped: 0, failed: 0, perTrack: [] };
    const idsCheck = bulkIdsSchema.safeParse(ids);
    if (!idsCheck.success) return { success: false, error: "Invalid id list (1-50)", ...empty };
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: "Not signed in", ...empty };
    const explicit = options?.provider ? providerSchema.safeParse(options.provider).data : undefined;
    const stored = explicit ? null : await getPreferredAiProvider();
    const picked = await pickProvider(explicit ?? stored ?? undefined);
    if (!picked) {
        return { success: false, error: "No AI provider key configured. Add one in Settings → AI.", ...empty };
    }
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected", ...empty };

    const perTrack: Array<{ id: number; status: "filled" | "skipped" | "failed"; fields?: string[]; error?: string }> = [];
    let filled = 0, skipped = 0, failed = 0;
    for (const id of idsCheck.data) {
        const track = await companionLibrary.getTrackById(link, id);
        if (!track) { failed++; perTrack.push({ id, status: "failed", error: "Track not found" }); continue; }
        const out = await runSuggest(track, picked);
        if (!out.success || !out.suggestion) {
            failed++;
            perTrack.push({ id, status: "failed", error: out.error });
            continue;
        }
        const upd = applicableUpdate(track, out.suggestion);
        const fields = Object.keys(upd);
        if (fields.length === 0) {
            skipped++;
            perTrack.push({ id, status: "skipped" });
            continue;
        }
        try {
            await companionLibrary.updateTrack(link, id, upd as Partial<CompanionTrack>);
            filled++;
            perTrack.push({ id, status: "filled", fields });
        } catch (err) {
            failed++;
            perTrack.push({ id, status: "failed", error: err instanceof Error ? err.message : "Update failed" });
        }
    }
    revalidatePath("/library");
    revalidatePath("/");
    return {
        success: true,
        provider: picked.provider,
        processed: idsCheck.data.length,
        filled, skipped, failed,
        perTrack,
    };
}
