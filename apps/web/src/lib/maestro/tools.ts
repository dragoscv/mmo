import "server-only";

/**
 * Maestro tool catalog.
 *
 * Each tool follows the Vercel AI SDK v5 contract: `tool({ description,
 * inputSchema, execute })`. Tools receive `{ userId, sessionId,
 * allowDestructive, currentProjectExternalId? }` via closure (see
 * `buildTools()`) so individual `execute` fns stay pure on their declared
 * inputs.
 *
 * DAW tools operate on the `dawProjects.document` JSON blob — the same
 * source of truth the DAW UI reads/writes through `useProjectAutosave`.
 * Positions and lengths are in **beats** (matching `DAWProject` in
 * `lib/daw-engine.ts`); the UI converts to seconds via tempo.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { tracks, syncLog } from "@/db/schema";
import { dawProjects } from "@/db/schema-projects";
import { and, eq, ilike, or, desc, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { buildTrainingTools as buildTrainingToolsLazy } from "./training-tools";

export interface ToolContext {
    userId: string;
    sessionId: string;
    /** When false, destructive tools refuse and ask for confirmation. */
    allowDestructive: boolean;
    /** External id of the DAW project the user has open in the UI, if any. */
    currentProjectExternalId?: string;
}

function refusedDestructive(toolName: string) {
    return {
        ok: false as const,
        reason: "destructive-disabled" as const,
        message: `${toolName} requires ai.agent.allowDestructive. Toggle it in /settings/copilot → Agent.`,
    };
}

async function appendSync(
    userId: string,
    entity: string,
    entityId: string,
    op: "upsert" | "delete",
    payload: Record<string, unknown> | null,
) {
    await db.insert(syncLog).values({
        userId,
        entity,
        entityId,
        op,
        payload: payload as object | null,
        originDeviceId: null,
    });
}

// ─── DAW document helpers ───────────────────────────────────────────────

interface MidiNoteDoc {
    id: string;
    pitch: number;
    velocity: number;
    start: number;
    duration: number;
    channel: number;
}

interface ClipDoc {
    id: string;
    type: "audio" | "midi";
    name: string;
    trackId: string;
    position: number;
    length: number;
    color: string;
    muted: boolean;
    midi?: { notes: MidiNoteDoc[]; instrumentId: string };
    audio?: Record<string, unknown>;
}

interface TrackDoc {
    id: string;
    name: string;
    type: "audio" | "midi" | "return" | "master";
    color: string;
    volume: number;
    pan: number;
    muted: boolean;
    soloed: boolean;
    armed: boolean;
    frozen: boolean;
    height: number;
    inserts: InsertEffectDoc[];
    sends: unknown[];
    clips: ClipDoc[];
    automationLanes: AutomationLaneDoc[];
    inputSource: string;
    outputTarget: string;
    instrumentId?: string;
    peakL: number;
    peakR: number;
}

interface InsertEffectDoc {
    id: string;
    type: string;
    enabled: boolean;
    params: Record<string, number>;
    sidechainSourceTrackId?: string;
}

interface AutomationPointDoc {
    time: number;
    value: number;
    curve: "linear" | "exponential" | "step";
}

interface AutomationLaneDoc {
    id: string;
    trackId: string;
    parameter: string;
    points: AutomationPointDoc[];
    visible: boolean;
    color: string;
    mode: "read" | "write" | "touch" | "latch";
}

interface ProjectDoc {
    id: string;
    name: string;
    tempo: number;
    timeSignature: { numerator: number; denominator: number };
    tracks: TrackDoc[];
    masterTrack: TrackDoc;
    loopRegion: { start: number; end: number; enabled: boolean };
    createdAt: number;
    modifiedAt: number;
    duration: number;
}

function newId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Sample manifest (read-only, cached) ────────────────────────────────

interface SampleEntry {
    file: string;
    path: string;
    name: string;
    type: string;
    duration: number;
    sizeKB: number;
    oneshot: boolean;
    bpm: number | null;
    key: string | null;
    brightness?: string;
    rmsDb?: number;
}

interface SampleManifest {
    version: number;
    name: string;
    categories: Array<{
        path: string;
        label: string;
        genres: Array<{ name: string; label: string; path: string; samples: SampleEntry[] }>;
    }>;
}

let _manifestCache: { loadedAt: number; data: SampleManifest } | null = null;
async function loadSampleManifest(): Promise<SampleManifest | null> {
    if (_manifestCache && Date.now() - _manifestCache.loadedAt < 5 * 60_000) {
        return _manifestCache.data;
    }
    try {
        const p = path.join(process.cwd(), "public", "samples", "manifest.json");
        const raw = await fsp.readFile(p, "utf8");
        const data = JSON.parse(raw) as SampleManifest;
        _manifestCache = { loadedAt: Date.now(), data };
        return data;
    } catch {
        return null;
    }
}

// ─── FX defaults (mirrored from audio-fx-engine to keep tools.ts server-pure) ─

const FX_DEFAULTS: Record<string, Record<string, number>> = {
    eq3: { low: 0, mid: 0, high: 0 },
    parametricEq: { freq1: 200, gain1: 0, q1: 1, freq2: 1000, gain2: 0, q2: 1, freq3: 5000, gain3: 0, q3: 1 },
    compressor: { threshold: -24, knee: 30, ratio: 4, attack: 0.003, release: 0.25, makeupGain: 0 },
    limiter: { threshold: -1, release: 0.1 },
    gate: { threshold: -40, attack: 0.001, release: 0.1 },
    reverb: { mix: 0.3, decay: 2.5, preDelay: 0.02, damping: 0.5 },
    delay: { mix: 0.3, time: 0.375, feedback: 0.4, damping: 0.3 },
    chorus: { rate: 1.5, depth: 0.5, mix: 0.5 },
    flanger: { rate: 0.5, depth: 0.7, feedback: 0.5, mix: 0.5 },
    phaser: { rate: 0.5, depth: 0.7, feedback: 0.5, mix: 0.5, stages: 4 },
    distortion: { drive: 0.5, tone: 0.5, mix: 0.5 },
    bitcrusher: { bits: 8, sampleRate: 0.5, mix: 0.5 },
    filter: { type: 0, cutoff: 8000, resonance: 1, mix: 1 },
    sidechain: { threshold: -20, ratio: 8, attack: 0.001, release: 0.2 },
    stereoWidth: { width: 1 },
    deEsser: { threshold: -20, frequency: 6000, ratio: 4 },
    saturator: { drive: 0.3, mix: 0.5, tone: 0.5 },
    tremolo: { rate: 4, depth: 0.5 },
    pingPongDelay: { mix: 0.3, time: 0.25, feedback: 0.4, spread: 0.8 },
    convolutionReverb: { mix: 0.3, decay: 2 },
    autotune: { speed: 0.1, amount: 1.0, key: 0, scale: 0 },
    pitchShift: { semitones: 0, cents: 0, mix: 1 },
    noiseSuppression: { threshold: -40, reduction: 20, attack: 0.005, release: 0.05 },
    vocoderLite: { bands: 16, attack: 0.005, release: 0.02, mix: 0.8 },
};

const FX_TYPES = Object.keys(FX_DEFAULTS) as Array<keyof typeof FX_DEFAULTS>;

// ─── Genre presets for generateMusic ───────────────────────────────────
// Tag-style hints that ACE-Step / MusicGen respond strongly to.
// `extras` is appended verbatim before the user prompt. `negative` is
// merged into the negativePrompt passed by the caller.

const GENRE_PRESETS: Record<string, {
    bpm: [number, number];
    extras: string;
    negative: string;
    masterPreset?: "minimal" | "standard" | "pro";
}> = {
    "melodic-techno":  { bpm: [120, 126], extras: "melodic techno, rolling sub bass, hypnotic plucky arp, four-on-the-floor kick, crisp hats, atmospheric pad, side-chained", negative: "vocals, lyrics, rap, distorted, lo-fi, glitch", masterPreset: "pro" },
    "techno":          { bpm: [128, 138], extras: "driving techno, punchy kick, dark synth stab, industrial percussion, hypnotic groove", negative: "vocals, lyrics, cheesy, pop, ballad", masterPreset: "pro" },
    "tech-house":      { bpm: [124, 128], extras: "tech-house, shuffled hats, deep filtered bassline, percussive top, vocal chop stab, groovy", negative: "distorted, harsh, lo-fi", masterPreset: "pro" },
    "psytrance":       { bpm: [140, 148], extras: "psytrance, rolling 16th-note bass, screechy hoover lead, snare rolls, energetic drop, mystical pads", negative: "vocals, lyrics, slow, acoustic", masterPreset: "pro" },
    "acid":            { bpm: [125, 135], extras: "acid, squelchy 303 bassline, resonant filter sweeps, raw analog drums, hypnotic", negative: "orchestral, vocals, ballad", masterPreset: "pro" },
    "trance":          { bpm: [134, 140], extras: "uplifting trance, supersaw lead, gated pluck, big breakdown, euphoric chord progression", negative: "distorted, lo-fi, rap", masterPreset: "pro" },
    "dnb":             { bpm: [170, 178], extras: "drum and bass, fast amen-style breakbeat, deep reese bass, atmospheric pads", negative: "slow, vocals, ballad", masterPreset: "pro" },
    "trap":            { bpm: [140, 150], extras: "trap, 808 sub bass, snappy snare, hi-hat rolls, dark synth, half-time feel", negative: "orchestral, jazz, acoustic", masterPreset: "pro" },
    "house":           { bpm: [120, 126], extras: "classic house, warm piano stab, soulful vocal hook, four-on-the-floor kick, claps on 2 and 4", negative: "distorted, harsh, metal", masterPreset: "pro" },
    "deep-house":      { bpm: [118, 124], extras: "deep house, warm analog bass, jazzy chord pad, soft kick, smooth groove", negative: "harsh, distorted, fast", masterPreset: "pro" },
    "lofi":            { bpm: [70, 90],   extras: "lofi hip-hop, dusty vinyl crackle, mellow jazz chords, boom-bap drums, warm tape saturation", negative: "loud, distorted, fast, aggressive", masterPreset: "standard" },
    "ambient":         { bpm: [60, 90],   extras: "ambient, ethereal pads, evolving texture, soft reverb-drenched lead, no percussion or minimal", negative: "loud, fast, aggressive, distorted", masterPreset: "standard" },
    "pop":             { bpm: [100, 120], extras: "modern pop, catchy melodic hook, polished production, layered vocals, four-on-the-floor or syncopated kick", negative: "lo-fi, distorted, harsh", masterPreset: "pro" },
    "rock":            { bpm: [110, 140], extras: "rock, driving electric guitars, punchy drum kit with cymbals, gritty bass", negative: "electronic, synth, ambient", masterPreset: "pro" },
    "jazz":            { bpm: [80, 130],  extras: "jazz, brushed drums, walking upright bass, smooth saxophone, warm piano chords", negative: "electronic, distorted, loud", masterPreset: "standard" },
    "manele":          { bpm: [95, 115],  extras: "manele, balkan oriental, syncopated darbuka and dumbek percussion, melismatic vocal line, accordion or organ, ney flute, romantic minor melodies", negative: "distorted, harsh, ambient", masterPreset: "pro" },
    "balkanica":       { bpm: [110, 140], extras: "balkan brass, fast accordion riffs, energetic dumbek and tapan drums, syncopated odd-meter feel", negative: "slow, ambient, electronic", masterPreset: "pro" },
    "latino":          { bpm: [90, 120],  extras: "latin pop reggaeton, dembow rhythm, syncopated percussion, Spanish guitar accents, tropical vibe", negative: "slow, ambient, distorted", masterPreset: "pro" },
    "populara":        { bpm: [80, 130],  extras: "romanian folk, traditional violin and accordion, modal scales, lively rhythm", negative: "electronic, distorted, ambient", masterPreset: "standard" },
    "bounce":          { bpm: [125, 135], extras: "melbourne bounce, fat side-chained kick, festival big-room lead, energetic build", negative: "slow, acoustic, ambient", masterPreset: "pro" },
    "fuziune":         { bpm: [90, 130],  extras: "genre fusion, eclectic instrumentation, cross-cultural rhythm, modern production", negative: "", masterPreset: "pro" },
};

function buildSongPrompt(args: {
    prompt: string;
    genre?: string;
    bpm?: number;
    key?: string;
    mood?: string;
    instruments?: readonly string[];
    negativePrompt?: string;
}): { prompt: string; resolvedBpm?: number; preset?: typeof GENRE_PRESETS[string] } {
    const preset = args.genre ? GENRE_PRESETS[args.genre.toLowerCase().trim()] : undefined;
    const tags: string[] = [];
    if (args.genre) tags.push(args.genre);
    let bpm = args.bpm;
    if (bpm == null && preset) bpm = Math.round((preset.bpm[0] + preset.bpm[1]) / 2);
    if (bpm != null) tags.push(`${bpm} BPM`);
    if (args.key) tags.push(args.key);
    if (args.mood) tags.push(args.mood);
    if (preset?.extras) tags.push(preset.extras);
    if (args.instruments?.length) tags.push(args.instruments.join(", "));
    const tagLine = tags.length ? `${tags.join(", ")}. ` : "";
    const neg = [preset?.negative, args.negativePrompt].filter(Boolean).join(", ");
    const negLine = neg ? ` Negative: ${neg}.` : "";
    // ACE-Step responds dramatically better when prompts contain structure
    // metatags. If the user (or upstream Maestro) didn't supply any, prepend
    // a sensible default song skeleton based on tempo: faster genres get
    // a drop, slow genres get a bridge.
    const hasStructure = /\[(intro|verse|chorus|drop|bridge|outro|break|build|hook|pre[- ]?chorus)\]/i.test(args.prompt);
    let structureLine = "";
    if (!hasStructure) {
        const fastGenres = /techno|trance|psy|house|dnb|trap|bounce|acid|hardstyle/i;
        const slowGenres = /lofi|ambient|ballad|populara|jazz|classical/i;
        const wantsDrop = (args.genre && fastGenres.test(args.genre)) || (bpm != null && bpm >= 122);
        const wantsBridge = (args.genre && slowGenres.test(args.genre)) || (bpm != null && bpm <= 95);
        const sections = wantsDrop
            ? "[Intro] [Build] [Drop] [Break] [Drop] [Outro]"
            : wantsBridge
                ? "[Intro] [Verse] [Chorus] [Verse] [Bridge] [Chorus] [Outro]"
                : "[Intro] [Verse] [Chorus] [Verse] [Chorus] [Outro]";
        structureLine = `${sections} `;
    }
    return {
        prompt: `${tagLine}${structureLine}${args.prompt}${negLine}`.trim(),
        resolvedBpm: bpm,
        preset,
    };
}

const TRACK_COLORS = [
    "#8b5cf6", "#3b82f6", "#06b6d4", "#10b981", "#22c55e",
    "#eab308", "#f97316", "#ef4444", "#ec4899", "#a855f7",
];

function nextColor(seed: number): string {
    return TRACK_COLORS[Math.abs(seed) % TRACK_COLORS.length];
}

async function loadProjectDoc(
    userId: string,
    externalId: string,
): Promise<{ rowId: number; fv: Record<string, string>; doc: ProjectDoc } | null> {
    const [row] = await db
        .select({
            id: dawProjects.id,
            document: dawProjects.document,
            fv: dawProjects.fieldVersions,
        })
        .from(dawProjects)
        .where(and(
            eq(dawProjects.userId, userId),
            eq(dawProjects.externalId, externalId),
            isNull(dawProjects.deletedAt),
        ))
        .limit(1);
    if (!row) return null;
    const doc = row.document as unknown as ProjectDoc | null;
    if (!doc || !Array.isArray(doc.tracks)) return null;
    return { rowId: row.id, fv: (row.fv ?? {}) as Record<string, string>, doc };
}

async function saveProjectDoc(
    userId: string,
    externalId: string,
    rowId: number,
    fv: Record<string, string>,
    doc: ProjectDoc,
    bpm?: number,
): Promise<void> {
    const ts = new Date();
    const tsIso = ts.toISOString();
    const nextFv = { ...fv, document: tsIso, ...(bpm !== undefined ? { bpm: tsIso } : {}) };
    const patch: Record<string, unknown> = {
        document: { ...doc, modifiedAt: ts.getTime() },
        fieldVersions: nextFv,
        updatedAt: ts,
    };
    if (bpm !== undefined) patch.bpm = bpm;
    await db.update(dawProjects).set(patch as never).where(eq(dawProjects.id, rowId));
    await appendSync(userId, "daw_projects", externalId, "upsert", {
        document: patch.document,
        ...(bpm !== undefined ? { bpm } : {}),
        updatedAt: tsIso,
    });
}

async function resolveOpenProject(
    ctx: ToolContext,
    hint?: string,
): Promise<{ externalId: string; rowId: number; fv: Record<string, string>; doc: ProjectDoc } | null> {
    const tryIds = [hint, ctx.currentProjectExternalId].filter((x): x is string => !!x);
    for (const id of tryIds) {
        const loaded = await loadProjectDoc(ctx.userId, id);
        if (loaded) return { externalId: id, ...loaded };
    }
    // Fallback: most-recent project with a non-empty document
    const rows = await db
        .select({
            externalId: dawProjects.externalId,
            id: dawProjects.id,
            document: dawProjects.document,
            fv: dawProjects.fieldVersions,
        })
        .from(dawProjects)
        .where(and(eq(dawProjects.userId, ctx.userId), isNull(dawProjects.deletedAt)))
        .orderBy(desc(dawProjects.updatedAt))
        .limit(10);
    for (const r of rows) {
        const doc = r.document as unknown as ProjectDoc | null;
        if (doc && Array.isArray(doc.tracks)) {
            return {
                externalId: r.externalId,
                rowId: r.id,
                fv: (r.fv ?? {}) as Record<string, string>,
                doc,
            };
        }
    }
    return null;
}

function summarizeTrack(t: TrackDoc) {
    return {
        id: t.id,
        name: t.name,
        type: t.type,
        color: t.color,
        volume: t.volume,
        pan: t.pan,
        muted: t.muted,
        soloed: t.soloed,
        armed: t.armed,
        instrumentId: t.instrumentId,
        clipCount: t.clips.length,
        insertCount: (t.inserts ?? []).length,
        automationLaneCount: (t.automationLanes ?? []).length,
        inserts: (t.inserts ?? []).map((fx) => ({ id: fx.id, type: fx.type, enabled: fx.enabled })),
    };
}

/**
 * Idempotency helper: scan the project for tracks whose first clip already plays
 * one of the given stem URLs. Returns { trackIds, clipIds } when every requested
 * stem is already present, else null.
 */
function findExistingStemTracks(
    doc: ProjectDoc,
    stems: Record<string, string>,
): { trackIds: Record<string, string>; clipIds: Record<string, string>; lengthBeats: number } | null {
    const trackIds: Record<string, string> = {};
    const clipIds: Record<string, string> = {};
    let lengthBeats = 0;
    for (const [stemName, url] of Object.entries(stems)) {
        if (!url) continue;
        let found = false;
        for (const t of doc.tracks) {
            if (t.type !== "audio") continue;
            const clip = (t.clips ?? []).find(
                (c) => c.audio && typeof c.audio.sourceUrl === "string" && c.audio.sourceUrl === url,
            );
            if (clip) {
                trackIds[stemName] = t.id;
                clipIds[stemName] = clip.id;
                lengthBeats = Math.max(lengthBeats, clip.length);
                found = true;
                break;
            }
        }
        if (!found) return null;
    }
    return Object.keys(trackIds).length > 0 ? { trackIds, clipIds, lengthBeats } : null;
}

function summarizeClip(c: ClipDoc) {
    return {
        id: c.id,
        trackId: c.trackId,
        name: c.name,
        type: c.type,
        position: c.position,
        length: c.length,
        muted: c.muted,
        color: c.color,
        ...(c.midi ? { noteCount: c.midi.notes.length, instrumentId: c.midi.instrumentId } : {}),
    };
}

export function buildTools(ctx: ToolContext): Record<string, Tool> {
    return {
        ...buildTrainingToolsLazy(ctx),
        // ─── Library ────────────────────────────────────────────────

        listLibraryTracks: tool({
            description:
                "List tracks from the user's music library. Use this to find songs by title/artist or browse the latest additions.",
            inputSchema: z.object({
                query: z.string().optional().describe("Free-text search across title/artist/album. Empty = newest first."),
                limit: z.number().int().min(1).max(50).default(10),
            }),
            execute: async ({ query, limit }) => {
                const base = db
                    .select({
                        id: tracks.id,
                        title: tracks.title,
                        artist: tracks.artist,
                        album: tracks.album,
                        bpm: tracks.bpm,
                        keyCamelot: tracks.keyCamelot,
                        genre: tracks.genre,
                        rating: tracks.rating,
                    })
                    .from(tracks);
                const where = query
                    ? and(
                          eq(tracks.userId, ctx.userId),
                          or(
                              ilike(tracks.title, `%${query}%`),
                              ilike(tracks.artist, `%${query}%`),
                              ilike(tracks.album, `%${query}%`),
                          ),
                      )
                    : eq(tracks.userId, ctx.userId);
                const rows = await base.where(where).orderBy(desc(tracks.addedAt)).limit(limit);
                return { count: rows.length, tracks: rows };
            },
        }),

        getTrackDetails: tool({
            description: "Fetch full metadata for a single track by id.",
            inputSchema: z.object({ trackId: z.number().int() }),
            execute: async ({ trackId }) => {
                const [row] = await db
                    .select()
                    .from(tracks)
                    .where(and(eq(tracks.id, trackId), eq(tracks.userId, ctx.userId)))
                    .limit(1);
                if (!row) return { found: false as const };
                return { found: true as const, track: row };
            },
        }),

        rateTrack: tool({
            description: "Set the user's rating (0–5) on a track. Destructive.",
            inputSchema: z.object({
                trackId: z.number().int(),
                rating: z.number().int().min(0).max(5),
            }),
            execute: async ({ trackId, rating }) => {
                if (!ctx.allowDestructive) return refusedDestructive("rateTrack");
                const result = await db
                    .update(tracks)
                    .set({ rating })
                    .where(and(eq(tracks.id, trackId), eq(tracks.userId, ctx.userId)))
                    .returning({ id: tracks.id, rating: tracks.rating });
                return { ok: true as const, updated: result[0] ?? null };
            },
        }),

        // ─── DAW projects ───────────────────────────────────────────

        listDawProjects: tool({
            description: "List the user's DAW projects (most-recently updated first). The 'current' project (if any) is highlighted.",
            inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
            execute: async ({ limit }) => {
                const rows = await db
                    .select({
                        externalId: dawProjects.externalId,
                        name: dawProjects.name,
                        bpm: dawProjects.bpm,
                        keyCamelot: dawProjects.keyCamelot,
                        updatedAt: dawProjects.updatedAt,
                    })
                    .from(dawProjects)
                    .where(and(eq(dawProjects.userId, ctx.userId), isNull(dawProjects.deletedAt)))
                    .orderBy(desc(dawProjects.updatedAt))
                    .limit(limit);
                return {
                    count: rows.length,
                    currentProjectExternalId: ctx.currentProjectExternalId ?? null,
                    projects: rows.map((r) => ({
                        ...r,
                        isCurrent: r.externalId === ctx.currentProjectExternalId,
                    })),
                };
            },
        }),

        getDawProject: tool({
            description:
                "Get the full project summary: tempo, time-signature, tracks (with clip counts), duration. If projectExternalId is omitted, uses the user's current project.",
            inputSchema: z.object({ projectExternalId: z.string().optional() }),
            execute: async ({ projectExternalId }) => {
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { found: false as const, reason: "no-project" as const };
                return {
                    found: true as const,
                    projectExternalId: p.externalId,
                    name: p.doc.name,
                    tempo: p.doc.tempo,
                    timeSignature: p.doc.timeSignature,
                    duration: p.doc.duration,
                    trackCount: p.doc.tracks.length,
                    tracks: p.doc.tracks.map(summarizeTrack),
                };
            },
        }),

        listDawTracks: tool({
            description: "List tracks for a DAW project (defaults to the user's current project).",
            inputSchema: z.object({ projectExternalId: z.string().optional() }),
            execute: async ({ projectExternalId }) => {
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { found: false as const, reason: "no-project" as const };
                return {
                    found: true as const,
                    projectExternalId: p.externalId,
                    count: p.doc.tracks.length,
                    tracks: p.doc.tracks.map(summarizeTrack),
                };
            },
        }),

        listDawClips: tool({
            description:
                "List clips in a DAW project (optionally filtered to one track). Positions/lengths are in beats.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string().optional(),
            }),
            execute: async ({ projectExternalId, trackId }) => {
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { found: false as const, reason: "no-project" as const };
                const all = p.doc.tracks.flatMap((t) => t.clips);
                const filtered = trackId ? all.filter((c) => c.trackId === trackId) : all;
                return {
                    found: true as const,
                    projectExternalId: p.externalId,
                    count: filtered.length,
                    clips: filtered.map(summarizeClip),
                };
            },
        }),

        // ─── DAW edits (destructive) ────────────────────────────────

        createDawTrack: tool({
            description:
                "Add a new track to a DAW project. Kind 'audio' for audio clips, 'midi' for MIDI clips (synth/drums). Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                name: z.string().min(1).max(64),
                kind: z.enum(["audio", "midi"]).default("midi"),
                instrumentId: z.enum(["synth", "drums", "bass", "piano"]).optional()
                    .describe("Required only for kind='midi'. Defaults to 'synth'."),
                color: z.string().optional(),
                volume: z.number().min(0).max(1).default(0.75),
            }),
            execute: async ({ projectExternalId, name, kind, instrumentId, color, volume }) => {
                if (!ctx.allowDestructive) return refusedDestructive("createDawTrack");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const track: TrackDoc = {
                    id: newId(),
                    name,
                    type: kind,
                    color: color ?? nextColor(p.doc.tracks.length),
                    volume,
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
                    instrumentId: kind === "midi" ? (instrumentId ?? "synth") : undefined,
                    peakL: 0,
                    peakR: 0,
                };
                const newDoc: ProjectDoc = { ...p.doc, tracks: [...p.doc.tracks, track] };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, newDoc);
                return {
                    ok: true as const,
                    projectExternalId: p.externalId,
                    trackId: track.id,
                    track: summarizeTrack(track),
                };
            },
        }),

        createReturnTrack: tool({
            description:
                "Add a return track for shared FX buses (reverb, delay, parallel compression). " +
                "Returns the new returnTrackId you can pass to addSendRoute. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                name: z.string().min(1).max(64),
                color: z.string().optional(),
                volume: z.number().min(0).max(1).default(0.8),
            }),
            execute: async ({ projectExternalId, name, color, volume }) => {
                if (!ctx.allowDestructive) return refusedDestructive("createReturnTrack");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const track: TrackDoc = {
                    id: newId(),
                    name,
                    type: "return",
                    color: color ?? nextColor(p.doc.tracks.length),
                    volume,
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
                };
                const newDoc: ProjectDoc = { ...p.doc, tracks: [...p.doc.tracks, track] };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, newDoc);
                return {
                    ok: true as const,
                    projectExternalId: p.externalId,
                    returnTrackId: track.id,
                    track: summarizeTrack(track),
                };
            },
        }),

        addSendRoute: tool({
            description:
                "Route part of a source track's signal to a return track (for shared reverb/delay/parallel-comp). " +
                "Amount is linear 0..1. If a send to that return already exists, it is replaced. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                sourceTrackId: z.string(),
                returnTrackId: z.string(),
                amount: z.number().min(0).max(1),
                preFader: z.boolean().default(false),
            }),
            execute: async ({ projectExternalId, sourceTrackId, returnTrackId, amount, preFader }) => {
                if (!ctx.allowDestructive) return refusedDestructive("addSendRoute");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const src = p.doc.tracks.find((t) => t.id === sourceTrackId);
                if (!src) return { ok: false as const, reason: "source-not-found" as const };
                const ret = p.doc.tracks.find((t) => t.id === returnTrackId);
                if (!ret || ret.type !== "return") {
                    return { ok: false as const, reason: "return-not-found" as const, message: "returnTrackId must point at a track with type='return' (create one with createReturnTrack)." };
                }
                const existingSends = (src.sends ?? []) as Array<{ returnTrackId: string; amount: number; preFader: boolean }>;
                const filtered = existingSends.filter((s) => s.returnTrackId !== returnTrackId);
                const updatedSrc: TrackDoc = {
                    ...src,
                    sends: [...filtered, { returnTrackId, amount, preFader }],
                };
                const newTracks = p.doc.tracks.map((t) => (t.id === sourceTrackId ? updatedSrc : t));
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return {
                    ok: true as const,
                    projectExternalId: p.externalId,
                    sourceTrackId,
                    returnTrackId,
                    amount,
                    preFader,
                };
            },
        }),

        setDawProjectTempo: tool({
            description: "Set the project tempo (BPM, 20–300). Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                bpm: z.number().min(20).max(300),
            }),
            execute: async ({ projectExternalId, bpm }) => {
                if (!ctx.allowDestructive) return refusedDestructive("setDawProjectTempo");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const newDoc = { ...p.doc, tempo: bpm };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, newDoc, bpm);
                return { ok: true as const, projectExternalId: p.externalId, bpm };
            },
        }),

        setDawProjectTimeSignature: tool({
            description: "Set the project time signature (e.g. 4/4, 3/4, 6/8). Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                numerator: z.number().int().min(1).max(16),
                denominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
            }),
            execute: async ({ projectExternalId, numerator, denominator }) => {
                if (!ctx.allowDestructive) return refusedDestructive("setDawProjectTimeSignature");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const newDoc = { ...p.doc, timeSignature: { numerator, denominator } };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, newDoc);
                return { ok: true as const, projectExternalId: p.externalId, timeSignature: { numerator, denominator } };
            },
        }),

        createDawClip: tool({
            description:
                "Create a clip on a DAW track. Positions and length are in BEATS (e.g. 16 beats = 4 bars in 4/4). Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string().describe("Parent track id (from listDawTracks)."),
                name: z.string().default("Clip"),
                kind: z.enum(["audio", "midi"]).default("midi"),
                position: z.number().min(0).default(0).describe("Start in beats."),
                length: z.number().min(0.01).default(16).describe("Length in beats."),
                color: z.string().optional(),
            }),
            execute: async ({ projectExternalId, trackId, name, kind, position, length, color }) => {
                if (!ctx.allowDestructive) return refusedDestructive("createDawClip");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const trackIdx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (trackIdx < 0) return { ok: false as const, reason: "track-not-found" as const, trackId };
                const track = p.doc.tracks[trackIdx];
                if (track.type !== "audio" && track.type !== "midi") {
                    return { ok: false as const, reason: "track-not-clip-capable" as const, trackType: track.type };
                }
                if (kind !== track.type) {
                    return { ok: false as const, reason: "kind-track-mismatch" as const, trackType: track.type, clipKind: kind };
                }
                const clip: ClipDoc = {
                    id: newId(),
                    type: kind,
                    name,
                    trackId,
                    position,
                    length,
                    color: color ?? track.color,
                    muted: false,
                    ...(kind === "midi"
                        ? { midi: { notes: [], instrumentId: track.instrumentId ?? "synth" } }
                        : { audio: { sourceUrl: "", name, startOffset: 0, duration: 0, sampleRate: 48000, channels: 2, gain: 1, fadeIn: 0, fadeOut: 0, reversed: false, pitchShift: 0, timeStretch: 1 } }),
                };
                const newTracks = [...p.doc.tracks];
                newTracks[trackIdx] = { ...track, clips: [...track.clips, clip] };
                const newDoc = { ...p.doc, tracks: newTracks };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, newDoc);
                return { ok: true as const, projectExternalId: p.externalId, clipId: clip.id, clip: summarizeClip(clip) };
            },
        }),

        moveDawClip: tool({
            description: "Move/resize an existing clip. position and length are in BEATS. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                clipId: z.string(),
                position: z.number().min(0).optional(),
                length: z.number().min(0.01).optional(),
                trackId: z.string().optional().describe("Move to a different track."),
            }),
            execute: async ({ projectExternalId, clipId, position, length, trackId }) => {
                if (!ctx.allowDestructive) return refusedDestructive("moveDawClip");
                if (position === undefined && length === undefined && trackId === undefined) {
                    return { ok: false as const, reason: "no-change" as const };
                }
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                let srcIdx = -1; let clipIdxInSrc = -1; let clip: ClipDoc | undefined;
                for (let i = 0; i < p.doc.tracks.length; i++) {
                    const ci = p.doc.tracks[i].clips.findIndex((c) => c.id === clipId);
                    if (ci >= 0) { srcIdx = i; clipIdxInSrc = ci; clip = p.doc.tracks[i].clips[ci]; break; }
                }
                if (!clip) return { ok: false as const, reason: "clip-not-found" as const };
                const dstId = trackId ?? clip.trackId;
                const dstIdx = p.doc.tracks.findIndex((t) => t.id === dstId);
                if (dstIdx < 0) return { ok: false as const, reason: "target-track-not-found" as const };
                if (p.doc.tracks[dstIdx].type !== clip.type) {
                    return { ok: false as const, reason: "track-kind-mismatch" as const };
                }
                const patched: ClipDoc = {
                    ...clip,
                    position: position ?? clip.position,
                    length: length ?? clip.length,
                    trackId: dstId,
                };
                const newTracks = p.doc.tracks.map((t) => ({ ...t, clips: [...t.clips] }));
                newTracks[srcIdx].clips.splice(clipIdxInSrc, 1);
                newTracks[dstIdx].clips.push(patched);
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, clipId, applied: { position: patched.position, length: patched.length, trackId: dstId } };
            },
        }),

        setDawTrackVolume: tool({
            description: "Set linear volume (0..1) on a track. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string(),
                volume: z.number().min(0).max(1),
            }),
            execute: async ({ projectExternalId, trackId, volume }) => {
                if (!ctx.allowDestructive) return refusedDestructive("setDawTrackVolume");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const newTracks = [...p.doc.tracks];
                newTracks[idx] = { ...newTracks[idx], volume };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, trackId, volume };
            },
        }),

        addMidiNotes: tool({
            description:
                "Append MIDI notes to a MIDI clip. pitch is MIDI note number (60 = middle C, 36 = kick on a drum track), velocity 1..127, start/duration in BEATS (relative to clip start). Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                clipId: z.string(),
                notes: z.array(z.object({
                    pitch: z.number().int().min(0).max(127),
                    velocity: z.number().int().min(1).max(127).default(100),
                    start: z.number().min(0),
                    duration: z.number().min(0.001).default(0.25),
                    channel: z.number().int().min(0).max(15).default(0),
                })).min(1).max(512),
            }),
            execute: async ({ projectExternalId, clipId, notes }) => {
                if (!ctx.allowDestructive) return refusedDestructive("addMidiNotes");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                let trackIdx = -1; let clipIdx = -1;
                for (let i = 0; i < p.doc.tracks.length; i++) {
                    const ci = p.doc.tracks[i].clips.findIndex((c) => c.id === clipId);
                    if (ci >= 0) { trackIdx = i; clipIdx = ci; break; }
                }
                if (trackIdx < 0) return { ok: false as const, reason: "clip-not-found" as const };
                const clip = p.doc.tracks[trackIdx].clips[clipIdx];
                if (clip.type !== "midi" || !clip.midi) return { ok: false as const, reason: "not-midi-clip" as const };
                const newNotes: MidiNoteDoc[] = notes.map((n) => ({
                    id: newId(),
                    pitch: n.pitch,
                    velocity: n.velocity,
                    start: n.start,
                    duration: n.duration,
                    channel: n.channel,
                }));
                const newTracks = p.doc.tracks.map((t) => ({ ...t, clips: [...t.clips] }));
                const newClip: ClipDoc = {
                    ...clip,
                    midi: { ...clip.midi, notes: [...clip.midi.notes, ...newNotes] },
                };
                newTracks[trackIdx].clips[clipIdx] = newClip;
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, clipId, added: newNotes.length, totalNotes: newClip.midi!.notes.length };
            },
        }),

        exportDawProject: tool({
            description:
                "Request an offline render of a DAW project to WAV/MP3. Returns a stub render job id; the full-graph bounce pipeline is implemented in P6 phase B/E.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                format: z.enum(["wav", "mp3"]).default("wav"),
                sampleRate: z.number().int().default(48000),
            }),
            execute: async ({ projectExternalId, format, sampleRate }) => {
                if (!ctx.allowDestructive) return refusedDestructive("exportDawProject");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const jobId = randomUUID();
                return {
                    ok: true as const,
                    status: "pending" as const,
                    jobId,
                    projectExternalId: p.externalId,
                    format,
                    sampleRate,
                    note: "Full-graph offline render lands in P6 phase B (engine.exportProject rewrite) and phase E (companion /render router).",
                };
            },
        }),

        sendAssetToDaw: tool({
            description:
                "Take a ready generated-asset, Demucs-split it into 4 stems if needed, then either " +
                "append the stems as 4 new audio tracks to the currently-open project OR create a " +
                "brand-new project named after the prompt. Use when the user asks to 'open in DAW', " +
                "'add this song to a project', or 'remix this'. Destructive.",
            inputSchema: z.object({
                assetId: z.string().min(1).describe("Id from generateMusic / listGeneratedAssets."),
                mode: z.enum(["append", "create"]).default("append")
                    .describe("'append' = add to current project (falls back to create if none open); 'create' = always make new."),
            }),
            execute: async ({ assetId, mode }) => {
                if (!ctx.allowDestructive) return refusedDestructive("sendAssetToDaw");
                const mod = await import("@/actions/generate");
                const r = await mod.sendGeneratedAssetToDaw(
                    assetId,
                    mode,
                    ctx.currentProjectExternalId,
                );
                return r;
            },
        }),

        recommendSimilar: tool({
            description:
                "Find audio assets most similar to a given asset using CLAP embeddings + pgvector " +
                "cosine similarity. Returns up to N matches with similarity scores in [0,1]. Useful " +
                "for 'find more songs like this', layering suggestions, or building cohesive playlists. " +
                "Read-only.",
            inputSchema: z.object({
                assetId: z.string().min(1),
                assetKind: z.enum(["generated", "scanned", "stem"]).default("generated"),
                limit: z.number().int().min(1).max(50).default(10),
            }),
            execute: async ({ assetId, assetKind, limit }) => {
                try {
                    const { db } = await import("@/db");
                    const { audioEmbeddings, generatedAssets } = await import("@/db/schema-ai");
                    const { and, eq, sql } = await import("drizzle-orm");
                    const [src] = await db
                        .select({ embedding: audioEmbeddings.embedding })
                        .from(audioEmbeddings)
                        .where(and(eq(audioEmbeddings.assetId, assetId), eq(audioEmbeddings.assetKind, assetKind)))
                        .limit(1);
                    if (!src) {
                        return { ok: false as const, reason: "asset-not-embedded" as const };
                    }
                    const vec = `[${src.embedding.join(",")}]`;
                    const rows = await db.execute<{
                        asset_id: string;
                        asset_kind: string;
                        distance: number;
                        prompt: string | null;
                    }>(sql`
                        SELECT ae.asset_id, ae.asset_kind,
                               ae.embedding <=> ${vec}::vector AS distance,
                               ga.prompt_text AS prompt
                        FROM ${audioEmbeddings} ae
                        LEFT JOIN ${generatedAssets} ga
                               ON ga.id = ae.asset_id AND ae.asset_kind = 'generated'
                              AND ga.user_id = ${ctx.userId}
                        WHERE NOT (ae.asset_id = ${assetId} AND ae.asset_kind = ${assetKind})
                          AND (ae.asset_kind <> 'generated' OR ga.user_id = ${ctx.userId})
                        ORDER BY distance ASC
                        LIMIT ${limit}
                    `);
                    const arr = rows as unknown as Array<{
                        asset_id: string; asset_kind: string; distance: number; prompt: string | null;
                    }>;
                    return {
                        ok: true as const,
                        count: arr.length,
                        results: arr.map((r) => ({
                            assetId: r.asset_id,
                            assetKind: r.asset_kind,
                            similarity: Math.max(0, 1 - Number(r.distance)),
                            prompt: r.prompt,
                        })),
                    };
                } catch (err) {
                    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
                }
            },
        }),

        masterAsset: tool({
            description:
                "Master a ready generated asset via the Cloud Run mastering service (SoX + ffmpeg " +
                "chain with EQ, multiband compression, saturator, stereo widener, loudnorm -14 LUFS " +
                "+ true-peak limiter). Creates a NEW generated_assets row tagged as mastered. " +
                "Presets: 'minimal' (loudnorm only), 'standard' (mild EQ + comp + limit), 'pro' " +
                "(full chain — recommended). Typical cost: $0.0003 per 3-min song. Destructive " +
                "because it creates a new asset.",
            inputSchema: z.object({
                assetId: z.string().min(1),
                preset: z.enum(["minimal", "standard", "pro"]).default("pro"),
            }),
            execute: async ({ assetId, preset }) => {
                if (!ctx.allowDestructive) return refusedDestructive("masterAsset");
                try {
                    const mod = await import("@/actions/generate");
                    return await mod.masterGeneratedAsset({ assetId, preset });
                } catch (err) {
                    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
                }
            },
        }),

        // ─── Advanced editing (destructive) ────────────────────────

        setDawTrackPan: tool({
            description: "Set the track pan in the range -1 (full left) .. +1 (full right). Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string(),
                pan: z.number().min(-1).max(1),
            }),
            execute: async ({ projectExternalId, trackId, pan }) => {
                if (!ctx.allowDestructive) return refusedDestructive("setDawTrackPan");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const newTracks = [...p.doc.tracks];
                newTracks[idx] = { ...newTracks[idx], pan };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, trackId, pan };
            },
        }),

        deleteDawClip: tool({
            description: "Delete a clip from its track. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                clipId: z.string(),
            }),
            execute: async ({ projectExternalId, clipId }) => {
                if (!ctx.allowDestructive) return refusedDestructive("deleteDawClip");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                let srcIdx = -1; let clipIdx = -1;
                for (let i = 0; i < p.doc.tracks.length; i++) {
                    const ci = p.doc.tracks[i].clips.findIndex((c) => c.id === clipId);
                    if (ci >= 0) { srcIdx = i; clipIdx = ci; break; }
                }
                if (srcIdx < 0) return { ok: false as const, reason: "clip-not-found" as const };
                const newTracks = p.doc.tracks.map((t) => ({ ...t, clips: [...t.clips] }));
                newTracks[srcIdx].clips.splice(clipIdx, 1);
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, clipId, trackId: p.doc.tracks[srcIdx].id };
            },
        }),

        duplicateDawClip: tool({
            description:
                "Duplicate a clip (same track, same length, optional position offset in beats). " +
                "If `repeat` > 1, lays N copies back-to-back starting at the offset. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                clipId: z.string(),
                offsetBeats: z.number().optional().describe("Where the first copy goes (default: right after the source clip)."),
                repeat: z.number().int().min(1).max(64).default(1),
            }),
            execute: async ({ projectExternalId, clipId, offsetBeats, repeat }) => {
                if (!ctx.allowDestructive) return refusedDestructive("duplicateDawClip");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                let srcIdx = -1; let clipIdx = -1; let src: ClipDoc | undefined;
                for (let i = 0; i < p.doc.tracks.length; i++) {
                    const ci = p.doc.tracks[i].clips.findIndex((c) => c.id === clipId);
                    if (ci >= 0) { srcIdx = i; clipIdx = ci; src = p.doc.tracks[i].clips[ci]; break; }
                }
                if (!src) return { ok: false as const, reason: "clip-not-found" as const };
                const baseStart = offsetBeats ?? (src.position + src.length);
                const dupes: ClipDoc[] = [];
                for (let i = 0; i < repeat; i++) {
                    const copy: ClipDoc = JSON.parse(JSON.stringify(src));
                    copy.id = newId();
                    copy.position = baseStart + i * src.length;
                    if (copy.midi) copy.midi.notes = copy.midi.notes.map((n) => ({ ...n, id: newId() }));
                    dupes.push(copy);
                }
                const newTracks = p.doc.tracks.map((t) => ({ ...t, clips: [...t.clips] }));
                newTracks[srcIdx].clips.push(...dupes);
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, created: dupes.map((c) => ({ id: c.id, position: c.position })) };
            },
        }),

        deleteDawTrack: tool({
            description: "Delete a track (including all clips). Cannot delete master. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string(),
            }),
            execute: async ({ projectExternalId, trackId }) => {
                if (!ctx.allowDestructive) return refusedDestructive("deleteDawTrack");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                if (p.doc.masterTrack?.id === trackId) {
                    return { ok: false as const, reason: "cannot-delete-master" as const };
                }
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const newTracks = p.doc.tracks.filter((t) => t.id !== trackId);
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, trackId };
            },
        }),

        // ─── FX inserts (destructive) ──────────────────────────────

        listFxTypes: tool({
            description:
                "List all built-in effect types and their default parameters. Use before addFxInsert to know which `type` strings exist.",
            inputSchema: z.object({}),
            execute: async () => {
                return {
                    types: FX_TYPES.map((t) => ({ type: t, defaultParams: FX_DEFAULTS[t] })),
                };
            },
        }),

        addFxInsert: tool({
            description:
                "Add an insert effect on a track. Parameters override the defaults from listFxTypes. " +
                "Use `position` to put the insert at a specific slot (default: append). Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string(),
                type: z.string().describe("One of the FxType values from listFxTypes, e.g. 'reverb', 'compressor', 'parametricEq'."),
                params: z.record(z.string(), z.number()).optional()
                    .describe("Partial param overrides; unspecified keys take the default."),
                enabled: z.boolean().default(true),
                position: z.number().int().min(0).optional(),
                sidechainSourceTrackId: z.string().optional()
                    .describe("Only meaningful when type='sidechain'."),
            }),
            execute: async ({ projectExternalId, trackId, type, params, enabled, position, sidechainSourceTrackId }) => {
                if (!ctx.allowDestructive) return refusedDestructive("addFxInsert");
                if (!FX_DEFAULTS[type]) {
                    return { ok: false as const, reason: "unknown-fx-type" as const, knownTypes: FX_TYPES };
                }
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const fx: InsertEffectDoc = {
                    id: newId(),
                    type,
                    enabled,
                    params: { ...FX_DEFAULTS[type], ...(params ?? {}) },
                    ...(sidechainSourceTrackId ? { sidechainSourceTrackId } : {}),
                };
                const track = p.doc.tracks[idx];
                const inserts = [...(track.inserts ?? [])];
                if (position === undefined || position >= inserts.length) inserts.push(fx);
                else inserts.splice(position, 0, fx);
                const newTracks = [...p.doc.tracks];
                newTracks[idx] = { ...track, inserts };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, fxId: fx.id, type, params: fx.params, trackId };
            },
        }),

        removeFxInsert: tool({
            description: "Remove an FX insert from a track by fxId. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string(),
                fxId: z.string(),
            }),
            execute: async ({ projectExternalId, trackId, fxId }) => {
                if (!ctx.allowDestructive) return refusedDestructive("removeFxInsert");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const inserts = (p.doc.tracks[idx].inserts ?? []).filter((fx) => fx.id !== fxId);
                if (inserts.length === (p.doc.tracks[idx].inserts ?? []).length) {
                    return { ok: false as const, reason: "fx-not-found" as const };
                }
                const newTracks = [...p.doc.tracks];
                newTracks[idx] = { ...p.doc.tracks[idx], inserts };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, trackId, fxId };
            },
        }),

        setFxParam: tool({
            description:
                "Change one or more parameters on an existing FX insert. Pass only the params you want to change. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string(),
                fxId: z.string(),
                params: z.record(z.string(), z.number()),
                enabled: z.boolean().optional(),
            }),
            execute: async ({ projectExternalId, trackId, fxId, params, enabled }) => {
                if (!ctx.allowDestructive) return refusedDestructive("setFxParam");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const inserts = (p.doc.tracks[idx].inserts ?? []).map((fx) => {
                    if (fx.id !== fxId) return fx;
                    return {
                        ...fx,
                        ...(enabled !== undefined ? { enabled } : {}),
                        params: { ...fx.params, ...params },
                    };
                });
                const found = inserts.some((fx) => fx.id === fxId);
                if (!found) return { ok: false as const, reason: "fx-not-found" as const };
                const newTracks = [...p.doc.tracks];
                newTracks[idx] = { ...p.doc.tracks[idx], inserts };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                const patched = inserts.find((fx) => fx.id === fxId)!;
                return { ok: true as const, fxId, applied: patched };
            },
        }),

        // ─── Automation (destructive) ──────────────────────────────

        addAutomationPoint: tool({
            description:
                "Add a single point to an automation lane. Creates the lane if it doesn't exist yet. " +
                "`parameter` is 'volume', 'pan', or 'fx.<fxId>.<paramName>'. " +
                "`time` is in beats; `value` is in the parameter's NATIVE units " +
                "(volume: 0..1, pan: -1..+1, fx.<fxId>.<param>: whatever that param expects — see listFxTypes). " +
                "For rhythmic patterns (sidechain duck, LFO sweep) prefer `addRhythmicDuck` / `addAutomationPoints`. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string(),
                parameter: z.string(),
                time: z.number().min(0),
                value: z.number(),
                curve: z.enum(["linear", "exponential", "step"]).default("linear"),
            }),
            execute: async ({ projectExternalId, trackId, parameter, time, value, curve }) => {
                if (!ctx.allowDestructive) return refusedDestructive("addAutomationPoint");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const track = p.doc.tracks[idx];
                const lanes = [...(track.automationLanes ?? [])];
                let lane = lanes.find((l) => l.parameter === parameter);
                if (!lane) {
                    lane = {
                        id: newId(),
                        trackId,
                        parameter,
                        points: [],
                        visible: true,
                        color: track.color,
                        mode: "read",
                    };
                    lanes.push(lane);
                } else {
                    lane = { ...lane, points: [...lane.points] };
                    lanes[lanes.findIndex((l) => l.id === lane!.id)] = lane;
                }
                lane.points.push({ time, value, curve });
                lane.points.sort((a, b) => a.time - b.time);
                const newTracks = [...p.doc.tracks];
                newTracks[idx] = { ...track, automationLanes: lanes };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, trackId, parameter, laneId: lane.id, pointCount: lane.points.length };
            },
        }),

        // ─── Samples library (read + create audio clip) ────────────

        searchSamples: tool({
            description:
                "Search the curated sample library (bass/drums/leads/pads/loops/vocals/fx/synths). " +
                "Filter by category, genre, name keyword, BPM, or one-shot flag. Returns up to 50 matches with playable URLs.",
            inputSchema: z.object({
                category: z.enum([
                    "bass", "drums/claps", "drums/cymbals", "drums/darbuka", "drums/fills",
                    "drums/hihats", "drums/kicks", "drums/percussion", "drums/shakers",
                    "drums/snares", "fx", "leads", "loops", "pads",
                    "synths/acid", "synths/arps", "synths/chords", "vocals",
                ]).optional(),
                query: z.string().optional().describe("Substring match on the sample name (case-insensitive)."),
                genre: z.string().optional(),
                oneshot: z.boolean().optional().describe("true = single hits only, false = loops only."),
                bpm: z.number().int().optional().describe("Match the sample's BPM exactly."),
                limit: z.number().int().min(1).max(50).default(20),
            }),
            execute: async ({ category, query, genre, oneshot, bpm, limit }) => {
                const m = await loadSampleManifest();
                if (!m) return { ok: false as const, reason: "manifest-missing" as const };
                const q = query?.toLowerCase();
                const results: SampleEntry[] = [];
                for (const cat of m.categories) {
                    if (category && cat.path !== category) continue;
                    for (const g of cat.genres) {
                        if (genre && !g.name.includes(genre) && !g.label.toLowerCase().includes(genre.toLowerCase())) continue;
                        for (const s of g.samples) {
                            if (q && !s.name.toLowerCase().includes(q)) continue;
                            if (oneshot !== undefined && s.oneshot !== oneshot) continue;
                            if (bpm !== undefined && s.bpm !== bpm) continue;
                            results.push(s);
                            if (results.length >= limit) break;
                        }
                        if (results.length >= limit) break;
                    }
                    if (results.length >= limit) break;
                }
                return {
                    ok: true as const,
                    count: results.length,
                    samples: results.map((s) => ({
                        name: s.name,
                        path: s.path,
                        type: s.type,
                        duration: s.duration,
                        bpm: s.bpm,
                        key: s.key,
                        oneshot: s.oneshot,
                    })),
                };
            },
        }),

        listSampleCategories: tool({
            description: "List all sample-library categories with their genre subfolders. Useful before searchSamples.",
            inputSchema: z.object({}),
            execute: async () => {
                const m = await loadSampleManifest();
                if (!m) return { ok: false as const, reason: "manifest-missing" as const };
                return {
                    ok: true as const,
                    categories: m.categories.map((c) => ({
                        path: c.path,
                        label: c.label,
                        genres: c.genres.map((g) => ({ name: g.name, label: g.label, count: g.samples.length })),
                    })),
                };
            },
        }),

        createSampleAudioClip: tool({
            description:
                "Place a library sample on an AUDIO track as an audio clip at the given beat position. " +
                "Use searchSamples first to discover sample paths. The clip's length defaults to enough beats to hold the sample's duration at the project tempo. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string().describe("Must be an audio-type track."),
                samplePath: z.string().describe("Sample `path` from searchSamples (e.g. '/samples/drums/kicks/X.wav')."),
                name: z.string().optional(),
                position: z.number().min(0).default(0),
                lengthBeats: z.number().min(0.01).optional(),
                gain: z.number().min(0).max(2).default(1),
            }),
            execute: async ({ projectExternalId, trackId, samplePath, name, position, lengthBeats, gain }) => {
                if (!ctx.allowDestructive) return refusedDestructive("createSampleAudioClip");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const track = p.doc.tracks[idx];
                if (track.type !== "audio") {
                    return { ok: false as const, reason: "track-not-audio" as const, trackType: track.type };
                }
                // Look up sample metadata so we can pre-fill duration/length.
                const m = await loadSampleManifest();
                let entry: SampleEntry | undefined;
                if (m) {
                    for (const c of m.categories) for (const g of c.genres) {
                        const found = g.samples.find((s) => s.path === samplePath);
                        if (found) { entry = found; break; }
                    }
                }
                const tempo = p.doc.tempo || 120;
                const durSec = entry?.duration ?? 1;
                const defaultLenBeats = Math.max(0.25, (durSec * tempo) / 60);
                const clipName = name ?? entry?.name ?? samplePath.split("/").pop() ?? "Sample";
                const clip: ClipDoc = {
                    id: newId(),
                    type: "audio",
                    name: clipName,
                    trackId,
                    position,
                    length: lengthBeats ?? defaultLenBeats,
                    color: track.color,
                    muted: false,
                    audio: {
                        sourceUrl: samplePath,
                        name: clipName,
                        startOffset: 0,
                        duration: durSec,
                        sampleRate: 48000,
                        channels: 2,
                        gain,
                        fadeIn: 0,
                        fadeOut: 0,
                        reversed: false,
                        pitchShift: 0,
                        timeStretch: 1,
                    },
                };
                const newTracks = [...p.doc.tracks];
                newTracks[idx] = { ...track, clips: [...track.clips, clip] };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, clipId: clip.id, samplePath, position, lengthBeats: clip.length };
            },
        }),

        // ─── Generative (Replicate / companion) ────────────────────

        generateMusic: tool({
            description:
                "Generate a song from a text prompt. Default tier='T0' runs ACE-Step locally on the user's companion " +
                "(free, GPU) and automatically splits the result into 4 Demucs stems (drums/bass/other/vocals). " +
                "When `splitToTracks` (default true) is set on T0, the 4 stems are placed on 4 new audio tracks " +
                "at the current cursor position so the user can mix them immediately. " +
                "Tier='T1' uses Replicate (MusicGen) and costs API credits. Returns assetId; if T0 and not split, " +
                "use getGenerationStatus to poll. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                prompt: z.string().min(1).max(2000),
                durationSec: z.number().int().min(1).max(240).default(30),
                tier: z.enum(["T0", "T1"]).default("T0"),
                model: z.string().optional()
                    .describe("T1 only: Replicate model id (default 'meta/musicgen'). Ignored for T0."),
                seed: z.number().int().optional(),
                loraPath: z.string().optional()
                    .describe("T0 only: absolute path to a trained ACE-Step LoRA checkpoint on the companion. " +
                        "Discover via listAceStepLoras."),
                loraWeight: z.number().min(0).max(2).default(1.0),
                splitToTracks: z.boolean().default(true)
                    .describe("T0 only: when true, after generation completes, create 4 audio tracks named " +
                        "'<prompt> — Drums/Bass/Other/Vocals' and place the corresponding stems on each."),
                position: z.number().min(0).default(0)
                    .describe("Beat position to drop the stems at. Defaults to 0."),
                genre: z.string().optional()
                    .describe("Genre tag (e.g. 'melodic-techno', 'psytrance', 'manele', 'lofi', 'pop'). " +
                        "Applies a preset with BPM range, tag-style hints, and negative prompt. " +
                        "Known: melodic-techno, techno, tech-house, psytrance, acid, trance, dnb, trap, house, " +
                        "deep-house, lofi, ambient, pop, rock, jazz, manele, balkanica, latino, populara, bounce, fuziune."),
                bpm: z.number().min(40).max(220).optional()
                    .describe("Target BPM. Defaults to the midpoint of the genre preset. Also sets the project tempo " +
                        "when no other tempo was set on this turn."),
                key: z.string().optional()
                    .describe("Musical key like 'A minor', 'C# dorian', 'F major'. Embedded into the prompt."),
                mood: z.string().optional()
                    .describe("Optional mood/energy adjective string ('dark, hypnotic', 'euphoric, uplifting')."),
                instruments: z.array(z.string()).max(20).optional()
                    .describe("Optional list of instruments to require ('808 sub', 'supersaw lead', 'analog kick')."),
                negativePrompt: z.string().max(500).optional()
                    .describe("Things to AVOID in the generation ('vocals, distorted, lo-fi')."),
                setProjectTempo: z.boolean().default(true)
                    .describe("When true and BPM is provided (or implied by genre), also call setDawProjectTempo on the open project."),
            }),
            execute: async ({ projectExternalId, prompt, durationSec, tier, model, seed, loraPath, loraWeight, splitToTracks, position, genre, bpm, key, mood, instruments, negativePrompt, setProjectTempo }) => {
                if (!ctx.allowDestructive) return refusedDestructive("generateMusic");
                try {
                    const built = buildSongPrompt({ prompt, genre, bpm, key, mood, instruments, negativePrompt });
                    const finalPrompt = built.prompt;
                    const mod = await import("@/actions/generate");
                    // Optionally align project tempo before generation (so split-to-tracks beat math is right).
                    if (setProjectTempo && built.resolvedBpm) {
                        const p0 = await resolveOpenProject(ctx, projectExternalId);
                        if (p0 && Math.round(p0.doc.tempo) !== Math.round(built.resolvedBpm)) {
                            await saveProjectDoc(
                                ctx.userId, p0.externalId, p0.rowId, p0.fv,
                                { ...p0.doc, tempo: built.resolvedBpm }, built.resolvedBpm,
                            );
                        }
                    }
                    const asset = await mod.generateAsset({
                        tier,
                        kind: "song",
                        prompt: finalPrompt,
                        durationSec,
                        ...(tier === "T1" ? { model: model ?? "meta/musicgen" } : {}),
                        ...(seed !== undefined ? { seed } : {}),
                        ...(tier === "T0" && loraPath ? { loraPath, loraWeight } : {}),
                    });

                    // If T0 finished synchronously AND we have stems AND splitToTracks → wire them onto 4 tracks.
                    if (tier === "T0" && splitToTracks && asset.status === "ready" && asset.songStems) {
                        const p = await resolveOpenProject(ctx, projectExternalId);
                        if (!p) {
                            return {
                                ok: true as const,
                                assetId: asset.id,
                                status: asset.status,
                                stems: asset.songStems,
                                message: "Song ready but no project open — call createDawTrack + createSampleAudioClip manually.",
                            };
                        }
                        // Idempotency: if every stem URL already lives on an existing track, return those.
                        const existing = findExistingStemTracks(p.doc, asset.songStems);
                        if (existing) {
                            return {
                                ok: true as const,
                                assetId: asset.id,
                                status: asset.status,
                                tracksCreated: existing.trackIds,
                                clipsCreated: existing.clipIds,
                                lengthBeats: existing.lengthBeats,
                                tempo: p.doc.tempo,
                                deduped: true,
                                message: "Stems already present on existing tracks — reused (no duplicates).",
                            };
                        }
                        const tempo = p.doc.tempo || 120;
                        const lenBeats = Math.max(0.25, (durationSec * tempo) / 60);
                        const stemOrder = ["drums", "bass", "other", "vocals"] as const;
                        const newTracks: TrackDoc[] = [...p.doc.tracks];
                        const createdTrackIds: Record<string, string> = {};
                        const createdClipIds: Record<string, string> = {};
                        const shortPrompt = prompt.slice(0, 32);
                        for (const stem of stemOrder) {
                            const url = asset.songStems[stem];
                            if (!url) continue;
                            const trackId = newId();
                            const clipId = newId();
                            const track: TrackDoc = {
                                id: trackId,
                                name: `${shortPrompt} — ${stem[0]!.toUpperCase()}${stem.slice(1)}`,
                                type: "audio",
                                color: nextColor(newTracks.length),
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
                                clips: [{
                                    id: clipId,
                                    type: "audio",
                                    name: stem,
                                    trackId,
                                    position,
                                    length: lenBeats,
                                    color: nextColor(newTracks.length),
                                    muted: false,
                                    audio: {
                                        sourceUrl: url,
                                        name: stem,
                                        startOffset: 0,
                                        duration: durationSec,
                                        sampleRate: asset.sampleRate ?? 48000,
                                        channels: 2,
                                        gain: 1,
                                        fadeIn: 0,
                                        fadeOut: 0,
                                        reversed: false,
                                        pitchShift: 0,
                                        timeStretch: 1,
                                    },
                                }],
                            };
                            newTracks.push(track);
                            createdTrackIds[stem] = trackId;
                            createdClipIds[stem] = clipId;
                        }
                        await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                        return {
                            ok: true as const,
                            assetId: asset.id,
                            status: asset.status,
                            tracksCreated: createdTrackIds,
                            clipsCreated: createdClipIds,
                            lengthBeats: lenBeats,
                            tempo,
                            message: `Generated locally with ACE-Step + Demucs (${Object.keys(createdTrackIds).length} stems on new tracks).`,
                        };
                    }

                    return {
                        ok: true as const,
                        assetId: asset.id,
                        status: asset.status,
                        message: asset.error ?? (tier === "T0"
                            ? "Submitted to local ACE-Step. Poll with getGenerationStatus."
                            : "Submitted to Replicate. Poll with getGenerationStatus."),
                    };
                } catch (err) {
                    return {
                        ok: false as const,
                        reason: "generation-failed" as const,
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
            },
        }),

        listAceStepLoras: tool({
            description:
                "List the user's trained ACE-Step LoRA checkpoints (style/genre adapters). Returns absolute " +
                "checkpoint paths suitable for the `loraPath` arg on generateMusic. Read-only.",
            inputSchema: z.object({}),
            execute: async () => {
                try {
                    const mod = await import("@/actions/generate");
                    const loras = await mod.listAvailableAceLoras();
                    return {
                        ok: true as const,
                        count: loras.reduce((n, l) => n + l.ckpts.length, 0),
                        loras: loras.flatMap((l) => l.ckpts.map((c) => ({
                            exp: l.exp,
                            name: c.name,
                            absPath: c.absPath,
                            sizeMB: c.sizeMB,
                        }))),
                    };
                } catch (err) {
                    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
                }
            },
        }),

        separateAssetStems: tool({
            description:
                "Demucs-split an existing generated-song asset into 4 stems (drums/bass/other/vocals) and " +
                "drop each stem on its own new audio track in the open project. If the asset already has " +
                "stems, reuses them (no re-split). Use when the user wants to mix a previously generated " +
                "T1/MusicGen song that has no stems, or wants to break apart any T0 song they generated " +
                "with splitStems=false. Destructive.",
            inputSchema: z.object({
                assetId: z.string().min(1).describe("Id from generateMusic / listGeneratedAssets."),
                projectExternalId: z.string().optional(),
                position: z.number().min(0).default(0),
                durationSec: z.number().min(0.5).max(600).optional()
                    .describe("Asset duration in seconds (only needed when the asset row lacks it)."),
            }),
            execute: async ({ assetId, projectExternalId, position, durationSec }) => {
                if (!ctx.allowDestructive) return refusedDestructive("separateAssetStems");
                try {
                    const mod = await import("@/actions/generate");
                    const res = await mod.separateGeneratedAssetStems(assetId);
                    if (!res.ok) {
                        return { ok: false as const, reason: "separation-failed" as const, error: res.error };
                    }
                    const status = await mod.getGenerationStatus(assetId);
                    const p = await resolveOpenProject(ctx, projectExternalId);
                    if (!p) {
                        return {
                            ok: true as const,
                            assetId,
                            stems: res.stems,
                            message: "Stems ready but no project open — call createDawTrack + createSampleAudioClip manually.",
                        };
                    }
                    // Idempotency: skip if every stem URL already on an existing track.
                    const existing = findExistingStemTracks(p.doc, res.stems as Record<string, string>);
                    if (existing) {
                        return {
                            ok: true as const,
                            assetId,
                            tracksCreated: existing.trackIds,
                            clipsCreated: existing.clipIds,
                            lengthBeats: existing.lengthBeats,
                            tempo: p.doc.tempo,
                            deduped: true,
                            message: "Stems already on existing tracks — reused (no duplicates).",
                        };
                    }
                    const tempo = p.doc.tempo || 120;
                    const dur = durationSec ?? status.durationSec ?? 30;
                    const lenBeats = Math.max(0.25, (dur * tempo) / 60);
                    const stemOrder = ["drums", "bass", "other", "vocals"] as const;
                    const newTracks: TrackDoc[] = [...p.doc.tracks];
                    const createdTrackIds: Record<string, string> = {};
                    const createdClipIds: Record<string, string> = {};
                    const shortPrompt = (status.prompt ?? assetId).slice(0, 32);
                    for (const stem of stemOrder) {
                        const url = res.stems[stem];
                        if (!url) continue;
                        const trackId = newId();
                        const clipId = newId();
                        const track: TrackDoc = {
                            id: trackId,
                            name: `${shortPrompt} — ${stem[0]!.toUpperCase()}${stem.slice(1)}`,
                            type: "audio",
                            color: nextColor(newTracks.length),
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
                            clips: [{
                                id: clipId,
                                type: "audio",
                                name: stem,
                                trackId,
                                position,
                                length: lenBeats,
                                color: nextColor(newTracks.length),
                                muted: false,
                                audio: {
                                    sourceUrl: url,
                                    name: stem,
                                    startOffset: 0,
                                    duration: dur,
                                    sampleRate: status.sampleRate ?? 48000,
                                    channels: 2,
                                    gain: 1,
                                    fadeIn: 0,
                                    fadeOut: 0,
                                    reversed: false,
                                    pitchShift: 0,
                                    timeStretch: 1,
                                },
                            }],
                        };
                        newTracks.push(track);
                        createdTrackIds[stem] = trackId;
                        createdClipIds[stem] = clipId;
                    }
                    await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                    return {
                        ok: true as const,
                        assetId,
                        tracksCreated: createdTrackIds,
                        clipsCreated: createdClipIds,
                        lengthBeats: lenBeats,
                        tempo,
                        message: `Split asset into ${Object.keys(createdTrackIds).length} stem tracks.`,
                    };
                } catch (err) {
                    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
                }
            },
        }),

        listRvcVoiceModels: tool({
            description:
                "List the user's trained RVC v2 voice-conversion models. Each model converts the " +
                "timbre of any sung vocal to the trained voice (e.g. user's own voice). Read-only.",
            inputSchema: z.object({}),
            execute: async () => {
                try {
                    const mod = await import("@/actions/voice-convert");
                    const res = await mod.listVoiceConversionModels();
                    return { ok: true as const, count: res.length, models: res };
                } catch (err) {
                    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
                }
            },
        }),

        convertVocalWithRVC: tool({
            description:
                "RVC v2 voice-conversion: retarget the timbre of an existing audio asset to one of " +
                "the user's trained voice models. Two modes: " +
                "(1) Pure vocal: when the asset is already an isolated vocal stem, set isolateFirst=false. " +
                "(2) Full song: when the asset is a mixed song, set isolateFirst=true — Demucs splits " +
                "drums/bass/other/vocals, RVC converts only the vocals, then we re-mix back. " +
                "The converted result is added as a new audio track in the open project (when one is " +
                "open). Destructive (creates new track + asset).",
            inputSchema: z.object({
                assetId: z.string().min(1)
                    .describe("Id of the source asset from listGeneratedAssets / generateMusic."),
                modelId: z.string().min(1)
                    .describe("Id of an RVC model from listRvcVoiceModels."),
                pitchSemitones: z.number().int().min(-24).max(24).default(0)
                    .describe("Transpose the converted vocal by N semitones (12 = up an octave)."),
                indexRate: z.number().min(0).max(1).default(0.66)
                    .describe("How strongly to lean on the retrieval index (0..1). 0.5-0.7 is typical."),
                f0Method: z.enum(["rmvpe", "pm", "harvest", "crepe"]).default("rmvpe")
                    .describe("Pitch-extraction method. rmvpe is best for singing."),
                isolateFirst: z.boolean().default(true)
                    .describe("Run Demucs first to isolate vocals from a full mix. Set false " +
                              "when the input is already a dry vocal stem."),
                projectExternalId: z.string().optional(),
                position: z.number().min(0).default(0),
            }),
            execute: async ({ assetId, modelId, pitchSemitones, indexRate, f0Method, isolateFirst, projectExternalId, position }) => {
                if (!ctx.allowDestructive) return refusedDestructive("convertVocalWithRVC");
                try {
                    const mod = await import("@/actions/voice-convert");
                    // Guard: refuse early if no models installed so the LLM gets a
                    // concrete actionable error instead of a sidecar 500.
                    const models = await mod.listVoiceConversionModels();
                    if (!models.length) {
                        return { ok: false as const, error: "no-rvc-models-installed: drop a trained RVC v2 model folder under <companion>/voices/.rvc-models/<id>/ first" };
                    }
                    if (!models.some((m) => m.id === modelId)) {
                        return { ok: false as const, error: `rvc-model-not-found: ${modelId}. Available: ${models.map((m) => m.id).join(", ")}` };
                    }
                    const res = await mod.convertAssetWithRVC({
                        assetId, modelId, pitchSemitones, indexRate, f0Method, isolateFirst,
                    });
                    if (!res.ok) return { ok: false as const, error: res.error };

                    const p = await resolveOpenProject(ctx, projectExternalId);
                    if (!p) {
                        return {
                            ok: true as const,
                            assetId: res.newAssetId,
                            convertedUrl: res.url,
                            message: "Converted but no project open — call createDawTrack + createSampleAudioClip to add it.",
                        };
                    }
                    const tempo = p.doc.tempo || 120;
                    const dur = res.durationSec ?? 30;
                    const lenBeats = Math.max(0.25, (dur * tempo) / 60);
                    const trackId = newId();
                    const clipId = newId();
                    const track: TrackDoc = {
                        id: trackId,
                        name: `RVC — ${modelId.slice(0, 24)}`,
                        type: "audio",
                        color: nextColor(p.doc.tracks.length),
                        volume: 0.85,
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
                        clips: [{
                            id: clipId,
                            type: "audio",
                            name: `rvc-${modelId.slice(0, 12)}`,
                            trackId,
                            position,
                            length: lenBeats,
                            color: nextColor(p.doc.tracks.length),
                            muted: false,
                            audio: {
                                sourceUrl: res.url,
                                name: "rvc-vocals",
                                startOffset: 0,
                                duration: dur,
                                sampleRate: res.sampleRate ?? 48000,
                                channels: 2,
                                gain: 1,
                                fadeIn: 0,
                                fadeOut: 0,
                                reversed: false,
                                pitchShift: 0,
                                timeStretch: 1,
                            },
                        }],
                    };
                    await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, {
                        ...p.doc,
                        tracks: [...p.doc.tracks, track],
                    });
                    return {
                        ok: true as const,
                        assetId: res.newAssetId,
                        trackId,
                        clipId,
                        durationSec: dur,
                        lengthBeats: lenBeats,
                        message: `Voice-converted with model '${modelId}' and added as new track.`,
                    };
                } catch (err) {
                    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
                }
            },
        }),

        prepareAceStepDataset: tool({
            description:
                "Bundle a list of the user's existing generated-music assets into a training dataset and upload it " +
                "to gs://mmo-training-prod/<jobId>/dataset/ in the layout the ACE-Step LoRA trainer expects " +
                "(one folder per item with audio.<ext> + text.txt). Returns { datasetUri, outputUri, jobId } that " +
                "plug straight into trainAceStepLora with target='vertex'. Only includes assets that are ready " +
                "and have a non-empty promptText; everything else is reported under `skipped`. Costs only egress.",
            inputSchema: z.object({
                assetIds: z.array(z.string()).min(1).max(500)
                    .describe("IDs from generatedAssets to include. Each must belong to the caller, be ready, and have a promptText."),
                jobId: z.string().min(1).max(64).optional()
                    .describe("Optional explicit jobId (used as the GCS prefix). Defaults to 'lora-<base36-timestamp>'."),
            }),
            execute: async ({ assetIds, jobId }) => {
                if (!ctx.allowDestructive) return refusedDestructive("prepareAceStepDataset");
                try {
                    const mod = await import("@/actions/vertex-dataset");
                    const res = await mod.prepareAceStepDataset({ assetIds, jobId });
                    if (!res.ok) return { ok: false as const, error: res.error };
                    return {
                        ok: true as const,
                        jobId: res.jobId,
                        datasetUri: res.datasetUri,
                        outputUri: res.outputUri,
                        fileCount: res.fileCount,
                        skipped: res.skipped,
                        message:
                            `Uploaded ${res.fileCount} item(s) to ${res.datasetUri}` +
                            (res.skipped.length ? ` — skipped ${res.skipped.length}` : "") +
                            `. Now call trainAceStepLora with target='vertex', datasetUri='${res.datasetUri}', outputUri='${res.outputUri}'.`,
                    };
                } catch (err) {
                    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
                }
            },
        }),

        trainAceStepLora: tool({
            description:
                "Kick off an ACE-Step LoRA training run (style/genre adapter). Two targets: " +
                "(1) target='local' (default): spawns `scripts/train-acestep-lora.ps1` detached on " +
                "the user's GPU. ~3-6h for 5000 steps on RTX 3060 Ti. Checkpoints land in " +
                "listAceStepLoras under <exp>/ckpts/*.ckpt. Requires dataDir (local path). " +
                "(2) target='vertex': submits a Vertex AI Custom Job on a GCP A100 spot VM. " +
                "Requires datasetUri and outputUri (gs:// URIs under mmo-training-prod). " +
                "~6h on A100 spot ≈ $7. Returns the Vertex jobName for monitoring. " +
                "Destructive (long-running, GPU-heavy, may incur cloud cost).",
            inputSchema: z.object({
                expName: z.string().min(1).max(64)
                    .describe("Short name for the training run (becomes the output folder / job id)."),
                target: z.enum(["local", "vertex"]).default("local"),
                dataDir: z.string().min(1).optional()
                    .describe("[local only] Absolute path to the HF-formatted training dataset."),
                datasetUri: z.string().startsWith("gs://").optional()
                    .describe("[vertex only] gs:// URI of the dataset directory."),
                outputUri: z.string().startsWith("gs://").optional()
                    .describe("[vertex only] gs:// URI for checkpoints and logs."),
                maxSteps: z.number().int().min(100).max(50000).default(5000),
                repeatCount: z.number().int().min(1).max(2000).default(200)
                    .describe("[local only] How many times to repeat the dataset per epoch."),
                rank: z.number().int().min(4).max(128).default(16)
                    .describe("[vertex only] LoRA rank. 16 is the sweet spot for ACE-Step."),
                spot: z.boolean().default(true)
                    .describe("[vertex only] Use spot/preemptible VM (~70% cheaper but can be interrupted)."),
            }),
            execute: async ({ expName, target, dataDir, datasetUri, outputUri, maxSteps, repeatCount, rank, spot }) => {
                if (!ctx.allowDestructive) return refusedDestructive("trainAceStepLora");
                try {
                    const mod = await import("@/actions/generate");
                    if (target === "vertex") {
                        if (!datasetUri || !outputUri) {
                            return { ok: false as const, error: "vertex target requires datasetUri and outputUri" };
                        }
                        const res = await mod.submitAceStepLoraTrainingVertex({
                            expName, datasetUri, outputUri, maxSteps, rank, spot,
                        });
                        if (!res.ok) return { ok: false as const, error: res.error };
                        return {
                            ok: true as const,
                            target: "vertex" as const,
                            jobName: res.jobName,
                            jobId: res.jobId,
                            consoleUrl: res.consoleUrl,
                            message:
                                `Submitted Vertex AI training '${expName}'. Monitor at: ${res.consoleUrl}. ` +
                                `Est. wall-time ~6h on A100 spot. Checkpoints land at ${outputUri}.`,
                        };
                    }
                    if (!dataDir) {
                        return { ok: false as const, error: "local target requires dataDir" };
                    }
                    const res = await mod.startAceStepLoraTraining({ expName, dataDir, maxSteps, repeatCount });
                    if (!res.ok) return { ok: false as const, error: res.error };
                    return {
                        ok: true as const,
                        target: "local" as const,
                        jobId: res.jobId,
                        pid: res.pid,
                        logPath: res.logPath,
                        message:
                            `Training started in background (pid ${res.pid}). Tail ${res.logPath} for progress. ` +
                            `Estimated wall-time: ~${Math.round(maxSteps / 1500)}h on RTX 3060 Ti. ` +
                            `Checkpoints will appear in listAceStepLoras under exp='${expName}'.`,
                    };
                } catch (err) {
                    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
                }
            },
        }),

        getGenerationStatus: tool({
            description:
                "Poll the status of a previously-submitted generateMusic/synthesizeVocal job. Returns 'pending', 'ready', or 'failed'.",
            inputSchema: z.object({
                assetId: z.string(),
            }),
            execute: async ({ assetId }) => {
                try {
                    const mod = await import("@/actions/generate");
                    const dto = await mod.getGenerationStatus(assetId);
                    return {
                        ok: true as const,
                        assetId,
                        status: dto.status,
                        kind: dto.kind,
                        url: dto.fileUrl ?? null,
                        durationSec: dto.durationSec ?? null,
                        error: dto.error ?? null,
                    };
                } catch (err) {
                    return {
                        ok: false as const,
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
            },
        }),

        synthesizeVocal: tool({
            description:
                "Synthesize a spoken or sung vocal stem from text. Pick a provider:\n" +
                "  • `piper`             — free offline TTS via the companion (robotic, single pitch).\n" +
                "  • `piper-melody`      — offline melody-aligned singing on Piper. Pass `melodyClipId`.\n" +
                "  • `xtts`              — cloned-voice spoken speech (XTTS-v2). Pass `clonedVoiceId` + `language`.\n" +
                "  • `xtts-melody`       — cloned-voice SINGING. Pass `clonedVoiceId` + `melodyClipId`. The companion\n" +
                "                          re-synthesizes each syllable in the user’s timbre and pitch-shifts to the\n" +
                "                          target MIDI notes — use this for personalised vocal hooks and ad-libs.\n" +
                "  • `f5`               — cloned-voice via F5-TTS (only when the user has it installed).\n" +
                "  • `elevenlabs`        — cloud TTS, best quality. Needs ELEVENLABS_API_KEY on the server.\n" +
                "Use listClonedVoices first to discover the user’s personal voiceIds. Returns a generated-asset\n" +
                "id you can poll with getGenerationStatus, then drop on an audio track via createSampleAudioClip.\n" +
                "Destructive.",
            inputSchema: z.object({
                text: z.string().min(1).max(2000),
                provider: z.enum(["piper", "piper-melody", "xtts", "xtts-melody", "f5", "elevenlabs"]).default("piper"),
                voice: z.enum(["male", "female", "neutral"]).default("neutral")
                    .describe("Piper preset only. Ignored for xtts/f5/elevenlabs."),
                rate: z.number().min(0.5).max(2.0).default(1.0)
                    .describe("Speech speed (piper / xtts providers)."),
                pitchSemitones: z.number().min(-12).max(12).default(0)
                    .describe("Post-shift in semitones (piper plain only)."),
                melodyClipId: z.string().optional()
                    .describe(
                        "MIDI clip id whose notes drive the vocal melody. Required for provider " +
                        "'piper-melody' or 'xtts-melody'. Each note becomes one syllable target."
                    ),
                clonedVoiceId: z.string().optional()
                    .describe(
                        "Personal-voice id (e.g. 'v-...') returned by listClonedVoices. Required for " +
                        "provider='xtts', 'xtts-melody', or 'f5'."
                    ),
                language: z.string().min(2).max(8).optional()
                    .describe("ISO language tag for multilingual backends (xtts/f5). Defaults to the voice’s primary."),
                elevenLabsVoiceId: z.string().optional()
                    .describe(
                        "ElevenLabs voice id (e.g. '21m00Tcm4TlvDq8ikWAM' = Rachel). Required for provider='elevenlabs'."
                    ),
            }),
            execute: async ({ text, provider, voice, rate, pitchSemitones, melodyClipId, clonedVoiceId, language, elevenLabsVoiceId }) => {
                if (!ctx.allowDestructive) return refusedDestructive("synthesizeVocal");

                // Resolve melody from clip id when requested.
                let melody: Array<{ beat: number; durationBeats: number; midiPitch: number }> | undefined;
                let tempo: number | undefined;
                const needsMelody = provider === "piper-melody" || provider === "xtts-melody";
                if (needsMelody) {
                    if (!melodyClipId) {
                        return {
                            ok: false as const,
                            reason: "missing-melody-clip" as const,
                            message: `provider='${provider}' requires melodyClipId pointing at a MIDI clip on the current project.`,
                        };
                    }
                    if (!ctx.currentProjectExternalId) {
                        return {
                            ok: false as const,
                            reason: "no-project" as const,
                            message: "No DAW project is open in the UI. Open one first or pass it via context.",
                        };
                    }
                    const loaded = await resolveOpenProject(ctx);
                    if (!loaded) {
                        return { ok: false as const, reason: "project-not-found" as const };
                    }
                    const project = loaded.doc;
                    let clip: ClipDoc | undefined;
                    for (const t of project.tracks) {
                        clip = t.clips.find((c) => c.id === melodyClipId);
                        if (clip) break;
                    }
                    if (!clip || !clip.midi) {
                        return {
                            ok: false as const,
                            reason: "clip-not-midi" as const,
                            message: `Clip ${melodyClipId} not found or is not a MIDI clip.`,
                        };
                    }
                    melody = clip.midi.notes
                        .slice()
                        .sort((a, b) => a.start - b.start)
                        .map((n) => ({
                            // Beats are clip-relative so the rendered WAV starts
                            // at note 1 instead of being prefixed with N bars of
                            // silence (which would waste disk + bake the timeline
                            // position into the asset).
                            beat: n.start,
                            durationBeats: n.duration,
                            midiPitch: n.pitch,
                        }));
                    tempo = project.tempo;
                    if (melody.length === 0) {
                        return {
                            ok: false as const,
                            reason: "empty-melody" as const,
                            message: `Clip ${melodyClipId} has no notes.`,
                        };
                    }
                }

                if ((provider === "xtts" || provider === "xtts-melody" || provider === "f5") && !clonedVoiceId) {
                    return {
                        ok: false as const,
                        reason: "missing-cloned-voice" as const,
                        message: `provider='${provider}' requires clonedVoiceId. Call listClonedVoices first or send the user to /voice-wizard.`,
                    };
                }

                const model =
                    provider === "elevenlabs"
                        ? `cloud:elevenlabs:${elevenLabsVoiceId ?? "21m00Tcm4TlvDq8ikWAM"}`
                        : provider === "xtts" || provider === "xtts-melody"
                            ? `companion:xtts:${clonedVoiceId}`
                            : provider === "f5"
                                ? `companion:f5:${clonedVoiceId}`
                                : provider === "piper-melody"
                                    ? `companion:piper-tts-melody:${voice}`
                                    : `companion:piper-tts:${voice}`;
                const tier = provider === "elevenlabs" ? "T2" : "T0";

                try {
                    const mod = await import("@/actions/generate");
                    const asset = await mod.generateAsset({
                        tier,
                        kind: "vocal",
                        prompt: text,
                        durationSec: Math.min(60, Math.max(1, Math.ceil((text.length / 15) / rate))),
                        model,
                        ...(language ? { language } : {}),
                        ...(melody ? { melody, tempo } : {}),
                    });
                    return {
                        ok: true as const,
                        assetId: asset.id,
                        status: asset.status,
                        provider,
                        note: asset.error ??
                            (provider === "elevenlabs"
                                ? "Submitted to ElevenLabs. Should be ready in a few seconds."
                                : provider === "xtts"
                                    ? "Submitted to XTTS-v2 on the companion. First render warms the model (~10s)."
                                    : provider === "xtts-melody"
                                        ? `Submitted ${melody!.length}-note cloned-voice melody. Per-syllable XTTS + pitch-shift takes a few minutes for long passages.`
                                        : provider === "f5"
                                            ? "Submitted to F5-TTS on the companion."
                                            : provider === "piper-melody"
                                                ? `Submitted ${melody!.length}-note melody to companion. Singing pass takes 30-90s.`
                                                : "Submitted to companion TTS. Should be ready in a few seconds."),
                        params: { voice, rate, pitchSemitones, noteCount: melody?.length ?? 0, clonedVoiceId, language },
                    };
                } catch (err) {
                    return {
                        ok: false as const,
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
            },
        }),

        synthesizeIntro: tool({
            description:
                "Synthesize a spoken intro/outro line using Azure Neural TTS (cloud). " +
                "Best for podcast-style narration, music video voiceovers, or DJ drops " +
                "in Romanian or English. Cheap (~$0.005 per 30-second line). NOT for " +
                "singing — use synthesizeVocal for that. Returns a ready-to-use audio " +
                "asset; drop it on an audio track with createSampleAudioClip. Destructive.",
            inputSchema: z.object({
                text: z.string().min(1).max(2000)
                    .describe("The line to speak. Plain text, no SSML — markup is added automatically."),
                voice: z.string().min(3).max(60).default("ro-RO-AlinaNeural")
                    .describe(
                        "Azure Neural voice id. Romanian: ro-RO-AlinaNeural (f) / ro-RO-EmilNeural (m). " +
                        "English: en-US-JennyNeural (f, multi-style) / en-US-GuyNeural (m) / en-GB-RyanNeural (m). " +
                        "Spanish: es-ES-AlvaroNeural."
                    ),
                rate: z.number().min(0.5).max(2.0).optional()
                    .describe("Speech rate multiplier. 1.0 = normal, 1.2 = 20% faster."),
                pitchSemitones: z.number().min(-12).max(12).optional()
                    .describe("Pitch shift in semitones (-12..12)."),
                style: z.string().optional()
                    .describe(
                        "Optional speaking style for multi-style voices (Jenny supports many): " +
                        "'cheerful', 'sad', 'angry', 'newscast', 'customerservice', 'excited'."
                    ),
            }),
            execute: async ({ text, voice, rate, pitchSemitones, style }) => {
                if (!ctx.allowDestructive) return refusedDestructive("synthesizeIntro");
                try {
                    const mod = await import("@/actions/generate");
                    const asset = await mod.synthesizeAzureIntro({ text, voice, rate, pitchSemitones, style });
                    return {
                        ok: true as const,
                        assetId: asset.id,
                        status: asset.status,
                        kind: asset.kind,
                        url: asset.fileUrl ?? null,
                        durationSec: asset.durationSec ?? null,
                        error: asset.error ?? null,
                    };
                } catch (err) {
                    return {
                        ok: false as const,
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
            },
        }),

        listClonedVoices: tool({
            description:
                "List the user's personal voice clones trained in /voice-wizard. Returns an array of\n" +
                "{ id, name, engine, language, samples, updatedAt }. Use these ids with `synthesizeVocal`'s\n" +
                "`clonedVoiceId` argument (provider='xtts', 'xtts-melody', or 'f5'). When the list is\n" +
                "empty, tell the user to open /voice-wizard and record 3\u20136 clean clips of their voice.\n" +
                "Read-only.",
            inputSchema: z.object({}),
            execute: async () => {
                try {
                    const mod = await import("@/actions/voice-clone");
                    const voices = await mod.listMyClonedVoices();
                    return {
                        ok: true as const,
                        count: voices.length,
                        voices: voices.map((v) => ({
                            id: v.id,
                            name: v.name,
                            engine: v.engine,
                            language: v.language,
                            sampleCount: v.samples.length,
                            updatedAt: v.updatedAt,
                            notes: v.notes,
                        })),
                        hint: voices.length === 0
                            ? "No cloned voices yet. Send the user to /voice-wizard to record their own voice."
                            : "Pass any of these ids as clonedVoiceId to synthesizeVocal (provider='xtts-melody' for singing).",
                    };
                } catch (err) {
                    return {
                        ok: false as const,
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
            },
        }),

        // ─── Async polling (read-only) ─────────────────────────────

        awaitAssetReady: tool({
            description:
                "Poll a generated asset until status='ready' (or 'failed', or timeout). Blocks server-side " +
                "so the LLM does not waste step budget polling itself. Returns the final asset DTO. " +
                "Use after generateMusic/synthesizeVocal/convertVocalWithRVC/separateAssetStems for any " +
                "path that returned status='pending'.",
            inputSchema: z.object({
                assetId: z.string().min(1),
                timeoutSec: z.number().int().min(1).max(600).default(300),
                pollMs: z.number().int().min(500).max(10000).default(2000),
            }),
            execute: async ({ assetId, timeoutSec, pollMs }) => {
                try {
                    const mod = await import("@/actions/generate");
                    const deadline = Date.now() + timeoutSec * 1000;
                    let last = await mod.getGenerationStatus(assetId);
                    while ((last.status === "pending") && Date.now() < deadline) {
                        await new Promise((r) => setTimeout(r, pollMs));
                        last = await mod.getGenerationStatus(assetId);
                    }
                    return {
                        ok: true as const,
                        assetId,
                        status: last.status,
                        timedOut: last.status === "pending",
                        url: last.fileUrl ?? null,
                        stems: last.songStems ?? null,
                        durationSec: last.durationSec ?? null,
                        sampleRate: last.sampleRate ?? null,
                        error: last.error ?? null,
                    };
                } catch (err) {
                    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
                }
            },
        }),

        // ─── Advanced automation patterns (destructive) ────────────

        addAutomationPoints: tool({
            description:
                "Bulk-append automation points to a lane (creates lane if missing). Use for pre-computed " +
                "envelopes, LFO patterns, or anything that would otherwise need 20+ addAutomationPoint " +
                "calls. Up to 1024 points per call. `value` is in the parameter's NATIVE units. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string(),
                parameter: z.string().describe("'volume', 'pan', or 'fx.<fxId>.<paramName>'."),
                points: z.array(z.object({
                    time: z.number().min(0),
                    value: z.number(),
                    curve: z.enum(["linear", "exponential", "step"]).default("linear"),
                })).min(1).max(1024),
            }),
            execute: async ({ projectExternalId, trackId, parameter, points }) => {
                if (!ctx.allowDestructive) return refusedDestructive("addAutomationPoints");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const track = p.doc.tracks[idx];
                const lanes = [...(track.automationLanes ?? [])];
                let lane = lanes.find((l) => l.parameter === parameter);
                if (!lane) {
                    lane = {
                        id: newId(), trackId, parameter, points: [],
                        visible: true, color: track.color, mode: "read",
                    };
                    lanes.push(lane);
                } else {
                    lane = { ...lane, points: [...lane.points] };
                    lanes[lanes.findIndex((l) => l.id === lane!.id)] = lane;
                }
                lane.points.push(...points);
                lane.points.sort((a, b) => a.time - b.time);
                const newTracks = [...p.doc.tracks];
                newTracks[idx] = { ...track, automationLanes: lanes };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, trackId, parameter, laneId: lane.id, pointCount: lane.points.length };
            },
        }),

        addRhythmicDuck: tool({
            description:
                "Compose a per-beat rhythmic envelope (classic side-chain duck shape) and write it as " +
                "automation points on a single lane. Produces (restValue) → (restValue*depth) → (restValue) " +
                "per period for `durationBeats` beats. Use for sidechain-style bass ducking, tremolo, or " +
                "rhythmic filter sweeps. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string(),
                parameter: z.string().default("volume")
                    .describe("Lane parameter. 'volume' is the typical sidechain target."),
                durationBeats: z.number().min(0.5).max(2048),
                periodBeats: z.number().min(0.0625).max(8).default(1)
                    .describe("Period of one duck cycle in beats. 1 = on every quarter (kick on 4/4)."),
                depth: z.number().min(0).max(1).default(0.4)
                    .describe("Trough multiplier of restValue (0.4 = duck down to 40%)."),
                attackBeats: z.number().min(0.0).max(2).default(0.05),
                releaseBeats: z.number().min(0.01).max(4).default(0.25),
                restValue: z.number().default(1.0)
                    .describe("Resting value at the top of each cycle (native units)."),
                offsetBeats: z.number().min(0).default(0)
                    .describe("Start beat of the first duck cycle."),
            }),
            execute: async ({ projectExternalId, trackId, parameter, durationBeats, periodBeats, depth, attackBeats, releaseBeats, restValue, offsetBeats }) => {
                if (!ctx.allowDestructive) return refusedDestructive("addRhythmicDuck");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const track = p.doc.tracks[idx];
                const points: AutomationPointDoc[] = [];
                const trough = restValue * depth;
                const cycles = Math.floor(durationBeats / periodBeats);
                for (let i = 0; i < cycles; i++) {
                    const t0 = offsetBeats + i * periodBeats;
                    points.push({ time: t0, value: restValue, curve: "linear" });
                    points.push({ time: t0 + attackBeats, value: trough, curve: "exponential" });
                    points.push({ time: t0 + attackBeats + releaseBeats, value: restValue, curve: "exponential" });
                }
                if (points.length === 0) return { ok: false as const, reason: "no-points-generated" as const };
                if (points.length > 1024) {
                    return { ok: false as const, reason: "too-many-points" as const, requested: points.length, max: 1024,
                        hint: "Reduce durationBeats or increase periodBeats." };
                }
                const lanes = [...(track.automationLanes ?? [])];
                let lane = lanes.find((l) => l.parameter === parameter);
                if (!lane) {
                    lane = { id: newId(), trackId, parameter, points: [], visible: true, color: track.color, mode: "read" };
                    lanes.push(lane);
                } else {
                    lane = { ...lane, points: [...lane.points] };
                    lanes[lanes.findIndex((l) => l.id === lane!.id)] = lane;
                }
                lane.points.push(...points);
                lane.points.sort((a, b) => a.time - b.time);
                const newTracks = [...p.doc.tracks];
                newTracks[idx] = { ...track, automationLanes: lanes };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, trackId, parameter, laneId: lane.id, pointCount: lane.points.length, cycles };
            },
        }),

        // ─── Track cosmetics (destructive) ─────────────────────────

        renameDawTrack: tool({
            description: "Rename a track. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string(),
                name: z.string().min(1).max(120),
            }),
            execute: async ({ projectExternalId, trackId, name }) => {
                if (!ctx.allowDestructive) return refusedDestructive("renameDawTrack");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const newTracks = [...p.doc.tracks];
                newTracks[idx] = { ...newTracks[idx], name };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, trackId, name };
            },
        }),

        setDawTrackColor: tool({
            description: "Set the track color (hex string like '#ff8800'). Useful for visually grouping stems. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                trackId: z.string(),
                color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex color like #aabbcc"),
            }),
            execute: async ({ projectExternalId, trackId, color }) => {
                if (!ctx.allowDestructive) return refusedDestructive("setDawTrackColor");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const idx = p.doc.tracks.findIndex((t) => t.id === trackId);
                if (idx < 0) return { ok: false as const, reason: "track-not-found" as const };
                const newTracks = [...p.doc.tracks];
                newTracks[idx] = { ...newTracks[idx], color };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, tracks: newTracks });
                return { ok: true as const, trackId, color };
            },
        }),

        // ─── Master bus tools (destructive) ────────────────────────

        getMasterTrack: tool({
            description: "Read the master track's FX chain, automation, and volume/pan. Read-only.",
            inputSchema: z.object({ projectExternalId: z.string().optional() }),
            execute: async ({ projectExternalId }) => {
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const m = p.doc.masterTrack;
                if (!m) return { ok: false as const, reason: "no-master-track" as const };
                return {
                    ok: true as const,
                    id: m.id,
                    name: m.name,
                    volume: m.volume,
                    pan: m.pan,
                    inserts: (m.inserts ?? []).map((fx) => ({ id: fx.id, type: fx.type, enabled: fx.enabled, params: fx.params })),
                    automationLanes: (m.automationLanes ?? []).map((l) => ({ id: l.id, parameter: l.parameter, pointCount: l.points.length })),
                };
            },
        }),

        setMasterVolume: tool({
            description: "Set the master track volume (linear 0..1, 0.85 ≈ default). Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                volume: z.number().min(0).max(1),
            }),
            execute: async ({ projectExternalId, volume }) => {
                if (!ctx.allowDestructive) return refusedDestructive("setMasterVolume");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const masterTrack = { ...p.doc.masterTrack, volume };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, masterTrack });
                return { ok: true as const, volume };
            },
        }),

        addMasterFx: tool({
            description:
                "Add an insert effect on the master bus (the final stage before output). Use for master " +
                "limiter (type='limiter', threshold=-1), bus compressor (type='compressor'), master EQ " +
                "(type='parametricEq'), saturator, or stereoWidth. A typical mastering chain is: " +
                "eq3 → compressor → saturator → stereoWidth → limiter(threshold=-1). Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                type: z.string(),
                params: z.record(z.string(), z.number()).optional(),
                enabled: z.boolean().default(true),
                position: z.number().int().min(0).optional(),
            }),
            execute: async ({ projectExternalId, type, params, enabled, position }) => {
                if (!ctx.allowDestructive) return refusedDestructive("addMasterFx");
                if (!FX_DEFAULTS[type]) {
                    return { ok: false as const, reason: "unknown-fx-type" as const, knownTypes: FX_TYPES };
                }
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const fx: InsertEffectDoc = {
                    id: newId(), type, enabled,
                    params: { ...FX_DEFAULTS[type], ...(params ?? {}) },
                };
                const inserts = [...(p.doc.masterTrack.inserts ?? [])];
                if (position === undefined || position >= inserts.length) inserts.push(fx);
                else inserts.splice(position, 0, fx);
                const masterTrack = { ...p.doc.masterTrack, inserts };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, masterTrack });
                return { ok: true as const, fxId: fx.id, type, params: fx.params };
            },
        }),

        setMasterFxParam: tool({
            description: "Patch params on a master-bus insert. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                fxId: z.string(),
                params: z.record(z.string(), z.number()),
                enabled: z.boolean().optional(),
            }),
            execute: async ({ projectExternalId, fxId, params, enabled }) => {
                if (!ctx.allowDestructive) return refusedDestructive("setMasterFxParam");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const inserts = (p.doc.masterTrack.inserts ?? []).map((fx) => {
                    if (fx.id !== fxId) return fx;
                    return {
                        ...fx,
                        ...(enabled !== undefined ? { enabled } : {}),
                        params: { ...fx.params, ...params },
                    };
                });
                if (!inserts.some((fx) => fx.id === fxId)) {
                    return { ok: false as const, reason: "fx-not-found" as const };
                }
                const masterTrack = { ...p.doc.masterTrack, inserts };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, masterTrack });
                const patched = inserts.find((fx) => fx.id === fxId)!;
                return { ok: true as const, fxId, applied: patched };
            },
        }),

        removeMasterFx: tool({
            description: "Remove an FX insert from the master bus. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                fxId: z.string(),
            }),
            execute: async ({ projectExternalId, fxId }) => {
                if (!ctx.allowDestructive) return refusedDestructive("removeMasterFx");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const before = p.doc.masterTrack.inserts ?? [];
                const inserts = before.filter((fx) => fx.id !== fxId);
                if (inserts.length === before.length) {
                    return { ok: false as const, reason: "fx-not-found" as const };
                }
                const masterTrack = { ...p.doc.masterTrack, inserts };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, { ...p.doc, masterTrack });
                return { ok: true as const, fxId };
            },
        }),

        // ─── Project lifecycle & navigation ────────────────────────

        createDawProject: tool({
            description:
                "Create a brand-new, EMPTY DAW project and return its externalId. Use when the user " +
                "starts a NEW song concept (different genre/title/BPM than what's open). For iterating " +
                "on the open project, do NOT call this — just edit. Always pick a descriptive name " +
                "like '<Title> — <Genre> <BPM>BPM <Key>' (e.g. 'Inima Pe Vinyl — Manele×TechHouse 124BPM Am'). " +
                "Optionally pre-set tempo, key, and time signature. Returns { externalId, navigateUrl } — " +
                "follow with navigateApp({app:'daw', projectExternalId}) so the user sees the new project. " +
                "Destructive.",
            inputSchema: z.object({
                name: z.string().min(1).max(120)
                    .describe("Descriptive name. Pattern: '<Title> — <Genre> <BPM>BPM [Key]'."),
                bpm: z.number().min(40).max(220).optional(),
                key: z.string().optional().describe("Camelot ('8A') or musical ('A minor') key."),
                timeSignature: z.object({
                    numerator: z.number().int().min(1).max(32),
                    denominator: z.number().int().min(1).max(32),
                }).optional(),
            }),
            execute: async ({ name, bpm, key, timeSignature }) => {
                if (!ctx.allowDestructive) return refusedDestructive("createDawProject");
                const externalId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const { createDefaultProject } = await import("@/lib/daw-engine");
                const doc = createDefaultProject(name);
                doc.id = externalId;
                if (bpm) doc.tempo = Math.round(bpm);
                if (timeSignature) doc.timeSignature = timeSignature;
                const { saveProject } = await import("@/actions/projects");
                await saveProject({
                    kind: "daw",
                    externalId,
                    name,
                    document: doc as unknown as Record<string, unknown>,
                    extras: {
                        ...(bpm ? { bpm: Math.round(bpm) } : {}),
                        ...(key ? { keyCamelot: key } : {}),
                    },
                });
                return {
                    ok: true as const,
                    externalId,
                    name,
                    tempo: doc.tempo,
                    timeSignature: doc.timeSignature,
                    navigateUrl: `/daw?project=${externalId}`,
                    hint: "Call navigateApp({app:'daw', projectExternalId} to open it in the UI.",
                };
            },
        }),

        renameDawProject: tool({
            description:
                "Rename a DAW project. Defaults to the open project when projectExternalId is omitted. " +
                "Use to upgrade an 'Untitled' or generic name to something descriptive once the song " +
                "concept is clear. Destructive.",
            inputSchema: z.object({
                projectExternalId: z.string().optional(),
                name: z.string().min(1).max(120),
            }),
            execute: async ({ projectExternalId, name }) => {
                if (!ctx.allowDestructive) return refusedDestructive("renameDawProject");
                const p = await resolveOpenProject(ctx, projectExternalId);
                if (!p) return { ok: false as const, reason: "no-project" as const };
                const newDoc = { ...p.doc, name };
                await saveProjectDoc(ctx.userId, p.externalId, p.rowId, p.fv, newDoc);
                // Also update the top-level name column via saveProject for the project list UI.
                const { saveProject } = await import("@/actions/projects");
                await saveProject({
                    kind: "daw",
                    externalId: p.externalId,
                    name,
                    document: newDoc as unknown as Record<string, unknown>,
                });
                return { ok: true as const, externalId: p.externalId, name };
            },
        }),

        navigateApp: tool({
            description:
                "Open one of the MMO sub-apps in the UI. Use to take the user to the DAW after " +
                "creating/editing a project, to the Library after importing tracks, etc. The client " +
                "intercepts the tool result and routes via the SPA router. Pass projectExternalId " +
                "for project-scoped surfaces (daw/editor/live/visualizations).",
            inputSchema: z.object({
                app: z.enum([
                    "daw", "editor", "live", "library", "visualizations",
                    "voice-wizard", "settings", "settings-music", "settings-copilot",
                    "generated", "playlists", "mixer",
                ]),
                projectExternalId: z.string().optional()
                    .describe("Required for daw/editor/live/visualizations to pin the open project."),
            }),
            execute: async ({ app, projectExternalId }) => {
                const base: Record<string, string> = {
                    "daw": "/daw",
                    "editor": "/editor",
                    "live": "/live",
                    "library": "/library",
                    "visualizations": "/visualizations",
                    "voice-wizard": "/voice-wizard",
                    "settings": "/settings",
                    "settings-music": "/settings/music",
                    "settings-copilot": "/settings/copilot",
                    "generated": "/generated",
                    "playlists": "/playlists",
                    "mixer": "/mixer",
                };
                const path = base[app];
                const url = projectExternalId && ["/daw", "/editor", "/live", "/visualizations"].includes(path)
                    ? `${path}?project=${encodeURIComponent(projectExternalId)}`
                    : path;
                return {
                    ok: true as const,
                    navigate: { url, app, projectExternalId: projectExternalId ?? null },
                    hint: "The chat dock will route the user to this URL automatically.",
                };
            },
        }),

        reportMaestroIssue: tool({
            description:
                "File an internal bug/UX report for the dev team. Call this PROACTIVELY when a tool " +
                "call returns ok:false with an unexpected reason, when the user complains about a " +
                "broken behaviour, or when you detect a gap (missing tool, confusing error, stuck " +
                "generation). Reports are persisted server-side and logged for triage. Always include " +
                "the failing tool name + input snippet in `context` when reporting a tool failure.",
            inputSchema: z.object({
                title: z.string().min(3).max(160),
                summary: z.string().min(3).max(4000),
                severity: z.enum(["low", "medium", "high", "blocker"]).default("medium"),
                category: z.enum(["bug", "ux", "gap", "performance", "data"]).default("bug"),
                context: z.record(z.string(), z.unknown()).optional()
                    .describe("Free-form metadata: failing tool name, tool input, error message, project id, etc."),
            }),
            execute: async ({ title, summary, severity, category, context: ictx }) => {
                const entry = {
                    ts: new Date().toISOString(),
                    userId: ctx.userId,
                    sessionId: ctx.sessionId,
                    currentProjectExternalId: ctx.currentProjectExternalId ?? null,
                    title,
                    summary,
                    severity,
                    category,
                    context: ictx ?? null,
                };
                // Console log for live dev visibility.
                // eslint-disable-next-line no-console
                console.warn("[maestro-feedback]", JSON.stringify(entry));
                // Append to JSONL file for offline triage.
                try {
                    const dir = path.join(process.cwd(), "data", "maestro-feedback");
                    await fsp.mkdir(dir, { recursive: true });
                    const file = path.join(dir, "issues.jsonl");
                    await fsp.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
                } catch (err) {
                    // eslint-disable-next-line no-console
                    console.warn("[maestro-feedback] file write failed", err);
                }
                // Mirror into syncLog so it appears in the cross-device audit trail.
                try {
                    await appendSync(ctx.userId, "maestroFeedback", randomUUID(), "upsert", entry);
                } catch { /* ignore */ }
                return {
                    ok: true as const,
                    filed: true,
                    severity,
                    category,
                    title,
                    hint: "Tell the user the issue was filed and offer a workaround if possible.",
                };
            },
        }),

        updateConversationMeta: tool({
            description:
                "Update the current conversation's title and/or one-paragraph description. Call this whenever the " +
                "conversation's topic crystallises or shifts so the History pane stays accurate — e.g. after the " +
                "first concrete task ('Train 3 LoRAs on House/Trance/Techno') or when the user pivots to a new " +
                "subject. The description should be <=300 chars and capture WHAT we're working on + the current " +
                "state ('Training in progress: 3 Vertex jobs running, eval prompts patched'). Either field is " +
                "optional; pass only what changed.",
            inputSchema: z.object({
                title: z.string().min(1).max(120).optional()
                    .describe("Short, specific chat title. Imperative or noun phrase. No quotes, no trailing period."),
                description: z.string().min(1).max(300).optional()
                    .describe("One-paragraph summary of the conversation goal and current state."),
            }),
            execute: async ({ title, description }) => {
                if (!title && !description) {
                    return { ok: false as const, reason: "no-fields" as const, message: "Pass title and/or description." };
                }
                try {
                    const { updateSessionMeta } = await import("@/actions/maestro");
                    await updateSessionMeta(ctx.sessionId, { title, description });
                    return { ok: true as const, sessionId: ctx.sessionId, title: title ?? null, description: description ?? null };
                } catch (err) {
                    return {
                        ok: false as const,
                        reason: "update-failed" as const,
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
            },
        }),
    };
}
