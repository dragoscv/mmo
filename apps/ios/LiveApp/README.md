# MixAI Live for iPhone, iPad and Apple Watch (WP21-09)

Pure controllers of the MixAI Live engine (ADR-0015) over control protocol v1
([`docs/live/remote-protocol.md`](../../../docs/live/remote-protocol.md)). No audio and no Rust on the device.

| Path | What |
|---|---|
| `../LiveCore/` | SwiftPM library (iOS 26 / watchOS 11 / macOS 15): protocol Codable models (lenient, forward compatible), `ServerMessage` / `ClientCommand`, pure `LiveReducer` + `LiveModel`, `Throttle` (30 ms per control), `LiveClient` (`URLSessionWebSocketTask`, ping, backoff reconnect, role gating, optimistic mix), `PairingLink` (`mixai-live://pair?...` and `http://host:17920/?t=...`), `EngineStore` + `TokenVault` (Keychain), `WatchLink` v1, `Teleprompter`. Swift Testing suite |
| `LiveApp/` | `MixAILive` (`ro.mixai.live`, iPhone + iPad): Connect (Bonjour `_mixai-live._tcp`, VisionKit QR scan, manual link / address + token, paired engines, auto-reconnect), Perform (Canvas meters in a TimelineView, tuner, PANIC hold-to-confirm, MUTE, BYPASS, prev / next, TAP, mix sliders, presets with long-press delete / revert to factory, setlist, lyrics teleprompter, haptic on scene change, screen kept awake), Chain (controller: toggles, parameters from `GET /api/fx`, add / remove / reorder, save preset, long-press MIDI learn with a waiting banner + cancel; read-only for other roles), MIDI (engine ports + activity light, bindings with unbind, channel filter, program-change toggle, learn for actions and mix faders; `docs/live/midi.md`) |
| `LiveApp/Localizable.xcstrings` | EN + RO for every key, also compiled into the watch app + complication. `InfoPlist.xcstrings` localises the usage descriptions |
| `../LiveWatch/` | `MixAILiveWatch` (`ro.mixai.live.watchkitapp`): scene prev / next, mute, PANIC (hold 1 s), tap, song + part around the input level ring; `MixAILiveWatchWidgets` complication (current part) via App Group `group.ro.mixai.live` |

Watch routing: commands go through the iPhone (WatchConnectivity `sendMessage`, relayed by the phone's socket); the
phone also sends the engine config + latest snapshot as `applicationContext`. When the phone is not reachable the
watch opens its own `LiveClient` (10 Hz meters). watchOS restricts `URLSessionWebSocketTask` (TN3135), so the
direct route may be refused on hardware; the phone relay is the supported path.

Checks:

```powershell
node apps/ios/scripts/strings-check.mjs apps/ios/LiveApp/Localizable.xcstrings apps/ios/LiveApp apps/ios/LiveWatch
```

On the Mac (`vmui-mac`): `cd LiveCore && swift test`; unsigned compiles with the `MixAILive` (iOS + embedded watch)
and `MixAILiveWatch` schemes (`generic/platform=iOS` / `generic/platform=watchOS`, `CODE_SIGNING_ALLOWED=NO`).

Apple portal: App IDs `ro.mixai.live`, `.watchkitapp`, `.watchkitapp.widgets` and App Group `group.ro.mixai.live`
do not exist yet; signed builds and TestFlight need them and an App Store Connect record first.
