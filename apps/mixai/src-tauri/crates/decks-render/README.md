# decks-render

GPU views for MixAI Decks, drawn once in Rust with wgpu 30 (ADR-0014 D61, tracker WP19-14).
MIT OR Apache-2.0.

## Hosts

| Host | Constructor | Handle |
|---|---|---|
| SwiftUI (iOS/macOS) | `Renderer::new_from_raw_handle` | `UiKit`/`AppKit` view backed by a `CAMetalLayer` |
| Compose Android | `new_from_raw_handle` | `AndroidNdk` (`ANativeWindow` from `SurfaceView`); drop in `surfaceDestroyed` |
| Compose Desktop | `new_from_raw_handle` | `Win32` HWND / `Xlib`/`Xcb` / `Wayland` |
| winit (dev) | `new_from_window` | `Arc<Window>` |
| Texture compositors, tests | `new_headless` | offscreen `Rgba8Unorm` (`headless_texture()`, `read_pixels()`) |

Frame loop: `set_views` (layout, logical px) and `set_peaks` (on track load), then per frame
`update(&FrameState)` + `render()`. Text labels are not drawn: the native UI overlays them.

## Views

- `Waveform` — scrolling 3-band waveform, centred playhead, zoom (`zoom_seconds`), beat grid with
  downbeat emphasis, cue / hot cue / loop markers, slip shadow playhead.
- `Overview` — whole track, played region dimmed, hot cues, playhead.
- `Stacked` — 2–4 lanes with aligned playheads and a phase meter per lane against the first deck.
- `Platter` — rotating record (procedural vinyl shader), position marker, deck-colour rim/label.
- `DvsScope` — X/Y Lissajous points with fading trail.

Styles: `Rgb3Band`, `SingleColor` (deck colour), `Spectral` (band-energy gradient); `Theme::Dark`/
`Light`; `reduced_motion` = waveform page-flips instead of scrolling, platter turns in 30° steps.

## Data

`PeaksView`: three bands × (`min`, `max`, `rms`) `u8` arrays at `points_per_second`.
`min`/`max`: `v / 127.5 - 1` (128 ≈ 0); `rms`: `v / 255`. Packed to one `u32` per band per point
on upload; the fragment shader reduces the points under each pixel column (≤ 32 samples).

Deck colours are copied from `packages/design-tokens/src/tokens.ts` (`BRAND.deckA..D`, D9) into
`src/colors.rs`; the `deck_colours_match_design_tokens` test fails when they drift.

## Commands

```powershell
cargo test --manifest-path apps/mixai/src-tauri/Cargo.toml -p decks-render
cargo test --manifest-path apps/mixai/src-tauri/Cargo.toml -p decks-render --release -- --ignored --nocapture   # frame timing
cargo run  --manifest-path apps/mixai/src-tauri/Cargo.toml -p decks-render --example window --release
```

Snapshots land in `<repo>/.copilot-tmp/decks-render/*.png`.
