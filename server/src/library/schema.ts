/**
 * Library schema (companion-owned SQLite).
 *
 * The companion now owns the music library. Web app holds only auth +
 * device registry + recordings metadata. Each row carries `userId` so a
 * single companion install can serve multiple sign-ins on the same
 * machine (rare but cheap to support and a hard requirement for the
 * "no content when not authenticated" guarantee — content is filtered
 * by userId at every query).
 */

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const tracks = sqliteTable("tracks", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    filepath: text("filepath").notNull(),
    filename: text("filename").notNull(),
    artist: text("artist"),
    title: text("title"),
    album: text("album"),
    remix: text("remix"),
    label: text("label"),
    bpm: real("bpm"),
    keyCamelot: text("key_camelot"),
    keyMusical: text("key_musical"),
    duration: integer("duration"),
    energy: integer("energy"),
    genre: text("genre"),
    subgenre: text("subgenre"),
    mood: text("mood"),
    color: text("color"),
    vocalType: text("vocal_type"),
    setPosition: text("set_position"),
    mixability: integer("mixability"),
    isProcessed: integer("is_processed", { mode: "boolean" }).default(false),
    fileSize: integer("file_size"),
    format: text("format"),
    bitrate: integer("bitrate"),
    sampleRate: integer("sample_rate"),
    addedAt: text("added_at").default(sql`(datetime('now'))`),
    analyzedAt: text("analyzed_at"),
    rating: integer("rating"),
    isFavorite: integer("is_favorite", { mode: "boolean" }).default(false),
    tags: text("tags"),
    artworkUrl: text("artwork_url"),
    musicbrainzId: text("musicbrainz_id"),
    releaseMbid: text("release_mbid"),
    isrc: text("isrc"),
    year: integer("year"),
    comment: text("comment"),
    lyrics: text("lyrics"),
    syncedLyrics: text("synced_lyrics"),
    isHidden: integer("is_hidden", { mode: "boolean" }).default(false),
    sourceUrl: text("source_url"),
    sourcePlatform: text("source_platform"),
    sourceId: text("source_id"),
    relatedTrackId: integer("related_track_id"),
    deviceId: text("device_id"),
    isOfflineAvailable: integer("is_offline_available", { mode: "boolean" }).default(false),
    stemsStatus: text("stems_status"),
    stemsVocalsPath: text("stems_vocals_path"),
    stemsDrumsPath: text("stems_drums_path"),
    stemsBassPath: text("stems_bass_path"),
    stemsMelodyPath: text("stems_melody_path"),
    stemsAnalyzedAt: text("stems_analyzed_at"),
    /** Model identifier used for the most recent stems run, e.g.
     *  "bs_roformer_ep_317_sdr_12.9755" or "htdemucs_ft". Lets the
     *  Mixer/UI tell the user "stems generated with model X" and lets
     *  the analyzer skip re-runs when the same model already produced
     *  the cache. */
    stemsModel: text("stems_model"),
    /** Last-error message when stemsStatus = "error". */
    stemsError: text("stems_error"),
    /** Integrated loudness in LUFS (BS.1770-4). Negative numbers,
     *  e.g. -14.0 for streaming-master targets. */
    loudnessLufs: real("loudness_lufs"),
    /** True-peak in dBFS as measured by pyloudnorm / ITU BS.1770-4. */
    loudnessTruePeakDbfs: real("loudness_true_peak_dbfs"),
    /** Loudness range (LRA) in LU. Useful to flag dynamics-killed masters. */
    loudnessRangeLu: real("loudness_range_lu"),
    /** Chromaprint fingerprint (base64-ish). Stable across re-encodes,
     *  so this is the canonical identity hash for the audio content. */
    acoustidFingerprint: text("acoustid_fingerprint"),
    /** AcoustID UUID returned by the lookup API. Joins to MusicBrainz. */
    acoustidId: text("acoustid_id"),
    /** Confidence (0..1) of the BPM estimate from the DSP analyzer. */
    bpmConfidence: real("bpm_confidence"),
    /** Confidence (0..1) of the key/scale estimate. */
    keyConfidence: real("key_confidence"),
    /** Beat positions in seconds, JSON array. */
    beats: text("beats"),
    /** Downbeat positions in seconds, JSON array. */
    downbeats: text("downbeats"),
    /** Beat-aligned chord progression: JSON array of
     *  `{ start: number; end: number; chord: string }`. */
    chordProgression: text("chord_progression"),
    /** Functional structure segments: JSON array of
     *  `{ start: number; end: number; label: "intro"|"verse"|"chorus"|"bridge"|"outro"|"break" }`. */
    structureSegments: text("structure_segments"),
    /** Whole-track DSP analysis timestamp (separate from external
     *  metadata `analyzedAt` so each can be re-run independently). */
    dspAnalyzedAt: text("dsp_analyzed_at"),
});

export const playlists = sqliteTable("playlists", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").default("manual"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const playlistTracks = sqliteTable("playlist_tracks", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    playlistId: integer("playlist_id").notNull(),
    trackId: integer("track_id").notNull(),
    position: integer("position").notNull(),
});

export const scanLogs = sqliteTable("scan_logs", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    action: text("action").notNull(),
    filepath: text("filepath").notNull(),
    details: text("details"),
    scannedAt: text("scanned_at").default(sql`(datetime('now'))`),
});

export const downloads = sqliteTable("downloads", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    artist: text("artist"),
    duration: integer("duration"),
    thumbnail: text("thumbnail"),
    extractor: text("extractor"),
    filePath: text("file_path"),
    fileSize: integer("file_size"),
    format: text("format"),
    quality: text("quality"),
    status: text("status").notNull().default("pending"),
    trackId: integer("track_id"),
    error: text("error"),
    downloadedAt: text("downloaded_at").default(sql`(datetime('now'))`),
});

export type Track = typeof tracks.$inferSelect;
export type NewTrack = typeof tracks.$inferInsert;
export type Playlist = typeof playlists.$inferSelect;
export type PlaylistTrack = typeof playlistTracks.$inferSelect;
export type ScanLog = typeof scanLogs.$inferSelect;
export type DownloadRecord = typeof downloads.$inferSelect;
