"use client";

/**
 * Mixer Settings — "Console" tab.
 *
 * Lets the user:
 *  - See which physical controllers are connected and which driver is bound
 *  - Pick / pin a driver per controller (override auto-detect)
 *  - Pick a built-in colour preset for LED feedback
 *  - Trigger a brief LED-test animation on every connected controller
 *  - Refresh the MIDI device list
 */

import { useMemo, useState } from "react";
import { useMidi } from "@/hooks/use-midi";
import { listDriverInfos, detectDriverForDevice } from "@/lib/controllers/drivers/registry";
import { GenericMidiDriver } from "@/lib/controllers/controller-driver";
import { BUILTIN_COLOR_PRESETS, DEFAULT_COLORS, getPresetById, type ColorPreset, type ColorRole } from "@/lib/controllers/color-presets";
import { identifyAllControllers, rebindAllControllers, runBindDiagnostic, useActiveControllers, type BindDiagnosticResult } from "@/components/controller-bridge";
import { Gamepad2, RefreshCw, Sparkles, Lightbulb, AlertCircle, CheckCircle2, Terminal, Stethoscope } from "lucide-react";
import { cn } from "@/lib/utils";

const PREVIEW_ROLES: { role: ColorRole; label: string }[] = [
    { role: "play", label: "Play" },
    { role: "cue", label: "Cue" },
    { role: "sync", label: "Sync" },
    { role: "loop", label: "Loop" },
    { role: "headphoneCue", label: "HP Cue" },
    { role: "padModeHotcue", label: "Hot Cue" },
    { role: "padModeBeatloop", label: "Beat Loop" },
    { role: "padModeSampler", label: "Sampler" },
];

const HOT_CUE_ROLES: ColorRole[] = [
    "hotcue1", "hotcue2", "hotcue3", "hotcue4",
    "hotcue5", "hotcue6", "hotcue7", "hotcue8",
];

function previewColor(preset: ColorPreset, role: ColorRole): string {
    return preset.colors[role] ?? DEFAULT_COLORS[role];
}

export function ConsoleTab() {
    const midi = useMidi();
    const driverInfos = useMemo(() => listDriverInfos(), []);
    const activeControllers = useActiveControllers();
    const [diag, setDiag] = useState<BindDiagnosticResult | null>(null);

    const presetId = midi.settings.colorPresetId ?? "rekordbox-classic";
    const preset = getPresetById(presetId) ?? BUILTIN_COLOR_PRESETS[0];

    const connectedOutputs = midi.devices.filter(d => d.output);
    const inputsWithoutOutput = midi.devices.filter(d => !d.output && !d.outputOnly);
    const boundIds = new Set(activeControllers.map(c => c.deviceId));

    // Snapshot of raw MIDI port state — gives the user visibility into what
    // Chrome's Web MIDI subsystem actually sees, which often differs from
    // what Windows / macOS shows in their audio panels.
    const diagnostics = useMemo(() => midi.getDiagnostics(), [midi]);
    const inputLines = diagnostics.filter(l => l.trim().startsWith("IN  ["));
    const outputLines = diagnostics.filter(l => l.trim().startsWith("OUT ["));

    return (
        <div className="space-y-4">
            {/* ── Connected controllers ─────────────────────────────────── */}
            <section className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-3">
                <div className="flex items-center gap-2 mb-2">
                    <Gamepad2 className="w-3.5 h-3.5 text-white/40" />
                    <span className="text-[11px] uppercase tracking-wider text-white/50 font-medium">Connected Controllers</span>
                    <div className="ml-auto flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => { void midi.refreshDevices(); }}
                            title="Re-scan MIDI devices"
                            className="inline-flex items-center gap-1 text-[10px] text-white/40 hover:text-white/80 transition-colors cursor-pointer"
                        >
                            <RefreshCw className="w-3 h-3" /> Refresh
                        </button>
                        <button
                            type="button"
                            onClick={() => { rebindAllControllers(); }}
                            title="Tear down and re-bind every controller driver — use if a device shows 'Not bound' even though it's connected"
                            className="inline-flex items-center gap-1 text-[10px] text-white/40 hover:text-white/80 transition-colors cursor-pointer"
                        >
                            <Sparkles className="w-3 h-3" /> Re-bind
                        </button>
                        <button
                            type="button"
                            onClick={() => { setDiag(runBindDiagnostic()); }}
                            title="Run an end-to-end diagnostic that bypasses React and pokes the MIDI engine directly"
                            className="inline-flex items-center gap-1 text-[10px] text-emerald-400/60 hover:text-emerald-300 transition-colors cursor-pointer"
                        >
                            <Stethoscope className="w-3 h-3" /> Diagnose
                        </button>
                    </div>
                </div>

                {connectedOutputs.length === 0 ? (
                    <div className="flex items-center gap-2 text-[10px] text-white/40 bg-white/[0.02] border border-white/[0.04] rounded px-2.5 py-2">
                        <AlertCircle className="w-3 h-3 shrink-0" />
                        No controllers detected. Plug in a MIDI device with an output port (most DJ controllers) and click Refresh.
                    </div>
                ) : (
                    <ul className="space-y-1.5">
                        {connectedOutputs.map(device => {
                            const auto = detectDriverForDevice(device.name) ?? new GenericMidiDriver();
                            const isBound = boundIds.has(device.id);
                            return (
                                <li key={device.id} className="rounded-md bg-black/30 border border-white/[0.06] p-2.5">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="text-[11px] font-medium text-white/85 truncate">{device.name}</div>
                                            <div className="text-[9px] text-white/35 truncate">{device.manufacturer || "Unknown vendor"}</div>
                                        </div>
                                        <div className="flex flex-col items-end gap-0.5 shrink-0">
                                            <span className={cn(
                                                "rounded px-1.5 py-0.5 text-[9px] font-medium border",
                                                auto.info.id === "generic-midi"
                                                    ? "bg-amber-500/10 border-amber-500/20 text-amber-300/80"
                                                    : "bg-emerald-500/10 border-emerald-500/20 text-emerald-300/80"
                                            )}>
                                                {auto.info.name}
                                            </span>
                                            <span className={cn(
                                                "inline-flex items-center gap-1 text-[8.5px] font-medium",
                                                isBound ? "text-emerald-400/85" : "text-white/30"
                                            )}>
                                                {isBound ? <CheckCircle2 className="w-2.5 h-2.5" /> : <AlertCircle className="w-2.5 h-2.5" />}
                                                {isBound ? "Driver active" : "Not bound"}
                                            </span>
                                        </div>
                                    </div>
                                    {/* Capability chips */}
                                    {auto.info.id !== "generic-midi" && (
                                        <div className="flex flex-wrap gap-1 mt-1.5">
                                            {Object.entries(auto.info.capabilities).filter(([, v]) => v).map(([k]) => (
                                                <span key={k} className="text-[8.5px] px-1.5 py-px rounded bg-white/[0.04] text-white/40 border border-white/[0.04]">{k}</span>
                                            ))}
                                        </div>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}

                {/* Inputs without an output port — common cause of "no LED feedback" */}
                {inputsWithoutOutput.length > 0 && (
                    <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber-300/70 bg-amber-500/[0.05] border border-amber-500/15 rounded px-2 py-1.5">
                        <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
                        <div>
                            <div className="font-medium">{inputsWithoutOutput.length} device(s) have no MIDI output port</div>
                            <div className="text-amber-300/50 leading-snug">
                                {inputsWithoutOutput.map(d => d.name).join(", ")}.
                                The browser can read input from these but cannot light their LEDs. On Windows, ensure no other app (Rekordbox, Serato) is holding the device, then unplug and re-plug.
                            </div>
                        </div>
                    </div>
                )}

                {/* Bind diagnostic result */}
                {diag && (
                    <div className="mt-2 rounded border border-emerald-500/20 bg-emerald-500/[0.04] p-2 space-y-1.5">
                        <div className="flex items-center gap-1.5 text-[10px] text-emerald-300/85 font-medium">
                            <Stethoscope className="w-3 h-3" />
                            Bind Diagnostic — {new Date(diag.timestamp).toLocaleTimeString()}
                            <button
                                type="button"
                                onClick={() => setDiag(null)}
                                className="ml-auto text-[9px] text-white/30 hover:text-white/70 cursor-pointer"
                            >
                                close
                            </button>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9.5px] text-white/60">
                            <div>Engine ready: <span className={diag.engineReady ? "text-emerald-400" : "text-red-400"}>{String(diag.engineReady)}</span></div>
                            <div>Engine devices: <span className="text-white/85">{diag.midiDeviceCount}</span></div>
                            <div>Drivers ref size: <span className="text-white/85">{diag.driversRefSize}</span></div>
                            <div>Registry size: <span className="text-white/85">{diag.registrySize}</span></div>
                            <div>Snapshot version: <span className="text-white/85">v{diag.snapshotVersion}</span></div>
                            <div>Bridge mounted: <span className={diag.bridgeMounted ? "text-emerald-400" : "text-red-400"}>{String(diag.bridgeMounted)}</span></div>
                            <div>Bridge renders: <span className="text-white/85">{diag.bridgeRenderCount}</span></div>
                            <div>Last render: <span className="text-white/85">{diag.bridgeLastRenderAgoMs < 0 ? "never" : `${diag.bridgeLastRenderAgoMs}ms ago`}</span></div>
                            <div>Last engine seen: <span className={diag.bridgeLastEngineSeen === "set" ? "text-emerald-400" : "text-red-400"}>{diag.bridgeLastEngineSeen}</span></div>
                        </div>
                        {diag.devices.length === 0 ? (
                            <div className="text-[10px] text-amber-300/70 italic">Engine reports zero devices.</div>
                        ) : (
                            <div className="space-y-1">
                                {diag.devices.map(d => (
                                    <div key={d.id} className="rounded bg-black/30 border border-white/[0.06] p-1.5 text-[9.5px]">
                                        <div className="text-white/85 font-medium">{d.name} <span className="text-white/35">— {d.id}</span></div>
                                        <div className="grid grid-cols-2 gap-x-3 gap-y-px mt-1 text-white/55">
                                            <div>hasOutput: <span className={d.hasOutput ? "text-emerald-400" : "text-red-400"}>{String(d.hasOutput)}</span></div>
                                            <div>outputOnly: <span className={d.outputOnly ? "text-amber-400" : "text-white/70"}>{String(d.outputOnly)}</span></div>
                                            <div>in driversRef: <span className={d.inDriversRef ? "text-emerald-400" : "text-red-400"}>{String(d.inDriversRef)}</span></div>
                                            <div>in registry: <span className={d.inRegistry ? "text-emerald-400" : "text-red-400"}>{String(d.inRegistry)}</span></div>
                                            <div className="col-span-2">detected: <span className="text-white/85">{d.detectedDriver}</span></div>
                                            {d.rawSendOk !== null && (
                                                <div className="col-span-2">
                                                    raw output.send(): <span className={d.rawSendOk ? "text-emerald-400" : "text-red-400"}>{d.rawSendOk ? "OK" : "FAILED"}</span>
                                                    {d.rawSendError && <span className="text-red-400/80"> — {d.rawSendError}</span>}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        {diag.notes.length > 0 && (
                            <div className="text-[9.5px] text-amber-300/70 leading-snug space-y-0.5">
                                {diag.notes.map((n, i) => <div key={i}>{n}</div>)}
                            </div>
                        )}
                    </div>
                )}

                {/* Raw MIDI port list (diagnostic) */}
                <details className="mt-2 group">
                    <summary className="text-[10px] text-white/40 hover:text-white/70 cursor-pointer inline-flex items-center gap-1.5 select-none list-none">
                        <Terminal className="w-3 h-3" />
                        Raw MIDI ports — {inputLines.length} in / {outputLines.length} out
                        <span className="text-white/25 group-open:rotate-90 inline-block transition-transform">›</span>
                    </summary>
                    <div className="mt-1.5 space-y-2">
                        <div>
                            <div className="text-[9px] uppercase tracking-wider text-white/35 mb-1">Inputs ({inputLines.length})</div>
                            {inputLines.length === 0 ? (
                                <div className="text-[10px] text-white/30 italic">No MIDI inputs visible to the browser.</div>
                            ) : (
                                <pre className="text-[9.5px] leading-snug text-white/55 bg-black/40 border border-white/[0.05] rounded px-2 py-1.5 whitespace-pre-wrap break-all overflow-x-auto">
{inputLines.map(l => l.trim()).join("\n")}
                                </pre>
                            )}
                        </div>
                        <div>
                            <div className="text-[9px] uppercase tracking-wider text-white/35 mb-1">Outputs ({outputLines.length})</div>
                            {outputLines.length === 0 ? (
                                <div className="text-[10px] text-amber-300/70 bg-amber-500/[0.05] border border-amber-500/15 rounded px-2 py-1.5 leading-snug">
                                    <div className="font-medium mb-0.5">Chrome sees zero MIDI output ports.</div>
                                    <div className="text-amber-300/55">
                                        Audio devices like &quot;Line (DDJ-FLX4)&quot; you may see in Windows are <em>audio</em> ports, not MIDI. Web MIDI never sees those. To enable LED feedback:
                                        <ul className="list-disc list-inside mt-1 space-y-0.5">
                                            <li>Close Rekordbox / Serato / Pioneer DDJ Settings Utility — they hold the MIDI port exclusively.</li>
                                            <li>Unplug + re-plug the controller, then click Refresh above.</li>
                                            <li>In Chrome: visit <code className="bg-white/10 px-1 rounded">chrome://settings/content/midiDevices</code> and confirm this site is Allowed.</li>
                                            <li>Check Windows Device Manager → Sound, video and game controllers — the FLX4 should appear as a USB-MIDI device.</li>
                                        </ul>
                                    </div>
                                </div>
                            ) : (
                                <pre className="text-[9.5px] leading-snug text-white/55 bg-black/40 border border-white/[0.05] rounded px-2 py-1.5 whitespace-pre-wrap break-all overflow-x-auto">
{outputLines.map(l => l.trim()).join("\n")}
                                </pre>
                            )}
                        </div>
                    </div>
                </details>

                {/* Driver override */}
                <div className="mt-3">
                    <label className="text-[10px] text-white/40 block mb-1">Force driver (advanced)</label>
                    <select
                        value={midi.settings.controllerDriverId ?? ""}
                        onChange={e => midi.updateSettings({ controllerDriverId: e.target.value || null })}
                        className="w-full text-[10px] bg-black/30 border border-white/[0.08] rounded px-2 py-1.5 text-white/70 outline-none cursor-pointer hover:bg-black/40 transition-colors"
                    >
                        <option value="">Auto-detect from device name (recommended)</option>
                        {driverInfos.filter(i => i.id !== "generic-midi").map(info => (
                            <option key={info.id} value={info.id}>{info.name}</option>
                        ))}
                    </select>
                    <p className="text-[9px] text-white/25 mt-1">Override the auto-detected driver — useful if your controller reports an unusual MIDI name.</p>
                </div>

                <button
                    type="button"
                    onClick={identifyAllControllers}
                    disabled={activeControllers.length === 0}
                    title={activeControllers.length === 0 ? "No driver is currently bound to a controller — see status above" : "Flash all LEDs on every connected controller"}
                    className="mt-3 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[10px] font-medium bg-purple-500/15 border border-purple-500/25 text-purple-200 hover:bg-purple-500/25 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    <Sparkles className="w-3 h-3" />
                    Flash all LEDs ({activeControllers.length} active driver{activeControllers.length === 1 ? "" : "s"})
                </button>
            </section>

            {/* ── Color preset ──────────────────────────────────────────── */}
            <section className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-3">
                <div className="flex items-center gap-2 mb-2">
                    <Lightbulb className="w-3.5 h-3.5 text-white/40" />
                    <span className="text-[11px] uppercase tracking-wider text-white/50 font-medium">LED Color Preset</span>
                </div>
                <p className="text-[10px] text-white/35 mb-2.5">
                    These colours are pushed to your controller&apos;s LEDs. Non-RGB controllers (DDJ-FLX4) use the perceived brightness of each colour to drive their single-colour LEDs.
                </p>

                <div className="grid grid-cols-2 gap-1.5">
                    {BUILTIN_COLOR_PRESETS.map(p => {
                        const active = p.id === presetId;
                        return (
                            <button
                                key={p.id}
                                type="button"
                                onClick={() => midi.updateSettings({ colorPresetId: p.id })}
                                className={cn(
                                    "rounded-md border p-2 text-left transition-colors cursor-pointer",
                                    active
                                        ? "bg-white/[0.06] border-white/20 ring-1 ring-white/10"
                                        : "bg-black/30 border-white/[0.06] hover:bg-black/40 hover:border-white/[0.12]"
                                )}
                            >
                                <div className="flex items-center justify-between gap-1.5 mb-1.5">
                                    <span className="text-[10.5px] font-medium text-white/85 truncate">{p.name}</span>
                                    {active && <span className="text-[8.5px] px-1 py-px rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Active</span>}
                                </div>
                                <div className="flex gap-1 mb-1">
                                    {HOT_CUE_ROLES.map(role => (
                                        <span
                                            key={role}
                                            className="flex-1 h-2 rounded-sm"
                                            style={{ backgroundColor: previewColor(p, role) }}
                                        />
                                    ))}
                                </div>
                                <p className="text-[9px] text-white/35 leading-snug line-clamp-2">{p.description}</p>
                            </button>
                        );
                    })}
                </div>
            </section>

            {/* ── Live preview ──────────────────────────────────────────── */}
            <section className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-3">
                <div className="text-[11px] uppercase tracking-wider text-white/50 font-medium mb-2">Color Preview</div>
                <div className="grid grid-cols-4 gap-1.5">
                    {PREVIEW_ROLES.map(({ role, label }) => (
                        <div key={role} className="flex flex-col items-center gap-1 py-1.5 rounded bg-black/30 border border-white/[0.04]">
                            <span
                                className="w-5 h-5 rounded-full shadow-inner"
                                style={{
                                    backgroundColor: previewColor(preset, role),
                                    boxShadow: `0 0 8px ${previewColor(preset, role)}55, inset 0 0 4px rgba(0,0,0,0.4)`,
                                }}
                            />
                            <span className="text-[9px] text-white/45">{label}</span>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
}
