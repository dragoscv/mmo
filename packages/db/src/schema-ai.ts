/**
 * AI / Copilot schema (Phase 2).
 *
 * Plural table names per project convention. All token / secret
 * material is AES-GCM encrypted in `app/src/lib/token-crypto.ts` before
 * insert and stored as the `v1:iv:ct` envelope (text). Plaintext never
 * touches the DB.
 *
 * See docs/followups/ai-daw-master-plan.md §4.3 for the design.
 */

import {
    pgTable,
    text,
    timestamp,
    integer,
    real,
    jsonb,
    uniqueIndex,
    index,
    primaryKey,
    boolean,
    customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./schema";

/** pgvector column type. Stored as `vector(dim)`; queried via Drizzle as a
 *  number[] in JS. The runtime parsing uses pg's text protocol for vectors,
 *  which formats as "[0.1,0.2,...]" — strip brackets + parse floats. */
function pgVector(name: string, dim: number) {
    const type = customType<{ data: number[]; driverData: string }>({
        dataType() {
            return `vector(${dim})`;
        },
        toDriver(value) {
            return `[${value.join(",")}]`;
        },
        fromDriver(value) {
            if (typeof value !== "string") return value as unknown as number[];
            return value.slice(1, -1).split(",").map(Number);
        },
    });
    return type(name);
}

/** One row per (user, provider, label). A user can have several
 *  "OpenAI" connections under different labels (work / personal etc.). */
export const aiProviderConnections = pgTable(
    "ai_provider_connections",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        provider: text("provider").notNull(), // openai | anthropic | google | mistral | groq | azure | copilot
        label: text("label").notNull().default("default"),

        // BYO-key providers store the encrypted API key here.
        encApiKey: text("enc_api_key"),

        // Copilot OAuth+session tokens. Both encrypted.
        encOauthToken: text("enc_oauth_token"),
        encSessionToken: text("enc_session_token"),
        sessionExpiresAt: timestamp("session_expires_at", { mode: "date" }),
        endpointsJson: jsonb("endpoints_json").$type<Record<string, string>>(),

        // For Copilot only — which client_id strategy was used.
        // 'vscode' = well-known VS Code client; 'custom' = user's own OAuth App
        copilotClientStrategy: text("copilot_client_strategy"),
        copilotClientId: text("copilot_client_id"),

        // Lifecycle
        status: text("status").notNull().default("active"), // active | expired | revoked
        lastVerifiedAt: timestamp("last_verified_at", { mode: "date" }),
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
    },
    (t) => [
        uniqueIndex("ai_provider_connections_user_provider_label_uniq").on(
            t.userId,
            t.provider,
            t.label,
        ),
        index("ai_provider_connections_user_idx").on(t.userId),
    ],
);

/** Per-user role → model mapping. Composite PK on (userId, role). */
export const aiModelChoices = pgTable(
    "ai_model_choices",
    {
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        role: text("role").notNull(), // see packages/ai/src/models/index.ts MODEL_ROLES
        connectionId: text("connection_id").notNull().references(() => aiProviderConnections.id, { onDelete: "cascade" }),
        provider: text("provider").notNull(),
        modelId: text("model_id").notNull(),
        params: jsonb("params").$type<Record<string, unknown>>(),
        updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.userId, t.role] })],
);

/** Maestro agent session. One per chat thread. */
export const aiAgentSessions = pgTable(
    "ai_agent_sessions",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        projectId: text("project_id"),
        title: text("title"),
        description: text("description"),
        autonomy: text("autonomy").notNull().default("auto"), // ask | propose | auto
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
        archivedAt: timestamp("archived_at", { mode: "date" }),
    },
    (t) => [
        index("ai_agent_sessions_user_idx").on(t.userId, t.updatedAt),
        index("ai_agent_sessions_project_idx").on(t.projectId),
    ],
);

export const aiAgentMessages = pgTable(
    "ai_agent_messages",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        sessionId: text("session_id").notNull().references(() => aiAgentSessions.id, { onDelete: "cascade" }),
        index: integer("idx").notNull(),
        role: text("role").notNull(), // user | assistant | system | tool
        content: jsonb("content").notNull(), // parts array (text/tool-call/tool-result)
        modelId: text("model_id"),
        tokensIn: integer("tokens_in"),
        tokensOut: integer("tokens_out"),
        costUsd: integer("cost_usd_micros"), // store as micros to avoid float drift
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
    },
    (t) => [
        uniqueIndex("ai_agent_messages_session_idx_uniq").on(t.sessionId, t.index),
    ],
);

export const aiAgentToolCalls = pgTable(
    "ai_agent_tool_calls",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        sessionId: text("session_id").notNull().references(() => aiAgentSessions.id, { onDelete: "cascade" }),
        messageId: text("message_id").references(() => aiAgentMessages.id, { onDelete: "cascade" }),
        toolName: text("tool_name").notNull(),
        input: jsonb("input"),
        output: jsonb("output"),
        error: text("error"),
        latencyMs: integer("latency_ms"),
        destructive: boolean("destructive").default(false),
        startedAt: timestamp("started_at", { mode: "date" }).defaultNow(),
        finishedAt: timestamp("finished_at", { mode: "date" }),
    },
    (t) => [
        index("ai_agent_tool_calls_session_idx").on(t.sessionId, t.startedAt),
        index("ai_agent_tool_calls_tool_idx").on(t.toolName),
    ],
);

/** Generative-audio output. File lives at app/data/generated/<userId>/<id>.<ext>. */
export const generatedAssets = pgTable(
    "generated_assets",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        sessionId: text("session_id").references(() => aiAgentSessions.id, { onDelete: "set null" }),
        kind: text("kind").notNull(), // one-shot | drum-loop | midi | loop | stem | song | vocal
        tier: text("tier").notNull(), // T0 | T1 | T2
        model: text("model"),
        promptText: text("prompt_text"),
        params: jsonb("params").$type<Record<string, unknown>>(),
        seed: integer("seed"),
        durationSec: integer("duration_sec"),
        sampleRate: integer("sample_rate"),
        license: text("license").notNull().default("unknown"), // commercial-clean | personal-use | unknown
        filePath: text("file_path"), // relative to app/data/generated/<userId>/
        fileSize: integer("file_size_bytes"),
        contentHash: text("content_hash"),
        status: text("status").notNull().default("pending"), // pending | ready | failed
        replicatePredictionId: text("replicate_prediction_id"),
        error: text("error"),
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
        updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
    },
    (t) => [
        index("generated_assets_user_idx").on(t.userId, t.createdAt),
        index("generated_assets_session_idx").on(t.sessionId),
    ],
);

/** CLAP audio embeddings for similarity search (pgvector).
 *  Migration 0024 creates the table + HNSW cosine index. The asset_id
 *  is text (not FK) because it can refer to generated_assets.id, scanned
 *  track ids, or stem files. Combine with asset_kind to disambiguate. */
export const audioEmbeddings = pgTable(
    "audio_embeddings",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        assetId: text("asset_id").notNull(),
        assetKind: text("asset_kind").notNull(), // generated | scanned | stem
        model: text("model").notNull().default("clap-htsat-fused"),
        modelVersion: text("model_version").notNull().default("1"),
        dim: integer("dim").notNull().default(512),
        embedding: pgVector("embedding", 512).notNull(),
        durationSec: real("duration_sec"),
        tempoBpm: real("tempo_bpm"),
        keyRoot: text("key_root"),
        keyMode: text("key_mode"),
        tags: jsonb("tags").$type<string[]>().default(sql`'[]'::jsonb`),
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
    },
    (t) => [
        uniqueIndex("audio_embeddings_asset_uniq").on(t.assetId, t.assetKind, t.model, t.modelVersion),
        index("audio_embeddings_asset_idx").on(t.assetId, t.assetKind),
    ],
);

/** Personal Access Tokens for the MCP / REST façade.
 *  JWT-signed in P11; the row stores the JWT `jti` + metadata, never the JWT itself. */
export const agentPats = pgTable(
    "agent_pats",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        jti: text("jti").notNull().unique(), // JWT id, looked up on each request
        label: text("label").notNull(),
        scopes: jsonb("scopes").$type<string[]>().notNull(),
        keyVersion: integer("key_version").notNull(),
        lastUsedAt: timestamp("last_used_at", { mode: "date" }),
        expiresAt: timestamp("expires_at", { mode: "date" }),
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
        revokedAt: timestamp("revoked_at", { mode: "date" }),
    },
    (t) => [
        index("agent_pats_user_idx").on(t.userId, t.createdAt),
    ],
);

/** In-flight device-code authorizations (cleared after success/expiry).
 *  Short-lived so we don't bother encrypting the device_code — it's
 *  useless without the user authorizing in their browser. */
export const aiDeviceCodeFlows = pgTable(
    "ai_device_code_flows",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        provider: text("provider").notNull().default("copilot"),
        deviceCode: text("device_code").notNull(),
        userCode: text("user_code").notNull(),
        verificationUri: text("verification_uri").notNull(),
        intervalSec: integer("interval_sec").notNull(),
        expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
        clientStrategy: text("client_strategy").notNull(), // 'vscode' | 'custom'
        clientId: text("client_id").notNull(),
        label: text("label").notNull().default("default"),
        status: text("status").notNull().default("pending"), // pending | success | failed | expired
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
        completedAt: timestamp("completed_at", { mode: "date" }),
    },
    (t) => [
        index("ai_device_code_flows_user_idx").on(t.userId, t.status),
    ],
);

/** MCP / REST façade audit log — one row per tools/call (or
 *  resources/read / prompts/get). Used for per-user usage reports
 *  and to debug misbehaving PATs. */
export const mcpAuditLog = pgTable(
    "mcp_audit_log",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        ts: timestamp("ts", { mode: "date" }).notNull().defaultNow(),
        userId: text("user_id").notNull(),
        jti: text("jti").notNull(),
        method: text("method").notNull(),
        tool: text("tool"),
        ok: boolean("ok").notNull(),
        durationMs: integer("duration_ms").notNull(),
        errorCode: integer("error_code"),
        createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
    },
    (t) => [
        index("mcp_audit_log_user_idx").on(t.userId, t.ts),
        index("mcp_audit_log_jti_idx").on(t.jti, t.ts),
    ],
);
