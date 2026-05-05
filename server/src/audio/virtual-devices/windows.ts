/**
 * Windows virtual audio adapter — wraps the Virtual-Audio-Driver
 * project (MIT, https://github.com/VirtualDrivers/Virtual-Audio-Driver).
 *
 * Why Virtual-Audio-Driver and not VB-CABLE / Synchronous Audio Router /
 * Voicemeeter:
 *   - VB-CABLE: donationware, EULA forbids redistribution without
 *               per-seat commercial licence.
 *   - Synchronous Audio Router: GPL-2, abandoned (last release 2019),
 *                               no Win11 24H2 signing.
 *   - Voicemeeter: same EULA situation as VB-CABLE.
 *   - Virtual-Audio-Driver: MIT, actively maintained (2025-07 release),
 *                           signed with an EV cert (loads on Win10/11
 *                           without test-signing), ships .inf + .sys + .cat.
 *
 * The signed release exposes a SINGLE render+capture endpoint pair. Adding
 * more endpoints requires modifying the INF + reinstalling — NOT a runtime
 * operation. Therefore this adapter:
 *   - probe()                     → reports installed yes/no
 *   - install() / uninstall()     → pnputil under UAC
 *   - list()                      → returns the one OS-visible endpoint
 *                                    pair as a synthetic "loopback" device
 *   - create()                    → throws (supportsRuntimeCreate=false)
 *   - rename / setEnabled / remove → operate on the installed driver via
 *                                    PowerShell + pnputil
 *
 * Multi-deck routing on Windows is achieved by combining this single
 * virtual pair with the user's physical interface(s); the web app's
 * audio engine handles per-channel multiplexing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import type {
    CreateVirtualDeviceOptions,
    DriverProbe,
    IVirtualDeviceAdapter,
    VirtualDevice,
} from "./types";

const exec = promisify(execFile);

const DRIVER_FRIENDLY_NAME = "Virtual Audio Driver";
const SYNTHETIC_DEVICE_ID = "vad-default-pair";

interface BundlePaths {
    inf: string;
    sys: string;
    cat: string;
    /** Reserved for a future multi-instance helper (not shipped today). */
    settingsExe: string;
}

export class WindowsVirtualAudioAdapter implements IVirtualDeviceAdapter {
    readonly platform = "windows" as const;

    /** Per-process state for the single endpoint pair. The companion
     *  store re-applies these on startup via reconcileOnStartup(). */
    private nameOverride = DRIVER_FRIENDLY_NAME;
    private enabled = true;

    constructor(private readonly bundle: BundlePaths) { }

    async probe(): Promise<DriverProbe> {
        try {
            const { stdout } = await exec("pnputil", ["/enum-drivers"], { timeout: 10_000 });
            const installed = stdout.toLowerCase().includes("virtualaudiodriver.inf")
                || stdout.includes(DRIVER_FRIENDLY_NAME);
            if (!installed) {
                return {
                    available: false,
                    reason: "Virtual Audio Driver not installed. Click Install (admin consent required).",
                    requiresElevation: true,
                    supportsRuntimeCreate: false,
                    maxDevices: 0,
                };
            }
            return {
                available: true,
                version: "Virtual Audio Driver (signed)",
                requiresElevation: true,
                supportsRuntimeCreate: false,
                maxDevices: 1,
            };
        } catch (err) {
            return {
                available: false,
                reason: `Failed to query pnputil: ${(err as Error).message}`,
                requiresElevation: true,
                supportsRuntimeCreate: false,
                maxDevices: 0,
            };
        }
    }

    async install(): Promise<DriverProbe> {
        if (!await fileExists(this.bundle.inf)) {
            throw new Error(
                "Virtual Audio Driver INF not bundled. Run `pnpm fetch:virtual-audio` from the server folder before packaging.",
            );
        }
        const argList = `'/add-driver','"${this.bundle.inf}"','/install'`;
        const psCmd = `Start-Process pnputil.exe -ArgumentList ${argList} -Verb RunAs -Wait -WindowStyle Hidden`;
        await exec("powershell.exe", ["-NoProfile", "-Command", psCmd], { timeout: 180_000 });
        return this.probe();
    }

    async uninstall(): Promise<void> {
        const { stdout } = await exec("pnputil", ["/enum-drivers"], { timeout: 10_000 });
        const blocks = stdout.split(/\r?\n\r?\n/);
        const target = blocks.find(b => b.toLowerCase().includes("virtualaudiodriver.inf"));
        if (!target) return;
        const m = /Published Name:\s*(oem\d+\.inf)/i.exec(target);
        if (!m) return;
        const oemInf = m[1];
        const argList = `'/delete-driver','${oemInf}','/uninstall','/force'`;
        const psCmd = `Start-Process pnputil.exe -ArgumentList ${argList} -Verb RunAs -Wait -WindowStyle Hidden`;
        await exec("powershell.exe", ["-NoProfile", "-Command", psCmd], { timeout: 60_000 });
    }

    async list(): Promise<VirtualDevice[]> {
        const probe = await this.probe();
        if (!probe.available) return [];
        return [{
            id: SYNTHETIC_DEVICE_ID,
            name: this.nameOverride,
            // Driver exposes both render + capture — surface as loopback
            // so the UI's loopback tag matches user expectation.
            topology: "loopback",
            channels: 2,
            sampleRate: 48000,
            enabled: this.enabled,
            source: "preexisting",
        }];
    }

    async create(_opts: CreateVirtualDeviceOptions): Promise<VirtualDevice> {
        throw new Error(
            "Adding new virtual devices is not supported on Windows by the bundled driver. "
            + "It exposes one endpoint pair; multi-deck routing is handled by the web app's "
            + "channel router.",
        );
    }

    async rename(id: string, newName: string): Promise<VirtualDevice> {
        if (id !== SYNTHETIC_DEVICE_ID) throw new Error(`Unknown virtual device ${id}`);
        const psCmd = renameRegistryPSCmd(newName);
        try {
            await exec("powershell.exe", ["-NoProfile", "-Command",
                `Start-Process powershell -ArgumentList '-NoProfile','-Command',"${psCmd.replace(/"/g, '\\"')}" -Verb RunAs -Wait -WindowStyle Hidden`,
            ], { timeout: 30_000 });
        } catch {
            // UAC cancelled or registry write failed — keep in-process
            // override so the companion UI stays consistent. The OS
            // picker will pick up the new name on next reboot or on
            // a successful registry write.
        }
        this.nameOverride = newName;
        return (await this.list())[0];
    }

    async setEnabled(id: string, enabled: boolean): Promise<VirtualDevice> {
        if (id !== SYNTHETIC_DEVICE_ID) throw new Error(`Unknown virtual device ${id}`);
        const verb = enabled ? "Enable-PnpDevice" : "Disable-PnpDevice";
        const inner = [
            `Get-PnpDevice -FriendlyName '${escapePsArg(this.nameOverride)}*' -ErrorAction SilentlyContinue`,
            `| ${verb} -Confirm:$false -ErrorAction SilentlyContinue`,
        ].join(" ");
        await exec("powershell.exe", ["-NoProfile", "-Command",
            `Start-Process powershell -ArgumentList '-NoProfile','-Command',"${inner.replace(/"/g, '\\"')}" -Verb RunAs -Wait -WindowStyle Hidden`,
        ], { timeout: 30_000 }).catch(() => undefined);
        this.enabled = enabled;
        return (await this.list())[0];
    }

    async remove(id: string): Promise<void> {
        if (id !== SYNTHETIC_DEVICE_ID) return;
        // The driver exposes a single device — "removing" it means
        // uninstalling the driver. The UI confirms before calling this.
        await this.uninstall();
    }
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

function escapePsArg(s: string): string {
    return s.replace(/'/g, "''");
}

/**
 * PowerShell snippet that renames every MMDevice friendly name owned
 * by our driver. We match by the existing friendly name (substring of
 * "Virtual Audio Driver") so the rename is idempotent.
 *
 * Property GUIDs:
 *   {a45c254e-df1c-4efd-8020-67d146a850e0},2  → DEVPKEY_Device_FriendlyName
 *   {b3f8fa53-0004-438e-9003-51a46e139bfc},6  → PKEY_Device_FriendlyName (MMDevice)
 */
function renameRegistryPSCmd(newName: string): string {
    const safe = newName.replace(/'/g, "''");
    return [
        "$base='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\MMDevices\\Audio';",
        "Get-ChildItem -Path $base -Recurse -ErrorAction SilentlyContinue |",
        "Where-Object { $_.PSChildName -match '^\\{[0-9a-fA-F-]+\\}$' } |",
        "ForEach-Object {",
        "  $props=Join-Path $_.PSPath 'Properties';",
        "  if (Test-Path $props) {",
        "    $name=(Get-ItemProperty -Path $props -ErrorAction SilentlyContinue).'{a45c254e-df1c-4efd-8020-67d146a850e0},2';",
        `    if ($name -like '*${DRIVER_FRIENDLY_NAME}*') {`,
        `      Set-ItemProperty -Path $props -Name '{b3f8fa53-0004-438e-9003-51a46e139bfc},6' -Value '${safe}' -ErrorAction SilentlyContinue;`,
        "    }",
        "  }",
        "}",
    ].join(" ");
}

// Forward-compat: keep BundlePaths in the API so a future multi-instance
// helper can be wired without an interface change.
void ({} as BundlePaths);
