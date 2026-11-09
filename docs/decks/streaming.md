# MixAI Decks — streaming strategy (D64)

Decision D64 (owner, 2026-11-08) in [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md) §13, ADR-0014
decision 7 ([ADR-0014](../adr/0014-mixai-decks-native-dj.md)). Work package WP19-19.

**Principle: they pay us, we never pay for catalogue access.** Research on 2026-11-08 found no streaming service
that publishes a revenue share for DJ apps; the real income is affiliate commission on new subscriptions. So
streaming in Decks is built as (1) great local files + library interop, (2) catalogues whose owners pay us per
subscriber we bring, (3) everything else behind feature flags until a partner agreement exists.

## Per service

| Service | Plan | Status 2026-11-09 | Flag (planned name) |
|---|---|---|---|
| Local files | Default source; full analysis, stems, DVS, export | built (`decks-library`, `decks-analysis`) | — |
| OneLibrary (AlphaTheta / Algoriddim / Native Instruments) | Read + write when a spec exists; meanwhile CDJ USB export via `rekordbox.xml` | **no public spec** (see below) | — |
| **Apple Music** | MusicKit catalogue; subscription sheet `MusicSubscriptionOffer` carrying our **Apple Services Performance Partner** affiliate token (commission per new Apple Music membership); separate application for Apple's DJ entitlement (mixing/effects on catalogue tracks) | apply (owner) | `streaming.apple_music` |
| **Beatport / Beatport Streaming** | Partner API application asking for a **per-trial bounty** + co-marketing, not a fee from us | apply (owner) | `streaming.beatport` |
| SoundCloud (Go+ DJ) | Behind a flag pending B2B approval | flag only | `streaming.soundcloud` |
| TIDAL | Behind a flag pending B2B approval; the public SDK only gives 30 s previews | flag only | `streaming.tidal` |
| Spotify | **Not integrated.** Spotify Developer Policy §III.7 forbids mixing / synchronising Spotify content outside partner deals | blocked by policy; revisit only after traction with a direct partner deal | — |
| Deezer, Amazon Music | After traction | — | — |

Feature flags are off by default and live with the other product flags (Pro infra pattern in
[architecture.md](architecture.md#9-pro-infra-wp19-23-prepared-not-enabled)). A service is enabled only after its
written agreement and a review of its display / attribution rules.

## OneLibrary

- Launched Oct 2025 by AlphaTheta, Algoriddim and Native Instruments as a shared device library format.
- **Status 2026-11-08: no public specification or SDK.** The partner pages
  (<https://www.alphatheta.com/en/onelibrary/>) describe compatibility only.
- Community reverse-engineering project: <https://github.com/v1vendi/onelibrary> — the device export is a
  **SQLCipher**-encrypted SQLite database (`exportLibrary.db`). We do not ship code derived from it without a
  licence and a legal check of the encryption key's provenance.
- `decks-library` keeps a `OneLibrary` interop slot (`Source::OneLibrary`) that returns "pending spec"; until then
  CDJ users export `rekordbox.xml` + USB layout ([library-interop.md](library-interop.md)).
- Action: request developer access from AlphaTheta (checklist below).

## Application checklist (owner = user)

| # | Application | Where | What we send | What we need back | Status |
|---|---|---|---|---|---|
| 1 | Apple Services Performance Partner (affiliate) | Apple Services Performance Partners programme portal | Company details, site `decks.mixai.ro`, apps (`ro.mixai.dj`), traffic description | Affiliate token for `MusicSubscriptionOffer` + reporting access | to send |
| 2 | Apple Music DJ entitlement / MusicKit partnership | Apple developer contact / partnership request (email in Appendix A) | Product description, platforms, mixing features used on catalogue tracks, DRM handling (no export / recording of catalogue audio) | Entitlement for real-time mixing, tempo/key change and FX on catalogue streams; terms on recording and stems | to send |
| 3 | Beatport partner API | Beatport partnerships / API team (email in Appendix B) | Product, platforms, launch stage, revenue model, integration scope | API credentials (catalogue + streaming), per-trial / per-subscription bounty terms, co-marketing | to send |
| 4 | SoundCloud B2B (DJ streaming) | SoundCloud partner team | Same product brief | DJ streaming API access + terms | later |
| 5 | TIDAL B2B (DJ extension) | TIDAL partner team | Same product brief | Full-length DJ streaming access (beyond 30 s previews) | later |
| 6 | OneLibrary developer access | AlphaTheta (OneLibrary partners) | Product brief, interop scope (read + write device library) | Specification / SDK + licence terms | to send |
| 7 | Phase (MWM) HID partnership | MWM | DVS brief ([dvs.md](dvs.md)) | HID protocol for Phase remotes | to send (D65) |

For every application keep: date sent, contact, reply, and the resulting terms in this table.

## Appendix A — draft email: Apple Music / MusicKit DJ entitlement

> Subject: MixAI Decks — request for MusicKit DJ mixing entitlement and partnership
>
> Hello,
>
> I am Dragos Catalin Vladulescu, developer of MixAI Decks (bundle id `ro.mixai.dj`, https://decks.mixai.ro), a DJ
> application built on a native Rust audio engine with SwiftUI on macOS, iPadOS and iOS, plus Android, Windows and
> Linux versions. Decks provides beat/phase sync, key detection, key lock, EQ/filter/FX, hot cues and loops, and
> controller support (Pioneer DDJ-FLX4, Novation Circuit Tracks, MIDI/BLE MIDI).
>
> We are at launch stage, so we have no user numbers to share yet. Decks is free at launch, with a later optional Pro
> subscription. We are applying to the Apple Services Performance Partners programme and want to present Apple
> Music's subscription offer (`MusicSubscriptionOffer`) inside Decks to users without a membership.
>
> We are asking for:
> 1. the entitlement / agreement that allows real-time mixing of Apple Music catalogue tracks in a DJ app
>    (tempo and key change, EQ, effects, crossfading between two or more tracks);
> 2. the conditions on recording mixes and on-device stem separation for catalogue content — by default Decks will
>    disable recording, export and stems for catalogue tracks;
> 3. any technical requirements (DRM playback path, attribution, analytics) we must meet.
>
> Happy to provide a TestFlight build and a technical walkthrough.
>
> Kind regards,
> Dragos Catalin Vladulescu — MixAI (https://mixai.ro)

## Appendix B — draft email: Beatport partner API

> Subject: MixAI Decks — Beatport partner API and streaming integration
>
> Hello Beatport partnerships team,
>
> I develop MixAI Decks (https://decks.mixai.ro), a DJ application with a native Rust audio engine and native apps
> for macOS, iPadOS/iOS (SwiftUI), Android, Windows and Linux. Features: beat/phase sync, key detection, key lock,
> stems, FX, hot cues, rekordbox/Serato/Traktor/Engine library import, CDJ USB export, and controller support
> (Pioneer DDJ-FLX4, Novation Circuit Tracks, MIDI/BLE MIDI, DVS).
>
> We are at launch stage (no user numbers yet). Decks is free, with a later optional Pro tier. We would like to
> integrate Beatport Streaming and the Beatport catalogue (search, previews, purchases, crates) and send our users to
> a Beatport Streaming trial.
>
> We are asking for:
> 1. partner API credentials for catalogue and DJ streaming;
> 2. a revenue model where Beatport pays a bounty per started trial or converted subscription originating in Decks
>    (we do not pay for catalogue access);
> 3. co-marketing at launch (listing among supported DJ apps).
>
> I can share a build and an integration plan on request.
>
> Kind regards,
> Dragos Catalin Vladulescu — MixAI (https://mixai.ro)
