-- Device-code login for TVs / limited-input devices (Plex/Netflix style).
-- The TV creates a row via POST /api/device/code and shows `user_code`;
-- the phone approves it on /activate (sets user_id + status='approved');
-- the TV polls POST /api/device/token, which mints an Auth.js `session`
-- row and marks the code 'consumed'. Rows are short-lived (15 min).
CREATE TABLE IF NOT EXISTS "device_auth_codes" (
    "id" text PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
    "device_code_hash" text NOT NULL UNIQUE,
    "user_code" text NOT NULL UNIQUE,
    "device_name" text NOT NULL,
    "platform" text NOT NULL,
    "ip" text,
    "user_id" text REFERENCES "user"("id") ON DELETE cascade,
    "status" text NOT NULL DEFAULT 'pending',
    "last_polled_at" timestamptz,
    "expires_at" timestamptz NOT NULL,
    "created_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "device_auth_codes_user_code_idx" ON "device_auth_codes" ("user_code");
CREATE INDEX IF NOT EXISTS "device_auth_codes_expires_idx" ON "device_auth_codes" ("expires_at");
