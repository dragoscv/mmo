# Linux virtual audio — no bundled binaries needed

The Linux adapter wires the companion to the host's PipeWire / PulseAudio
stack via `pactl`, which ships with every modern desktop distro
(`pulseaudio-utils` on Debian/Ubuntu, `pipewire-pulse` on Fedora/Arch).
We don't ship any kernel module or HAL plug-in here — the OS already
exposes everything we need.

If `pactl` is missing, the adapter's `probe()` returns
`{ available: false, reason: "pactl not found …" }` and the UI surfaces
the install hint (e.g. `sudo apt install pulseaudio-utils`).

This folder is intentionally empty (apart from this README). It exists
so `extraResources` can include a stable layout across all three
platforms.
