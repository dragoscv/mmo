# MixAI Decks changelog

## 1.2.0 — 2026-11-09

- **Bluetooth MIDI controllers, built in.** Settings → Bluetooth MIDI scans for any BLE-MIDI 1.0
  controller (tested with the Pioneer DDJ-FLX4) and connects directly. No Windows driver, no
  pairing and no extra app needed, on Windows, macOS and Linux.
- The controller uses the same mapping and MIDI Learn as USB controllers (DDJ-FLX4 auto-maps).
- LED feedback over Bluetooth: PLAY / CUE follow deck state.
- Auto-connect: the last controller is remembered and reconnects when it is switched on or comes
  back in range.
- Live link stats: messages per second, packet gap (p95) and signal strength.
