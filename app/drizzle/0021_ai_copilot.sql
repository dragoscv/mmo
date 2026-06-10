-- 0021 — AI / Copilot tables (Phase 2 of the AI Copilot refactor).
-- See app/src/db/schema-ai.ts and docs/followups/ai-daw-master-plan.md §4.3.

CREATE TABLE IF NOT EXISTS "ai_provider_connections" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "provider" text NOT NULL,
    "label" text NOT NULL DEFAULT 'default',
    "enc_api_key" text,
    "enc_oauth_token" text,
    "enc_session_token" text,
    "session_expires_at" timestamp,
    "endpoints_json" jsonb,
    "copilot_client_strategy" text,
    "copilot_client_id" text,
    "status" text NOT NULL DEFAULT 'active',
    "last_verified_at" timestamp,
    "created_at" timestamp DEFAULT now(),
    "updated_at" timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_connections_user_provider_label_uniq"
    ON "ai_provider_connections" ("user_id", "provider", "label");
CREATE INDEX IF NOT EXISTS "ai_provider_connections_user_idx"
    ON "ai_provider_connections" ("user_id");

CREATE TABLE IF NOT EXISTS "ai_model_choices" (
    "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "role" text NOT NULL,
    "connection_id" text NOT NULL REFERENCES "ai_provider_connections"("id") ON DELETE CASCADE,
    "provider" text NOT NULL,
    "model_id" text NOT NULL,
    "params" jsonb,
    "updated_at" timestamp DEFAULT now(),
    PRIMARY KEY ("user_id", "role")
);

CREATE TABLE IF NOT EXISTS "ai_agent_sessions" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "project_id" text,
    "title" text,
    "autonomy" text NOT NULL DEFAULT 'auto',
    "created_at" timestamp DEFAULT now(),
    "updated_at" timestamp DEFAULT now(),
    "archived_at" timestamp
);
CREATE INDEX IF NOT EXISTS "ai_agent_sessions_user_idx"
    ON "ai_agent_sessions" ("user_id", "updated_at");
CREATE INDEX IF NOT EXISTS "ai_agent_sessions_project_idx"
    ON "ai_agent_sessions" ("project_id");

CREATE TABLE IF NOT EXISTS "ai_agent_messages" (
    "id" text PRIMARY KEY NOT NULL,
    "session_id" text NOT NULL REFERENCES "ai_agent_sessions"("id") ON DELETE CASCADE,
    "idx" integer NOT NULL,
    "role" text NOT NULL,
    "content" jsonb NOT NULL,
    "model_id" text,
    "tokens_in" integer,
    "tokens_out" integer,
    "cost_usd_micros" integer,
    "created_at" timestamp DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_agent_messages_session_idx_uniq"
    ON "ai_agent_messages" ("session_id", "idx");

CREATE TABLE IF NOT EXISTS "ai_agent_tool_calls" (
    "id" text PRIMARY KEY NOT NULL,
    "session_id" text NOT NULL REFERENCES "ai_agent_sessions"("id") ON DELETE CASCADE,
    "message_id" text REFERENCES "ai_agent_messages"("id") ON DELETE CASCADE,
    "tool_name" text NOT NULL,
    "input" jsonb,
    "output" jsonb,
    "error" text,
    "latency_ms" integer,
    "destructive" boolean DEFAULT false,
    "started_at" timestamp DEFAULT now(),
    "finished_at" timestamp
);
CREATE INDEX IF NOT EXISTS "ai_agent_tool_calls_session_idx"
    ON "ai_agent_tool_calls" ("session_id", "started_at");
CREATE INDEX IF NOT EXISTS "ai_agent_tool_calls_tool_idx"
    ON "ai_agent_tool_calls" ("tool_name");

CREATE TABLE IF NOT EXISTS "generated_assets" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "session_id" text REFERENCES "ai_agent_sessions"("id") ON DELETE SET NULL,
    "kind" text NOT NULL,
    "tier" text NOT NULL,
    "model" text,
    "prompt_text" text,
    "params" jsonb,
    "seed" integer,
    "duration_sec" integer,
    "sample_rate" integer,
    "license" text NOT NULL DEFAULT 'unknown',
    "file_path" text,
    "file_size_bytes" integer,
    "content_hash" text,
    "created_at" timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "generated_assets_user_idx"
    ON "generated_assets" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "generated_assets_session_idx"
    ON "generated_assets" ("session_id");

CREATE TABLE IF NOT EXISTS "agent_pats" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "jti" text NOT NULL UNIQUE,
    "label" text NOT NULL,
    "scopes" jsonb NOT NULL,
    "key_version" integer NOT NULL,
    "last_used_at" timestamp,
    "expires_at" timestamp,
    "created_at" timestamp DEFAULT now(),
    "revoked_at" timestamp
);
CREATE INDEX IF NOT EXISTS "agent_pats_user_idx"
    ON "agent_pats" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "ai_device_code_flows" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "provider" text NOT NULL DEFAULT 'copilot',
    "device_code" text NOT NULL,
    "user_code" text NOT NULL,
    "verification_uri" text NOT NULL,
    "interval_sec" integer NOT NULL,
    "expires_at" timestamp NOT NULL,
    "client_strategy" text NOT NULL,
    "client_id" text NOT NULL,
    "label" text NOT NULL DEFAULT 'default',
    "status" text NOT NULL DEFAULT 'pending',
    "created_at" timestamp DEFAULT now(),
    "completed_at" timestamp
);
CREATE INDEX IF NOT EXISTS "ai_device_code_flows_user_idx"
    ON "ai_device_code_flows" ("user_id", "status");
