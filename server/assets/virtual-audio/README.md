# Virtual Audio Driver Assets

Bundled driver binaries are **not** committed — they are too large and
licence terms recommend pulling fresh from upstream. Run:

```pwsh
pnpm fetch:virtual-audio
```

before `pnpm dist` so electron-builder packages them into the installer.

## What ends up here

```
windows/
  VirtualAudioDriver.inf      # signed by VirtualDrivers project (EV cert)
  VirtualAudioDriver.sys
  VirtualAudioDriver.cat
  VAD-Settings.exe            # multi-instance manager
macos/
  BlackHole.16ch.pkg          # signed + notarised by Existential Audio
```

Linux ships nothing — `pactl` is part of every modern desktop distro
(PipeWire on Fedora/Ubuntu 22.04+, PulseAudio on older systems).

## Why these specific drivers

| OS | Driver | Licence | Notes |
|---|---|---|---|
| Windows | [Virtual-Audio-Driver](https://github.com/VirtualDrivers/Virtual-Audio-Driver) | MIT | Signed by maintainer with EV cert; loads on Win10/11 without test-signing. Up to 10 endpoint instances. |
| macOS | [BlackHole](https://github.com/ExistentialAudio/BlackHole) | GPL-3 | User-space CoreAudio HAL plug-in (not a kext); zero added latency. Companion is AGPL-3-or-later, so GPL-3 is compatible. |
| Linux | PipeWire / PulseAudio (`pactl`) | LGPL-2.1 | Part of the OS. We just shell out. |

We deliberately do **not** ship VB-CABLE or Voicemeeter — both are
donationware whose EULA forbids redistribution without a paid commercial
licence.

## Hash verification

`fetch-virtual-audio.mjs` pins SHA-256 hashes for every artifact. When
upgrading an upstream release:

1. Download the new artifact manually.
2. Audit it (signature, virustotal, sandbox run).
3. Compute the SHA-256 (`Get-FileHash` on Windows, `shasum -a 256` on Unix).
4. Update the `sha256` field in `ARTIFACTS` in
   `server/scripts/fetch-virtual-audio.mjs`.

CI must fail the build if the hash is empty (production guard) — see the
TODO in the script.
