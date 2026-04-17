"use client";

import { useState, useEffect, useCallback } from "react";
import { useDAW } from "./daw-context";
import { cn } from "@/lib/utils";
import { X, Settings, Keyboard, Monitor, Volume2, Palette, Mic } from "lucide-react";
import {
    useDAWSettings,
    enumerateAudioOutputs,
    enumerateAudioInputs,
    requestAudioPermission,
    setAudioContextSinkId,
    type ClipDisplayMode,
    type WaveformStyle,
    type WaveformColorMode,
    type TrackHeight,
    type GridStyle,
    type PlayheadColor,
    type SpectrogramColorMap,
    type EditorWaveformColor,
    PLAYHEAD_COLORS,
    EDITOR_WAVEFORM_COLORS,
} from "@/hooks/use-daw-settings";
import { NOTATION_LABELS, type NoteNotation } from "@/lib/note-notation";

type SettingsTab = "audio" | "display" | "personalize" | "shortcuts";

export function DAWSettingsModal() {
    const daw = useDAW();
    const [tab, setTab] = useState<SettingsTab>("audio");

    if (!daw.showSettingsModal) return null;

    const tabs: { id: SettingsTab; label: string; icon: typeof Settings }[] = [
        { id: "audio", label: "Audio", icon: Volume2 },
        { id: "display", label: "Display", icon: Monitor },
        { id: "personalize", label: "Personalize", icon: Palette },
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
                    {tab === "personalize" && <PersonalizeSettings />}
                    {tab === "shortcuts" && <ShortcutSettings />}
                </div>
            </div>
        </div>
    );
}

function AudioSettings() {
    const settings = useDAWSettings();
    const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
    const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
    const [audioPermission, setAudioPermission] = useState<"prompt" | "granted" | "denied">("prompt");

    // Enumerate audio devices on mount
    useEffect(() => {
        (async () => {
            try {
                const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
                if (status.state === "granted") {
                    setAudioPermission("granted");
                    setAudioDevices(await enumerateAudioOutputs());
                    setInputDevices(await enumerateAudioInputs());
                } else if (status.state === "denied") {
                    setAudioPermission("denied");
                } else {
                    setAudioPermission("prompt");
                    setAudioDevices(await enumerateAudioOutputs());
                }
            } catch {
                setAudioDevices(await enumerateAudioOutputs());
            }
        })();
    }, []);

    const handleRequestPermission = useCallback(async () => {
        const result = await requestAudioPermission();
        setAudioPermission(result);
        if (result === "granted") {
            setAudioDevices(await enumerateAudioOutputs());
            setInputDevices(await enumerateAudioInputs());
        }
    }, []);

    const handleOutputChange = useCallback(async (deviceId: string) => {
        settings.update({ audioOutputDeviceId: deviceId });
        // Apply to DAW AudioContext
        const ctx = (window as unknown as { __mmo_daw_ctx?: AudioContext }).__mmo_daw_ctx;
        if (ctx) await setAudioContextSinkId(ctx, deviceId);
        // Apply to all audio elements
        const audios = document.querySelectorAll("audio");
        for (const audio of audios) {
            if ("setSinkId" in audio) {
                try {
                    await (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId);
                } catch { /* not supported */ }
            }
        }
    }, [settings]);

    return (
        <div className="space-y-4">
            <SettingsSection title="Audio Output">
                <SettingsRow label="Output Device" description="Select audio playback device">
                    {audioPermission !== "granted" ? (
                        <button
                            onClick={handleRequestPermission}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-medium bg-purple-500/20 border border-purple-500/30 text-purple-300 hover:bg-purple-500/30 transition-colors cursor-pointer"
                        >
                            <Volume2 className="w-3 h-3" />
                            Grant Permission
                        </button>
                    ) : (
                        <select
                            value={settings.audioOutputDeviceId}
                            onChange={(e) => handleOutputChange(e.target.value)}
                            className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none min-w-[180px]"
                        >
                            {audioDevices.length === 0 && (
                                <option value="default">Default</option>
                            )}
                            {audioDevices.map(d => (
                                <option key={d.deviceId} value={d.deviceId}>
                                    {d.label || `Output ${d.deviceId.slice(0, 8)}`}
                                </option>
                            ))}
                        </select>
                    )}
                </SettingsRow>
            </SettingsSection>

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
                <SettingsRow label="Input Device" description="Audio input source (microphone / line in)">
                    {audioPermission !== "granted" ? (
                        <button
                            onClick={handleRequestPermission}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-medium bg-purple-500/20 border border-purple-500/30 text-purple-300 hover:bg-purple-500/30 transition-colors cursor-pointer"
                        >
                            <Mic className="w-3 h-3" />
                            Grant Permission
                        </button>
                    ) : (
                        <select
                            value={settings.audioInputDeviceId}
                            onChange={(e) => settings.update({ audioInputDeviceId: e.target.value })}
                            className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none min-w-[180px]"
                        >
                            {inputDevices.length === 0 && (
                                <option value="default">Default Input</option>
                            )}
                            {inputDevices.map(d => (
                                <option key={d.deviceId} value={d.deviceId}>
                                    {d.label || `Input ${d.deviceId.slice(0, 8)}`}
                                </option>
                            ))}
                        </select>
                    )}
                </SettingsRow>
                <SettingsRow label="Monitoring" description="Monitor input while recording">
                    <ToggleSwitch checked={settings.inputMonitorEnabled} onChange={(v) => settings.update({ inputMonitorEnabled: v })} />
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
    const s = useDAWSettings();

    return (
        <div className="space-y-4">
            <SettingsSection title="Note Notation">
                <SettingsRow label="Primary Format" description="Main format for displaying musical keys">
                    <select
                        value={s.noteNotation1}
                        onChange={(e) => {
                            const v = e.target.value as NoteNotation;
                            // If picking the same as secondary, swap them
                            if (v === s.noteNotation2) {
                                s.update({ noteNotation1: v, noteNotation2: s.noteNotation1 });
                            } else {
                                s.update({ noteNotation1: v });
                            }
                        }}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        {(Object.entries(NOTATION_LABELS) as [NoteNotation, string][]).map(([key, label]) => (
                            <option key={key} value={key}>{label}</option>
                        ))}
                    </select>
                </SettingsRow>
                <SettingsRow label="Secondary Format" description="Optional second notation shown alongside">
                    <select
                        value={s.noteNotation2}
                        onChange={(e) => {
                            const v = e.target.value as NoteNotation | "none";
                            // If picking the same as primary, swap them
                            if (v !== "none" && v === s.noteNotation1) {
                                s.update({ noteNotation2: "none" });
                            } else {
                                s.update({ noteNotation2: v });
                            }
                        }}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        <option value="none">None (single notation)</option>
                        {(Object.entries(NOTATION_LABELS) as [NoteNotation, string][])
                            .filter(([key]) => key !== s.noteNotation1)
                            .map(([key, label]) => (
                                <option key={key} value={key}>{label}</option>
                            ))}
                    </select>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Clip Display">
                <SettingsRow label="Content Display" description="What to show inside clips">
                    <select
                        value={s.clipDisplayMode}
                        onChange={(e) => s.update({ clipDisplayMode: e.target.value as ClipDisplayMode })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        <option value="both">Waveform + Notes</option>
                        <option value="waveform">Waveform Only</option>
                        <option value="notes">Notes Only</option>
                        <option value="none">None</option>
                    </select>
                </SettingsRow>
                <SettingsRow label="Waveform Style" description="Waveform rendering style in clips">
                    <select
                        value={s.waveformStyle}
                        onChange={(e) => s.update({ waveformStyle: e.target.value as WaveformStyle })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        <option value="classic">Classic</option>
                        <option value="bars">Bars</option>
                        <option value="lines">Lines</option>
                        <option value="filled">Filled</option>
                    </select>
                </SettingsRow>
                <SettingsRow label="Waveform Color" description="How clip waveforms are colored">
                    <select
                        value={s.waveformColorMode}
                        onChange={(e) => s.update({ waveformColorMode: e.target.value as WaveformColorMode })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        <option value="clip">Clip Color</option>
                        <option value="mono">Monochrome</option>
                        <option value="gradient">Gradient</option>
                    </select>
                </SettingsRow>
                <SettingsRow label="Show Clip Names" description="Display clip name in header bar">
                    <ToggleSwitch checked={s.showClipNames} onChange={(v) => s.update({ showClipNames: v })} />
                </SettingsRow>
                <SettingsRow label="Show Info Badges" description="MIDI/duration badges on clips">
                    <ToggleSwitch checked={s.showClipInfoBadges} onChange={(v) => s.update({ showClipInfoBadges: v })} />
                </SettingsRow>
                <SettingsRow label="Clip Opacity" description="Opacity of clip content area">
                    <div className="flex items-center gap-2">
                        <input
                            type="range"
                            min={0.3}
                            max={1}
                            step={0.05}
                            value={s.clipOpacity}
                            onChange={(e) => s.update({ clipOpacity: parseFloat(e.target.value) })}
                            className="w-20 h-1 accent-purple-500"
                        />
                        <span className="text-[9px] text-white/30 w-6 text-right">{Math.round(s.clipOpacity * 100)}%</span>
                    </div>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Timeline">
                <SettingsRow label="Track Height" description="Default height of timeline tracks">
                    <select
                        value={s.trackHeight}
                        onChange={(e) => s.update({ trackHeight: e.target.value as TrackHeight })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        <option value="compact">Compact (48px)</option>
                        <option value="normal">Normal (60px)</option>
                        <option value="large">Large (80px)</option>
                    </select>
                </SettingsRow>
                <SettingsRow label="Grid Style" description="Grid visualization in timeline">
                    <select
                        value={s.gridStyle}
                        onChange={(e) => s.update({ gridStyle: e.target.value as GridStyle })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        <option value="lines">Lines</option>
                        <option value="dots">Dots</option>
                        <option value="none">None</option>
                    </select>
                </SettingsRow>
                <SettingsRow label="Grid Opacity" description="Visibility of grid lines">
                    <div className="flex items-center gap-2">
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={s.gridOpacity}
                            onChange={(e) => s.update({ gridOpacity: parseFloat(e.target.value) })}
                            className="w-20 h-1 accent-purple-500"
                        />
                        <span className="text-[9px] text-white/30 w-6 text-right">{Math.round(s.gridOpacity * 100)}%</span>
                    </div>
                </SettingsRow>
                <SettingsRow label="Show Automation" description="Display automation curves on tracks">
                    <ToggleSwitch checked={s.showAutomation} onChange={(v) => s.update({ showAutomation: v })} />
                </SettingsRow>
                <SettingsRow label="Snap to Grid" description="Snap clip operations to grid positions">
                    <ToggleSwitch checked={s.snapToGrid} onChange={(v) => s.update({ snapToGrid: v })} />
                </SettingsRow>
                <SettingsRow label="Active Highlighting" description="Glow effect on currently playing clips">
                    <ToggleSwitch checked={s.activeClipHighlight} onChange={(v) => s.update({ activeClipHighlight: v })} />
                </SettingsRow>
                <SettingsRow label="Playhead Color" description="Color of the playback position indicator">
                    <div className="flex items-center gap-1.5">
                        {(Object.keys(PLAYHEAD_COLORS) as PlayheadColor[]).map(c => (
                            <button
                                key={c}
                                onClick={() => s.update({ playheadColor: c })}
                                className={cn(
                                    "w-5 h-5 rounded-full border-2 transition-all",
                                    s.playheadColor === c ? "border-white/60 scale-110" : "border-white/10 hover:border-white/30"
                                )}
                                style={{ background: PLAYHEAD_COLORS[c] }}
                                title={c}
                            />
                        ))}
                    </div>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Mixer">
                <SettingsRow label="Peak Hold" description="Hold peak indicators duration">
                    <select
                        value={s.peakHoldDuration}
                        onChange={(e) => s.update({ peakHoldDuration: parseInt(e.target.value), showMixerPeakHold: parseInt(e.target.value) > 0 })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        <option value="0">Disabled</option>
                        <option value="1000">1 second</option>
                        <option value="2000">2 seconds</option>
                        <option value="5000">5 seconds</option>
                    </select>
                </SettingsRow>
                <SettingsRow label="Meter Type" description="Level meter display mode">
                    <select
                        value={s.meterType}
                        onChange={(e) => s.update({ meterType: e.target.value as "peak" | "rms" | "peak+rms" })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        <option value="peak">Peak</option>
                        <option value="rms">RMS</option>
                        <option value="peak+rms">Peak + RMS</option>
                    </select>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Performance">
                <SettingsRow label="UI Refresh Rate" description="Visual update frequency">
                    <select
                        value={s.uiRefreshRate}
                        onChange={(e) => s.update({ uiRefreshRate: parseInt(e.target.value) })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        <option value="30">30 fps</option>
                        <option value="60">60 fps</option>
                    </select>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Status Bar Stats">
                <p className="text-[9px] text-white/25 -mt-1 mb-2">Choose which performance metrics to display in the bottom status bar</p>
                {([
                    { key: "showFps" as const, label: "FPS", desc: "Frame rate counter" },
                    { key: "showHeapMemory" as const, label: "Heap Memory", desc: "JS heap used (MB)" },
                    { key: "showJsHeapTotal" as const, label: "JS Heap Total", desc: "Total JS heap allocated" },
                    { key: "showDomNodes" as const, label: "DOM Nodes", desc: "Number of DOM elements" },
                    { key: "showAudioLatency" as const, label: "Audio Latency", desc: "Audio context latency (ms)" },
                    { key: "showCpuCores" as const, label: "CPU Cores", desc: "Hardware concurrency" },
                    { key: "showDeviceMemory" as const, label: "Device Memory", desc: "Approximate device RAM" },
                ] as const).map(item => (
                    <SettingsRow key={item.key} label={item.label} description={item.desc}>
                        <ToggleSwitch
                            checked={s.dawStatusBarStats[item.key]}
                            onChange={(v) => s.update({ dawStatusBarStats: { ...s.dawStatusBarStats, [item.key]: v } })}
                        />
                    </SettingsRow>
                ))}
            </SettingsSection>
        </div>
    );
}

function PersonalizeSettings() {
    const s = useDAWSettings();

    return (
        <div className="space-y-4">
            <SettingsSection title="Sound Editor — Waveform">
                <SettingsRow label="Waveform Color" description="Color of the waveform in the editor">
                    <div className="flex items-center gap-1.5">
                        {(Object.keys(EDITOR_WAVEFORM_COLORS) as EditorWaveformColor[]).map(c => (
                            <button
                                key={c}
                                onClick={() => s.update({ editorWaveformColor: c })}
                                className={cn(
                                    "w-5 h-5 rounded-full border-2 transition-all",
                                    s.editorWaveformColor === c ? "border-white/60 scale-110" : "border-white/10 hover:border-white/30"
                                )}
                                style={{ background: EDITOR_WAVEFORM_COLORS[c] }}
                                title={c}
                            />
                        ))}
                    </div>
                </SettingsRow>
                <SettingsRow label="Show RMS Overlay" description="Display RMS energy alongside peaks">
                    <ToggleSwitch checked={s.editorShowRms} onChange={(v) => s.update({ editorShowRms: v })} />
                </SettingsRow>
                <SettingsRow label="Show Grid Lines" description="Time grid lines in editor view">
                    <ToggleSwitch checked={s.editorShowGridLines} onChange={(v) => s.update({ editorShowGridLines: v })} />
                </SettingsRow>
                <SettingsRow label="Show Minimap" description="Overview minimap below waveform">
                    <ToggleSwitch checked={s.editorShowMinimap} onChange={(v) => s.update({ editorShowMinimap: v })} />
                </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Sound Editor — Spectrogram">
                <SettingsRow label="Color Map" description="Spectrogram color scheme">
                    <select
                        value={s.spectrogramColorMap}
                        onChange={(e) => s.update({ spectrogramColorMap: e.target.value as SpectrogramColorMap })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        <option value="magma">Magma</option>
                        <option value="viridis">Viridis</option>
                        <option value="inferno">Inferno</option>
                        <option value="plasma">Plasma</option>
                        <option value="grayscale">Grayscale</option>
                    </select>
                </SettingsRow>
                <SettingsRow label="FFT Size" description="Frequency resolution (higher = more detail, slower)">
                    <select
                        value={s.spectrogramFftSize}
                        onChange={(e) => s.update({ spectrogramFftSize: parseInt(e.target.value) })}
                        className="h-7 bg-black/30 border border-white/10 rounded text-xs px-2 text-white/60 focus:outline-none"
                    >
                        <option value="512">512 (fast)</option>
                        <option value="1024">1024</option>
                        <option value="2048">2048 (balanced)</option>
                        <option value="4096">4096 (detailed)</option>
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

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <button
            onClick={() => onChange(!checked)}
            className={cn(
                "w-8 h-4 rounded-full transition-colors relative",
                checked ? "bg-purple-500" : "bg-white/10"
            )}
        >
            <div
                className={cn(
                    "w-3 h-3 bg-white rounded-full absolute top-0.5 transition-transform",
                    checked ? "translate-x-4" : "translate-x-0.5"
                )}
            />
        </button>
    );
}
