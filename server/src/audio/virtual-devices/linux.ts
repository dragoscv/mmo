/**
 * Linux virtual audio adapter — wraps `pactl` (PipeWire's PulseAudio
 * compatibility shim, or legacy pulseaudio).
 *
 * Why pactl and not direct libpipewire? pactl is in the base install of
 * every modern desktop distro (Ubuntu 22.04+, Fedora 36+, Arch, Debian
 * 12+), is stable across PipeWire / PulseAudio, and gives us
 *   - module-null-sink   → "independent" virtual devices
 *   - module-loopback    → "loopback" mirrors
 *   - module-remap-source → exposing the .monitor as a true input device
 *
 * Devices created via `pactl load-module` get a numeric module ID per
 * boot; they do NOT survive a reboot. We persist the wanted set in
 * the companion store and re-apply it on startup. Device IDs returned
 * by `list()` are the synthetic UUIDs we assigned (not the volatile
 * PipeWire serials), so the caller can rely on them across restarts.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type {
    CreateVirtualDeviceOptions,
    DriverProbe,
    IVirtualDeviceAdapter,
    VirtualDevice,
} from "./types";

const exec = promisify(execFile);

/**
 * One module loaded into the running PulseAudio / PipeWire process.
 * For an "independent" device we load 1 null-sink (ID = sinkModuleId).
 * For a "loopback" device we load 1 null-sink + 1 loopback module.
 */
interface LoadedModule {
    /** Companion-assigned stable id. */
    id: string;
    name: string;
    topology: "independent" | "loopback";
    channels: number;
    sampleRate: number;
    enabled: boolean;
    /** Volatile module IDs — undefined when `enabled === false`. */
    sinkModuleId?: number;
    loopbackModuleId?: number;
}

const TAG_PREFIX = "mmo_va_";

async function pactl(args: string[]): Promise<string> {
    const { stdout } = await exec("pactl", args, { timeout: 10_000 });
    return stdout;
}

export class LinuxVirtualAudioAdapter implements IVirtualDeviceAdapter {
    readonly platform = "linux" as const;
    private modules = new Map<string, LoadedModule>();

    async probe(): Promise<DriverProbe> {
        try {
            const info = await pactl(["info"]);
            // PipeWire reports e.g. "Server Name: PulseAudio (on PipeWire 1.0.5)"
            const m = /Server Name:\s*(.+)/.exec(info);
            return {
                available: true,
                version: m ? m[1].trim() : "PulseAudio compatible",
                requiresElevation: false,
                supportsRuntimeCreate: true,
                maxDevices: -1,
            };
        } catch (err) {
            return {
                available: false,
                reason: `pactl not available: ${(err as Error).message}. Install pipewire-pulse or pulseaudio-utils.`,
                requiresElevation: false,
                supportsRuntimeCreate: false,
                maxDevices: 0,
            };
        }
    }

    async install(): Promise<DriverProbe> {
        // Nothing to install — PipeWire/PulseAudio ship with every modern distro.
        return this.probe();
    }

    async uninstall(): Promise<void> {
        // Unload all of our modules; do NOT touch the system audio server.
        for (const id of Array.from(this.modules.keys())) {
            await this.remove(id).catch(() => undefined);
        }
    }

    async list(): Promise<VirtualDevice[]> {
        // Return the in-process registry. We deliberately do NOT scan
        // pactl output for "preexisting" virtual devices — those belong
        // to other apps (Discord noise-suppression, OBS, etc.) and we
        // must not let the user accidentally remove them.
        return Array.from(this.modules.values()).map(m => ({
            id: m.id,
            name: m.name,
            topology: m.topology,
            channels: m.channels,
            sampleRate: m.sampleRate,
            enabled: m.enabled,
            source: "companion" as const,
        }));
    }

    async create(opts: CreateVirtualDeviceOptions): Promise<VirtualDevice> {
        const id = randomUUID();
        const safe = sanitiseName(opts.name);
        const mod: LoadedModule = {
            id,
            name: safe,
            topology: opts.topology === "loopback" ? "loopback" : "independent",
            channels: opts.channels ?? 2,
            sampleRate: opts.sampleRate ?? 48000,
            enabled: false,
        };
        this.modules.set(id, mod);
        await this.applyEnabled(mod, true);
        return toVD(mod);
    }

    async rename(id: string, newName: string): Promise<VirtualDevice> {
        const mod = this.modules.get(id);
        if (!mod) throw new Error(`Virtual device ${id} not found`);
        const wasEnabled = mod.enabled;
        if (wasEnabled) await this.applyEnabled(mod, false);
        mod.name = sanitiseName(newName);
        if (wasEnabled) await this.applyEnabled(mod, true);
        return toVD(mod);
    }

    async setEnabled(id: string, enabled: boolean): Promise<VirtualDevice> {
        const mod = this.modules.get(id);
        if (!mod) throw new Error(`Virtual device ${id} not found`);
        await this.applyEnabled(mod, enabled);
        return toVD(mod);
    }

    async remove(id: string): Promise<void> {
        const mod = this.modules.get(id);
        if (!mod) return;
        await this.applyEnabled(mod, false);
        this.modules.delete(id);
    }

    private async applyEnabled(mod: LoadedModule, enabled: boolean): Promise<void> {
        if (enabled === mod.enabled) return;
        if (enabled) {
            const sinkName = `${TAG_PREFIX}${mod.name}`;
            const sinkOut = await pactl([
                "load-module",
                "module-null-sink",
                `sink_name=${sinkName}`,
                `sink_properties=device.description="${mod.name}"`,
                `rate=${mod.sampleRate}`,
                `channels=${mod.channels}`,
            ]);
            mod.sinkModuleId = parseInt(sinkOut.trim(), 10);
            if (mod.topology === "loopback") {
                // module-loopback with latency_msec=1 is the lowest the
                // PulseAudio API allows; PipeWire actually delivers
                // sub-millisecond when the graph quantum is small.
                const lbOut = await pactl([
                    "load-module",
                    "module-loopback",
                    `source=${sinkName}.monitor`,
                    "latency_msec=1",
                ]);
                mod.loopbackModuleId = parseInt(lbOut.trim(), 10);
            }
            mod.enabled = true;
        } else {
            if (mod.loopbackModuleId !== undefined) {
                await pactl(["unload-module", String(mod.loopbackModuleId)]).catch(() => undefined);
                mod.loopbackModuleId = undefined;
            }
            if (mod.sinkModuleId !== undefined) {
                await pactl(["unload-module", String(mod.sinkModuleId)]).catch(() => undefined);
                mod.sinkModuleId = undefined;
            }
            mod.enabled = false;
        }
    }
}

function toVD(m: LoadedModule): VirtualDevice {
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

function sanitiseName(name: string): string {
    // pactl sink_name accepts [A-Za-z0-9_.-]; description (quoted) is freer.
    return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60) || "MMO_Device";
}
