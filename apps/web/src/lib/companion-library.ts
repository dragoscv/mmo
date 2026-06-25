/**
 * Companion library HTTP client (server-side only).
 *
 * Resolves the signed-in user's local companion (registered in the
 * `devices` table with a localhost api_url) and exposes a typed wrapper
 * over the companion's `/library/*` endpoints.
 *
 * Key invariant — the companion is the SOLE source of truth for tracks,
 * playlists, scan logs and downloads. The web app's own SQLite no
 * longer stores any of those rows. Every read & write goes through this
 * client. When there is no session OR no reachable local companion the
 * caller receives `null` and is expected to render an empty state.
 */

import "server-only";
import { auth } from "@/auth";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { materializeDeviceToken } from "@/lib/device-token";
import { isLoopbackUrl, pickCompanionUrl } from "@/lib/companion-url";

export interface CompanionLink {
    apiUrl: string;
    token: string;
    deviceId: string;
    userId: string;
}

/** Resolve "the" companion for the signed-in user.
 *
 *  Preference order:
 *    1. A device whose api_url is on localhost / 127.0.0.1 (true local
 *       companion — lowest latency, used by the audio engine path).
 *    2. Any other device the user has paired with a non-empty api_url
 *       and token (LAN, Tailscale, 10.x, 192.168.x, public domain, …).
 *
 *  The chosen device's reachable base URL is then resolved by
 *  `pickCompanionUrl`: when the Next runtime is co-located with the
 *  companion (local `pnpm dev` / Tauri), the loopback URL is preferred
 *  (fastest + immune to flaky LAN IPs); on hosted runtimes (Vercel /
 *  Cloud Run) only the non-loopback LAN/tunnel URL is used.
 *
 *  Returns null when there's no session, no paired device, or no
 *  reachable URL for the current runtime.
 *  Does NOT probe the companion — callers tolerate transient downtime
 *  via per-method try/catch. For paths that already know which device
 *  they want, prefer `getCompanionLinkForDevice(deviceId)`. */
export async function getCompanionLink(): Promise<CompanionLink | null> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;

    const rows = await db.select().from(devices)
        .where(eq(devices.userId, userId));
    const usable = rows.filter((d) => d.apiUrl && d.tokenEncrypted);
    if (usable.length === 0) return null;
    // Choose the BEST device, not an arbitrary one. With multiple paired
    // machines (e.g. desktop + laptop) the previous code picked whichever row
    // the DB returned first, which could be a long-offline device whose tunnel
    // is dead → every probe 530s ("Reconnecting…"). Rank by:
    //   1. recently-seen (online within the heartbeat window) first,
    //   2. then a true-local loopback api_url,
    //   3. then most-recent last_seen_at.
    const ONLINE_WINDOW_MS = 90_000;
    const now = Date.now();
    const seenMs = (d: typeof usable[number]) => (d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0);
    const isOnline = (d: typeof usable[number]) => now - seenMs(d) <= ONLINE_WINDOW_MS;
    const ranked = [...usable].sort((a, b) => {
        const ao = isOnline(a) ? 1 : 0, bo = isOnline(b) ? 1 : 0;
        if (ao !== bo) return bo - ao;
        const al = isLoopbackUrl(a.apiUrl!) ? 1 : 0, bl = isLoopbackUrl(b.apiUrl!) ? 1 : 0;
        if (al !== bl) return bl - al;
        return seenMs(b) - seenMs(a);
    });
    const chosen = ranked[0];
    const bearer = await materializeDeviceToken(chosen);
    if (!bearer) return null;
    const chosenUrl = pickCompanionUrl(chosen);
    if (!chosenUrl) return null;
    return { apiUrl: chosenUrl.replace(/\/+$/, ""), token: bearer, deviceId: chosen.id, userId };
}

/** Resolve a CompanionLink for an explicit device id owned by the
 *  signed-in user. Use this when the caller already knows which device
 *  the operation targets (scan ingest, watch poll, per-device library
 *  reads). Avoids the localhost-only filter in `getCompanionLink`,
 *  which silently fails for LAN-reachable companions (e.g. Tailscale,
 *  10.x, 192.168.x). */
export async function getCompanionLinkForDevice(
    deviceId: string,
): Promise<CompanionLink | null> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;
    const rows = await db.select().from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
        .limit(1);
    const row = rows[0];
    if (!row || !row.apiUrl) return null;
    const bearer = await materializeDeviceToken(row);
    if (!bearer) return null;
    const url = pickCompanionUrl(row) ?? row.apiUrl;
    return { apiUrl: url.replace(/\/+$/, ""), token: bearer, deviceId: row.id, userId };
}

/** Online window shared across companion resolvers (heartbeat freshness). */
export const COMPANION_ONLINE_WINDOW_MS = 90_000;

export interface CompanionLinkInfo extends CompanionLink {
    name: string;
    online: boolean;
    lastSeenAt: Date | null;
}

/** Resolve CompanionLinks for ALL of the signed-in user's paired devices
 *  that have a usable api_url + token and a reachable URL for the current
 *  runtime. Used by the aggregate (multi-companion) reads so Library /
 *  Dashboard / Analysis show data across every companion rather than a
 *  single auto-picked one. Ordered online-first, then most-recent. */
export async function getAllCompanionLinks(): Promise<CompanionLinkInfo[]> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return [];
    const rows = await db.select().from(devices).where(eq(devices.userId, userId));
    const now = Date.now();
    const out: CompanionLinkInfo[] = [];
    for (const d of rows) {
        if (!d.apiUrl || !d.tokenEncrypted) continue;
        const url = pickCompanionUrl(d);
        if (!url) continue;
        const bearer = await materializeDeviceToken(d);
        if (!bearer) continue;
        const lastSeenAt = d.lastSeenAt ? new Date(d.lastSeenAt) : null;
        out.push({
            apiUrl: url.replace(/\/+$/, ""),
            token: bearer,
            deviceId: d.id,
            userId,
            name: d.name,
            lastSeenAt,
            online: lastSeenAt ? now - lastSeenAt.getTime() <= COMPANION_ONLINE_WINDOW_MS : false,
        });
    }
    out.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0);
    });
    return out;
}

/** Run a read against every online companion and merge the results.
 *  Offline companions are skipped (their cached data, when present, is the
 *  caller's responsibility). Errors from one companion never fail the whole
 *  aggregate — they're collected and returned alongside the data. */
export async function aggregateAcrossCompanions<T>(
    fn: (link: CompanionLinkInfo) => Promise<T>,
    opts: { onlineOnly?: boolean } = {},
): Promise<{ results: Array<{ link: CompanionLinkInfo; value: T }>; errors: Array<{ deviceId: string; name: string; error: string }> }> {
    const links = await getAllCompanionLinks();
    const targets = opts.onlineOnly === false ? links : links.filter((l) => l.online);
    const results: Array<{ link: CompanionLinkInfo; value: T }> = [];
    const errors: Array<{ deviceId: string; name: string; error: string }> = [];
    await Promise.all(targets.map(async (link) => {
        try { results.push({ link, value: await fn(link) }); }
        catch (e) { errors.push({ deviceId: link.deviceId, name: link.name, error: e instanceof Error ? e.message : String(e) }); }
    }));
    return { results, errors };
}

// ─── Low-level fetch helper ─────────────────────────────────────────────────

async function call<T>(
    link: CompanionLink,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    pathAndQuery: string,
    body?: unknown,
    timeoutMs = 15_000,
): Promise<T> {
    const url = `${link.apiUrl}/library${pathAndQuery}`;
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
        let detail = "";
        try { detail = (await res.json()).error ?? ""; } catch { /* ignore */ }
        throw new Error(`Companion ${method} /library${pathAndQuery} failed (${res.status})${detail ? ": " + detail : ""}`);
    }
    return await res.json() as T;
}

// ─── Types (mirrors companion's library schema) ─────────────────────────────

export interface CompanionTrack {
    id: number;
    userId: string;
    filepath: string;
    filename: string;
    artist: string | null;
    title: string | null;
    album: string | null;
    remix: string | null;
    label: string | null;
    bpm: number | null;
    keyCamelot: string | null;
    keyMusical: string | null;
    duration: number | null;
    energy: number | null;
    genre: string | null;
    subgenre: string | null;
    mood: string | null;
    color: string | null;
    vocalType: string | null;
    setPosition: string | null;
    mixability: number | null;
    isProcessed: boolean | null;
    fileSize: number | null;
    format: string | null;
    bitrate: number | null;
    sampleRate: number | null;
    addedAt: string | null;
    analyzedAt: string | null;
    rating: number | null;
    isFavorite: boolean | null;
    tags: string | null;
    artworkUrl: string | null;
    musicbrainzId: string | null;
    releaseMbid: string | null;
    isrc: string | null;
    year: number | null;
    comment: string | null;
    lyrics: string | null;
    syncedLyrics: string | null;
    isHidden: boolean | null;
    sourceUrl: string | null;
    sourcePlatform: string | null;
    sourceId: string | null;
    relatedTrackId: number | null;
    deviceId: string | null;
    isOfflineAvailable: boolean | null;
    stemsStatus: string | null;
    stemsVocalsPath: string | null;
    stemsDrumsPath: string | null;
    stemsBassPath: string | null;
    stemsMelodyPath: string | null;
    stemsAnalyzedAt: string | null;
    stemsModel?: string | null;
    stemsError?: string | null;
    /** Integrated loudness (LUFS, BS.1770-4). */
    loudnessLufs?: number | null;
    /** True peak in dBFS. */
    loudnessTruePeakDbfs?: number | null;
    /** Loudness range (LU). */
    loudnessRangeLu?: number | null;
    /** AcoustID Chromaprint fingerprint (base64-ish). */
    acoustidFingerprint?: string | null;
    /** AcoustID UUID — joins to MusicBrainz. */
    acoustidId?: string | null;
    /** DSP confidence 0..1 for the BPM estimate. */
    bpmConfidence?: number | null;
    /** DSP confidence 0..1 for the key estimate. */
    keyConfidence?: number | null;
    /** JSON array of beat positions in seconds. */
    beats?: string | null;
    /** JSON array of downbeat positions in seconds. */
    downbeats?: string | null;
    /** JSON array of `{start, end, chord}` beat-aligned chord segments. */
    chordProgression?: string | null;
    /** JSON array of `{start, end, label}` functional structure segments. */
    structureSegments?: string | null;
    /** Last DSP analyzer run timestamp (separate from external metadata). */
    dspAnalyzedAt?: string | null;
    /** SHA-256 of the source file's content; primary dedupe key. */
    sha256?: string | null;
    /** Cloud availability: "connected" when a source device is online,
     *  "disconnected" otherwise. Set by cloud-library reads; the client
     *  overlays "offline" when the track is pinned in IndexedDB. */
    availabilityState?: "connected" | "disconnected" | null;
    /** Number of distinct devices that hold this track's file. */
    sourceCount?: number | null;
    /** Display names of the source devices (online first), for tooltips. */
    sourceDeviceNames?: string[] | null;
}

export interface PaginatedTracks {
    tracks: CompanionTrack[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

export interface TrackFilters {
    genre?: string;
    subgenre?: string;
    minBpm?: number;
    maxBpm?: number;
    energy?: number;
    search?: string;
    key?: string;
    isProcessed?: boolean;
    isFavorite?: boolean;
    isHidden?: boolean;
    tag?: string;
    rating?: number;
    album?: string;
    artist?: string;
    year?: number;
    label?: string;
    mood?: string;
    page?: number;
    pageSize?: number;
    sort?: string;
    order?: "asc" | "desc";
}

function toQuery(f: TrackFilters | undefined): string {
    if (!f) return "";
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) {
        if (v === undefined || v === null || v === "") continue;
        usp.set(k, String(v));
    }
    const s = usp.toString();
    return s ? `?${s}` : "";
}

// ─── High-level API ─────────────────────────────────────────────────────────

export const companionLibrary = {
    async getTracks(link: CompanionLink, filters?: TrackFilters): Promise<PaginatedTracks> {
        return call<PaginatedTracks>(link, "GET", `/tracks${toQuery(filters)}`);
    },
    async getTrackById(link: CompanionLink, id: number): Promise<CompanionTrack | null> {
        try {
            const r = await call<{ track: CompanionTrack }>(link, "GET", `/tracks/${id}`);
            return r.track;
        } catch { return null; }
    },
    /** Stream the raw source audio file for a track. Caller owns the
     *  response; close/consume the body promptly. */
    async fetchTrackAudio(link: CompanionLink, id: number): Promise<Response> {
        const url = `${link.apiUrl}/library/tracks/${id}/audio`;
        const res = await fetch(url, {
            headers: { "X-Device-Token": link.token, "X-User-Id": link.userId },
            signal: AbortSignal.timeout(120_000),
            cache: "no-store",
        });
        if (!res.ok) {
            throw new Error(`Companion GET /library/tracks/${id}/audio failed (${res.status})`);
        }
        return res;
    },
    async updateTrack(link: CompanionLink, id: number, data: Partial<CompanionTrack>): Promise<void> {
        await call(link, "PATCH", `/tracks/${id}`, data);
    },
    async deleteTrack(link: CompanionLink, id: number): Promise<void> {
        await call(link, "DELETE", `/tracks/${id}`);
    },
    async toggleFavorite(link: CompanionLink, id: number): Promise<{ isFavorite: boolean }> {
        const r = await call<{ isFavorite: boolean }>(link, "POST", `/tracks/${id}/favorite`);
        return { isFavorite: r.isFavorite };
    },
    async setRating(link: CompanionLink, id: number, rating: number | null): Promise<void> {
        await call(link, "POST", `/tracks/${id}/rating`, { rating });
    },
    async setTags(link: CompanionLink, id: number, tags: string[]): Promise<void> {
        await call(link, "POST", `/tracks/${id}/tags`, { tags });
    },
    async setHidden(link: CompanionLink, ids: number[], hidden: boolean): Promise<{ count: number }> {
        return call(link, "POST", `/tracks/hide`, { ids, hidden });
    },
    async ingestTracks(
        link: CompanionLink,
        tracks: Array<Partial<CompanionTrack> & { filepath: string; filename: string }>,
    ): Promise<{ inserted: number; skipped: number; total: number }> {
        // Chunk to keep each POST body under the companion's express
        // limit (64 MB) with a healthy margin even for tracks with long
        // tag strings. 1000 rows ≈ 1–2 MB of JSON in practice. Without
        // this, a single big-folder scan triggered HTTP 413. The
        // companion ingest is idempotent on (user_id, filepath), so
        // chunked retries are safe. Per-chunk timeout is generous
        // (60 s) because a 1k upsert on a cold SQLite can take a few
        // seconds when indexes are rebuilt.
        const CHUNK = 1000;
        const TIMEOUT = 60_000;
        if (tracks.length <= CHUNK) {
            return call(link, "POST", `/tracks/ingest`, { tracks }, TIMEOUT);
        }
        let inserted = 0;
        let skipped = 0;
        let total = 0;
        for (let i = 0; i < tracks.length; i += CHUNK) {
            const slice = tracks.slice(i, i + CHUNK);
            const r = await call<{ inserted: number; skipped: number; total: number }>(
                link, "POST", `/tracks/ingest`, { tracks: slice }, TIMEOUT,
            );
            inserted += r.inserted;
            skipped += r.skipped;
            total += r.total;
        }
        return { inserted, skipped, total };
    },
    async getGenres(link: CompanionLink): Promise<string[]> {
        const r = await call<{ genres: (string | null)[] }>(link, "GET", `/genres`);
        return (r.genres || []).filter((g): g is string => !!g);
    },
    async getKeys(link: CompanionLink): Promise<string[]> {
        const r = await call<{ keys: (string | null)[] }>(link, "GET", `/keys`);
        return (r.keys || []).filter((k): k is string => !!k);
    },
    async getTags(link: CompanionLink): Promise<string[]> {
        const r = await call<{ tags: string[] }>(link, "GET", `/tags`);
        return r.tags || [];
    },
    async getStats(link: CompanionLink): Promise<DashboardStats> {
        return call<DashboardStats>(link, "GET", `/stats`);
    },
    async getDrives(link: CompanionLink): Promise<CompanionDrive[]> {
        const r = await call<{ drives: CompanionDrive[] }>(link, "GET", `/drives`);
        return r.drives || [];
    },
    async cleanRekordboxDrive(
        link: CompanionLink,
        data: { drive: string; includeOneLibrary?: boolean; includeContents?: boolean },
    ): Promise<{ removed: string[]; removedOneLibrary: boolean }> {
        return call<{ removed: string[]; removedOneLibrary: boolean }>(
            link, "POST", `/drives/rekordbox/clean`, data,
        );
    },
    async getSavedDrives(link: CompanionLink): Promise<CompanionSavedDrive[]> {
        const r = await call<{ drives: CompanionSavedDrive[] }>(link, "GET", `/drives/saved`);
        return r.drives || [];
    },
    async addSavedDrive(link: CompanionLink, data: { path: string; label: string; type?: string; format?: string }): Promise<CompanionSavedDrive> {
        const r = await call<{ drive: CompanionSavedDrive }>(link, "POST", `/drives/saved`, data);
        return r.drive;
    },
    async removeSavedDrive(link: CompanionLink, id: number): Promise<void> {
        await call(link, "DELETE", `/drives/saved/${id}`);
    },
    /** Non-streaming USB copy. Use `copyTracksToUsb()` (top-level export)
     *  when you want progress events as the copy runs. */
    async copyTracksToUsbBatch(
        link: CompanionLink,
        opts: { trackIds: number[]; destination: string; musicSubdir?: string },
    ): Promise<UsbCopyResult> {
        return call<UsbCopyResult>(link, "POST", `/usb/copy`, { ...opts, stream: false });
    },
    async getScanLogs(link: CompanionLink, limit = 20): Promise<ScanLogEntry[]> {
        // Short timeout: this runs during dashboard render. A stale/unreachable
        // companion (e.g. cached LAN IP from another network) must fail fast
        // instead of blocking the page for the full default timeout.
        const r = await call<{ logs: ScanLogEntry[] }>(link, "GET", `/scan-logs?limit=${limit}`, undefined, 3_000);
        return r.logs || [];
    },
    async getPlaylists(link: CompanionLink, timeoutMs?: number): Promise<PlaylistSummary[]> {
        const r = await call<{ playlists: PlaylistSummary[] }>(link, "GET", `/playlists`, undefined, timeoutMs);
        return r.playlists || [];
    },
    async createPlaylist(link: CompanionLink, name: string, description?: string): Promise<PlaylistSummary> {
        const r = await call<{ playlist: PlaylistSummary }>(link, "POST", `/playlists`, { name, description });
        return r.playlist;
    },
    async updatePlaylist(link: CompanionLink, id: number, data: { name?: string; description?: string }): Promise<void> {
        await call(link, "PATCH", `/playlists/${id}`, data);
    },
    async deletePlaylist(link: CompanionLink, id: number): Promise<void> {
        await call(link, "DELETE", `/playlists/${id}`);
    },
    async getPlaylistTracks(link: CompanionLink, id: number, page = 1, pageSize = 50): Promise<PaginatedPlaylistTracks> {
        return call(link, "GET", `/playlists/${id}/tracks?page=${page}&pageSize=${pageSize}`);
    },
    async addTracksToPlaylist(link: CompanionLink, playlistId: number, trackIds: number[]): Promise<{ added: number }> {
        return call(link, "POST", `/playlists/${playlistId}/tracks`, { trackIds });
    },
    async removeTrackFromPlaylist(link: CompanionLink, playlistId: number, trackId: number): Promise<void> {
        await call(link, "DELETE", `/playlists/${playlistId}/tracks/${trackId}`);
    },
    async reorderPlaylist(link: CompanionLink, playlistId: number, trackIds: number[]): Promise<{ count: number }> {
        return call(link, "POST", `/playlists/${playlistId}/reorder`, { trackIds });
    },
};

// ─── Analyzer (DSP + source separation) client ──────────────────────────────

export interface AnalyzeOptions {
    /** BPM, key, energy, loudness (LUFS), beats, chord progression. */
    dsp?: boolean;
    /** Chromaprint fingerprint (companion needs `fpcalc` on PATH). */
    fingerprint?: boolean;
    /** Source separation. Output WAVs cached by the companion under
     *  `<userData>/stems/<trackId>/`. Default model is BS-Roformer
     *  which leads MVSEP for vocal isolation as of 2025. */
    stems?: boolean;
    /** Override the default stems model id (audio-separator filename
     *  without the `.ckpt`/`.yaml` extension). Examples:
     *  - `htdemucs_ft`                          (default, Demucs v4 fine-tuned, 4-stem)
     *  - `htdemucs_6s`                          (6-stem: + piano + guitar, experimental)
     *  - `model_bs_roformer_ep_317_sdr_12.9755` (best vocals, 2-stem only)
     *  - `mel_band_roformer_kim_ft_unwa.ckpt`   (4-stem mel-band) */
    stemsModel?: string;
    /** Web-metadata lane: genre/album/year/label/ISRC/artwork/lyrics/BPM
     *  fetched in-process on the companion (MusicBrainz/iTunes/Deezer/
     *  CoverArtArchive/LRCLIB). Survives refresh; stored immediately. */
    metadata?: boolean;
    /** Sub-flags for the metadata lane (default all on when `metadata`). */
    metaFields?: { tags?: boolean; artwork?: boolean; lyrics?: boolean; bpm?: boolean };
}


export interface AnalyzerJob {
    id: string;
    trackId: number;
    /** Groups sub-jobs from the same enqueue() call (one per category). */
    requestId?: string;
    /** Which lane this sub-job belongs to (companion 0.9+). */
    category?: Category;
    enqueuedAt?: number;
    startedAt?: number;
    finishedAt?: number;
    progress?: number;
    stage?: string;
    message?: string;
    error?: string | null;
}

/** Companion 0.9+ splits analysis across three independent worker
 *  lanes that run truly concurrently (disjoint resources). */
export type Category = "dsp" | "stems" | "fingerprint" | "metadata";

/** One "Start analysis" run = one logical job (batch) containing many item
 *  sub-jobs. Mirrors the companion's BatchSummary. */
export interface AnalyzerBatch {
    batchId: string;
    label: string;
    total: number;
    /** Distinct tracks in the run (not item sub-jobs). */
    tracks: number;
    /** Distinct tracks fully finished. */
    tracksFinished: number;
    queued: number;
    running: number;
    done: number;
    errored: number;
    canceled: number;
    finished: number;
    progress: number;
    state: "running" | "done" | "error";
    categories: Category[];
    enqueuedAt: number;
    startedAt: number | null;
    finishedAt: number | null;
    lanes: BatchLane[];
}

export interface BatchLane {
    category: Category;
    total: number;
    finished: number;
    done: number;
    running: number;
    queued: number;
    startedAt: number | null;
    lastFinishedAt: number | null;
}

export interface LaneStatus {
    category: Category;
    paused: boolean;
    current: AnalyzerJob | null;
    queue: AnalyzerJob[];
    queueDepth: number;
}

export interface AnalyzerStatus {
    /** Most-progressed currently-running job (legacy single-card view). */
    current: AnalyzerJob | null;
    /** Flattened queued jobs across all lanes (sorted by enqueuedAt). */
    queue: AnalyzerJob[];
    /** Recently-completed ring buffer (cross-lane). */
    completed: AnalyzerJob[];
    /** Per-lane snapshots — use these for the new three-card UI. */
    lanes?: LaneStatus[];
    /** True when EVERY lane is paused. */
    paused?: boolean;
    /** True when AT LEAST ONE lane is paused. */
    anyPaused?: boolean;
    /** Authoritative finished-job counts since the timestamp the
     *  client passed in `?since=`. Driven by sqlite (not the
     *  in-memory ring buffer) so it stays accurate across batches
     *  with thousands of completions. Only present when `since` was
     *  passed AND the companion is v0.9.2+. */
    finishedSince?: { done: number; errored: number; total: number };
}

export interface GpuInfo {
    hasNvidia: boolean;
    gpuName: string | null;
    cudaRuntime: string | null;
    onnxPackage: string | null;
    onnxProviders: string[];
    onnxGpuActive: boolean;
    torchCuda: boolean;
    recommendation: "ready" | "install_onnx_gpu" | "install_cuda_runtime" | "no_gpu";
}

export interface AnalyzerHealth {
    ok: boolean;
    pythonPath?: string;
    pythonVersion?: string;
    pythonExecutable?: string;
    available?: Record<string, boolean>;
    gpu?: GpuInfo;
    reason?: string;
    /** True when the failure is a transient connectivity problem (tunnel
     *  530/502/503/504 or timeout) rather than a real analyzer-offline /
     *  missing-deps state. The UI shows "reconnecting / retry" instead of
     *  the misleading pip-install hint. */
    transient?: boolean;
}

export interface AnalyzerLogEntry {
    seq: number;
    ts: number;
    level: "info" | "warn" | "error" | "debug";
    message: string;
    jobId?: string;
}

export const companionAnalyzer = {
    async health(link: CompanionLink): Promise<AnalyzerHealth> {
        return call<AnalyzerHealth>(link, "GET", `/analyze/health`);
    },
    async start(link: CompanionLink, trackIds: number[], options: AnalyzeOptions, batch?: { id: string; label: string }): Promise<{ jobs: Array<{ id: string; trackId: number }>; batchId?: string }> {
        return call(link, "POST", `/analyze`, { trackIds, options, batchId: batch?.id, batchLabel: batch?.label });
    },
    async batches(link: CompanionLink, limit = 50): Promise<{ batches: AnalyzerBatch[] }> {
        return call(link, "GET", `/analyze/batches?limit=${limit}`);
    },
    async resync(link: CompanionLink): Promise<{ queued: number; total: number }> {
        return call(link, "POST", `/analyze/resync`, {});
    },
    async cancelBatch(link: CompanionLink, batchId: string): Promise<{ canceled: number }> {
        return call(link, "POST", `/analyze/batch/${encodeURIComponent(batchId)}/cancel`, {});
    },
    async status(link: CompanionLink, sinceMs?: number): Promise<AnalyzerStatus> {
        const qs = sinceMs && sinceMs > 0 ? `?since=${sinceMs}` : "";
        return call<AnalyzerStatus>(link, "GET", `/analyze/status${qs}`);
    },
    async getJob(link: CompanionLink, id: string): Promise<{ job: AnalyzerJob }> {
        return call(link, "GET", `/analyze/job/${encodeURIComponent(id)}`);
    },
    async cancel(link: CompanionLink, id: string): Promise<{ canceled: boolean }> {
        return call(link, "POST", `/analyze/cancel/${encodeURIComponent(id)}`);
    },
    async retry(link: CompanionLink, id: string): Promise<{ job: { id: string; trackId: number } }> {
        return call(link, "POST", `/analyze/retry/${encodeURIComponent(id)}`);
    },
    async clearQueue(link: CompanionLink, category: Category | "all" = "all"): Promise<{ removed: number; category: Category | "all" }> {
        return call(link, "POST", `/analyze/queue/clear`, { category });
    },
    /** Hold new work in a lane (or all lanes). The currently running
     *  sub-job continues to completion. */
    async pauseLane(link: CompanionLink, category: Category | "all" = "all"): Promise<{ paused: boolean; category: Category | "all" }> {
        return call(link, "POST", `/analyze/pause`, { category });
    },
    async resumeLane(link: CompanionLink, category: Category | "all" = "all"): Promise<{ paused: boolean; category: Category | "all" }> {
        return call(link, "POST", `/analyze/resume`, { category });
    },
    async removeCompleted(link: CompanionLink, id: string): Promise<{ removed: boolean }> {
        return call(link, "DELETE", `/analyze/completed/${encodeURIComponent(id)}`);
    },
    async clearCompleted(link: CompanionLink, filter: "all" | "errored" | "done" = "all"): Promise<{ removed: number; filter: string }> {
        return call(link, "POST", `/analyze/completed/clear?filter=${filter}`);
    },
    async retryFailed(link: CompanionLink): Promise<{ enqueued: number; jobs: Array<{ id: string; trackId: number }> }> {
        return call(link, "POST", `/analyze/retry-failed`);
    },
    async logs(link: CompanionLink, since = 0, limit = 500): Promise<{ logs: AnalyzerLogEntry[] }> {
        return call(link, "GET", `/analyze/logs?since=${since}&limit=${limit}`);
    },
    async installGpu(
        link: CompanionLink,
        target: "onnx" | "torch" | "all" = "onnx",
    ): Promise<{ installed: string; gpu: GpuInfo; log: string }> {
        return call(link, "POST", `/analyze/gpu/install`, { target });
    },
    async restartSidecar(
        link: CompanionLink,
        force = false,
    ): Promise<{ ok: boolean; health: AnalyzerHealth }> {
        return call(link, "POST", `/analyze/restart`, { force });
    },
    /** Build a stems URL the browser can pass to `<audio>` or fetch.
     *  Uses the same auth headers as the JSON API — for `<audio>` you
     *  must use a fetch+blob workflow (no header support on `<audio src>`).
     *  Returns null when the track has no stems yet. */
    stemUrl(link: CompanionLink, trackId: number, stem: "vocals" | "drums" | "bass" | "other" | "instrumental"): string {
        return `${link.apiUrl}/library/stems/${trackId}/${stem}.wav`;
    },
};

export interface CompanionDrive {
    path: string;
    label: string;
    format: string;
    totalSize: number;
    freeSpace: number;
    usedSpace: number;
    type: "fixed" | "removable" | "network" | "unknown";
    /** Rekordbox library status (null when the drive can't be inspected). */
    rekordbox?: RekordboxDriveStatus | null;
}

export interface RekordboxDriveStatus {
    hasClassic: boolean;
    hasDeviceLibraryPlus: boolean;
    hasOneLibrary: boolean;
    hasContents: boolean;
    trackCount: number;
    dbBytes: number;
}

export interface CompanionSavedDrive {
    id: number;
    userId: string;
    path: string;
    label: string;
    type: string;
    format: string | null;
    isActive: boolean | null;
    createdAt: string | null;
}

export interface DashboardStats {
    total: number;
    processed: number;
    unprocessed: number;
    analyzed: number;
    favorites: number;
    avgBpm: number;
    totalDuration: number;
    totalSize: number;
    playlistCount: number;
    genreStats: { genre: string; count: number }[];
    energyStats: { energy: number; count: number }[];
    bpmRanges: { range: string; count: number }[];
    keyStats: { key: string; count: number }[];
    formatStats: { format: string; count: number }[];
    health: {
        total: number;
        missingGenre: number;
        missingBpm: number;
        missingKey: number;
        missingEnergy: number;
        missingArtwork: number;
    };
    recentTracks: Array<{
        id: number;
        title: string | null;
        artist: string | null;
        genre: string | null;
        bpm: number | null;
        keyCamelot: string | null;
        energy: number | null;
        rating: number | null;
        artworkUrl: string | null;
        addedAt: string | null;
        duration: number | null;
        isFavorite: boolean | null;
    }>;
    topRated: Array<{
        id: number;
        title: string | null;
        artist: string | null;
        rating: number | null;
        artworkUrl: string | null;
    }>;
}

export interface ScanLogEntry {
    id: number;
    userId: string;
    action: string;
    filepath: string;
    details: string | null;
    scannedAt: string | null;
}

export interface PlaylistSummary {
    id: number;
    name: string;
    description: string | null;
    type: string | null;
    createdAt: string | null;
    trackCount: number;
}

export interface PaginatedPlaylistTracks {
    tracks: Array<CompanionTrack & { position: number }>;
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
}

// ─── Empty-state factories (used when not authed / no companion) ────────────

export const EMPTY_PAGINATED_TRACKS: PaginatedTracks = {
    tracks: [], total: 0, page: 1, pageSize: 50, totalPages: 0,
};

export const EMPTY_STATS: DashboardStats = {
    total: 0, processed: 0, unprocessed: 0, analyzed: 0, favorites: 0,
    avgBpm: 0, totalDuration: 0, totalSize: 0, playlistCount: 0,
    genreStats: [], energyStats: [], bpmRanges: [], keyStats: [], formatStats: [],
    health: { total: 0, missingGenre: 0, missingBpm: 0, missingKey: 0, missingEnergy: 0, missingArtwork: 0 },
    recentTracks: [], topRated: [],
};

// ─── USB copy: streaming SSE consumer ──────────────────────────────────────

export type UsbCopyStatus = "copied" | "skipped" | "error";

export interface UsbCopyEvent {
    type: "start" | "progress" | "done";
    /** total tracks in the request (sent on `start` and every event). */
    total: number;
    /** 1-based index of the in-flight track (only on `progress`). */
    index?: number;
    status?: UsbCopyStatus;
    trackId?: number;
    /** Absolute target path on the destination drive. */
    file?: string;
    /** Final on-disk size in bytes, when the operation succeeded. */
    size?: number;
    error?: string;
    /** Cumulative tally (only on `done`). */
    copied?: number;
    skipped?: number;
    errors?: number;
    /** The fully resolved `<destination>/<musicSubdir>` (sent on `start`). */
    targetDir?: string;
}

export interface UsbCopyResult {
    copied: number;
    skipped: number;
    errors: number;
    total: number;
}

/**
 * Stream USB copy progress from the companion.
 *
 * Yields `start` once, one `progress` event per track, then a final
 * `done` event. The caller can break out of the loop early — the
 * underlying HTTP body is closed by the surrounding `try/finally`,
 * but the companion will continue copying any in-flight file. There
 * is no server-side cancel for this MVP; if you need it, wire an
 * AbortController through the call.
 */
export async function* copyTracksToUsb(
    link: CompanionLink,
    opts: { trackIds: number[]; destination: string; musicSubdir?: string },
    signal?: AbortSignal,
): AsyncGenerator<UsbCopyEvent, void, void> {
    const url = `${link.apiUrl}/library/usb/copy`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "X-Device-Token": link.token,
            "X-User-Id": link.userId,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
        },
        body: JSON.stringify({ ...opts, stream: true }),
        cache: "no-store",
        signal,
    });
    if (!res.ok || !res.body) {
        let detail = "";
        try { detail = (await res.json()).error ?? ""; } catch { /* ignore */ }
        throw new Error(`USB copy failed (${res.status})${detail ? ": " + detail : ""}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        for (; ;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // Split on the SSE record terminator (\n\n).
            let idx: number;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const raw = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                let event = "message";
                let data = "";
                for (const line of raw.split("\n")) {
                    if (line.startsWith("event:")) event = line.slice(6).trim();
                    else if (line.startsWith("data:")) data += line.slice(5).trim();
                }
                if (event !== "start" && event !== "progress" && event !== "done") continue;
                try {
                    const payload = JSON.parse(data) as Omit<UsbCopyEvent, "type">;
                    yield { type: event, ...payload } as UsbCopyEvent;
                } catch {
                    // Malformed payload — skip rather than abort the whole stream.
                }
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
    }
}

// ─── Rekordbox USB export (true plug-and-play CDJ/XDJ) ───────────────────────

export type RekordboxAutoCrate = "genre" | "bpm" | "key";
export type RekordboxTranscode = "none" | "incompatible" | "all";

export interface RekordboxExportOptions {
    /** Explicit track ids. Omit to export the whole library (or playlists). */
    trackIds?: number[];
    /** Playlist ids to export (their tracks are included + a crate created). */
    playlistIds?: number[];
    /** Absolute destination drive path. */
    destination: string;
    /** Auto-generate "By Genre / BPM / Key" crates. */
    autoCrates?: RekordboxAutoCrate[];
    /** Transcode policy for incompatible codecs (default "incompatible"). */
    transcode?: RekordboxTranscode;
    /** Write USBANLZ analysis files (beatgrid, cues, waveforms). Default true. */
    writeAnlz?: boolean;
}

/** A progress event from the rekordbox export sidecar (via the companion). */
export interface RekordboxExportEvent {
    /** Event kind: "start" | "progress" | "stage" | "done" | "error" | "log". */
    type: string;
    [key: string]: unknown;
}

/**
 * Stream rekordbox USB export progress from the companion. Yields a `start`
 * event, any number of sidecar progress events, then a terminal `done` (or
 * `error`). The caller may break early; pass an AbortSignal to cancel.
 */
export async function* rekordboxExport(
    link: CompanionLink,
    opts: RekordboxExportOptions,
    signal?: AbortSignal,
): AsyncGenerator<RekordboxExportEvent, void, void> {
    const url = `${link.apiUrl}/library/rekordbox/export`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "X-Device-Token": link.token,
            "X-User-Id": link.userId,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
        },
        body: JSON.stringify(opts),
        cache: "no-store",
        signal,
    });
    if (!res.ok || !res.body) {
        let detail = "";
        try { detail = (await res.json()).error ?? ""; } catch { /* ignore */ }
        throw new Error(`Rekordbox export failed (${res.status})${detail ? ": " + detail : ""}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        for (; ;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const raw = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                let event = "message";
                let data = "";
                for (const line of raw.split("\n")) {
                    if (line.startsWith("event:")) event = line.slice(6).trim();
                    else if (line.startsWith("data:")) data += line.slice(5).trim();
                }
                if (!data) continue;
                try {
                    const payload = JSON.parse(data) as Record<string, unknown>;
                    yield { type: event, ...payload };
                } catch {
                    // Malformed payload — skip.
                }
            }
        }
    } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
    }
}
