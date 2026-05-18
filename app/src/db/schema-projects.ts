/**
 * Project persistence schema — DAW / Sound Editor / Live / Mixer / Viz.
 *
 * See drizzle/0017_projects.sql for the rationale.
 *
 * Shared pattern per project table:
 *   - `externalId`     stable cross-device UUID minted by the originator
 *   - `document`       JSONB blob holding the structured project state
 *   - `yjsState`       reserved BYTEA for future Yjs CRDT collab
 *   - `fieldVersions`  per-field LWW clocks (mirrors `tracks`)
 *   - `syncVersion`    monotonic counter populated by `syncLog`
 *   - `originDeviceId` to avoid echo-pull on the writing device
 */

import {
    pgTable, text, integer, bigint, boolean, timestamp, serial, real, jsonb, customType, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users, devices } from "./schema";

const bytea = customType<{ data: Buffer; default: false }>({
    dataType() { return "bytea"; },
});

const projectColumns = {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull().default("Untitled"),
    document: jsonb("document").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    yjsState: bytea("yjs_state"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
    deletedAt: timestamp("deleted_at"),
    syncVersion: bigint("sync_version", { mode: "number" }).default(0),
    fieldVersions: jsonb("field_versions").$type<Record<string, string>>().default(sql`'{}'::jsonb`),
    originDeviceId: text("origin_device_id"),
};

export const dawProjects = pgTable("daw_projects", {
    ...projectColumns,
    bpm: real("bpm"),
    keyCamelot: text("key_camelot"),
    color: text("color"),
    isFavorite: boolean("is_favorite").default(false),
}, (t) => [
    uniqueIndex("daw_projects_user_ext_uniq").on(t.userId, t.externalId),
    index("daw_projects_user_updated_idx").on(t.userId, t.updatedAt),
]);

export const editorProjects = pgTable("editor_projects", {
    ...projectColumns,
    sourceSha256: text("source_sha256"),
    sourceAssetId: integer("source_asset_id"),
    durationMs: integer("duration_ms"),
}, (t) => [
    uniqueIndex("editor_projects_user_ext_uniq").on(t.userId, t.externalId),
    index("editor_projects_user_updated_idx").on(t.userId, t.updatedAt),
]);

export const liveSessions = pgTable("live_sessions", projectColumns, (t) => [
    uniqueIndex("live_sessions_user_ext_uniq").on(t.userId, t.externalId),
    index("live_sessions_user_updated_idx").on(t.userId, t.updatedAt),
]);

export const mixerSetups = pgTable("mixer_setups", projectColumns, (t) => [
    uniqueIndex("mixer_setups_user_ext_uniq").on(t.userId, t.externalId),
    index("mixer_setups_user_updated_idx").on(t.userId, t.updatedAt),
]);

export const visualizationPresets = pgTable("visualization_presets", {
    ...projectColumns,
    kind: text("kind"),
}, (t) => [
    uniqueIndex("viz_presets_user_ext_uniq").on(t.userId, t.externalId),
]);

export const projectSnapshots = pgTable("project_snapshots", {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    projectKind: text("project_kind").notNull(),
    projectExternalId: text("project_external_id").notNull(),
    label: text("label"),
    auto: boolean("auto").default(true),
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    gitCommitSha: text("git_commit_sha"),
    createdAt: timestamp("created_at").defaultNow(),
    syncVersion: bigint("sync_version", { mode: "number" }).default(0),
}, (t) => [
    uniqueIndex("project_snapshots_user_ext_uniq").on(t.userId, t.externalId),
    index("project_snapshots_project_idx").on(t.userId, t.projectKind, t.projectExternalId, t.createdAt),
]);

export const projectAssets = pgTable("project_assets", {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    projectKind: text("project_kind"),
    projectExternalId: text("project_external_id"),
    sha256: text("sha256").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    durationMs: integer("duration_ms"),
    gcsObjectKey: text("gcs_object_key"),
    companionId: text("companion_id").references(() => devices.id, { onDelete: "set null" }),
    companionPath: text("companion_path"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
    deletedAt: timestamp("deleted_at"),
    syncVersion: bigint("sync_version", { mode: "number" }).default(0),
    fieldVersions: jsonb("field_versions").$type<Record<string, string>>().default(sql`'{}'::jsonb`),
    originDeviceId: text("origin_device_id"),
}, (t) => [
    uniqueIndex("project_assets_user_ext_uniq").on(t.userId, t.externalId),
    index("project_assets_user_sha_idx").on(t.userId, t.sha256),
    index("project_assets_project_idx").on(t.userId, t.projectKind, t.projectExternalId),
]);

export type ProjectKind = "daw" | "editor" | "live" | "mixer" | "visualization";

export const PROJECT_TABLES = {
    daw: dawProjects,
    editor: editorProjects,
    live: liveSessions,
    mixer: mixerSetups,
    visualization: visualizationPresets,
} as const;

export const PROJECT_SYNC_ENTITY: Record<ProjectKind, string> = {
    daw: "daw_projects",
    editor: "editor_projects",
    live: "live_sessions",
    mixer: "mixer_setups",
    visualization: "visualization_presets",
};
