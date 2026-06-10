-- LAN discovery: companions announce their non-loopback IP on startup so
-- the user's other devices (tablet, TV, second laptop) can reach them
-- across the local network. `api_url` keeps the loopback URL for the
-- machine running the companion; `lan_url` is the cross-device URL.
--
-- `lan_announced_at` lets us age out stale LAN URLs (Wi-Fi switch,
-- DHCP renewal) — clients should treat LAN URLs older than ~24h as
-- "needs re-probe before trusting".

ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "lan_url" text;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "lan_announced_at" timestamp;

CREATE INDEX IF NOT EXISTS "devices_lan_url_idx" ON "devices" ("user_id", "lan_url");
