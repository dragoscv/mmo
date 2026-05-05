/**
 * Virtual Audio Device — cross-platform abstraction.
 *
 * The companion ships with native virtual audio drivers for each OS so
 * the web app's low-latency engine can route per-deck audio through
 * dedicated, named endpoints (Master / Cue / Aux1 / Aux2 / …) without
 * the user having to install third-party tools manually.
 *
 * Driver choice per OS (all redistributable, all GPL-3-compatible —
 * companion itself is AGPL-3.0-or-later):
 *
 *   - Linux:   PipeWire / PulseAudio `pactl` (dynamic null-sinks + loopbacks,
 *              no kernel module required)
 *   - macOS:   BlackHole (GPL-3) — user-space CoreAudio HAL plug-in
 *              loaded by `coreaudiod`, no kext / no DriverKit entitlement
 *   - Windows: Virtual-Audio-Driver (MIT, signed by maintainer with EV cert)
 *              — WDM/SYSVAD-derived kernel driver, installed via pnputil
 *
 * VB-CABLE is intentionally NOT used: it is donationware and its EULA
 * forbids redistribution without a (paid, per-seat) commercial licence.
 */

/** Direction of a virtual endpoint as the OS sees it. */
export type VAEndpointKind = "playback" | "capture" | "duplex";

/** Topology of the virtual device as the user thinks of it. */
export type VATopology =
    /** Independent endpoint pair (one playback + one capture, NOT linked).
     *  Used for per-deck routing — each deck writes to its own playback
     *  endpoint and the engine reads back from the matching capture
     *  endpoint when needed. This is what professional DJ software ships
     *  with (cf. rekordbox's "Internal" devices). DEFAULT. */
    | "independent"
    /** Loopback: whatever is written to playback is mirrored to capture
     *  with zero added samples of latency. Used for system-audio capture,
     *  recording streams, broadcast software, etc. */
    | "loopback";

/** A single virtual device managed by the companion. */
export interface VirtualDevice {
    /** Stable identifier assigned by the companion (UUID or driver-handle).
     *  Persisted across reboots. */
    id: string;
    /** User-facing name as shown by the OS (e.g. "MMO-Master"). */
    name: string;
    topology: VATopology;
    /** Number of channels per endpoint (typically 2). */
    channels: number;
    /** Sample rate in Hz (typically 48000). The driver may renegotiate
     *  this if the OS audio engine prefers a different one. */
    sampleRate: number;
    /** Whether the device is currently visible to the OS audio system.
     *  Disabling does NOT remove the device — it just hides it from
     *  app device pickers, useful for temporarily decluttering. */
    enabled: boolean;
    /** Where the device came from. Devices we did not create cannot be
     *  renamed/removed (e.g. an existing BlackHole 2ch install). */
    source: "companion" | "preexisting";
}

/** Result of probing the host for the underlying driver. */
export interface DriverProbe {
    /** True iff the driver backend the adapter needs is functional. */
    available: boolean;
    /** Human-readable explanation when not available
     *  (e.g. "BlackHole 16ch not installed"). */
    reason?: string;
    /** Driver version string, if reportable. */
    version?: string;
    /** True iff installing/uninstalling/managing devices needs
     *  elevated privileges (sudo / UAC). Almost always true on
     *  Windows + macOS, false on Linux. */
    requiresElevation: boolean;
    /** When `false`, the adapter cannot create new devices at runtime
     *  — only enable/disable/rename existing ones (Windows ships with
     *  N pre-baked endpoints; we do not dynamically add INF entries). */
    supportsRuntimeCreate: boolean;
    /** Maximum number of independent virtual devices the driver can
     *  expose. -1 means unlimited (Linux). */
    maxDevices: number;
}

/** Options for creating a new virtual device. */
export interface CreateVirtualDeviceOptions {
    name: string;
    topology: VATopology;
    /** Defaults to 2. */
    channels?: number;
    /** Defaults to 48000. */
    sampleRate?: number;
}

/** What every per-OS adapter must implement. */
export interface IVirtualDeviceAdapter {
    /** Identifier for the driver backend. */
    readonly platform: "linux" | "macos" | "windows";
    /** Probe the OS for the underlying driver. Cheap & sync-fast. */
    probe(): Promise<DriverProbe>;
    /** Install the bundled driver. May require admin/sudo and may
     *  prompt the user (UAC on Windows, sudo on macOS). On macOS a
     *  reboot is recommended but not required. On Linux this is a
     *  no-op (PipeWire/PulseAudio is part of the OS).
     *  Resolves with the post-install probe result. */
    install(): Promise<DriverProbe>;
    /** Uninstall the bundled driver. Same caveats as install. */
    uninstall(): Promise<void>;
    /** Enumerate virtual devices currently visible to the OS. */
    list(): Promise<VirtualDevice[]>;
    /** Create a new virtual device. Throws if `supportsRuntimeCreate`
     *  is false on this platform. */
    create(opts: CreateVirtualDeviceOptions): Promise<VirtualDevice>;
    /** Rename a virtual device. May require kicking the OS audio
     *  service (coreaudiod / pipewire / Audiosrv) for the new name
     *  to appear in the OS picker. */
    rename(id: string, newName: string): Promise<VirtualDevice>;
    /** Toggle visibility to the OS audio system. */
    setEnabled(id: string, enabled: boolean): Promise<VirtualDevice>;
    /** Remove a virtual device permanently. */
    remove(id: string): Promise<void>;
}

/** Default device set — what we create on first-run if the OS has none.
 *  Mirrors what hardware DJ controllers expose: a Master out, a Cue out
 *  for headphone monitoring, two aux pairs for hot-cue layering / sample
 *  decks, and one loopback for recording / OBS / Discord. */
export const DEFAULT_DEVICE_SET: CreateVirtualDeviceOptions[] = [
    { name: "MMO-Master", topology: "independent", channels: 2, sampleRate: 48000 },
    { name: "MMO-Cue", topology: "independent", channels: 2, sampleRate: 48000 },
    { name: "MMO-Aux1", topology: "independent", channels: 2, sampleRate: 48000 },
    { name: "MMO-Aux2", topology: "independent", channels: 2, sampleRate: 48000 },
    { name: "MMO-Loopback", topology: "loopback", channels: 2, sampleRate: 48000 },
];
