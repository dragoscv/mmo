"use client";

import { useState } from "react";
import { useDAW } from "./daw-context";
import { cn } from "@/lib/utils";
import { X, Settings, Keyboard, Monitor, Volume2 } from "lucide-react";

type SettingsTab = "audio" | "display" | "shortcuts";

export function DAWSettingsModal() {
    const daw = useDAW();
    const [tab, setTab] = useState<SettingsTab>("audio");

    if (!daw.showSettingsModal) return null;

    const tabs: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
        { id: "audio", label: "Audio", icon: Volume2 },
        { id: "display", label: "Display", icon: Monitor },
        { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
    ];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-[560px] max-h-[80vh] bg-[var(--daw-bg)] border border-[var(--daw-border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                    <div className="flex items-center gap-2">
                        <Settings className="h-4 w-4 text-white/30" />
                        <h2 className="text-sm font-medium text-white/80">DAW Settings</h2>
                    </div>
                    <button
                        onClick={() => daw.setSettingsModal(false)}
                        className="w-6 h-6 rounded flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/5"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Tab bar */}
                <div className="flex border-b border-white/10 px-2">
                    {tabs.map(t => (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id)}
                            className={cn(
                                "flex items-center gap-1.5 px-3 h-9 text-xs transition-colors",
                                tab === t.id ? "text-white/80 border-b-2 border-purple-500" : "text-white/30"
                            )}
                        >
                            <t.icon className="h-3 w-3" />
                            {t.label}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4">
                    {tab === "audio" && <AudioSettings />}
                    {tab === "display" && <DisplaySettings />}
                    {tab === "shortcuts" && <ShortcutSettings />}
                </div>
            </div>
        </div>
    );
}

function AudioSettings() {
    return (
        <div className="space-y-4">
            <SettingsSection title="Audio Engine">
                <SettingsRow label="Sample Rate" description="Audio processing sample rate">
                    <select className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none">
                        <option value="44100">44,100 Hz</option>
                        <option value="48000">48,000 Hz</option>
                        <option value="96000">96,000 Hz</option>
                    </select>
                </SettingsRow>
                <SettingsRow label="Buffer Size" description="Lower = less latency, higher CPU">
                    <select className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none">
                        <option value="128">128 samples</option>
                        <option value="256">256 samples</option>
                        <option value="512">512 samples</option>
                        <option value="1024">1024 samples</option>
                    </select>
                </SettingsRow>
                <SettingsRow label="Latency Hint" description="Audio context latency mode">
                    <select className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none">
                        <option value="interactive">Interactive (low latency)</option>
                        <option value="balanced">Balanced</option>
                        <option value="playback">Playback (high quality)</option>
                    </select>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Recording">
                <SettingsRow label="Input Device" description="Audio input source">
                    <select className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none min-w-[160px]">
                        <option>Default Input</option>
                    </select>
                </SettingsRow>
                <SettingsRow label="Monitoring" description="Monitor input while recording">
                    <ToggleSwitch />
                </SettingsRow>
                <SettingsRow label="Count-in" description="Metronome count-in before recording">
                    <select className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none">
                        <option value="0">None</option>
                        <option value="1">1 bar</option>
                        <option value="2">2 bars</option>
                    </select>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Metronome">
                <SettingsRow label="Volume" description="Metronome click volume">
                    <input type="range" min={0} max={1} step={0.01} defaultValue={0.5} className="w-24 h-1 accent-purple-500" />
                </SettingsRow>
                <SettingsRow label="Sound" description="Click sound type">
                    <select className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none">
                        <option>Classic Click</option>
                        <option>Wood Block</option>
                        <option>Beep</option>
                    </select>
                </SettingsRow>
            </SettingsSection>
        </div>
    );
}

function DisplaySettings() {
    return (
        <div className="space-y-4">
            <SettingsSection title="Timeline">
                <SettingsRow label="Default Zoom" description="Initial zoom level for new projects">
                    <input type="range" min={10} max={200} step={5} defaultValue={40} className="w-24 h-1 accent-purple-500" />
                </SettingsRow>
                <SettingsRow label="Show Waveforms" description="Display waveform previews in clips">
                    <ToggleSwitch defaultChecked />
                </SettingsRow>
                <SettingsRow label="Grid Type" description="Grid visualization style">
                    <select className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none">
                        <option>Lines</option>
                        <option>Dots</option>
                        <option>None</option>
                    </select>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Mixer">
                <SettingsRow label="Peak Hold" description="Hold peak indicators duration">
                    <select className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none">
                        <option value="1000">1 second</option>
                        <option value="2000">2 seconds</option>
                        <option value="5000">5 seconds</option>
                        <option value="0">Infinite</option>
                    </select>
                </SettingsRow>
                <SettingsRow label="Meter Type" description="Level meter display">
                    <select className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none">
                        <option>Peak</option>
                        <option>RMS</option>
                        <option>Peak + RMS</option>
                    </select>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Performance">
                <SettingsRow label="UI Refresh Rate" description="Visual update frequency">
                    <select className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none">
                        <option value="30">30 fps</option>
                        <option value="60">60 fps</option>
                    </select>
                </SettingsRow>
            </SettingsSection>
        </div>
    );
}

function ShortcutSettings() {
    const shortcuts = [
        {
            category: "Transport", items: [
                { key: "Space", action: "Play / Pause" },
                { key: "Enter", action: "Stop" },
                { key: "R", action: "Record" },
                { key: "K", action: "Toggle Metronome" },
                { key: "L", action: "Toggle Loop" },
            ]
        },
        {
            category: "Tools", items: [
                { key: "V", action: "Select Tool" },
                { key: "D", action: "Draw Tool" },
                { key: "E", action: "Erase Tool" },
                { key: "C", action: "Cut Tool" },
                { key: "M", action: "Mute Tool" },
                { key: "A", action: "Automation Tool" },
            ]
        },
        {
            category: "Editing", items: [
                { key: "Ctrl+Z", action: "Undo" },
                { key: "Ctrl+Y", action: "Redo" },
                { key: "Ctrl+S", action: "Save Project" },
                { key: "Delete", action: "Delete Selected Clip" },
                { key: "Ctrl+D", action: "Duplicate" },
            ]
        },
        {
            category: "Navigation", items: [
                { key: "Ctrl++", action: "Zoom In" },
                { key: "Ctrl+-", action: "Zoom Out" },
                { key: "F1", action: "Toggle Browser" },
                { key: "F2", action: "Toggle Mixer" },
                { key: "F3", action: "Toggle Piano Roll" },
                { key: "F4", action: "Toggle Step Sequencer" },
                { key: "F5", action: "Toggle Effects" },
                { key: "F6", action: "Toggle Synth" },
                { key: "F7", action: "Toggle Automation" },
            ]
        },
        {
            category: "Tracks", items: [
                { key: "Ctrl+Shift+T", action: "Add Audio Track" },
                { key: "Ctrl+Shift+I", action: "Add MIDI Track" },
            ]
        },
    ];

    return (
        <div className="space-y-4">
            {shortcuts.map(cat => (
                <SettingsSection key={cat.category} title={cat.category}>
                    {cat.items.map(item => (
                        <div key={item.key} className="flex items-center justify-between py-1">
                            <span className="text-[11px] text-white/50">{item.action}</span>
                            <kbd className="px-2 py-0.5 bg-black/30 border border-white/10 rounded text-[10px] text-white/40 font-mono">
                                {item.key}
                            </kbd>
                        </div>
                    ))}
                </SettingsSection>
            ))}
        </div>
    );
}

// ─── Shared UI ───────────────────────────────────────────────────────────

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div>
            <h3 className="text-[10px] text-white/30 uppercase tracking-wider mb-2">{title}</h3>
            <div className="space-y-2 pl-1">{children}</div>
        </div>
    );
}

function SettingsRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between py-1">
            <div>
                <p className="text-[11px] text-white/60">{label}</p>
                <p className="text-[9px] text-white/20">{description}</p>
            </div>
            {children}
        </div>
    );
}

function ToggleSwitch({ defaultChecked }: { defaultChecked?: boolean }) {
    const [on, setOn] = useState(defaultChecked ?? false);
    return (
        <button
            onClick={() => setOn(!on)}
            className={cn(
                "w-8 h-4 rounded-full transition-colors relative",
                on ? "bg-purple-500" : "bg-white/10"
            )}
        >
            <div
                className={cn(
                    "w-3 h-3 bg-white rounded-full absolute top-0.5 transition-transform",
                    on ? "translate-x-4" : "translate-x-0.5"
                )}
            />
        </button>
    );
}
