-- Companion command queue.
--
-- Why: Vercel (where the web app runs) cannot reach the user's LAN where
-- the companion lives, and mixed-content + Private Network Access prevent
-- the browser from talking to http://192.168.x.x directly from the
-- https://muzicai.ro origin. So we use the companion's existing announce
-- heartbeat as a control channel: enqueue commands here, the companion
-- drains them via /api/devices/announce response, executes locally, then
-- POSTs results back on the next announce tick.
--
-- `status` lifecycle: pending -> dispatched -> done | error | expired.
-- Polling server actions wait on (status NOT IN ('pending','dispatched')).

CREATE TABLE IF NOT EXISTS "device_commands" (
    "id" text PRIMARY KEY,
    "device_id" text NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
    "kind" text NOT NULL,
    "payload" jsonb,
    "status" text NOT NULL DEFAULT 'pending',
    "result" jsonb,
    "error" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "dispatched_at" timestamptz,
    "completed_at" timestamptz,
    "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '5 minutes')
);

-- Hot path: companion polls "give me my pending commands".
CREATE INDEX IF NOT EXISTS "device_commands_dispatch_idx"
    ON "device_commands" ("device_id", "status", "created_at");

-- Polling server actions look up by id and need a fast status read.
CREATE INDEX IF NOT EXISTS "device_commands_status_idx"
    ON "device_commands" ("status", "expires_at");
