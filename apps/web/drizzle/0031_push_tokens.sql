-- Phone push (WP16-51). Native apps register FCM / APNs tokens (POST /api/push/register);
-- the MMO Server relays events (POST /api/push/relay, server/README.md § Push relay) and the
-- web fans out to the device owner's tokens. Additive only: the routes answer
-- 503 push_unavailable while this migration is pending, so the code can ship first.
CREATE TABLE IF NOT EXISTS "push_tokens" (
    "id" text PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
    "platform" text NOT NULL CHECK ("platform" IN ('android', 'ios')),
    "token" text NOT NULL UNIQUE,
    "environment" text NOT NULL DEFAULT 'production' CHECK ("environment" IN ('production', 'sandbox')),
    "device_name" text,
    "profile_id" text,
    "live_activity_token" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    "last_used_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "push_tokens_user_idx" ON "push_tokens" ("user_id");

-- Idempotency ledger: the companion retries (0, 1 s, 4 s) with the same eventId.
CREATE TABLE IF NOT EXISTS "push_relay_events" (
    "event_id" text PRIMARY KEY NOT NULL,
    "device_id" text NOT NULL REFERENCES "devices"("id") ON DELETE cascade,
    "event" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "push_relay_events_created_idx" ON "push_relay_events" ("created_at");
