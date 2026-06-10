"use server";

import { z } from "zod";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { auth } from "@/auth";
import { db } from "@/db";
import { generatedAssets } from "@/db/schema-ai";
import {
    GEN_KINDS,
    GEN_TIERS,
    type GeneratedAssetDto,
    type GenKind,
    type GenTier,
} from "@/lib/generate/types";
import {
    createPrediction,
    downloadOutput,
    getPrediction,
    ReplicateError,
} from "@/lib/generate/replicate";
import { startDspAnalysis } from "@/actions/analyze";
import { findLorasForPrompt } from "@/actions/loras";
import { companionAnalyzer, getCompanionLink } from "@/lib/companion-library";
import {
    singWithVoice,
    synthesizeWithVoice,
    fetchVoiceRender,
    generateSongOnCompanion,
    fetchEngineJobFile,
    listCompanionAceLoras,
    separateOnCompanion,
    type CompanionLora,
    type VoiceEngine,
} from "@/lib/companion-voice";
import {
    buildSongOutputGs,
    cloudMusicEnabled,
    generateSongOnCloud,
} from "@/lib/cloud-gpu-music";
import { canUseCloud, canUseCompanion, getProcessingMode } from "@/lib/processing-mode";

async function uid(): Promise<string> {
    const s = await auth();
    const id = s?.user?.id;
    if (!id) throw new Error("Not signed in");
    return id;
}

const GENERATED_DIR = path.join(process.cwd(), "data", "generated");

async function ensureUserDir(userId: string): Promise<string> {
    const dir = path.join(GENERATED_DIR, userId);
    await fsp.mkdir(dir, { recursive: true });
    return dir;
}

/**
 * Fire-and-forget CLAP embedding for a freshly-ready asset.
 * Tries companion sidecar first then Cloud Run fallback. Writes into
 * `audioEmbeddings` so /api/recommendations/similar (and the recommendSimilar
 * Maestro tool) can return matches. Failures are swallowed — the asset itself
 * is still useful without embeddings, the next poller pass will retry.
 */
function scheduleAutoEmbed(userId: string, assetId: string, relPath: string, durationSec?: number | null): void {
    void (async () => {
        try {
            const { embedAudio } = await import("@/lib/clap-embed");
            const { audioEmbeddings } = await import("@/db/schema-ai");
            const absPath = path.join(GENERATED_DIR, userId, relPath);
            const res = await embedAudio(absPath);
            if (!res || !("ok" in res) || !res.ok || !res.embedding || res.embedding.length === 0) return;
            await db.insert(audioEmbeddings).values({
                assetId,
                assetKind: "generated",
                model: res.model ?? "laion/larger_clap_music_and_speech",
                modelVersion: "v1",
                dim: res.embedding.length,
                embedding: res.embedding,
                durationSec: typeof durationSec === "number" ? durationSec : null,
            }).onConflictDoNothing();
        } catch {
            // best-effort; pollers will retry via embedMissingForUser()
        }
    })();
}

/**
 * Scan the user's ready assets and embed any that don't have an entry in
 * audioEmbeddings yet. Called from the pending pollers so we have a safety
 * net for paths that didn't fire scheduleAutoEmbed inline.
 */
async function embedMissingForUser(userId: string, limit = 10): Promise<void> {
    try {
        const { audioEmbeddings } = await import("@/db/schema-ai");
        const { sql } = await import("drizzle-orm");
        const rows = await db.execute<{ id: string; file_path: string; duration_sec: number | null }>(sql`
            SELECT ga.id, ga.file_path, ga.duration_sec
            FROM ${generatedAssets} ga
            LEFT JOIN ${audioEmbeddings} ae
                   ON ae.asset_id = ga.id AND ae.asset_kind = 'generated'
            WHERE ga.user_id = ${userId}
              AND ga.status = 'ready'
              AND ga.file_path IS NOT NULL
              AND ae.id IS NULL
            ORDER BY ga.updated_at DESC
            LIMIT ${limit}
        `);
        const arr = rows as unknown as Array<{ id: string; file_path: string; duration_sec: number | null }>;
        for (const r of arr) {
            scheduleAutoEmbed(userId, r.id, r.file_path, r.duration_sec);
        }
    } catch {
        // silent
    }
}

const melodyNoteSchema = z.object({
    beat: z.number().min(0),
    durationBeats: z.number().min(0.05),
    midiPitch: z.number().min(0).max(127),
});

const generateSchema = z.object({
    tier: z.enum(GEN_TIERS),
    kind: z.enum(GEN_KINDS),
    prompt: z.string().min(1).max(2000),
    durationSec: z.number().int().min(1).max(300).optional(),
    seed: z.number().int().optional(),
    model: z.string().min(1).max(200).optional(),
    trackId: z.number().int().positive().optional(),
    // Optional vocal-only inputs. When `melody` is non-empty we route
    // singing through the PSOLA / cloud path instead of plain TTS.
    melody: z.array(melodyNoteSchema).max(2048).optional(),
    tempo: z.number().min(20).max(300).optional(),
    /** Optional ISO language tag forwarded to multilingual TTS backends
     *  (XTTS-v2, F5-TTS). Ignored by Piper. */
    language: z.string().min(2).max(8).optional(),
    /** Optional ACE-Step LoRA checkpoint (absolute path on companion).
     *  Discoverable via listCompanionAceLoras(). */
    loraPath: z.string().min(1).max(500).optional(),
    loraWeight: z.number().min(0).max(2).optional(),
});

export type GenerateInput = z.infer<typeof generateSchema>;

/**
 * Run a generation. T0 (companion-local) and T2 (external/manual) currently
 * write a pending row only; T1 (Replicate) does a real ≤60s synchronous call
 * and persists the audio file when it succeeds.
 *
 * Vocal routing (kind === "vocal"):
 *   - T0 + model starts with `companion:`  → Piper sidecar (plain or `sing`)
 *   - T2 + model starts with `cloud:elevenlabs` → ElevenLabs REST API
 *   - T1 + model starts with `replicate:`        → Replicate (Bark / XTTS)
 */
export async function generateAsset(raw: GenerateInput): Promise<GeneratedAssetDto> {
    const userId = await uid();
    const input = generateSchema.parse(raw);

    if (input.kind === "vocal") {
        const model = (input.model ?? "").toLowerCase();
        if (model.startsWith("cloud:elevenlabs")) {
            return runCloudVocal(userId, input);
        }
        if (input.tier === "T1" && model.startsWith("replicate:")) {
            return runReplicate(userId, input);
        }
        // Cloned-voice models live on the user's companion under XTTS/F5.
        // Model strings look like `companion:xtts:<voiceId>` (sing inferred
        // from melody being non-empty, same convention as Piper).
        if (model.startsWith("companion:xtts:") || model.startsWith("companion:f5:")) {
            return runCompanionClonedVocal(userId, input);
        }
        // Default: companion Piper (sync 'sing' if melody given, else plain).
        return runCompanionVocal(userId, input);
    }

    if (input.tier === "T1") {
        return runReplicate(userId, input);
    }
    if (input.tier === "T0" && input.kind === "stem") {
        return runCompanionStems(userId, input);
    }
    if (input.tier === "T0" && input.kind === "song") {
        return runCompanionSong(userId, input);
    }

    // T0 (non-stem) and T2 stubs: persist a "pending" row with no file.
    const stubKindOk: Record<GenTier, boolean> = { T0: true, T1: true, T2: true };
    if (!stubKindOk[input.tier]) throw new Error(`Unsupported tier ${input.tier}`);

    const [row] = await db
        .insert(generatedAssets)
        .values({
            userId,
            kind: input.kind,
            tier: input.tier,
            model: input.model ?? null,
            promptText: input.prompt,
            params: input.seed != null ? { seed: input.seed } : null,
            seed: input.seed ?? null,
            durationSec: input.durationSec ?? null,
            license: "unknown",
            status: "pending",
            error: input.tier === "T0"
                ? "T0 (companion) only supports kind=stem today; other kinds are pending."
                : "T2 (external) requires manual upload — row recorded as pending.",
        })
        .returning();
    return toDto(row!, "pending", row!.error ?? undefined);
}

async function runCompanionVocal(userId: string, input: GenerateInput): Promise<GeneratedAssetDto> {
    // Parse the model string written by `synthesizeVocal` / `singVocal`:
    //   `companion:piper-tts:<voice>`          → plain TTS
    //   `companion:piper-tts-melody:<voice>`   → melody-aligned (sing)
    // Voice ∈ {male, female, neutral}.
    const modelStr = input.model ?? "companion:piper-tts:neutral";
    const isSing =
        /companion:piper-tts-melody/i.test(modelStr) ||
        ((input.melody?.length ?? 0) > 0);
    const voiceMatch = /companion:piper-tts(?:-melody)?:(male|female|neutral)/i.exec(modelStr);
    const voice = (voiceMatch?.[1]?.toLowerCase() ?? "neutral") as "male" | "female" | "neutral";

    const rate = 1.0;
    const pitchSemitones = 0;
    const melody = input.melody ?? [];
    const tempo = input.tempo ?? 120;

    const [row] = await db
        .insert(generatedAssets)
        .values({
            userId,
            kind: "vocal",
            tier: "T0",
            model: modelStr,
            promptText: input.prompt,
            params: isSing
                ? { voice, tempo, noteCount: melody.length, mode: "sing" }
                : { voice, rate, pitchSemitones, mode: "tts" },
            license: "commercial-clean",
            status: "pending",
        })
        .returning();
    const assetId = row!.id;

    const mode = await getProcessingMode(userId);
    if (!canUseCompanion(mode)) {
        return failAsset(assetId, "Cloud-only vocal synthesis is not yet supported. Cloud Piper voices and TTS coming soon — switch to auto or companion mode for now.");
    }

    const link = await getCompanionLink();
    if (!link) {
        return failAsset(assetId, "Companion not reachable. Open the companion app and pair this browser.");
    }

    const endpoint = isSing ? "/sing/voice" : "/synthesize/voice";
    const body = isSing
        ? { text: input.prompt, voice, tempo, melody }
        : { text: input.prompt, voice, rate, pitchSemitones };

    try {
        const res = await fetch(`${link.apiUrl}${endpoint}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Device-Token": link.token,
                "X-User-Id": link.userId,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(isSing ? 200_000 : 70_000),
            cache: "no-store",
        });

        if (!res.ok) {
            let detail = "";
            try { detail = (await res.json()).error ?? ""; } catch { /* ignore */ }
            return failAsset(assetId, `Companion ${isSing ? "sing" : "TTS"} failed (${res.status})${detail ? ": " + detail : ""}`);
        }

        const buf = Buffer.from(await res.arrayBuffer());
        const durationRaw = Number(res.headers.get("X-Duration-Sec") || "0");
        const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : null;
        const sampleRateRaw = Number(res.headers.get("X-Sample-Rate") || "0");
        const sampleRate = Number.isFinite(sampleRateRaw) && sampleRateRaw > 0 ? Math.round(sampleRateRaw) : null;
        const voiceModel = res.headers.get("X-Voice-Model") || null;

        const dir = await ensureUserDir(userId);
        const relPath = `${assetId}.wav`;
        await fsp.writeFile(path.join(dir, relPath), buf);
        const hash = createHash("sha256").update(buf).digest("hex");

        const [updated] = await db
            .update(generatedAssets)
            .set({
                filePath: relPath,
                fileSize: buf.byteLength,
                contentHash: hash,
                durationSec: durationSec ?? undefined,
                sampleRate: sampleRate ?? undefined,
                params: isSing
                    ? { voice, tempo, noteCount: melody.length, mode: "sing", voiceModel }
                    : { voice, rate, pitchSemitones, mode: "tts", voiceModel },
                status: "ready",
                error: null,
                updatedAt: new Date(),
            })
            .where(eq(generatedAssets.id, assetId))
            .returning();
        scheduleAutoEmbed(userId, assetId, relPath, durationSec ?? null);
        return toDto(updated!, "ready");
    } catch (e) {
        return failAsset(assetId, e instanceof Error ? e.message : String(e));
    }
}

/**
 * Cloned-voice vocal synthesis. Routes to the companion's `/voice/*`
 * endpoints backed by XTTS-v2 (or F5-TTS). The model string carries the
 * voice id chosen by the wizard:
 *
 *   `companion:xtts:<voiceId>`   →  XTTS-v2 (multilingual, zero-shot)
 *   `companion:f5:<voiceId>`     →  F5-TTS (sidecar must have it installed)
 *
 * Singing vs spoken is inferred from `input.melody.length > 0`, matching
 * the Piper path.
 */
async function runCompanionClonedVocal(userId: string, input: GenerateInput): Promise<GeneratedAssetDto> {
    const modelStr = input.model ?? "";
    const parts = modelStr.split(":");
    const engine = (parts[1] as VoiceEngine) ?? "xtts";
    const voiceId = parts.slice(2).join(":");
    if (!voiceId) {
        throw new Error("Cloned-voice model must encode voiceId (companion:xtts:<voiceId>).");
    }
    const melody = input.melody ?? [];
    const isSing = melody.length > 0;
    const tempo = input.tempo ?? 120;
    const language = input.language ?? "en";

    const [row] = await db
        .insert(generatedAssets)
        .values({
            userId,
            kind: "vocal",
            tier: "T0",
            model: modelStr,
            promptText: input.prompt,
            params: isSing
                ? { engine, voiceId, tempo, noteCount: melody.length, mode: "sing", language }
                : { engine, voiceId, mode: "tts", language },
            license: "personal-use",
            status: "pending",
        })
        .returning();
    const assetId = row!.id;

    try {
        const mode = await getProcessingMode(userId);
        if (!canUseCompanion(mode)) {
            return failAsset(assetId, "Cloud-only cloned-voice synthesis is not yet supported. Per-user voice models still live on the companion; cloud migration coming next.");
        }
        const r = isSing
            ? await singWithVoice({ voiceId, text: input.prompt, engine, language, tempo, melody })
            : await synthesizeWithVoice({ voiceId, text: input.prompt, engine, language });
        if (!r) {
            return failAsset(assetId, "Companion not reachable. Open the companion app and pair this browser.");
        }
        const wav = await fetchVoiceRender(r.streamUrl);
        if (!wav) {
            return failAsset(assetId, "Companion returned no audio for cloned-voice render.");
        }
        const dir = await ensureUserDir(userId);
        const relPath = `${assetId}.wav`;
        await fsp.writeFile(path.join(dir, relPath), wav.buffer);
        const hash = createHash("sha256").update(wav.buffer).digest("hex");
        const [updated] = await db
            .update(generatedAssets)
            .set({
                filePath: relPath,
                fileSize: wav.buffer.byteLength,
                contentHash: hash,
                durationSec: Math.max(1, Math.round(r.durationSec)),
                sampleRate: r.sampleRate,
                params: isSing
                    ? { engine, voiceId, tempo, noteCount: melody.length, mode: "sing", language }
                    : { engine, voiceId, mode: "tts", language },
                status: "ready",
                error: null,
                updatedAt: new Date(),
            })
            .where(eq(generatedAssets.id, assetId))
            .returning();
        scheduleAutoEmbed(userId, assetId, relPath, Math.max(1, Math.round(r.durationSec)));
        return toDto(updated!, "ready");
    } catch (e) {
        return failAsset(assetId, e instanceof Error ? e.message : String(e));
    }
}

/**
 * Cloud vocal synthesis via ElevenLabs. Used when model starts with
 * `cloud:elevenlabs:<voice-id>`. Requires ELEVENLABS_API_KEY in the
 * server env. Best quality, costs per-character against the user's quota.
 */
async function runCloudVocal(userId: string, input: GenerateInput): Promise<GeneratedAssetDto> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const modelStr = input.model ?? "cloud:elevenlabs:21m00Tcm4TlvDq8ikWAM";
    const voiceId = modelStr.split(":").pop() || "21m00Tcm4TlvDq8ikWAM"; // Rachel default

    const [row] = await db
        .insert(generatedAssets)
        .values({
            userId,
            kind: "vocal",
            tier: "T2",
            model: modelStr,
            promptText: input.prompt,
            params: { provider: "elevenlabs", voiceId },
            license: "commercial-clean",
            status: "pending",
        })
        .returning();
    const assetId = row!.id;

    if (!apiKey) {
        return failAsset(assetId,
            "ELEVENLABS_API_KEY not set. Add it to .env.local or use a different vocal provider " +
            "(model='companion:piper-tts:neutral' for offline).");
    }

    try {
        const res = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
            {
                method: "POST",
                headers: {
                    "xi-api-key": apiKey,
                    "Content-Type": "application/json",
                    "Accept": "audio/mpeg",
                },
                body: JSON.stringify({
                    text: input.prompt,
                    model_id: "eleven_multilingual_v2",
                    voice_settings: { stability: 0.45, similarity_boost: 0.8 },
                }),
                signal: AbortSignal.timeout(60_000),
            },
        );
        if (!res.ok) {
            let detail = "";
            try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
            return failAsset(assetId, `ElevenLabs ${res.status}: ${detail}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const dir = await ensureUserDir(userId);
        const relPath = `${assetId}.mp3`;
        await fsp.writeFile(path.join(dir, relPath), buf);
        const hash = createHash("sha256").update(buf).digest("hex");

        const [updated] = await db
            .update(generatedAssets)
            .set({
                filePath: relPath,
                fileSize: buf.byteLength,
                contentHash: hash,
                sampleRate: 44100,
                params: { provider: "elevenlabs", voiceId },
                status: "ready",
                error: null,
                updatedAt: new Date(),
            })
            .where(eq(generatedAssets.id, assetId))
            .returning();
        scheduleAutoEmbed(userId, assetId, relPath, null);
        return toDto(updated!, "ready");
    } catch (e) {
        return failAsset(assetId, e instanceof Error ? e.message : String(e));
    }
}

async function runCompanionStems(userId: string, input: GenerateInput): Promise<GeneratedAssetDto> {
    if (!input.trackId) {
        throw new Error("T0 stems generation requires a `trackId` (library track to separate).");
    }
    const [row] = await db
        .insert(generatedAssets)
        .values({
            userId,
            kind: "stem",
            tier: "T0",
            model: "companion:bs-roformer",
            promptText: input.prompt,
            params: { trackId: input.trackId },
            license: "commercial-clean",
            status: "pending",
        })
        .returning();
    const assetId = row!.id;

    try {
        const mode = await getProcessingMode(userId);
        if (!canUseCompanion(mode)) {
            // Cloud-only mode: stem split needs the source audio uploaded
            // to GCS. The current trackId path resolves only on the
            // companion; cloud stem split from a library track requires
            // the companion to first upload the source (not yet wired).
            return failAsset(assetId, "Cloud-only stem split from a library track is not yet supported. Switch to auto or companion mode, or generate a song (cloud song split coming next).");
        }
        const r = await startDspAnalysis([input.trackId], {
            dsp: false,
            stems: true,
            fingerprint: false,
        });
        if (r.error) return failAsset(assetId, `Companion: ${r.error}`);
        const jobId = r.jobs[0]?.id ?? null;
        const updated = await db.update(generatedAssets)
            .set({
                params: { trackId: input.trackId, companionJobId: jobId },
                error: jobId ? `Companion job ${jobId} queued.` : "Companion accepted job.",
                updatedAt: new Date(),
            })
            .where(eq(generatedAssets.id, assetId))
            .returning();
        return toDto(updated[0]!, "pending", updated[0]!.error ?? undefined);
    } catch (e) {
        return failAsset(assetId, e instanceof Error ? e.message : String(e));
    }
}

async function runCompanionSong(userId: string, input: GenerateInput): Promise<GeneratedAssetDto> {
    const splitStems = true; // always split into 4 stems per locked plan
    const durationSec = input.durationSec ?? 30;

    // Auto-pick a registered LoRA from the loraAssets registry when the
    // caller didn't supply one. Matches the prompt against name/tags/
    // triggerToken of the user's own + shared adapters, picks the best
    // match, and uses its gs:// weightsUri. Cloud path consumes gs://
    // directly; companion path only honours absolute local paths so the
    // auto-pick is effectively cloud-only (still fine — the cloud branch
    // is what runs when the companion is offline or for shared LoRAs).
    let effectiveLoraPath = input.loraPath;
    let effectiveLoraWeight = input.loraWeight;
    if (!effectiveLoraPath && input.prompt) {
        try {
            const matches = await findLorasForPrompt(input.prompt, 1);
            const best = matches[0];
            if (best?.weightsUri) {
                effectiveLoraPath = best.weightsUri;
                effectiveLoraWeight = effectiveLoraWeight ?? 0.8;
                console.info(
                    `[generate] auto-picked LoRA '${best.name}' (score-best) for prompt='${input.prompt.slice(0, 60)}…'`,
                );
            }
        } catch (err) {
            // Auto-pick is best-effort — never block generation on it.
            console.warn("[generate] findLorasForPrompt failed:", err);
        }
    }

    const [row] = await db
        .insert(generatedAssets)
        .values({
            userId,
            kind: "song",
            tier: "T0",
            model: "companion:ace-step+demucs",
            promptText: input.prompt,
            params: {
                durationSec,
                seed: input.seed,
                splitStems,
                lyrics: input.melody?.length ? undefined : undefined, // reserved
            },
            seed: input.seed ?? null,
            durationSec,
            license: "commercial-clean",
            status: "pending",
        })
        .returning();
    const assetId = row!.id;

    try {
        const mode = await getProcessingMode(userId);
        const resp = canUseCompanion(mode)
            ? await generateSongOnCompanion({
                  prompt: input.prompt,
                  durationSec,
                  seeds: input.seed != null ? [input.seed] : undefined,
                  splitStems,
                  ...(effectiveLoraPath && !effectiveLoraPath.startsWith("gs://")
                      ? { loraPath: effectiveLoraPath, loraWeight: effectiveLoraWeight ?? 1.0 }
                      : {}),
              })
            : null;
        if (!resp) {
            // No companion path — either offline (auto) or user picked
            // cloud-only. Use Cloud Run GPU when permitted+configured.
            if (!canUseCloud(mode)) {
                return failAsset(assetId, "Companion unavailable and cloud is disabled (processing mode: companion-only).");
            }
            if (!cloudMusicEnabled()) {
                return failAsset(assetId, mode === "cloud"
                    ? "Processing mode is cloud-only but GCP_ACESTEP_URL is not configured."
                    : "Companion link unavailable for song generation");
            }
            const outputGs = buildSongOutputGs(userId, assetId);
            const cloud = await generateSongOnCloud({
                prompt: input.prompt,
                durationSec,
                seeds: input.seed != null ? [input.seed] : undefined,
                outputGs,
                ...(effectiveLoraPath?.startsWith("gs://")
                    ? { loraGs: effectiveLoraPath, loraWeight: effectiveLoraWeight ?? 1.0 }
                    : {}),
            });
            if (!cloud.ok) {
                return failAsset(assetId, `Cloud ACE-Step: ${cloud.error}`);
            }
            const baseDir = await ensureUserDir(userId);
            const assetDir = path.join(baseDir, assetId);
            await fsp.mkdir(assetDir, { recursive: true });
            await fsp.writeFile(path.join(assetDir, "song.wav"), cloud.songWav);
            const hash = createHash("sha256").update(cloud.songWav).digest("hex");
            const [updated] = await db
                .update(generatedAssets)
                .set({
                    filePath: `${assetId}/song.wav`,
                    fileSize: cloud.songWav.byteLength,
                    contentHash: hash,
                    durationSec,
                    sampleRate: cloud.sampleRate,
                    model: "cloud:ace-step",
                    params: {
                        durationSec,
                        seed: input.seed,
                        splitStems: false,
                        device: cloud.device,
                        outputGs: cloud.outputGs,
                        cloudFallback: true,
                    },
                    status: "ready",
                    error: null,
                    updatedAt: new Date(),
                })
                .where(eq(generatedAssets.id, assetId))
                .returning();
            scheduleAutoEmbed(userId, assetId, `${assetId}/song.wav`, durationSec);
            return toDto(updated!, "ready");
        }

        // Pull song + stems back from companion.
        const songBuf = await fetchEngineJobFile(resp.jobId, resp.song);
        if (!songBuf) return failAsset(assetId, `Failed to fetch generated song (${resp.song})`);

        const baseDir = await ensureUserDir(userId);
        const assetDir = path.join(baseDir, assetId);
        await fsp.mkdir(assetDir, { recursive: true });
        await fsp.writeFile(path.join(assetDir, "song.wav"), songBuf);
        const hash = createHash("sha256").update(songBuf).digest("hex");

        const stemPaths: Record<string, string> = {};
        for (const [name, rel] of Object.entries(resp.stems)) {
            const b = await fetchEngineJobFile(resp.jobId, rel);
            if (!b) continue;
            const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
            const fname = `${safe}.wav`;
            await fsp.writeFile(path.join(assetDir, fname), b);
            stemPaths[name] = `${assetId}/${fname}`;
        }

        const [updated] = await db
            .update(generatedAssets)
            .set({
                filePath: `${assetId}/song.wav`,
                fileSize: songBuf.byteLength,
                contentHash: hash,
                durationSec,
                sampleRate: resp.sampleRate ?? 48000,
                params: {
                    durationSec,
                    seed: input.seed,
                    splitStems,
                    jobId: resp.jobId,
                    device: resp.device,
                    stems: stemPaths,
                },
                status: "ready",
                error: null,
                updatedAt: new Date(),
            })
            .where(eq(generatedAssets.id, assetId))
            .returning();
        scheduleAutoEmbed(userId, assetId, `${assetId}/song.wav`, durationSec);
        return toDto(updated!, "ready");
    } catch (e) {
        return failAsset(assetId, e instanceof Error ? e.message : String(e));
    }
}

async function runReplicate(userId: string, input: GenerateInput): Promise<GeneratedAssetDto> {
    const model = input.model ?? "meta/musicgen";

    const [row] = await db
        .insert(generatedAssets)
        .values({
            userId,
            kind: input.kind,
            tier: "T1",
            model,
            promptText: input.prompt,
            params: { seed: input.seed, durationSec: input.durationSec },
            seed: input.seed ?? null,
            durationSec: input.durationSec ?? null,
            license: "commercial-clean",
            status: "pending",
        })
        .returning();
    const assetId = row!.id;

    try {
        const pred = await createPrediction({
            model,
            input: {
                prompt: input.prompt,
                duration: input.durationSec ?? 8,
                ...(input.seed != null ? { seed: input.seed } : {}),
            },
            waitSec: 60,
        });

        // Persist the prediction id immediately so a poller can pick it up.
        await db.update(generatedAssets)
            .set({ replicatePredictionId: pred.id, updatedAt: new Date() })
            .where(eq(generatedAssets.id, assetId));

        if (pred.status !== "succeeded") {
            return toDto({ ...row!, replicatePredictionId: pred.id }, "pending",
                `Replicate status: ${pred.status} (id ${pred.id}); poll with pollPendingT1Generations.`);
        }

        const outUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output;
        if (!outUrl) return failAsset(assetId, "Replicate returned no output URL");
        return await finalizeFromUrl(userId, assetId, outUrl);
    } catch (err) {
        return failAsset(assetId, err instanceof Error ? err.message : String(err));
    }
}

/** Polls a previously-created T1 asset for completion. */
export async function getGenerationStatus(assetId: string): Promise<GeneratedAssetDto> {
    const userId = await uid();
    const [row] = await db
        .select()
        .from(generatedAssets)
        .where(and(eq(generatedAssets.id, assetId), eq(generatedAssets.userId, userId)))
        .limit(1);
    if (!row) throw new Error("Asset not found");
    if (row.status === "ready") return toDto(row, "ready");
    if (row.status === "failed") return toDto(row, "failed", row.error ?? undefined);
    if (row.tier !== "T1" || !row.replicatePredictionId) {
        return toDto(row, "pending", row.error ?? undefined);
    }
    return await refreshFromReplicate(userId, row);
}

/** Walks all pending T1 assets and pulls their latest Replicate status. */
export async function pollPendingT1Generations(): Promise<{ checked: number; ready: number; failed: number }> {
    const userId = await uid();
    const rows = await db
        .select()
        .from(generatedAssets)
        .where(and(
            eq(generatedAssets.userId, userId),
            eq(generatedAssets.tier, "T1"),
            eq(generatedAssets.status, "pending"),
        ))
        .limit(50);
    let ready = 0;
    let failed = 0;
    for (const r of rows) {
        if (!r.replicatePredictionId) continue;
        const dto = await refreshFromReplicate(userId, r).catch(() => null);
        if (dto?.status === "ready") ready++;
        else if (dto?.status === "failed") failed++;
    }
    void embedMissingForUser(userId);
    return { checked: rows.length, ready, failed };
}

/** Walks all pending T0 stem-separation assets and asks the companion
 *  whether the underlying analyzer job has completed. When a job is
 *  done the row is flipped to `ready` and `params.stemTrackId` is
 *  copied from `params.trackId` so the UI can build stem URLs via
 *  `companionAnalyzer.stemUrl(link, stemTrackId, "vocals" | ...)`.
 *
 *  Failures from the companion (`stage === "error"`) propagate into
 *  `failAsset`. Jobs the companion has forgotten (no longer in the
 *  status window) are treated as failed with a clear message. */
export async function pollPendingT0Generations(): Promise<{ checked: number; ready: number; failed: number }> {
    const userId = await uid();
    const rows = await db
        .select()
        .from(generatedAssets)
        .where(and(
            eq(generatedAssets.userId, userId),
            eq(generatedAssets.tier, "T0"),
            eq(generatedAssets.kind, "stem"),
            eq(generatedAssets.status, "pending"),
        ))
        .limit(50);
    if (rows.length === 0) return { checked: 0, ready: 0, failed: 0 };

    const link = await getCompanionLink().catch(() => null);
    if (!link) return { checked: rows.length, ready: 0, failed: 0 };

    const snapshot = await companionAnalyzer.status(link).catch(() => null);
    if (!snapshot) return { checked: rows.length, ready: 0, failed: 0 };

    const allJobs = [
        ...(snapshot.current ? [snapshot.current] : []),
        ...snapshot.queue,
        ...snapshot.completed,
        ...(snapshot.lanes ?? []).flatMap(l => [
            ...(l.current ? [l.current] : []),
            ...l.queue,
        ]),
    ];
    const jobsById = new Map(allJobs.map(j => [j.id, j]));

    let ready = 0;
    let failed = 0;
    for (const r of rows) {
        const params = (r.params ?? {}) as { trackId?: number; companionJobId?: string };
        if (!params.companionJobId) {
            await failAsset(r.id, "missing companionJobId");
            failed++;
            continue;
        }
        const job = jobsById.get(params.companionJobId);
        if (!job) {
            // Companion has rotated this job out of its window without
            // ever flipping it to done — treat as failed.
            await failAsset(r.id, "companion job not found (likely interrupted)");
            failed++;
            continue;
        }
        if (job.stage === "error" || job.error) {
            await failAsset(r.id, job.error ?? "companion analyzer error");
            failed++;
            continue;
        }
        if (job.stage === "done" || (typeof job.progress === "number" && job.progress >= 1)) {
            await db.update(generatedAssets)
                .set({
                    status: "ready",
                    error: null,
                    params: { ...params, stemTrackId: params.trackId },
                    updatedAt: new Date(),
                })
                .where(eq(generatedAssets.id, r.id));
            ready++;
        }
    }
    void embedMissingForUser(userId);
    return { checked: rows.length, ready, failed };
}

async function refreshFromReplicate(userId: string, row: AssetRow): Promise<GeneratedAssetDto> {
    if (!row.replicatePredictionId) return toDto(row, "pending");
    try {
        const pred = await getPrediction(row.replicatePredictionId);
        if (pred.status === "succeeded") {
            const outUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output;
            if (!outUrl) return failAsset(row.id, "Replicate succeeded with no output URL");
            return await finalizeFromUrl(userId, row.id, outUrl);
        }
        if (pred.status === "failed" || pred.status === "canceled") {
            return failAsset(row.id, pred.error ?? `Replicate ${pred.status}`);
        }
        return toDto(row, "pending", `Replicate status: ${pred.status}`);
    } catch (err) {
        if (err instanceof ReplicateError) {
            return failAsset(row.id, err.message);
        }
        throw err;
    }
}

async function finalizeFromUrl(userId: string, assetId: string, url: string): Promise<GeneratedAssetDto> {
    const buf = await downloadOutput(url);
    const dir = await ensureUserDir(userId);
    const ext = guessExt(url);
    const relPath = `${assetId}.${ext}`;
    const abs = path.join(dir, relPath);
    await fsp.writeFile(abs, buf);

    const hash = createHash("sha256").update(buf).digest("hex");

    const [updated] = await db
        .update(generatedAssets)
        .set({
            filePath: relPath,
            fileSize: buf.byteLength,
            contentHash: hash,
            status: "ready",
            error: null,
            updatedAt: new Date(),
        })
        .where(eq(generatedAssets.id, assetId))
        .returning();
    scheduleAutoEmbed(userId, assetId, relPath, updated?.durationSec ?? null);
    return toDto(updated!, "ready");
}

async function failAsset(assetId: string, reason: string): Promise<GeneratedAssetDto> {
    const [row] = await db
        .update(generatedAssets)
        .set({ status: "failed", error: reason, updatedAt: new Date() })
        .where(eq(generatedAssets.id, assetId))
        .returning();
    return toDto(row!, "failed", reason);
}

function guessExt(url: string): string {
    const m = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(url);
    return m ? m[1]!.toLowerCase() : "wav";
}

export async function listGeneratedAssets(): Promise<GeneratedAssetDto[]> {
    const userId = await uid();
    const rows = await db
        .select()
        .from(generatedAssets)
        .where(eq(generatedAssets.userId, userId))
        .orderBy(desc(generatedAssets.createdAt))
        .limit(200);
    return rows.map((r) => toDto(r, (r.status as GeneratedAssetDto["status"]) ?? (r.filePath ? "ready" : "pending"), r.error ?? undefined));
}

/** List trained ACE-Step LoRA checkpoints available on the user's companion.
 *  Used by the generate UI to populate the LoRA picker for tier=T0+kind=song. */
export async function listAvailableAceLoras(): Promise<CompanionLora[]> {
    await uid(); // auth gate
    return await listCompanionAceLoras();
}

/** Demucs-split an existing T0 song asset into 4 stems on disk and
 *  patch the asset's `params.stems` map. No-op (returns the existing
 *  stems) if the asset already has them. Used by Maestro's
 *  separateAssetStems tool to split an arbitrary previously-generated
 *  song into mixable parts. */
export async function separateGeneratedAssetStems(
    assetId: string,
): Promise<{ ok: true; stems: Record<string, string> } | { ok: false; error: string }> {
    const userId = await uid();
    const [row] = await db
        .select()
        .from(generatedAssets)
        .where(and(eq(generatedAssets.id, assetId), eq(generatedAssets.userId, userId)))
        .limit(1);
    if (!row) return { ok: false, error: "asset-not-found" };
    if (!row.filePath) return { ok: false, error: "asset-not-ready" };

    const existingParams = (row.params ?? {}) as Record<string, unknown>;
    const existingStems = existingParams.stems as Record<string, string> | undefined;
    if (existingStems && Object.keys(existingStems).length >= 4) {
        const urlMap = Object.fromEntries(
            Object.keys(existingStems).map((k) => [k, `/api/generated/${row.id}?stem=${encodeURIComponent(k)}`]),
        );
        return { ok: true, stems: urlMap };
    }

    const absSong = path.join(GENERATED_DIR, userId, row.filePath);
    try {
        await fsp.access(absSong);
    } catch {
        return { ok: false, error: "source-file-missing" };
    }

    const sep = await separateOnCompanion(absSong);
    if (!sep) return { ok: false, error: "companion-unavailable" };

    const assetDir = path.dirname(absSong);
    const stemPaths: Record<string, string> = { ...(existingStems ?? {}) };
    for (const [name, rel] of Object.entries(sep.stems)) {
        const buf = await fetchEngineJobFile(sep.jobId, rel);
        if (!buf) continue;
        const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
        const fname = `${safe}.wav`;
        await fsp.writeFile(path.join(assetDir, fname), buf);
        stemPaths[name] = path.posix.join(path.basename(assetDir), fname);
    }

    await db
        .update(generatedAssets)
        .set({
            params: { ...existingParams, stems: stemPaths, splitStems: true } as Record<string, unknown>,
        })
        .where(eq(generatedAssets.id, assetId));

    const urlMap = Object.fromEntries(
        Object.keys(stemPaths).map((k) => [k, `/api/generated/${row.id}?stem=${encodeURIComponent(k)}`]),
    );
    return { ok: true, stems: urlMap };
}

/** Spawn the local ACE-Step LoRA training script (`scripts/train-acestep-lora.ps1`)
 *  detached. Returns a short job id + log path the caller can tail.
 *  Training runs for hours; this fire-and-forget interface keeps the
 *  Maestro tool synchronous. */
export async function startAceStepLoraTraining(input: {
    expName: string;
    dataDir: string;
    maxSteps?: number;
    repeatCount?: number;
}): Promise<
    | { ok: true; jobId: string; pid: number; logPath: string }
    | { ok: false; error: string }
> {
    await uid();
    const expName = input.expName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    if (!expName) return { ok: false, error: "invalid-exp-name" };
    if (!input.dataDir) return { ok: false, error: "dataDir-required" };
    try {
        await fsp.access(input.dataDir);
    } catch {
        return { ok: false, error: `dataDir-not-found: ${input.dataDir}` };
    }

    // Resolve workspace root (cwd is e:\gh\mmo\app). Training script
    // lives at e:\gh\mmo\scripts\train-acestep-lora.ps1.
    const workspaceRoot = path.resolve(process.cwd(), "..");
    const scriptPath = path.join(workspaceRoot, "scripts", "train-acestep-lora.ps1");
    try {
        await fsp.access(scriptPath);
    } catch {
        return { ok: false, error: `script-not-found: ${scriptPath}` };
    }

    const logDir = path.join(workspaceRoot, "app", "data", "lora-training-logs");
    await fsp.mkdir(logDir, { recursive: true });
    const jobId = `lora-${Date.now().toString(36)}`;
    const logPath = path.join(logDir, `${jobId}.log`);

    const args = [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", scriptPath,
        "-DataDir", input.dataDir,
        "-ExpName", expName,
        ...(input.maxSteps ? ["-MaxSteps", String(input.maxSteps)] : []),
        ...(input.repeatCount ? ["-RepeatCount", String(input.repeatCount)] : []),
    ];

    const { spawn } = await import("node:child_process");
    const out = await fsp.open(logPath, "a");
    const child = spawn("pwsh", args, {
        cwd: workspaceRoot,
        detached: true,
        stdio: ["ignore", out.fd, out.fd],
        env: {
            ...process.env,
            // Critical: ACE-Step venv inherits base CUDA torch via
            // user-site fallback; setting this breaks it.
            PYTHONNOUSERSITE: "",
        },
    });
    child.unref();
    void out.close();
    if (!child.pid) return { ok: false, error: "spawn-failed" };
    return { ok: true, jobId, pid: child.pid, logPath };
}

/**
 * Synthesize a spoken intro/outro line via Azure Neural TTS and store it as a
 * generated asset. Saves the MP3 under data/generated/<userId>/<id>.mp3 and
 * records a `vocal` row with status="ready" so the Maestro UI can immediately
 * drop it onto a DAW track.
 *
 * Pricing: ~$15 / 1M characters. A 30-second intro is ~250 chars = $0.004.
 */
export async function synthesizeAzureIntro(input: {
    text: string;
    voice?: string;
    rate?: number;
    pitchSemitones?: number;
    style?: string;
}): Promise<GeneratedAssetDto> {
    const userId = await uid();
    if (!input.text?.trim()) throw new Error("text is required");
    if (input.text.length > 2000) throw new Error("text must be ≤ 2000 chars");

    const { synthesizeAzureTts } = await import("@/lib/azure-speech");
    const voice = input.voice ?? "ro-RO-AlinaNeural";

    const [row] = await db
        .insert(generatedAssets)
        .values({
            userId,
            kind: "vocal",
            tier: "T2",
            model: `cloud:azure-tts:${voice}`,
            promptText: input.text,
            params: {
                voice,
                rate: input.rate ?? 1.0,
                pitchSemitones: input.pitchSemitones ?? 0,
                style: input.style ?? null,
                mode: "tts",
                provider: "azure",
            },
            license: "commercial-clean",
            status: "pending",
        })
        .returning();
    const assetId = row!.id;

    try {
        const result = await synthesizeAzureTts({
            text: input.text,
            voice,
            rate: input.rate,
            pitch: input.pitchSemitones,
            style: input.style,
        });
        const dir = await ensureUserDir(userId);
        const filename = `${assetId}.mp3`;
        await fsp.writeFile(path.join(dir, filename), result.audio);

        const [updated] = await db
            .update(generatedAssets)
            .set({
                filePath: filename,
                fileSize: result.audio.byteLength,
                status: "ready",
                error: null,
            })
            .where(eq(generatedAssets.id, assetId))
            .returning();
        scheduleAutoEmbed(userId, assetId, filename, null);
        return toDto(updated!, "ready");
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failAsset(assetId, msg);
    }
}

export async function deleteGeneratedAsset(id: string): Promise<void> {
    const userId = await uid();
    const [row] = await db
        .select()
        .from(generatedAssets)
        .where(and(eq(generatedAssets.id, id), eq(generatedAssets.userId, userId)))
        .limit(1);
    if (!row) return;
    if (row.filePath) {
        const abs = path.join(GENERATED_DIR, userId, row.filePath);
        await fsp.unlink(abs).catch(() => {});
    }
    await db.delete(generatedAssets).where(eq(generatedAssets.id, id));
}

// ─── Cloud-Run mastering ─────────────────────────────────────────────────

/**
 * Master a ready generated asset via the Cloud Run mastering service.
 *
 *   1. Upload the source WAV to gs://<GCS_BUCKET_GENERATED>/master-in/<userId>/<assetId>.wav
 *   2. POST { input, output, preset } to GCP_MASTERING_URL with a Google
 *      ID token for audience = GCP_MASTERING_URL (the Cloud Run hostname).
 *   3. Download the mastered output back into data/generated/<userId>/ and
 *      create a new `generated_assets` row pointing at it.
 *
 * Returns the new asset DTO so the UI can play/download it directly.
 *
 * Requires env: GCP_MASTERING_URL, GCS_BUCKET_GENERATED, GCP_PROJECT_ID.
 * Optional env: GOOGLE_APPLICATION_CREDENTIALS for local dev (a workload
 * identity / instance metadata mint also works when deployed on GCP).
 */
export async function masterGeneratedAsset(input: {
    assetId: string;
    preset?: "minimal" | "standard" | "pro";
}): Promise<
    | { ok: true; asset: GeneratedAssetDto }
    | { ok: false; error: string }
> {
    const userId = await uid();
    const masteringUrl = process.env.GCP_MASTERING_URL;
    const bucket = process.env.GCS_BUCKET_GENERATED ?? "mmo-generated-prod";
    if (!masteringUrl) {
        return { ok: false, error: "GCP_MASTERING_URL not configured" };
    }

    // 1. Load + validate source asset.
    const [src] = await db
        .select()
        .from(generatedAssets)
        .where(and(eq(generatedAssets.id, input.assetId), eq(generatedAssets.userId, userId)))
        .limit(1);
    if (!src) return { ok: false, error: "asset-not-found" };
    if (src.status !== "ready" || !src.filePath) return { ok: false, error: "asset-not-ready" };

    const preset = input.preset ?? "pro";
    const srcAbs = path.join(GENERATED_DIR, userId, src.filePath);
    if (!(await fsp.stat(srcAbs).catch(() => null))) {
        return { ok: false, error: "source-file-missing" };
    }

    // 2. Create a new pending asset row up-front so the UI gets immediate
    //    feedback and so any failure marks the right row.
    const [mastered] = await db
        .insert(generatedAssets)
        .values({
            userId,
            kind: src.kind,
            tier: "T0",
            model: `cloud:mastering:${preset}`,
            promptText: src.promptText,
            params: { sourceAssetId: src.id, preset, mastered: true },
            seed: src.seed,
            durationSec: src.durationSec,
            license: src.license,
            status: "pending",
        })
        .returning();
    const masteredId = mastered!.id;

    try {
        // 3. Upload source to GCS.
        const { Storage } = await import("@google-cloud/storage");
        const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID ?? "mmo-mw-prod" });
        const inObject = `master-in/${userId}/${src.id}.wav`;
        const outObject = `master-out/${userId}/${masteredId}.wav`;
        await storage.bucket(bucket).upload(srcAbs, {
            destination: inObject,
            resumable: false,
            metadata: { contentType: "audio/wav" },
        });

        // 4. Mint a Google-signed ID token for the Cloud Run audience.
        let idToken: string | null = null;
        try {
            const ga = await import("google-auth-library");
            const auth = new ga.GoogleAuth();
            const client = await auth.getIdTokenClient(masteringUrl);
            const headers = await client.getRequestHeaders();
            const h = headers as unknown as { get?: (k: string) => string | null } & Record<string, string>;
            const authHeader = typeof h.get === "function" ? h.get("Authorization") : h["Authorization"];
            if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
                idToken = authHeader.slice("Bearer ".length);
            }
        } catch (e) {
            return await failAsset(masteredId, `id-token-mint-failed: ${e instanceof Error ? e.message : String(e)}`)
                .then(() => ({ ok: false, error: "id-token-mint-failed" }));
        }
        if (!idToken) {
            await failAsset(masteredId, "no-id-token");
            return { ok: false, error: "no-id-token (configure GOOGLE_APPLICATION_CREDENTIALS or run on GCP)" };
        }

        // 5. Call the Cloud Run /master endpoint.
        const resp = await fetch(`${masteringUrl.replace(/\/$/, "")}/master`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({
                input: `gs://${bucket}/${inObject}`,
                output: `gs://${bucket}/${outObject}`,
                preset,
            }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            await failAsset(masteredId, `cloud-run ${resp.status}: ${text.slice(0, 400)}`);
            return { ok: false, error: `cloud-run-${resp.status}` };
        }

        // 6. Download output back into data/generated/<userId>/.
        const dir = await ensureUserDir(userId);
        const relPath = `${masteredId}.wav`;
        const localAbs = path.join(dir, relPath);
        await storage.bucket(bucket).file(outObject).download({ destination: localAbs });
        const stat = await fsp.stat(localAbs);
        const buf = await fsp.readFile(localAbs);
        const hash = createHash("sha256").update(buf).digest("hex");

        const [updated] = await db
            .update(generatedAssets)
            .set({
                filePath: relPath,
                fileSize: stat.size,
                contentHash: hash,
                status: "ready",
                error: null,
                updatedAt: new Date(),
            })
            .where(eq(generatedAssets.id, masteredId))
            .returning();

        // 7. Best-effort cleanup of GCS staging objects (don't block).
        void storage.bucket(bucket).file(inObject).delete({ ignoreNotFound: true }).catch(() => {});
        void storage.bucket(bucket).file(outObject).delete({ ignoreNotFound: true }).catch(() => {});

        scheduleAutoEmbed(userId, masteredId, relPath, src.durationSec ?? null);
        return { ok: true, asset: toDto(updated!, "ready") };
    } catch (e) {
        await failAsset(masteredId, e instanceof Error ? e.message : String(e));
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

// ─── Send to DAW ─────────────────────────────────────────────────────────

/**
 * Take a ready generated asset, split it into 4 stems (if not already split),
 * and either append the stems to the user's currently-open project or
 * create a new project named after the prompt.
 *
 * Returns the project externalId so the UI can router.push(`/daw/<id>`).
 */
export async function sendGeneratedAssetToDaw(
    assetId: string,
    mode: "append" | "create",
    currentProjectExternalId?: string,
): Promise<
    | { ok: true; projectExternalId: string; appended: boolean; trackIds: string[] }
    | { ok: false; error: string }
> {
    const userId = await uid();
    const [row] = await db
        .select()
        .from(generatedAssets)
        .where(and(eq(generatedAssets.id, assetId), eq(generatedAssets.userId, userId)))
        .limit(1);
    if (!row) return { ok: false, error: "asset-not-found" };
    if (row.status !== "ready" || !row.filePath) return { ok: false, error: "asset-not-ready" };

    // 1. Ensure stems exist (no-op if already split).
    const sep = await separateGeneratedAssetStems(assetId);
    if (!sep.ok) return { ok: false, error: `stem-split-failed: ${sep.error}` };

    const { dawProjects } = await import("@/db/schema-projects");
    const { saveProject } = await import("@/actions/projects");

    // 2. Decide append vs create.
    let projectExternalId: string;
    let existingDoc: Record<string, unknown> | null = null;
    let appended = false;

    if (mode === "append" && currentProjectExternalId) {
        const [proj] = await db
            .select({ document: dawProjects.document })
            .from(dawProjects)
            .where(and(
                eq(dawProjects.userId, userId),
                eq(dawProjects.externalId, currentProjectExternalId),
            ))
            .limit(1);
        if (proj?.document) {
            existingDoc = proj.document as Record<string, unknown>;
            projectExternalId = currentProjectExternalId;
            appended = true;
        } else {
            // requested project doesn't exist → fall through to create
            projectExternalId = newProjectId();
        }
    } else {
        projectExternalId = newProjectId();
    }

    // 3. Build the project document (either from existing or fresh).
    const promptLabel = (row.promptText ?? "Generated song").slice(0, 64);
    const now = Date.now();
    const tempo = (existingDoc?.tempo as number | undefined) ?? 120;
    const existingTracks = (existingDoc?.tracks as unknown[] | undefined) ?? [];
    const durSec = row.durationSec ?? 30;
    const lenBeats = Math.max(0.25, (durSec * tempo) / 60);

    const stemOrder = ["drums", "bass", "other", "vocals"] as const;
    const stemColors: Record<string, string> = {
        drums: "#f97316",
        bass: "#3b82f6",
        other: "#a855f7",
        vocals: "#10b981",
    };

    // Idempotency: if appending and every stem URL is already a clip on some
    // audio track in this project, reuse those tracks instead of creating
    // duplicates. Mirrors findExistingStemTracks() in maestro/tools.ts.
    if (appended && existingDoc) {
        const stemUrls = stemOrder
            .map((s) => sep.stems[s])
            .filter((u): u is string => typeof u === "string" && u.length > 0);
        if (stemUrls.length > 0) {
            const trackList = existingTracks as Array<Record<string, unknown>>;
            const matched: string[] = [];
            const usedTrackIds = new Set<string>();
            for (const url of stemUrls) {
                let found: string | null = null;
                for (const t of trackList) {
                    if (usedTrackIds.has(t.id as string)) continue;
                    if (t.type !== "audio") continue;
                    const clips = (t.clips as Array<Record<string, unknown>> | undefined) ?? [];
                    for (const c of clips) {
                        const audio = c.audio as Record<string, unknown> | undefined;
                        if (audio?.sourceUrl === url) { found = t.id as string; break; }
                    }
                    if (found) { usedTrackIds.add(found); break; }
                }
                if (!found) { matched.length = 0; break; }
                matched.push(found);
            }
            if (matched.length === stemUrls.length) {
                return { ok: true, projectExternalId, appended: true, trackIds: matched };
            }
        }
    }

    const newTrackIds: string[] = [];
    const newTracks: Record<string, unknown>[] = [];
    let colorSeed = existingTracks.length;
    for (const stem of stemOrder) {
        const url = sep.stems[stem];
        if (!url) continue;
        const trackId = mkId();
        const clipId = mkId();
        newTrackIds.push(trackId);
        newTracks.push({
            id: trackId,
            name: `${promptLabel} — ${stem[0]!.toUpperCase()}${stem.slice(1)}`,
            type: "audio",
            color: stemColors[stem] ?? pickColor(colorSeed++),
            volume: 0.8,
            pan: 0,
            muted: false,
            soloed: false,
            armed: false,
            frozen: false,
            height: 80,
            inserts: [],
            sends: [],
            automationLanes: [],
            inputSource: "none",
            outputTarget: "master",
            peakL: 0,
            peakR: 0,
            clips: [
                {
                    id: clipId,
                    type: "audio",
                    name: stem,
                    trackId,
                    position: 0,
                    length: lenBeats,
                    color: stemColors[stem],
                    muted: false,
                    audio: {
                        buffer: null,
                        sourceUrl: url,
                        name: stem,
                        startOffset: 0,
                        duration: durSec,
                        sampleRate: 48000,
                        channels: 2,
                        gain: 1,
                        timeStretch: 1,
                        pitchShift: 0,
                        fadeIn: 0,
                        fadeOut: 0,
                    },
                },
            ],
        });
    }

    const newDoc: Record<string, unknown> = appended && existingDoc
        ? {
            ...existingDoc,
            tracks: [...existingTracks, ...newTracks],
            modifiedAt: now,
        }
        : {
            id: projectExternalId,
            name: promptLabel,
            tempo: 120,
            timeSignature: { numerator: 4, denominator: 4 },
            tracks: newTracks,
            masterTrack: {
                id: mkId(),
                name: "Master",
                type: "master",
                color: "#ef4444",
                volume: 0.85,
                pan: 0,
                muted: false,
                soloed: false,
                armed: false,
                frozen: false,
                height: 80,
                inserts: [],
                sends: [],
                clips: [],
                automationLanes: [],
                inputSource: "none",
                outputTarget: "master",
                peakL: 0,
                peakR: 0,
            },
            loopRegion: { start: 0, end: 16, enabled: false },
            createdAt: now,
            modifiedAt: now,
            duration: Math.max(64, Math.ceil(lenBeats)),
        };

    await saveProject({
        kind: "daw",
        externalId: projectExternalId,
        name: appended ? undefined : promptLabel,
        document: newDoc,
        extras: appended ? undefined : { bpm: 120 },
    });

    return { ok: true, projectExternalId, appended, trackIds: newTrackIds };
}

function mkId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newProjectId(): string {
    return `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const _TRACK_COLORS = [
    "#8b5cf6", "#3b82f6", "#06b6d4", "#10b981", "#22c55e",
    "#eab308", "#f97316", "#ef4444", "#ec4899", "#a855f7",
];
function pickColor(seed: number): string {
    return _TRACK_COLORS[Math.abs(seed) % _TRACK_COLORS.length]!;
}

// ─── Vertex AI training submission ───────────────────────────────────────

/**
 * Submit an ACE-Step LoRA training job to Vertex AI (GPU, GCP).
 *
 * Differs from `startAceStepLoraTraining` (which runs locally on the
 * companion's GPU) by using a cloud A100 spot instance — useful when the
 * user has no local GPU or wants to train faster (≈ 6h on A100 vs 12h
 * on RTX 3060). Dataset must already be uploaded to gs://mmo-training-prod/.
 *
 * Cost on A100 40GB spot ≈ $1.10/hr × 6h = ~$7 per LoRA training run.
 *
 * Returns immediately with the Vertex job name; training continues
 * asynchronously. Use the consoleUrl to monitor progress.
 */
// Region override for trainer submissions. SPOT L4 capacity is most
// reliable in `us-central1` (verified 2026-05; `europe-west4` spot was
// starved for 30+ min with PENDING jobs). Override via env if you need
// EU residency or a closer region to a private dataset.
function trainingRegion(): string {
    return process.env.GCP_TRAINING_REGION ?? process.env.GCP_REGION ?? "us-central1";
}

export async function submitAceStepLoraTrainingVertex(input: {
    expName: string;
    datasetUri: string; // gs://mmo-training-prod/<jobId>/dataset/
    outputUri: string;  // gs://mmo-training-prod/<jobId>/output/
    maxSteps?: number;
    rank?: number;
    spot?: boolean;
    jobId?: string;  // training_jobs.id — enables live monitor/control
    appUrl?: string; // base URL of this app for webhook + control endpoints
    machineType?: string;
    acceleratorType?: string;
    acceleratorCount?: number;
    learningRate?: number;
    batchSize?: number;
}): Promise<
    | { ok: true; jobName: string; jobId: string; consoleUrl: string }
    | { ok: false; error: string }
> {
    await uid();
    if (!input.expName.trim()) return { ok: false, error: "expName-required" };
    if (!input.datasetUri.startsWith("gs://")) return { ok: false, error: "datasetUri-must-be-gs-uri" };
    if (!input.outputUri.startsWith("gs://")) return { ok: false, error: "outputUri-must-be-gs-uri" };

    const workspaceRoot = path.resolve(process.cwd(), "..");
    const scriptPath = path.join(workspaceRoot, "infra", "vertex", "submit-training.py");
    try {
        await fsp.access(scriptPath);
    } catch {
        return { ok: false, error: `submit-script-missing: ${scriptPath}` };
    }

    const args = [
        scriptPath,
        "--exp-name", input.expName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
        "--dataset-uri", input.datasetUri,
        "--output-uri", input.outputUri,
        "--max-steps", String(input.maxSteps ?? 1500),
        "--rank", String(input.rank ?? 16),
        ...(input.spot === false ? [] : ["--spot"]),
        ...(input.jobId ? ["--job-id", input.jobId] : []),
        ...(input.appUrl ? ["--app-url", input.appUrl] : []),
        ...(input.machineType ? ["--machine-type", input.machineType] : []),
        ...(input.acceleratorType ? ["--accelerator-type", input.acceleratorType] : []),
        ...(input.acceleratorCount ? ["--accelerator-count", String(input.acceleratorCount)] : []),
        ...(input.learningRate ? ["--lr", String(input.learningRate)] : []),
        ...(input.batchSize ? ["--batch-size", String(input.batchSize)] : []),
    ];

    const { spawn } = await import("node:child_process");
    // Image lives in artifact-registry region (europe-west1) regardless
    // of where the training job runs. Vertex supports cross-region pulls.
    const trainerImage = process.env.VERTEX_TRAINER_IMAGE
        ?? "europe-west1-docker.pkg.dev/mmo-mw-prod/mmo-training/mmo-ace-step:latest";
    return new Promise((resolve) => {
        const child = spawn("python", args, {
            cwd: workspaceRoot,
            env: {
                ...process.env,
                GCP_PROJECT_ID: process.env.GCP_PROJECT_ID ?? "mmo-mw-prod",
                GCP_REGION: trainingRegion(),
                VERTEX_TRAINER_IMAGE: trainerImage,
            },
        });
        let stdout = "";
        let stderr = "";
        // Hard 60s cap. Vertex job submission is a single REST call; if it
        // takes longer than this the SDK is hung and the child needs killing.
        const killTimer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
            resolve({ ok: false, error: "vertex-submit-timeout-60s" });
        }, 60_000);
        child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
        child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
        child.on("error", (e) => { clearTimeout(killTimer); resolve({ ok: false, error: `spawn: ${e.message}` }); });
        child.on("close", (code) => {
            clearTimeout(killTimer);
            // The Python script always prints one JSON line on stdout.
            const lastLine = stdout.trim().split("\n").pop() ?? "";
            try {
                const parsed = JSON.parse(lastLine) as
                    | { ok: true; jobName: string; jobId: string; consoleUrl: string }
                    | { ok: false; error: string };
                resolve(parsed);
            } catch {
                resolve({
                    ok: false,
                    error: `python-exit-${code}: ${(stderr || stdout).slice(0, 500)}`,
                });
            }
        });
    });
}

/**
 * Submit a Conductor (Maestro brain) SFT or DPO training job to Vertex.
 * Reuses the same `submit-training.py` script with `VERTEX_TRAINER_IMAGE`
 * overridden to point at the conductor image so kind selection is purely
 * environmental — no script duplication.
 */
export async function submitConductorTrainingVertex(input: {
    expName: string;
    datasetUri: string;
    outputUri: string;
    mode: "sft" | "dpo";
    maxSteps?: number;
    rank?: number;
    spot?: boolean;
    jobId?: string;
    appUrl?: string;
}): Promise<
    | { ok: true; jobName: string; jobId: string; consoleUrl: string }
    | { ok: false; error: string }
> {
    await uid();
    if (!input.expName.trim()) return { ok: false, error: "expName-required" };
    if (!input.datasetUri.startsWith("gs://")) return { ok: false, error: "datasetUri-must-be-gs-uri" };
    if (!input.outputUri.startsWith("gs://")) return { ok: false, error: "outputUri-must-be-gs-uri" };

    const workspaceRoot = path.resolve(process.cwd(), "..");
    const scriptPath = path.join(workspaceRoot, "infra", "vertex", "submit-training.py");
    try {
        await fsp.access(scriptPath);
    } catch {
        return { ok: false, error: `submit-script-missing: ${scriptPath}` };
    }

    const args = [
        scriptPath,
        "--exp-name", input.expName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
        "--dataset-uri", input.datasetUri,
        "--output-uri", input.outputUri,
        "--max-steps", String(input.maxSteps ?? 1500),
        "--rank", String(input.rank ?? 16),
        ...(input.spot === false ? [] : ["--spot"]),
        ...(input.jobId ? ["--job-id", input.jobId] : []),
        ...(input.appUrl ? ["--app-url", input.appUrl] : []),
    ];

    const conductorImage = process.env.VERTEX_CONDUCTOR_TRAINER_IMAGE
        ?? "europe-west1-docker.pkg.dev/mmo-mw-prod/mmo-training/conductor-trainer:latest";

    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
        const child = spawn("python", args, {
            cwd: workspaceRoot,
            env: {
                ...process.env,
                GCP_PROJECT_ID: process.env.GCP_PROJECT_ID ?? "mmo-mw-prod",
                GCP_REGION: trainingRegion(),
                VERTEX_TRAINER_IMAGE: conductorImage,
                CONDUCTOR_MODE: input.mode,
            },
        });
        let stdout = "";
        let stderr = "";
        const killTimer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
            resolve({ ok: false, error: "vertex-submit-timeout-60s" });
        }, 60_000);
        child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
        child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
        child.on("error", (e) => { clearTimeout(killTimer); resolve({ ok: false, error: `spawn: ${e.message}` }); });
        child.on("close", (code) => {
            clearTimeout(killTimer);
            const lastLine = stdout.trim().split("\n").pop() ?? "";
            try {
                const parsed = JSON.parse(lastLine) as
                    | { ok: true; jobName: string; jobId: string; consoleUrl: string }
                    | { ok: false; error: string };
                resolve(parsed);
            } catch {
                resolve({
                    ok: false,
                    error: `python-exit-${code}: ${(stderr || stdout).slice(0, 500)}`,
                });
            }
        });
    });
}

type AssetRow = typeof generatedAssets.$inferSelect;

function toDto(row: AssetRow, status: "ready" | "pending" | "failed", error?: string): GeneratedAssetDto {
    const params = (row.params ?? null) as { stemTrackId?: number; stems?: Record<string, string> } | null;
    const songStems = params?.stems && typeof params.stems === "object"
        ? Object.fromEntries(
            Object.keys(params.stems).map((k) => [k, `/api/generated/${row.id}?stem=${encodeURIComponent(k)}`]),
        )
        : null;
    return {
        id: row.id,
        tier: row.tier as GenTier,
        kind: row.kind as GenKind,
        model: row.model,
        prompt: row.promptText,
        license: (row.license as GeneratedAssetDto["license"]) ?? "unknown",
        durationSec: row.durationSec,
        sampleRate: row.sampleRate,
        fileSize: row.fileSize,
        fileUrl: row.filePath ? `/api/generated/${row.id}` : null,
        stemTrackId: typeof params?.stemTrackId === "number" ? params.stemTrackId : null,
        songStems,
        status,
        error: error ?? null,
        createdAt: (row.createdAt ?? new Date()).toISOString(),
    };
}
