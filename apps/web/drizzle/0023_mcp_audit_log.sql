-- Persisted audit log for the MCP/REST façade. Each tools/call (or
-- resources/read / prompts/get) writes one row so we can debug
-- misbehaving PATs and produce per-user usage reports.

CREATE TABLE IF NOT EXISTS "mcp_audit_log" (
    "id" text PRIMARY KEY,
    "ts" timestamp NOT NULL DEFAULT now(),
    "user_id" text NOT NULL,
    "jti" text NOT NULL,
    "method" text NOT NULL,
    "tool" text,
    "ok" boolean NOT NULL,
    "duration_ms" integer NOT NULL,
    "error_code" integer,
    "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "mcp_audit_log_user_idx" ON "mcp_audit_log" ("user_id", "ts");
CREATE INDEX IF NOT EXISTS "mcp_audit_log_jti_idx" ON "mcp_audit_log" ("jti", "ts");
