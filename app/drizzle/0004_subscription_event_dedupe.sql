-- 0004 — Stripe webhook idempotency + ordering guard.
--
-- Stripe delivers events at-least-once and may deliver them out of order
-- (especially under retry pressure). Two real failure modes existed:
--
--   1. Replay: same event.id delivered twice → handler ran twice. For
--      `subscription.updated` that's harmless re-write, but for the
--      invoice-driven path that triggers an extra `subscriptions.retrieve`
--      and another DB write each time.
--   2. Out-of-order: `subscription.updated` (old snapshot, created at T0)
--      arriving after `subscription.deleted` (at T1) would resurrect a
--      cancelled subscription. Same shape downgrades a freshly-upgraded
--      Pro user.
--
-- Fix: persist the most recent applied (event_id, event_created_at) on the
-- subscription row. The webhook now skips events whose id matches the last
-- one seen, OR whose `created` timestamp is older than the last applied.
--
-- Both columns are nullable so existing rows keep working until the next
-- event arrives.

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "last_event_id" text,
  ADD COLUMN IF NOT EXISTS "last_event_at" timestamp;
