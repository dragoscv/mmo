# On-device stems (WP19-09)

Crate: `apps/mixai/src-tauri/crates/decks-stems` (MIT OR Apache-2.0).

## Pipeline

1. **Plan** — `plan_source(SourcePlan)` picks: cache → server copy → accelerated device → server
   separation → CPU device (only when not on low battery / throttled) → unavailable. The
   `device_only` privacy setting never contacts the server.
2. **Separate** — `separate(model, left, right, rate, cancel, progress)`: resample to 44.1 kHz
   (rubato FFT), cut into 7.8 s segments with a 25 % linear cross-fade (weights sum to 1),
   run the model per segment, overlap-add, resample back to the track rate. Cancellable between
   segments; progress after each segment.
3. **Cache** — `StemCache` writes `<root>/<key>/{vocals,drums,bass,other}.wav` (32-bit float,
   atomic temp-dir rename). Same file names as the MMO Server analyzer
   (`GET /stems/:trackId/<name>.wav`, 16-bit PCM is read too), so downloads and local results
   share one cache. `cache_key` = sha256(version, model id, first 4 MiB, file length).
   `prune(max_bytes)` drops the oldest sets.
4. **Play** — `Stems.layers` is in mixai-core order (vocals, drums, bass, melody/other) and maps
   1:1 onto `Command::LoadStems`; per-stem gain via `SetStemGain`.

## Model and runtime

| Item | Value |
|---|---|
| Model | HT-Demucs v4 single-file ONNX (StemSplit export, MIT), `mix (1,2,343980)` → `stems (1,4,2,343980)`, order drums/bass/other/vocals |
| Size | 316 MB fp32, 166 MB fp16-weights (same runtime cost) — downloaded on first use, never in the app bundle |
| Runtime | `ort` 2.0.0-rc.15 (ONNX Runtime 1.31) with `load-dynamic`: the app ships the platform library |
| Windows | `onnxruntime.dll` DirectML build → `ExecutionTarget::DirectMl` |
| macOS / iOS | CoreML EP → `ExecutionTarget::CoreMl` |
| Android | NNAPI + XNNPACK EPs from the onnxruntime-android AAR `.so` |
| Fallback | CPU EP everywhere; ONNX Runtime places unsupported nodes on CPU |

Reference speed (StemSplit, M4 Pro CPU): 1.6 s per 7.8 s segment (RTF 0.20); GPU EPs are
typically ≥ 5× faster. Measure a device with the example:

```powershell
cargo run -p decks-stems --example separate --features onnx --release -- <onnxruntime lib> <htdemucs.onnx> <in.wav> <out dir>
```

It prints load time, wall time and RTF and writes the cache set.

## Tests

`cargo test -p decks-stems --all-features` (no model or runtime needed): exact overlap-add
reconstruction with a linear stand-in model, stem order, padding of short tracks, 48 kHz round
trip, cancel, shape errors, cross-fade sum, cache round trip + server 16-bit WAVs + traversal
rejection + pruning, cache keys, source planning, server route paths, missing runtime library.

## Open

- Bundle the onnxruntime library per platform (Gradle AAR, Apple xcframework, MSIX) and the
  model downloader UI in the native apps; on-device RTF numbers per target.
- `decks-ffi` surface (`DecksStems`) once the native apps show the stem mixer.
