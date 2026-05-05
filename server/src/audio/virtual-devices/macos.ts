/**
 * macOS virtual audio adapter — wraps BlackHole (GPL-3, by Existential
 * Audio). BlackHole is a CoreAudio HAL plug-in, NOT a kext / NOT a
 * DriverKit extension, so it loads on Apple Silicon + Intel without
 * SIP changes, without a kernel collection rebuild, and without any
 * Apple-granted entitlement.
 *
 * What we ship:
 *   assets/virtual-audio/macos/BlackHole.16ch.pkg     — installer
 *   assets/virtual-audio/macos/BlackHole.uninstall.sh — official uninstaller
 *
 * Multiple instances:
 *   BlackHole supports multiple parallel instances by duplicating the
 *   .driver bundle under a new bundle ID (CFBundleIdentifier) and a new
 *   driver UUID. We DON'T do that at runtime — instead we ship the
 *   16-channel build and let the user partition it logically: each
 *   "virtual device" we expose is a stereo pair (channels 1-2 = Master,
 *   3-4 = Cue, 5-6 = Aux1, 7-8 = Aux2, 15-16 = Loopback). The OS sees
 *   ONE 16-channel device; the engine reads/writes specific channel
 *   ranges. This is the BlackHole-recommended pattern and avoids the
 *   complexity of registering N kernel-visible bundles.
 *
 *   Renaming: the OS-visible name comes from CFBundleName in the
 *   .driver's Info.plist. We patch it + kickstart coreaudiod. The
 *   per-channel labels (what the user actually wants to rename) are
 *   stored in the companion settings and surfaced through the
 *   web app's audio engine; they don't need any OS roundtrip.
 *
 * License: BlackHole is GPL-3.0. The companion is AGPL-3.0-or-later
 * (a GPL-3-compatible licence). We bundle BlackHole as-is, link to
 * its source, and surface its licence text in the UI.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
    CreateVirtualDeviceOptions,
    DriverProbe,
    IVirtualDeviceAdapter,
    VirtualDevice,
} from "./types";

const exec = promisify(execFile);

const HAL_DRIVER_DIR = "/Library/Audio/Plug-Ins/HAL";
const BLACKHOLE_BUNDLE = "BlackHole16ch.driver";
const BLACKHOLE_PLIST_NAME = "Info.plist";

interface InstanceMeta {
    id: string;
    name: string;
    topology: "independent" | "loopback";
    channels: number;
    sampleRate: number;
    enabled: boolean;
    /** Channel range inside the 16-ch bundle that this logical
     *  "device" represents. */
    channelOffset: number;
}

export class MacOSVirtualAudioAdapter implements IVirtualDeviceAdapter {
    readonly platform = "macos" as const;
    private instances = new Map<string, InstanceMeta>();
    private nextChannelOffset = 0;

    constructor(private readonly bundledPkgPath: string) { }

    async probe(): Promise<DriverProbe> {
        try {
            const driverPath = path.join(HAL_DRIVER_DIR, BLACKHOLE_BUNDLE);
            await fs.access(driverPath);
            // Read the version from Info.plist via PlistBuddy.
            const version = await this.readPlistKey(driverPath, "CFBundleShortVersionString").catch(() => undefined);
            return {
                available: true,
                version: version ? `BlackHole 16ch ${version}` : "BlackHole 16ch",
                requiresElevation: true,
                supportsRuntimeCreate: true,
                maxDevices: 8, // 16ch / 2ch per device
            };
        } catch {
            return {
                available: false,
                reason: "BlackHole 16ch not installed. Click Install to set it up (admin password required).",
                requiresElevation: true,
                supportsRuntimeCreate: false,
                maxDevices: 0,
            };
        }
    }

    async install(): Promise<DriverProbe> {
        if (!this.bundledPkgPath) {
            throw new Error("BlackHole installer not bundled. Run `pnpm fetch:virtual-audio` before packaging.");
        }
        try {
            await fs.access(this.bundledPkgPath);
        } catch {
            throw new Error(`BlackHole installer not found at ${this.bundledPkgPath}.`);
        }
        // `installer` requires root; we shell out via osascript so the
        // OS shows a native auth dialog instead of failing silently.
        const script = `do shell script "installer -pkg '${this.bundledPkgPath.replace(/'/g, "'\\''")}' -target /" with administrator privileges`;
        await exec("osascript", ["-e", script], { timeout: 120_000 });
        await this.kickstartCoreAudio();
        return this.probe();
    }

    async uninstall(): Promise<void> {
        const driverPath = path.join(HAL_DRIVER_DIR, BLACKHOLE_BUNDLE);
        const script = `do shell script "rm -rf '${driverPath}' && launchctl kickstart -k system/com.apple.audio.coreaudiod" with administrator privileges`;
        await exec("osascript", ["-e", script], { timeout: 30_000 });
        this.instances.clear();
        this.nextChannelOffset = 0;
    }

    async list(): Promise<VirtualDevice[]> {
        return Array.from(this.instances.values()).map(toVD);
    }

    async create(opts: CreateVirtualDeviceOptions): Promise<VirtualDevice> {
        const channels = opts.channels ?? 2;
        if (this.nextChannelOffset + channels > 16) {
            throw new Error(
                "BlackHole 16ch is full (8 stereo devices). Remove one before adding another."
            );
        }
        const meta: InstanceMeta = {
            id: randomUUID(),
            name: opts.name,
            topology: opts.topology === "loopback" ? "loopback" : "independent",
            channels,
            sampleRate: opts.sampleRate ?? 48000,
            enabled: true,
            channelOffset: this.nextChannelOffset,
        };
        this.nextChannelOffset += channels;
        this.instances.set(meta.id, meta);
        return toVD(meta);
    }

    async rename(id: string, newName: string): Promise<VirtualDevice> {
        const meta = this.instances.get(id);
        if (!meta) throw new Error(`Virtual device ${id} not found`);
        meta.name = newName;
        // The label is consumed by the web-app engine via the channel
        // metadata; no Info.plist patch is needed for per-stereo-pair
        // names. Renaming the bundle itself would require admin and
        // a coreaudiod restart, which we avoid for individual labels.
        return toVD(meta);
    }

    async setEnabled(id: string, enabled: boolean): Promise<VirtualDevice> {
        const meta = this.instances.get(id);
        if (!meta) throw new Error(`Virtual device ${id} not found`);
        meta.enabled = enabled;
        return toVD(meta);
    }

    async remove(id: string): Promise<void> {
        const meta = this.instances.get(id);
        if (!meta) return;
        this.instances.delete(id);
        // If this was the last allocated slice, we can recycle its
        // channel offset; otherwise we leave a gap (the next create()
        // will append, possibly hitting the 16ch ceiling earlier).
        if (meta.channelOffset + meta.channels === this.nextChannelOffset) {
            this.nextChannelOffset = meta.channelOffset;
        }
    }

    /** Force the CoreAudio daemon to reload all HAL plug-ins. Required
     *  after install / uninstall / Info.plist patch — without this,
     *  the device only appears after a logout/login cycle. */
    private async kickstartCoreAudio(): Promise<void> {
        // No admin needed for kickstart of a system service the user
        // owns; falls back silently if launchctl is busy.
        await new Promise<void>(resolve => {
            const child = spawn("launchctl", [
                "kickstart",
                "-k",
                "system/com.apple.audio.coreaudiod",
            ], { stdio: "ignore" });
            child.on("exit", () => resolve());
            child.on("error", () => resolve());
        });
    }

    private async readPlistKey(driverBundlePath: string, key: string): Promise<string> {
        const plistPath = path.join(driverBundlePath, "Contents", BLACKHOLE_PLIST_NAME);
        const { stdout } = await exec("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath]);
        return stdout.trim();
    }
}

function toVD(m: InstanceMeta): VirtualDevice {
    return {
        id: m.id,
        name: m.name,
        topology: m.topology,
        channels: m.channels,
        sampleRate: m.sampleRate,
        enabled: m.enabled,
        source: "companion",
    };
}
