# ADR-0001 — Brand is MixAI; the self-hosted server is MMO Server

- Status: Accepted · 2026-09-17

## Context
The product was rebranded MuzicAI in web 0.6.0 while identifiers stayed `mmo-*`. The
product now covers movies + music + DJ + TV, and the owned domain is `mixai.ro`.
Two names were in play: MMO (Multi Media Organizer, the original) and MixAI (the domain
and the native DJ app).

## Decision
- **MixAI** is the brand, the account, the domain and the name of every client app
  (web, Companion, DJ, TV, mobile, extension).
- **MMO Server** ("MixAI Media Organizer") is the self-hosted server that runs on a
  Raspberry Pi, a PC or in Docker — the analogue of *Plex Media Server* vs *Plex*.
- Package scopes stay `@mmo/*`; the GitHub repo stays `mmo`.
- Bundle identifiers move to `ro.mixai.*`; local storage keys move from `muzicai-*`
  to `mixai-*` with a one-time migration so users keep their data.

## Consequences
- Companion auto-update chain breaks once (new appId/artifactName) → ship as
  Companion 2.0.0 with a release note; old 1.x builds are told to download manually.
- Play Store: `ro.mixai.app` is a new listing; the old `ro.muzicai.app` is unpublished.
- Every domain reference becomes `mixai.ro`; `muzicai.ro` redirects 301 during a
  transition period.
