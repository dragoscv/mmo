# DVS decoder — clean-room provenance (WP19-13, D65)

Crate: `apps/mixai/src-tauri/crates/decks-dvs` (MIT OR Apache-2.0). Written 2026-11-08.

## Statement

- No source code, lookup table, LFSR polynomial, seed or other constant from **xwax**, **Mixxx**
  or any other GPL/LGPL/AGPL timecode implementation was opened, read, fetched or ported.
- The `vinylla` Rust crate was found in search results; its licence is **MPL-2.0** (stated in the
  search snippet of its README). It was **not opened** and nothing from it was used.
- No vendor timecode audio (Serato Control CD WAV, Traktor/Phase media) was downloaded or
  analysed. Vendor-specific constants were therefore not derived; see "Consequences".
- The MixAI timecode is our own design: carrier, AM depth, transition shape, LFSR tap pair and
  seed were chosen by us. The tap pair (20, 17) — characteristic polynomial x^20 + x^17 + 1 — is a
  textbook maximal-length tap pair (published primitive-trinomial tables / Wikipedia LFSR article).
  Its maximality is **proved by our own test** (`mixai_lfsr_is_maximal_and_windows_are_unique`:
  all 2^20 − 1 non-zero windows occur exactly once), not taken on trust.
- Dependencies: none at runtime; `hound` (Apache-2.0) as a dev-dependency only.

## Sources consulted (non-code, public)

| # | Source | Used for |
|---|---|---|
| 1 | https://mixxx.org/news/2021-11-21-dvs-internals-pt1/ (Jan Holthuis, blog prose only) | Serato carrier is 1 kHz, stereo, R shifted a quarter cycle; zero-crossing/direction principle |
| 2 | https://mixxx.org/news/2025-08-27-dvs-internals-pt3/ (Jan Claußen, blog prose only) | Serato bits = AM on the 1 kHz carrier, 20-bit LFSR length; Traktor MK2 = 2.5 kHz offset-modulated carrier, derivative pre-filter idea, 110-bit LFSR length (no polynomial given) |
| 3 | Search-result snippets for "vinylla" / "How Does Timecode Vinyl Actually Work (Pt. 2)" (DuckDuckGo / web search) | Confirmed vinylla is MPL-2.0 → not opened; noted that a forum post quotes Serato seed/tap values — **deliberately not used** (they originate from GPL xwax and were not verified from a non-GPL source) |
| 4 | https://docs.algoriddim.com (djay DVS support page, via search snippet) | Product behaviour: relative vs absolute mode semantics, 1 kHz control tone |
| 5 | https://en.wikipedia.org/wiki/Digital_vinyl_system (via search snippet) | General background |
| 6 | https://en.wikipedia.org/wiki/Linear-feedback_shift_register (general knowledge) | Maximal-length LFSR theory, tap tables |
| 7 | https://cdm.link/ni-ends-legal-dispute-over-traktor-scratch-digital-vinyls-twisty-turny-history/ | Patent history (N2IT / NI settlement 2008) for `dvs.md` |
| 8 | https://patents.google.com/patent/US20070283798A1/en | N2IT patent family text, priority chain, status |
| 9 | https://patents.google.com/patent/US20140313871A1/en | N2IT family continuation chain, US 9,218,844 status/expiry estimate |
| 10 | Search results listing JP6412660B2, US12236926B2, WO2025030193A1, US7273980B2 | Other patent families for `dvs.md` (titles/numbers only) |

Attempted but unavailable (HTTP 403/404, nothing read): mixxx.org pt1/pt2 old URLs,
patents.justia.com assignee page, freepatentsonline.com pages.

## Consequences

- **Serato CV02.5**: relative mode only (experimental, carrier-generic front-end). Absolute mode
  is **pending**: the polynomial/seed are not derivable from a public non-GPL description, and
  deriving them from Serato's own audio is a licence question (Serato's terms restrict use of the
  control tone) to be cleared before anyone analyses it.
- **Traktor MK2**: relative mode experimental (differentiating front-end); absolute pending.
- **Phase (audio mode)**: pending vendor docs — no public signal description found.
- Clean-room rule for future work: anyone adding a vendor `PositionCode` must record the source of
  every constant here and confirm it is not GPL-derived.
