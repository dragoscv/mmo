# ADR-0007 — AGPL-3.0 core, MIT SDK, commercial licence for cloud/Pro

- Status: Accepted · 2026-09-17

## Context
The repo is dual-licensed (`LICENSE` + `COMMERCIAL-LICENSE.md`). For wide adoption
of a self-hosted server the community expects a recognised OSI licence; Immich's
model (AGPL-3.0 core, optional paid support, trademark policy) is the reference.
GPL-2.0-only would block Apache-2.0 dependencies.

## Decision
- MMO Server and the web app core: **AGPL-3.0-only**.
- `packages/sdk` (client SDK) and any plugin API: **MIT**, so third-party clients and
  plugins are unencumbered.
- `COMMERCIAL-LICENSE.md` stays for the hosted MixAI cloud and Pro features.
- Add `TRADEMARKS.md`: "MixAI" and "MMO Server" names/logos are not covered by the
  code licence.

## Consequences
- Non-commercial-only inputs (TMDB free tier, AcoustID, IMDb datasets) constrain any
  paid tier; budget TMDB commercial (~$149/mo) before monetising.
- Essentia is AGPL (fine for core); InsightFace `buffalo_l` is non-commercial — avoid.
