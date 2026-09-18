# ADR-0009 — Remove third-party embed sources (vidsrc & co.)

- Status: Accepted · 2026-09-18
- Tracker: [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md) (D20, WP10-08)

## Context

The companion carried a hidden module, `server/src/library/streaming-scrapers.ts`, that built
iframe URLs for unlicensed streaming aggregators (vidsrc.to, vidsrc.me/xyz, 2embed, multiembed,
smashystream) from a TMDB id, exposed as `GET /video/streams/{kind}/{tmdbId}` and gated by the
settings key `video.externalEmbed.vidsrc.enabled` (default off, surfaced through `/video/probe`
and `/video/flags` as `vidsrcEnabled`). The web app mirrored it with `StreamSourcePicker` +
`lib/video/stream-sources.ts` on the movie/show detail pages and a read-only card in
`/settings/video`.

MixAI is a **library manager for media the user owns**, and its detail pages now sit next to a
licensed "where to watch" row (TMDB/JustWatch providers). Shipping — even dark — a switch that
turns those pages into a pirate-embed frontend is a legal and reputational liability for an
open-source project with a commercial licence (ADR-0007), it breaks the trust model of the TV and
store-distributed apps, and it was never covered by tests, docs or the OpenAPI spec's intent. The
flag being off by default does not change what the code is for.

## Decision

Remove the feature entirely rather than keep it behind a flag:

1. **Server.** Delete `streaming-scrapers.ts` and `vidsrc-flag.ts`; drop the
   `GET /video/streams/:kind/:tmdbId` route and its rate limiter; remove `vidsrcEnabled` from
   `/video/probe`, `/video/flags` (GET/POST) and the `VideoFlags` schema. The settings key is no
   longer read; a stale value in an existing `config.json` is ignored.
2. **API contract.** `server/openapi.yaml` loses the path and the `EmbedOption` schema; the
   generated Kotlin models (`apps/tv-android/.../generated/Models.kt`) and TS SDK types
   (`packages/sdk/src/generated`) are regenerated. Companion version 3.0.0 → **3.1.0** (minor:
   the removed operation was opt-in and undocumented to end users).
3. **Web.** Delete `components/video/stream-source-picker.tsx` and `lib/video/stream-sources.ts`;
   remove the `streamPicker` slot from `MovieDetailLayout`, the flag fetch from the four detail
   pages and the "Embed extern" card from `/settings/video`.

## Consequences

- **Positive.** No code path in the repo can point a player at an unlicensed source; the "where
  to watch" row is the only external-source UI, and it links out to licensed providers. One
  fewer secret flag, one fewer undocumented route, four fewer companion round-trips on detail
  pages.
- **Costs.** A user who had toggled the flag on loses the picker with no migration message; the
  setting silently becomes inert. `VideoFlags` is now a single-field object — the endpoint stays
  because `preRemuxAutoOnScan` still lives there.
- **Follow-ups.** None required; further "play from elsewhere" features must go through licensed
  provider deep links (JustWatch/TMDB `link`) or user-configured self-hosted servers.

## Alternatives considered

- **Keep it behind the flag (status quo).** Rejected — the liability is in the code existing and
  being one boolean away, not in the default; it also forces every TV/SDK consumer to carry a
  dead `vidsrcEnabled` field.
- **Move it to an opt-in plugin repo.** Rejected — it would still be a MixAI-branded artefact
  pointing at unlicensed sources.
- **Replace with a generic "custom iframe URL" setting.** Rejected — same outcome with a thinner
  veil, and no product need identified.
