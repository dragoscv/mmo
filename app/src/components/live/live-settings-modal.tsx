"use client";

/**
 * LiveSettingsModal — preferences for the Live Performance page.
 * Modeled on DAWSettingsModal: tabbed dialog with Audio / Display / Performance.
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Settings, Volume2, Monitor, Activity, RotateCcw, Mic } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLiveSettings, resetLiveSettings, type LiveAccent, type CoachVerbosity } from "@/hooks/use-live-settings";
import {
    enumerateAudioOutputs,
    enumerateAudioInputs,
    requestAudioPermission,
} from "@/hooks/use-daw-settings";
import { NOTATION_LABELS, type NoteNotation } from "@/lib/note-notation";

type Tab = "audio" | "display" | "performance";

interface Props {
    open: boolean;
    onClose: () => void;
}

export function LiveSettingsModal({ open, onClose }: Props) {
    const [tab, setTab] = useState<Tab>("audio");
    const [mounted, setMounted] = useState(false);

    useEffect(() => { setMounted(true); }, []);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        // Prevent body scroll while open.
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            window.removeEventListener("keydown", onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [open, onClose]);

    if (!open || !mounted) return null;

    const tabs: { id: Tab; label: string; icon: typeof Settings }[] = [
        { id: "audio", label: "Audio", icon: Volume2 },
        { id: "display", label: "Display", icon: Monitor },
        { id: "performance", label: "Performance", icon: Activity },
    ];

    return createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={onClose}>
            <div className="w-[560px] max-w-full max-h-[85vh] bg-[oklch(0.13_0.01_260)] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                    <div className="flex items-center gap-2">
                        <Settings className="h-4 w-4 text-rose-400/60" />
                        <h2 className="text-sm font-medium text-white/80">Live Settings</h2>
                    </div>
                    <button onClick={onClose}
                        className="w-6 h-6 rounded flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/5 cursor-pointer">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-white/10 px-2">
                    {tabs.map(t => (
                        <button key={t.id} onClick={() => setTab(t.id)}
                            className={cn(
                                "flex items-center gap-1.5 px-3 h-9 text-xs transition-colors cursor-pointer",
                                tab === t.id ? "text-white/85 border-b-2 border-rose-500" : "text-white/35 hover:text-white/60",
                            )}>
                            <t.icon className="h-3 w-3" />
                            {t.label}
                        </button>
                    ))}
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4">
                    {tab === "audio" && <AudioTab />}
                    {tab === "display" && <DisplayTab />}
                    {tab === "performance" && <PerformanceTab />}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/10 bg-black/20">
                    <button onClick={() => resetLiveSettings()}
                        className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] text-white/40 hover:text-white/70 hover:bg-white/5 cursor-pointer">
                        <RotateCcw className="h-3 w-3" /> Reset to defaults
                    </button>
                    <span className="text-[9px] text-white/25">Settings are saved automatically</span>
                </div>
            </div>
        </div>,
        document.body,
    );
}

// ─── Audio Tab ───────────────────────────────────────────────────────────

function AudioTab() {
    const settings = useLiveSettings();
    const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
    const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
    const [permission, setPermission] = useState<"prompt" | "granted" | "denied">("prompt");

    useEffect(() => {
        (async () => {
            try {
                const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
                if (status.state === "granted") {
                    setPermission("granted");
                    setOutputs(await enumerateAudioOutputs());
                    setInputs(await enumerateAudioInputs());
                } else if (status.state === "denied") {
                    setPermission("denied");
                } else {
                    setPermission("prompt");
                    setOutputs(await enumerateAudioOutputs());
                }
            } catch {
                setOutputs(await enumerateAudioOutputs());
            }
        })();
    }, []);

    const handlePermission = useCallback(async () => {
        const r = await requestAudioPermission();
        setPermission(r);
        if (r === "granted") {
            setOutputs(await enumerateAudioOutputs());
            setInputs(await enumerateAudioInputs());
        }
    }, []);

    const handleOutputChange = useCallback(async (deviceId: string) => {
        settings.update({ audioOutputDeviceId: deviceId });
        // Apply via setSinkId to the LiveEngine AudioContext (exposed on window
        // by LiveProvider) and to any HTMLAudioElement (backing track).
        const ctx = (window as unknown as { __mmo_live_ctx?: AudioContext }).__mmo_live_ctx;
        if (ctx && "setSinkId" in ctx) {
            try { await (ctx as AudioContext & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId); } catch { /* unsupported */ }
        }
        for (const audio of document.querySelectorAll("audio")) {
            if ("setSinkId" in audio) {
                try { await (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId); } catch { /* unsupported */ }
            }
        }
    }, [settings]);

    return (
        <div className="space-y-4">
            <Section title="Audio Output">
                <Row label="Output Device" hint="Where the live mix is heard">
                    {permission !== "granted" && outputs.length === 0 ? (
                        <button onClick={handlePermission}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-medium bg-rose-500/20 border border-rose-500/30 text-rose-300 hover:bg-rose-500/30 cursor-pointer">
                            <Volume2 className="w-3 h-3" /> Grant Permission
                        </button>
                    ) : (
                        <select value={settings.audioOutputDeviceId}
                            onChange={e => handleOutputChange(e.target.value)}
                            className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/70 focus:outline-none min-w-[200px]">
                            <option value="default">System Default</option>
                            {outputs.map(d => (
                                <option key={d.deviceId} value={d.deviceId}>
                                    {d.label || `Output ${d.deviceId.slice(0, 8)}`}
                                </option>
                            ))}
                        </select>
                    )}
                </Row>
            </Section>

            <Section title="Voice Input">
                <Row label="Available Microphones" hint="Pick one in the Voice Processor panel">
                    {inputs.length === 0 ? (
                        <span className="text-[10px] text-white/30">{permission === "granted" ? "No inputs detected" : "Permission required"}</span>
                    ) : (
                        <span className="text-[10px] text-white/50">{inputs.length} device{inputs.length === 1 ? "" : "s"} detected</span>
                    )}
                </Row>
                <Row label="Permission" hint="Microphone access status">
                    <div className="flex items-center gap-1.5">
                        <Mic className={cn("h-3 w-3", permission === "granted" ? "text-emerald-400" : permission === "denied" ? "text-red-400" : "text-amber-400")} />
                        <span className="text-[10px] uppercase tracking-wider text-white/60">{permission}</span>
                    </div>
                </Row>
            </Section>
        </div>
    );
}

// ─── Display Tab ─────────────────────────────────────────────────────────

function DisplayTab() {
    const settings = useLiveSettings();
    const accents: { id: LiveAccent; label: string; color: string }[] = [
        { id: "rose", label: "Rose", color: "#f43f5e" },
        { id: "violet", label: "Violet", color: "#a855f7" },
        { id: "emerald", label: "Emerald", color: "#10b981" },
        { id: "cyan", label: "Cyan", color: "#06b6d4" },
        { id: "amber", label: "Amber", color: "#f59e0b" },
    ];

    return (
        <div className="space-y-4">
            <Section title="Note Notation" hint="Choose 1 or 2 formats — applied to Key, Tuner, and Coach">
                <Row label="Primary">
                    <select value={settings.noteNotation1}
                        onChange={e => settings.update({ noteNotation1: e.target.value as NoteNotation })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/70 focus:outline-none min-w-[200px]">
                        {(Object.keys(NOTATION_LABELS) as NoteNotation[]).map(n => (
                            <option key={n} value={n}>{NOTATION_LABELS[n]}</option>
                        ))}
                    </select>
                </Row>
                <Row label="Secondary" hint="Shown alongside the primary, e.g. C / Do">
                    <select value={settings.noteNotation2}
                        onChange={e => settings.update({ noteNotation2: e.target.value as NoteNotation | "none" })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/70 focus:outline-none min-w-[200px]">
                        <option value="none">— None —</option>
                        {(Object.keys(NOTATION_LABELS) as NoteNotation[]).map(n => (
                            <option key={n} value={n}>{NOTATION_LABELS[n]}</option>
                        ))}
                    </select>
                </Row>
            </Section>

            <Section title="Tuner & Coach">
                <Row label="Show cents" hint="Display ±cents alongside the note">
                    <Toggle value={settings.showCents} onChange={v => settings.update({ showCents: v })} />
                </Row>
                <Row label="Coach verbosity" hint="How many tip rows to show at once">
                    <select value={settings.coachVerbosity}
                        onChange={e => settings.update({ coachVerbosity: e.target.value as CoachVerbosity })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/70 focus:outline-none">
                        <option value="minimal">Minimal (1)</option>
                        <option value="normal">Normal (3)</option>
                        <option value="verbose">Verbose (all)</option>
                    </select>
                </Row>
            </Section>

            <Section title="Accent Color">
                <div className="flex items-center gap-2">
                    {accents.map(a => (
                        <button key={a.id} onClick={() => settings.update({ accent: a.id })}
                            title={a.label}
                            className={cn(
                                "w-7 h-7 rounded-full border-2 transition-all cursor-pointer",
                                settings.accent === a.id ? "border-white/80 scale-110" : "border-white/10 hover:border-white/30",
                            )}
                            style={{ backgroundColor: a.color }} />
                    ))}
                </div>
            </Section>
        </div>
    );
}

// ─── Performance Tab ─────────────────────────────────────────────────────

function PerformanceTab() {
    const settings = useLiveSettings();
    return (
        <div className="space-y-4">
            <Section title="Realtime Refresh"
                hint="Lower = calmer, higher = more responsive. Affects Tuner, Coach, and meters.">
                <Row label="Refresh rate">
                    <Slider value={settings.refreshHz} min={1} max={30} step={1}
                        onChange={v => settings.update({ refreshHz: v })}
                        suffix="Hz" />
                </Row>
            </Section>

            <Section title="Smoothing"
                hint="Minimum time a value must remain stable before it can change on screen. Higher values feel calmer but lag slightly behind reality.">
                <Row label="Tuner stickiness">
                    <Slider value={settings.tunerStickinessMs} min={0} max={2000} step={100}
                        onChange={v => settings.update({ tunerStickinessMs: v })}
                        suffix="ms" />
                </Row>
                <Row label="Coach stickiness">
                    <Slider value={settings.coachStickinessMs} min={0} max={5000} step={250}
                        onChange={v => settings.update({ coachStickinessMs: v })}
                        suffix="ms" />
                </Row>
            </Section>
        </div>
    );
}

// ─── UI primitives ───────────────────────────────────────────────────────

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="rounded-lg border border-white/[0.06] bg-black/20 overflow-hidden">
            <div className="px-3 py-2 border-b border-white/[0.04]">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-white/70">{title}</div>
                {hint && <div className="text-[10px] text-white/35 mt-0.5">{hint}</div>}
            </div>
            <div className="p-3 space-y-2">{children}</div>
        </div>
    );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3 py-1">
            <div className="min-w-0">
                <div className="text-[11px] text-white/75">{label}</div>
                {hint && <div className="text-[10px] text-white/30 mt-0.5">{hint}</div>}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
    return (
        <button onClick={() => onChange(!value)}
            className={cn(
                "relative w-9 h-5 rounded-full transition-colors cursor-pointer",
                value ? "bg-rose-500/60" : "bg-white/10",
            )}>
            <span className={cn(
                "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all",
                value ? "left-4" : "left-0.5",
            )} />
        </button>
    );
}

function Slider({ value, min, max, step, onChange, suffix }: {
    value: number; min: number; max: number; step: number; onChange: (v: number) => void; suffix?: string;
}) {
    return (
        <div className="flex items-center gap-2">
            <input type="range" min={min} max={max} step={step} value={value}
                onChange={e => onChange(parseFloat(e.target.value))}
                className="w-32 accent-rose-500 cursor-pointer" />
            <span className="text-[10px] tabular-nums text-white/60 w-14 text-right">{value}{suffix ? ` ${suffix}` : ""}</span>
        </div>
    );
}
