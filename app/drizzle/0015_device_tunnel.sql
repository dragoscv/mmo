-- Cloudflare Tunnel per-device fast path.
--
-- Each companion gets its own named tunnel (provisioned via the
-- Cloudflare API by the web app right after pairing). The companion
-- runs `cloudflared` locally, terminating at http://localhost:17899
-- (its existing Express server). The browser then talks directly to
-- https://<tunnel_hostname> with the device token in the X-Device-Token
-- header — bypassing the 1.5-6s announce-queue round-trip for hot
-- operations like folder browsing.
--
-- Columns:
--   tunnel_id              — CF tunnel UUID. Used to update config /
--                            delete the tunnel when the device is
--                            unpaired or rotated. NULL until first
--                            successful provision.
--   tunnel_hostname        — fully-qualified host the browser fetches
--                            (e.g. device-abc123.devices.muzicai.ro).
--                            CNAMEd to <tunnel_id>.cfargotunnel.com.
--   tunnel_token_encrypted — opaque bearer the companion passes to
--                            `cloudflared tunnel run --token ...`. AES-
--                            256-GCM envelope identical to
--                            tokenEncrypted (encryptDeviceToken). Stays
--                            on the server until the companion fetches
--                            it once via the announce-channel bootstrap.

ALTER TABLE "devices" ADD COLUMN "tunnel_id" text;
ALTER TABLE "devices" ADD COLUMN "tunnel_hostname" text;
ALTER TABLE "devices" ADD COLUMN "tunnel_token_encrypted" text;
