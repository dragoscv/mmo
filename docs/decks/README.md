# MixAI Decks — documentation

MixAI Decks (formerly MixAI DJ, D60) is the DJ application of the MixAI suite: one Rust audio core with native UIs on
every OS ([ADR-0014](../adr/0014-mixai-decks-native-dj.md)). This folder is the current home of the Decks docs;
the Tauri 1.x plan is kept for history in [`docs/mixai/`](../mixai/00-architecture-and-plan.md).

| Document | Contents |
|---|---|
| [architecture.md](architecture.md) | Crate map, threading model, data flow, native UI plan, 1.x → 2.0 transition, licence policy, CI, performance budgets, Pro infra |
| [ffi.md](ffi.md) | UniFFI 0.31 binding surface for Swift and Kotlin |
| [controllers.md](controllers.md) | User guide (RO): DDJ-FLX4, Circuit Tracks, MIDI keyboard, BLE MIDI, MIDI learn |
| [mapping-format.md](mapping-format.md) | Controller mapping format v1, action vocabulary, scripts, MIDI clock, groove lane, BLE MIDI |
| [dvs.md](dvs.md) | Digital vinyl decoder: support matrix, API, MixAI timecode, measured results |
| [skins.md](skins.md) | Skins: the MixAI Signature default look and the classic skin, how a skin changes style and layout, built-in skins, legal note for look-alike skins, skin editor status; native apps: token-derived palettes, contrast gate, persistence |
| [layouts.md](layouts.md) | Zero-scroll shell: layout JSON, 12 panels incl. `waves`, built-in layouts (`pro` default, `pro-vertical`), gap rule, solver + tiers, panel minimum sizes, title bar, stage mode, snapshots, pop-out |
| [packs.md](packs.md) | `.mixaipack` format: manifest `v` 1 / 2, DTCG tokens, `style` block reference + refusal messages, layouts, assets, Ed25519 signing, trust levels, building a skin pack, Marketplace |
| [stems.md](stems.md) | On-device stem separation: HT-Demucs ONNX, accelerators, cache, server fallback |
| [remote.md](remote.md) | Connected mode: phone remote, second screen, Party DJ requests (LAN, QR pairing, security model) |
| [link.md](link.md) | Tempo sync between Decks instances on the LAN: session model, UDP wire format, constants, PIN key and security limits, commands |
| [transitions.md](transitions.md) | AI Transition Designer: next-track ranking, phrase-aligned plans, editable automation, set safety, RO/EN commands, risers |
| [set-recording.md](set-recording.md) | Set recording with automatic tracklist; text / CUE + ISRC / ORDA–UCMR-ADA CSV / Mixcloud / M3U8 exports |
| [dvs-clean-room.md](dvs-clean-room.md) | Clean-room provenance statement for the DVS decoder |
| [library-interop.md](library-interop.md) | rekordbox / Traktor / Serato / Engine / PDB / JSON read-write matrix, migration, key and colour mapping |
| [streaming.md](streaming.md) | Streaming strategy (D64), partner applications checklist, draft emails |

Tracker: [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md) §13 (D60–D68, WP19). App inventory:
[`docs/arhitectura/app-inventory.md`](../arhitectura/app-inventory.md).
