/**
 * Phase 1 — normalized sub-entity tables for each project kind.
 *
 *   DAW           → daw_tracks + daw_clips
 *   Sound Editor  → editor_regions
 *   Live          → live_cues
 *   Mixer         → mixer_channels
 *   Visualization → viz_layers
 *
 * Each sub-row carries `(userId, externalId)` as its sync key,
 * `parentExternalId` linking it to the project, `fieldVersions` for
 * per-field LWW, and a `kind`/`*_index` discriminator where ordering
 * matters.
 *
 * Sibling JSONB columns hold sub-sub data (MIDI notes, automation
 * points, FX param maps) — see 0018_projects_normalized.sql for the
 * "mid-normalization" rationale.
 */

import { pgTable, text, integer, bigint, boolean, timestamp, serial, real, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./schema";

const subRowColumns = {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    parentExternalId: text("parent_external_id").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
    deletedAt: timestamp("deleted_at"),
    syncVersion: bigint("sync_version", { mode: "number" }).default(0),
    fieldVersions: jsonb("field_versions").$type<Record<string, string>>().default(sql`'{}'::jsonb`),
    originDeviceId: text("origin_device_id"),
};

export const dawTracks = pgTable("daw_tracks", {
    ...subRowColumns,
    trackIndex: integer("track_index").notNull().default(0),
    name: text("name").notNull().default("Track"),
    kind: text("kind").notNull().default("audio"),
    color: text("color"),
    volume: real("volume").default(0.8),
    pan: real("pan").default(0),
    muted: boolean("muted").default(false),
    soloed: boolean("soloed").default(false),
    armed: boolean("armed").default(false),
    frozen: boolean("frozen").default(false),
    height: integer("height").default(90),
    inputSource: text("input_source"),
    outputTarget: text("output_target"),
    instrumentId: text("instrument_id"),
    inserts: jsonb("inserts").$type<unknown[]>().default(sql`'[]'::jsonb`),
    sends: jsonb("sends").$type<unknown[]>().default(sql`'[]'::jsonb`),
    automationLanes: jsonb("automation_lanes").$type<unknown[]>().default(sql`'[]'::jsonb`),
}, (t) => [
    uniqueIndex("daw_tracks_user_ext_uniq").on(t.userId, t.externalId),
    index("daw_tracks_parent_idx").on(t.userId, t.parentExternalId, t.trackIndex),
]);

export const dawClips = pgTable("daw_clips", {
    ...subRowColumns,
    trackExternalId: text("track_external_id").notNull(),
    kind: text("kind").notNull().default("audio"),
    name: text("name").notNull().default("Clip"),
    position: real("position").default(0),
    length: real("length").default(4),
    color: text("color"),
    muted: boolean("muted").default(false),
    audio: jsonb("audio").$type<Record<string, unknown>>(),
    midi: jsonb("midi").$type<Record<string, unknown>>(),
    automationData: jsonb("automation_data").$type<unknown[]>(),
}, (t) => [
    uniqueIndex("daw_clips_user_ext_uniq").on(t.userId, t.externalId),
    index("daw_clips_track_idx").on(t.userId, t.trackExternalId),
    index("daw_clips_parent_idx").on(t.userId, t.parentExternalId),
]);

export const editorRegions = pgTable("editor_regions", {
    ...subRowColumns,
    name: text("name").notNull().default("Region"),
    startMs: integer("start_ms").default(0),
    endMs: integer("end_ms").default(0),
    color: text("color"),
    fxChain: jsonb("fx_chain").$type<unknown[]>().default(sql`'[]'::jsonb`),
    editOps: jsonb("edit_ops").$type<unknown[]>().default(sql`'[]'::jsonb`),
    markers: jsonb("markers").$type<unknown[]>().default(sql`'[]'::jsonb`),
}, (t) => [
    uniqueIndex("editor_regions_user_ext_uniq").on(t.userId, t.externalId),
    index("editor_regions_parent_idx").on(t.userId, t.parentExternalId),
]);

export const liveCues = pgTable("live_cues", {
    ...subRowColumns,
    cueIndex: integer("cue_index").notNull().default(0),
    name: text("name").notNull().default("Cue"),
    color: text("color"),
    action: text("action"),
    mappings: jsonb("mappings").$type<unknown[]>().default(sql`'[]'::jsonb`),
    fxChain: jsonb("fx_chain").$type<unknown[]>().default(sql`'[]'::jsonb`),
}, (t) => [
    uniqueIndex("live_cues_user_ext_uniq").on(t.userId, t.externalId),
    index("live_cues_parent_idx").on(t.userId, t.parentExternalId, t.cueIndex),
]);

export const mixerChannels = pgTable("mixer_channels", {
    ...subRowColumns,
    channelIndex: integer("channel_index").notNull().default(0),
    name: text("name").notNull().default("Channel"),
    color: text("color"),
    volume: real("volume").default(0.8),
    pan: real("pan").default(0),
    muted: boolean("muted").default(false),
    soloed: boolean("soloed").default(false),
    inputSource: text("input_source"),
    fxSlots: jsonb("fx_slots").$type<unknown[]>().default(sql`'[]'::jsonb`),
    sends: jsonb("sends").$type<unknown[]>().default(sql`'[]'::jsonb`),
    eq: jsonb("eq").$type<Record<string, unknown>>(),
}, (t) => [
    uniqueIndex("mixer_channels_user_ext_uniq").on(t.userId, t.externalId),
    index("mixer_channels_parent_idx").on(t.userId, t.parentExternalId, t.channelIndex),
]);

export const vizLayers = pgTable("viz_layers", {
    ...subRowColumns,
    layerIndex: integer("layer_index").notNull().default(0),
    name: text("name").notNull().default("Layer"),
    kind: text("kind").notNull().default("waveform"),
    enabled: boolean("enabled").default(true),
    blendMode: text("blend_mode"),
    opacity: real("opacity").default(1),
    params: jsonb("params").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
    modulators: jsonb("modulators").$type<unknown[]>().default(sql`'[]'::jsonb`),
}, (t) => [
    uniqueIndex("viz_layers_user_ext_uniq").on(t.userId, t.externalId),
    index("viz_layers_parent_idx").on(t.userId, t.parentExternalId, t.layerIndex),
]);

// ─── OAuth tokens (Phase 3) ─────────────────────────────────────────────
export const userOauthTokens = pgTable("user_oauth_tokens", {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id"),
    login: text("login"),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    scope: text("scope"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => [uniqueIndex("user_oauth_tokens_unique").on(t.userId, t.provider)]);

// Registry used by sync-apply and project actions.
export const SUB_TABLES = {
    daw_tracks: dawTracks,
    daw_clips: dawClips,
    editor_regions: editorRegions,
    live_cues: liveCues,
    mixer_channels: mixerChannels,
    viz_layers: vizLayers,
} as const;

export type SubEntity = keyof typeof SUB_TABLES;
