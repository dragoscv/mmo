/**
 * Platform factory + persistence layer for the virtual audio
 * device subsystem. The companion process holds exactly one
 * adapter instance for the running OS.
 *
 * Persistence model:
 *   - The OS-side state (loaded modules / installed driver / created
 *     endpoints) is volatile across reboots on every platform we
 *     support. We therefore mirror the *intended* device set in the
 *     companion's electron-store and re-apply it on every startup.
 *   - On first-run (no persisted set, driver available), we install
 *     DEFAULT_DEVICE_SET so the user gets a working configuration
 *     out of the box without opening any dialog.
 */

import { app } from "electron";
import path from "node:path";
import os from "node:os";
import { LinuxVirtualAudioAdapter } from "./linux";
import { MacOSVirtualAudioAdapter } from "./macos";
import { WindowsVirtualAudioAdapter } from "./windows";
import {
    DEFAULT_DEVICE_SET,
    type CreateVirtualDeviceOptions,
    type DriverProbe,
    type IVirtualDeviceAdapter,
    type VirtualDevice,
} from "./types";
import { store } from "../../store";

export type {
    VirtualDevice,
    DriverProbe,
    CreateVirtualDeviceOptions,
} from "./types";
export { DEFAULT_DEVICE_SET } from "./types";

const STORE_KEY = "virtualAudioDevices";
const STORE_FIRSTRUN_KEY = "virtualAudioFirstRunDone";

interface PersistedDevice extends CreateVirtualDeviceOptions {
    id: string;
    enabled: boolean;
}

let cached: IVirtualDeviceAdapter | null = null;

/** Resolve the right adapter for this OS, with bundled-binary paths
 *  wired in. Safe to call repeatedly — the adapter is memoised. */
export function getVirtualAudioAdapter(): IVirtualDeviceAdapter {
    if (cached) return cached;
    const platform = os.platform();
    if (platform === "linux") {
        cached = new LinuxVirtualAudioAdapter();
    } else if (platform === "darwin") {
        cached = new MacOSVirtualAudioAdapter(macAssetPath("BlackHole.16ch.pkg"));
    } else if (platform === "win32") {
        cached = new WindowsVirtualAudioAdapter({
            inf: winAssetPath("VirtualAudioDriver.inf"),
            sys: winAssetPath("VirtualAudioDriver.sys"),
            cat: winAssetPath("VirtualAudioDriver.cat"),
            settingsExe: winAssetPath("VAD-Settings.exe"),
        });
    } else {
        throw new Error(`Unsupported platform for virtual audio: ${platform}`);
    }
    return cached;
}

/** Resolve a packaged asset path that works in both `electron .` (dev)
 *  and the asar-packed production build (`process.resourcesPath`). */
function assetBaseDir(): string {
    // In production electron-builder copies `assets/` into resources;
    // in dev we read from the repo's working tree.
    if (app.isPackaged) {
        return path.join(process.resourcesPath, "virtual-audio");
    }
    return path.join(__dirname, "..", "..", "..", "assets", "virtual-audio");
}

function winAssetPath(name: string): string {
    return path.join(assetBaseDir(), "windows", name);
}
function macAssetPath(name: string): string {
    return path.join(assetBaseDir(), "macos", name);
}

/** Load persisted intent. */
export function loadPersisted(): PersistedDevice[] {
    const raw = store.get(STORE_KEY) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (d): d is PersistedDevice =>
            !!d
            && typeof (d as PersistedDevice).id === "string"
            && typeof (d as PersistedDevice).name === "string",
    );
}

function savePersisted(devices: VirtualDevice[]): void {
    const persisted: PersistedDevice[] = devices.map(d => ({
        id: d.id,
        name: d.name,
        topology: d.topology,
        channels: d.channels,
        sampleRate: d.sampleRate,
        enabled: d.enabled,
    }));
    store.set(STORE_KEY, persisted);
}

/** Run on companion startup AFTER the audio engine is ready.
 *
 *  Behaviour matrix:
 *    driver missing       → no-op (UI will prompt the user to install)
 *    driver present, first run, no persisted devices → create DEFAULT_DEVICE_SET
 *    driver present, persisted devices               → re-apply them
 *
 *  Errors are swallowed and logged; we never want a virtual-device
 *  startup hiccup to crash the companion. */
export async function reconcileOnStartup(log: (msg: string) => void): Promise<void> {
    try {
        const adapter = getVirtualAudioAdapter();
        const probe = await adapter.probe();
        if (!probe.available) {
            log(`[virtual-audio] driver unavailable: ${probe.reason ?? "unknown"}. Skipping reconcile.`);
            return;
        }
        const persisted = loadPersisted();
        const firstRunDone = store.get(STORE_FIRSTRUN_KEY) === true;
        if (persisted.length === 0 && !firstRunDone) {
            if (!probe.supportsRuntimeCreate) {
                // Windows: driver provides a single endpoint pair, no
                // dynamic create. Skip first-run device creation; the
                // device shows up via list() once installed.
                log(`[virtual-audio] driver present but supportsRuntimeCreate=false — skipping default device creation.`);
                store.set(STORE_FIRSTRUN_KEY, true);
                return;
            }
            log(`[virtual-audio] first run detected — creating ${DEFAULT_DEVICE_SET.length} default devices.`);
            const created: VirtualDevice[] = [];
            for (const def of DEFAULT_DEVICE_SET) {
                try {
                    created.push(await adapter.create(def));
                } catch (err) {
                    log(`[virtual-audio] failed to create "${def.name}": ${(err as Error).message}`);
                }
            }
            store.set(STORE_FIRSTRUN_KEY, true);
            savePersisted(created);
            log(`[virtual-audio] first run complete: ${created.length}/${DEFAULT_DEVICE_SET.length} devices created.`);
            return;
        }
        // Re-apply persisted set onto a fresh OS audio service.
        if (!probe.supportsRuntimeCreate) {
            // No-op: Windows-style adapter holds its own state; list()
            // returns the OS-installed device pair directly.
            log(`[virtual-audio] driver present (single-instance backend) — nothing to re-apply.`);
            return;
        }
        const reapplied: VirtualDevice[] = [];
        for (const p of persisted) {
            try {
                const dev = await adapter.create({
                    name: p.name,
                    topology: p.topology,
                    channels: p.channels,
                    sampleRate: p.sampleRate,
                });
                if (!p.enabled) await adapter.setEnabled(dev.id, false);
                reapplied.push({ ...dev, enabled: p.enabled });
            } catch (err) {
                log(`[virtual-audio] failed to re-apply "${p.name}": ${(err as Error).message}`);
            }
        }
        savePersisted(reapplied);
        log(`[virtual-audio] re-applied ${reapplied.length}/${persisted.length} devices.`);
    } catch (err) {
        log(`[virtual-audio] reconcile error: ${(err as Error).message}`);
    }
}

// ─── Thin wrappers used by IPC handlers — keep persistence in sync ──────────

export async function listDevices(): Promise<VirtualDevice[]> {
    return getVirtualAudioAdapter().list();
}

export async function probeDriver(): Promise<DriverProbe> {
    return getVirtualAudioAdapter().probe();
}

export async function installDriver(): Promise<DriverProbe> {
    return getVirtualAudioAdapter().install();
}

export async function uninstallDriver(): Promise<void> {
    await getVirtualAudioAdapter().uninstall();
    store.set(STORE_KEY, []);
    store.set(STORE_FIRSTRUN_KEY, false);
}

export async function createDevice(opts: CreateVirtualDeviceOptions): Promise<VirtualDevice> {
    const dev = await getVirtualAudioAdapter().create(opts);
    const all = await listDevices();
    savePersisted(all);
    return dev;
}

export async function renameDevice(id: string, newName: string): Promise<VirtualDevice> {
    const dev = await getVirtualAudioAdapter().rename(id, newName);
    savePersisted(await listDevices());
    return dev;
}

export async function setDeviceEnabled(id: string, enabled: boolean): Promise<VirtualDevice> {
    const dev = await getVirtualAudioAdapter().setEnabled(id, enabled);
    savePersisted(await listDevices());
    return dev;
}

export async function removeDevice(id: string): Promise<void> {
    await getVirtualAudioAdapter().remove(id);
    savePersisted(await listDevices());
}
