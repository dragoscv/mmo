"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
    MidiEngine,
    BUILTIN_PRESETS,
    importPreset,
    exportPreset,
    type MidiPreset,
    type MidiDevice,
    type MidiMapping,
    type MidiMessage,
    type MidiAction,
    type MidiActionHandler,
} from "@/lib/midi-engine";
import {
    loadBeatGridEnabled,
    saveBeatGridEnabled,
} from "./mixer-waveforms";
import { useMixer } from "./mixer-context";
import type { CrossfaderCurve, EQMode, WaveformMode, DeckSide } from "@/lib/mixer-engine";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    Settings2,
    Usb,
    Music2,
    Keyboard,
    Upload,
    Download,
    RefreshCw,
    Zap,
    ZapOff,
    CircleDot,
    CheckCircle,
    XCircle,
    AlertCircle,
    Volume2,
    Plus,
    Copy,
    Trash2,
    MoreHorizontal,
    Pencil,
    ArrowLeft,
    Save,
    Search,
    X,
    Radio,
    Lock,
    Palette,
    Type,
    Eye,
    EyeOff,
    RotateCcw,
    Gauge,
    Layers,
    Sparkles,
    Monitor,
    Disc,
    AlertTriangle,
    Clock,
} from "lucide-react";
import {
    usePersonalization,
    ACCENT_COLORS,
    DENSITY_VALUES,
    DEFAULT_PERSONALIZATION,
    type MixerBackground,
    type AccentColor,
    type UIDensity,
    type KnobStyle,
    type JogwheelStyle,
} from "@/hooks/use-personalization";
import { JOG_STYLES, JOG_RENDERERS, type JogDesignProps } from "./jogwheel-designs";

// ─── Types ───────────────────────────────────────────────────────────────

interface MixerSettingsModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onMidiHandler?: MidiActionHandler;
}

// Storage key for MIDI settings
const MIDI_SETTINGS_KEY = "mmo-midi-settings";

interface MidiSettings {
    enabled: boolean;
    activePreset: string | null;
    customPresets: MidiPreset[];
    jogSensitivity: number; // 0.5 - 2.0
    tempoRange: number; // ±6, ±10, ±16, ±25
    crossfaderCurve: "linear" | "smooth" | "sharp";
}

const DEFAULT_SETTINGS: MidiSettings = {
    enabled: false,
    activePreset: null,
    customPresets: [],
    jogSensitivity: 1.0,
    tempoRange: 10,
    crossfaderCurve: "smooth",
};

function loadSettings(): MidiSettings {
    try {
        const raw = localStorage.getItem(MIDI_SETTINGS_KEY);
        if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings: MidiSettings) {
    try { localStorage.setItem(MIDI_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

// ─── Mapping Categories ──────────────────────────────────────────────────

const MAPPING_CATEGORIES: { label: string; actions: MidiAction[] }[] = [
    { label: "Transport", actions: ["play", "cue", "pause", "sync"] },
    { label: "Tempo", actions: ["tempo-slider", "tempo-range"] },
    { label: "Jog Wheel", actions: ["jog-touch", "jog-vinyl", "jog-bend", "jog-search"] },
    { label: "EQ & Gain", actions: ["eq-hi", "eq-mid", "eq-low", "trim"] },
    { label: "Mixer", actions: ["volume-fader", "crossfader", "filter", "headphone-cue"] },
    { label: "Loop", actions: ["loop-in", "loop-out", "reloop", "loop-halve", "loop-double"] },
    { label: "Beat Loop", actions: ["beatloop-0.25", "beatloop-0.5", "beatloop-1", "beatloop-2", "beatloop-4", "beatloop-8", "beatloop-16", "beatloop-32"] },
    { label: "Hot Cues", actions: ["hotcue-1", "hotcue-2", "hotcue-3", "hotcue-4", "hotcue-5", "hotcue-6", "hotcue-7", "hotcue-8", "hotcue-1-clear", "hotcue-2-clear", "hotcue-3-clear", "hotcue-4-clear"] },
    { label: "Beat Jump", actions: ["beatjump-back-1", "beatjump-fwd-1", "beatjump-back-4", "beatjump-fwd-4"] },
    { label: "Pad Modes", actions: ["pad-mode-hotcue", "pad-mode-beatloop", "pad-mode-beatjump", "pad-mode-sampler"] },
    { label: "FX", actions: ["fx-select", "fx-on-off", "fx-level"] },
    { label: "Master", actions: ["master-volume", "master-cue"] },
    { label: "Browser", actions: ["browse-turn", "browse-press", "back", "load-deck"] },
    { label: "Headphone", actions: ["headphone-mix", "headphone-level"] },
    { label: "Sampler", actions: ["sampler-1", "sampler-2", "sampler-3", "sampler-4", "sampler-5", "sampler-6", "sampler-7", "sampler-8"] },
    { label: "Other", actions: ["shift", "midi-clock-start", "midi-clock-stop"] },
];

const ALL_ACTIONS: MidiAction[] = MAPPING_CATEGORIES.flatMap(c => c.actions);

function getCategoryForAction(action: string): string {
    return MAPPING_CATEGORIES.find(c => c.actions.includes(action as MidiAction))?.label || "Other";
}

// ─── Component ───────────────────────────────────────────────────────────

export function MixerSettingsModal({ open, onOpenChange, onMidiHandler }: MixerSettingsModalProps) {
    const mixer = useMixer();
    const personalization = usePersonalization();
    const [settings, setSettings] = useState<MidiSettings>(loadSettings);
    const [beatGrid, setBeatGrid] = useState(loadBeatGridEnabled);
    const [devices, setDevices] = useState<MidiDevice[]>([]);
    const [midiStatus, setMidiStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
    const [lastMessage, setLastMessage] = useState<MidiMessage | null>(null);
    const [learnTarget, setLearnTarget] = useState<string | null>(null);
    const engineRef = useRef<MidiEngine | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
    const [audioPermission, setAudioPermission] = useState<"prompt" | "granted" | "denied">("prompt");
    const [selectedAudioDevice, setSelectedAudioDevice] = useState<string>(() => {
        try { return localStorage.getItem("mmo-audio-output") || "default"; } catch { return "default"; }
    });

    // Mapping editor state
    const [mappingView, setMappingView] = useState<"list" | "editor">("list");
    const [editingPreset, setEditingPreset] = useState<MidiPreset | null>(null);
    const [editingIsNew, setEditingIsNew] = useState(false);
    const [editingOriginalName, setEditingOriginalName] = useState<string | null>(null);
    const [mappingSearch, setMappingSearch] = useState("");
    const [mappingCategory, setMappingCategory] = useState<string>("all");
    const [learnRowIndex, setLearnRowIndex] = useState<number | null>(null);

    // Request audio permission and enumerate devices
    const requestAudioPermission = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // Stop all tracks immediately — we only needed the permission grant
            stream.getTracks().forEach(t => t.stop());
            setAudioPermission("granted");

            // Now enumerate devices with full labels
            const devs = await navigator.mediaDevices.enumerateDevices();
            setAudioDevices(devs.filter(d => d.kind === "audiooutput"));
        } catch {
            setAudioPermission("denied");
        }
    }, []);

    // Initialize MIDI engine
    useEffect(() => {
        if (!open) return;

        // Wire saved settings to mixer engine on open
        mixer.setCrossfaderCurve(settings.crossfaderCurve as CrossfaderCurve);
        mixer.setTempoRange(settings.tempoRange);
        mixer.setJogSensitivity(settings.jogSensitivity);

        // Check audio permission status and enumerate devices
        (async () => {
            try {
                // Check if permission is already granted
                const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
                if (status.state === "granted") {
                    setAudioPermission("granted");
                    const devs = await navigator.mediaDevices.enumerateDevices();
                    setAudioDevices(devs.filter(d => d.kind === "audiooutput"));
                } else if (status.state === "denied") {
                    setAudioPermission("denied");
                } else {
                    setAudioPermission("prompt");
                    // Still enumerate — will get devices without labels
                    const devs = await navigator.mediaDevices.enumerateDevices();
                    setAudioDevices(devs.filter(d => d.kind === "audiooutput"));
                }
            } catch {
                // Fallback: just try enumerating
                const devs = await navigator.mediaDevices?.enumerateDevices();
                setAudioDevices(devs?.filter(d => d.kind === "audiooutput") || []);
            }
        })();

        if (engineRef.current) return;

        const engine = new MidiEngine();
        engineRef.current = engine;

        engine.onDeviceChange = (devs) => setDevices(devs);
        engine.onMessage = (msg) => setLastMessage(msg);

        setMidiStatus("connecting");
        engine.init().then((success) => {
            setMidiStatus(success ? "connected" : "error");
            if (success) {
                setDevices(engine.getDevices());

                // Auto-detect and load preset
                const detected = engine.autoDetectPreset(BUILTIN_PRESETS);
                if (detected && !settings.activePreset) {
                    engine.setMapping(detected);
                    updateSettings({ activePreset: detected.name, enabled: true });
                } else if (settings.activePreset) {
                    const preset = getAllPresets(settings).find(p => p.name === settings.activePreset);
                    if (preset) engine.setMapping(preset);
                }

                if (onMidiHandler) engine.setHandler(onMidiHandler);
            }
        });

        return () => {
            engine.destroy();
            engineRef.current = null;
        };
    }, [open]);

    // Update handler when it changes
    useEffect(() => {
        if (engineRef.current && onMidiHandler) {
            engineRef.current.setHandler(onMidiHandler);
        }
    }, [onMidiHandler]);

    // MIDI Learn: capture next MIDI input when learnTarget is set
    useEffect(() => {
        if (!learnTarget || !lastMessage) return;
        const engine = engineRef.current;
        if (!engine) return;

        // Determine if it's a button or knob based on MIDI status
        const isNote = (lastMessage.status & 0xF0) === 0x90;
        const type: MidiMapping["type"] = isNote ? "note" : "cc";

        engine.addLearnedMapping({
            action: learnTarget as MidiAction,
            status: lastMessage.status,
            midino: lastMessage.note,
            deck: null,
            type,
            description: `Learned: ${learnTarget}`,
        });

        setLearnTarget(null);
    }, [learnTarget, lastMessage]);

    const updateSettings = useCallback((patch: Partial<MidiSettings>) => {
        setSettings(prev => {
            const next = { ...prev, ...patch };
            saveSettings(next);
            // Wire settings to mixer engine
            if (patch.crossfaderCurve) mixer.setCrossfaderCurve(patch.crossfaderCurve as CrossfaderCurve);
            if (patch.tempoRange != null) mixer.setTempoRange(patch.tempoRange);
            if (patch.jogSensitivity != null) mixer.setJogSensitivity(patch.jogSensitivity);
            return next;
        });
    }, [mixer]);

    const getAllPresets = useCallback((s: MidiSettings) => {
        return [...BUILTIN_PRESETS, ...s.customPresets];
    }, []);

    const selectPreset = useCallback((name: string) => {
        const preset = getAllPresets(settings).find(p => p.name === name);
        if (preset && engineRef.current) {
            engineRef.current.setMapping(preset);
            updateSettings({ activePreset: name });
        }
    }, [settings, getAllPresets, updateSettings]);

    const handleImportPreset = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const preset = importPreset(reader.result as string);
            if (preset) {
                updateSettings({
                    customPresets: [...settings.customPresets, preset],
                });
            }
        };
        reader.readAsText(file);
        e.target.value = "";
    }, [settings.customPresets, updateSettings]);

    const handleExportPreset = useCallback((presetName?: string) => {
        const name = presetName || settings.activePreset;
        const preset = getAllPresets(settings).find(p => p.name === name);
        if (!preset) return;
        const json = exportPreset(preset);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${preset.name.replace(/\s+/g, "-").toLowerCase()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [settings, getAllPresets]);

    const refreshDevices = useCallback(() => {
        if (engineRef.current) {
            setMidiStatus("connecting");
            engineRef.current.init().then((ok) => {
                setMidiStatus(ok ? "connected" : "error");
                setDevices(engineRef.current?.getDevices() || []);
            });
        }
    }, []);

    // ── Mapping CRUD ──

    const isBuiltinPreset = useCallback((name: string) => {
        return BUILTIN_PRESETS.some(p => p.name === name);
    }, []);

    const createNewPreset = useCallback(() => {
        const preset: MidiPreset = {
            name: "New Mapping",
            author: "Custom",
            description: "",
            deviceNameMatch: "",
            mappings: [],
        };
        // Ensure unique name
        const existing = getAllPresets(settings).map(p => p.name);
        let idx = 1;
        while (existing.includes(preset.name)) {
            preset.name = `New Mapping ${idx++}`;
        }
        setEditingPreset(preset);
        setEditingIsNew(true);
        setEditingOriginalName(null);
        setMappingView("editor");
        setMappingSearch("");
        setMappingCategory("all");
    }, [settings, getAllPresets]);

    const duplicatePreset = useCallback((name: string) => {
        const source = getAllPresets(settings).find(p => p.name === name);
        if (!source) return;
        const copy: MidiPreset = {
            ...structuredClone(source),
            name: `${source.name} (Copy)`,
            author: source.author || "Custom",
        };
        // Ensure unique name
        const existing = getAllPresets(settings).map(p => p.name);
        let idx = 2;
        while (existing.includes(copy.name)) {
            copy.name = `${source.name} (Copy ${idx++})`;
        }
        setEditingPreset(copy);
        setEditingIsNew(true);
        setEditingOriginalName(null);
        setMappingView("editor");
        setMappingSearch("");
        setMappingCategory("all");
    }, [settings, getAllPresets]);

    const startEditPreset = useCallback((name: string) => {
        const preset = getAllPresets(settings).find(p => p.name === name);
        if (!preset) return;
        setEditingPreset(structuredClone(preset));
        setEditingIsNew(false);
        setEditingOriginalName(name);
        setMappingView("editor");
        setMappingSearch("");
        setMappingCategory("all");
    }, [settings, getAllPresets]);

    const saveEditingPreset = useCallback(() => {
        if (!editingPreset) return;
        const trimmedName = editingPreset.name.trim();
        if (!trimmedName) return;

        let newCustom: MidiPreset[];
        if (editingIsNew) {
            newCustom = [...settings.customPresets, { ...editingPreset, name: trimmedName }];
        } else {
            // Update existing custom preset
            newCustom = settings.customPresets.map(p =>
                p.name === editingOriginalName ? { ...editingPreset, name: trimmedName } : p
            );
        }

        updateSettings({
            customPresets: newCustom,
            activePreset: trimmedName,
        });

        // Activate the saved preset
        if (engineRef.current) {
            engineRef.current.setMapping({ ...editingPreset, name: trimmedName });
        }

        setEditingPreset(null);
        setMappingView("list");
    }, [editingPreset, editingIsNew, editingOriginalName, settings.customPresets, updateSettings]);

    const cancelEditing = useCallback(() => {
        setEditingPreset(null);
        setMappingView("list");
        setLearnRowIndex(null);
    }, []);

    const deletePreset = useCallback((name: string) => {
        const newCustom = settings.customPresets.filter(p => p.name !== name);
        const patch: Partial<MidiSettings> = { customPresets: newCustom };
        if (settings.activePreset === name) {
            patch.activePreset = null;
        }
        updateSettings(patch);
    }, [settings, updateSettings]);

    const updateEditingMapping = useCallback((index: number, updates: Partial<MidiMapping>) => {
        if (!editingPreset) return;
        setEditingPreset(prev => {
            if (!prev) return prev;
            const newMappings = [...prev.mappings];
            newMappings[index] = { ...newMappings[index], ...updates };
            return { ...prev, mappings: newMappings };
        });
    }, [editingPreset]);

    const addMappingRow = useCallback(() => {
        if (!editingPreset) return;
        setEditingPreset(prev => {
            if (!prev) return prev;
            return {
                ...prev,
                mappings: [...prev.mappings, {
                    status: 0x90,
                    midino: 0,
                    action: "play" as MidiAction,
                    deck: "A" as const,
                    type: "note" as const,
                    description: "",
                }],
            };
        });
    }, [editingPreset]);

    const removeMappingRow = useCallback((index: number) => {
        if (!editingPreset) return;
        setEditingPreset(prev => {
            if (!prev) return prev;
            return { ...prev, mappings: prev.mappings.filter((_, i) => i !== index) };
        });
    }, [editingPreset]);

    // MIDI Learn for a specific row in the editor
    useEffect(() => {
        if (learnRowIndex === null || !lastMessage || !editingPreset) return;
        const isNote = (lastMessage.status & 0xF0) === 0x90 || (lastMessage.status & 0xF0) === 0x80;
        updateEditingMapping(learnRowIndex, {
            status: lastMessage.status,
            midino: lastMessage.note,
            type: isNote ? "note" : "cc",
        });
        setLearnRowIndex(null);
    }, [learnRowIndex, lastMessage, editingPreset, updateEditingMapping]);

    const activePreset = getAllPresets(settings).find(p => p.name === settings.activePreset);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[640px] max-h-[85vh] p-0 overflow-hidden bg-zinc-950 border-white/10 z-[80]" overlayClassName="z-[79]">
                <div className="p-4 pb-2 border-b border-white/[0.06]">
                    <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-white/90">
                        <Settings2 className="h-4 w-4" />
                        Mixer Settings
                    </DialogTitle>
                </div>

                <Tabs defaultValue="midi" className="flex flex-col min-h-0">
                    <TabsList className="w-full justify-start rounded-none border-b border-white/[0.06] bg-transparent px-4 h-9">
                        <TabsTrigger value="midi" className="text-xs data-[state=active]:bg-white/10 data-[state=active]:text-white gap-1.5">
                            <Usb className="h-3 w-3" />
                            MIDI Controllers
                        </TabsTrigger>
                        <TabsTrigger value="mapping" className="text-xs data-[state=active]:bg-white/10 data-[state=active]:text-white gap-1.5">
                            <Keyboard className="h-3 w-3" />
                            Mapping
                        </TabsTrigger>
                        <TabsTrigger value="audio" className="text-xs data-[state=active]:bg-white/10 data-[state=active]:text-white gap-1.5">
                            <Music2 className="h-3 w-3" />
                            Audio & Mix
                        </TabsTrigger>
                        <TabsTrigger value="personalize" className="text-xs data-[state=active]:bg-white/10 data-[state=active]:text-white gap-1.5">
                            <Palette className="h-3 w-3" />
                            Personalize
                        </TabsTrigger>
                    </TabsList>

                    <div className="overflow-y-auto p-4 max-h-[55vh]">
                        {/* ── MIDI Tab ── */}
                        <TabsContent value="midi" className="mt-0 space-y-4">
                            {/* Connection Status */}
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    {midiStatus === "connected" ? (
                                        <CheckCircle className="h-4 w-4 text-green-400" />
                                    ) : midiStatus === "error" ? (
                                        <XCircle className="h-4 w-4 text-red-400" />
                                    ) : midiStatus === "connecting" ? (
                                        <RefreshCw className="h-4 w-4 text-yellow-400 animate-spin" />
                                    ) : (
                                        <AlertCircle className="h-4 w-4 text-white/30" />
                                    )}
                                    <span className="text-xs text-white/60">
                                        {midiStatus === "connected" ? "Web MIDI Active" :
                                            midiStatus === "error" ? "MIDI not available" :
                                                midiStatus === "connecting" ? "Connecting..." : "Not initialized"}
                                    </span>
                                </div>
                                <button
                                    onClick={refreshDevices}
                                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/40 hover:text-white/70 text-xs transition-colors cursor-pointer border border-white/5"
                                >
                                    <RefreshCw className="h-3 w-3" />
                                    Refresh
                                </button>
                            </div>

                            {/* Enable/Disable */}
                            <div className="flex items-center justify-between rounded-lg bg-white/[0.03] border border-white/[0.06] p-3">
                                <div className="flex items-center gap-2">
                                    {settings.enabled ? (
                                        <Zap className="h-4 w-4 text-yellow-400" />
                                    ) : (
                                        <ZapOff className="h-4 w-4 text-white/20" />
                                    )}
                                    <div>
                                        <div className="text-xs text-white/80">MIDI Input</div>
                                        <div className="text-[10px] text-white/30">
                                            {settings.enabled ? "Listening for controller input" : "MIDI input disabled"}
                                        </div>
                                    </div>
                                </div>
                                <button
                                    onClick={() => updateSettings({ enabled: !settings.enabled })}
                                    className={cn(
                                        "relative w-10 h-5 rounded-full transition-colors cursor-pointer",
                                        settings.enabled ? "bg-green-500/60" : "bg-white/10"
                                    )}
                                >
                                    <div className={cn(
                                        "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform",
                                        settings.enabled ? "translate-x-5" : "translate-x-0.5"
                                    )} />
                                </button>
                            </div>

                            {/* Connected Devices */}
                            <div>
                                <div className="text-[10px] uppercase tracking-wider text-white/25 mb-2">Connected Devices</div>
                                {devices.length === 0 ? (
                                    <div className="text-center py-6 text-white/20 text-xs">
                                        <Usb className="h-6 w-6 mx-auto mb-2 opacity-30" />
                                        No MIDI devices detected.
                                        <br />
                                        <span className="text-[10px]">Connect a USB controller and click Refresh</span>
                                    </div>
                                ) : (
                                    <div className="space-y-1.5">
                                        {devices.map(d => (
                                            <div key={d.id} className="flex items-center justify-between rounded-md bg-white/[0.03] border border-white/[0.06] p-2.5">
                                                <div className="flex items-center gap-2">
                                                    <CircleDot className="h-3.5 w-3.5 text-green-400" />
                                                    <div>
                                                        <div className="text-xs text-white/80">{d.name}</div>
                                                        {d.manufacturer && (
                                                            <div className="text-[10px] text-white/30">{d.manufacturer}</div>
                                                        )}
                                                    </div>
                                                </div>
                                                <Badge variant="outline" className="text-[9px] text-white/40 border-white/10">
                                                    {d.output ? "In/Out" : "Input"}
                                                </Badge>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* MIDI Monitor */}
                            {lastMessage && (
                                <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5">
                                    <div className="text-[10px] uppercase tracking-wider text-white/25 mb-1.5">Last MIDI Message</div>
                                    <div className="flex items-center gap-3 font-mono text-[10px] text-white/50">
                                        <span>Ch: {lastMessage.channel + 1}</span>
                                        <span>Type: {lastMessage.type}</span>
                                        <span>Note: {lastMessage.note} (0x{lastMessage.note.toString(16).padStart(2, "0").toUpperCase()})</span>
                                        <span>Val: {lastMessage.value}</span>
                                    </div>
                                </div>
                            )}
                        </TabsContent>

                        {/* ── Mapping Tab ── */}
                        <TabsContent value="mapping" className="mt-0 space-y-0">
                            <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportPreset} />

                            {mappingView === "list" ? (
                                /* ── Preset List View ── */
                                <div className="space-y-3">
                                    {/* Header with actions */}
                                    <div className="flex items-center justify-between">
                                        <div className="text-[10px] uppercase tracking-wider text-white/25">Presets</div>
                                        <div className="flex items-center gap-1.5">
                                            <button
                                                onClick={() => fileInputRef.current?.click()}
                                                className="flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/40 hover:text-white/70 text-[10px] transition-colors cursor-pointer border border-white/5"
                                            >
                                                <Upload className="h-3 w-3" />
                                                Import
                                            </button>
                                            <button
                                                onClick={createNewPreset}
                                                className="flex items-center gap-1 px-2 py-1 rounded-md bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 text-[10px] transition-colors cursor-pointer border border-purple-500/20"
                                            >
                                                <Plus className="h-3 w-3" />
                                                New Preset
                                            </button>
                                        </div>
                                    </div>

                                    {/* Built-in Presets */}
                                    <div>
                                        <div className="text-[9px] uppercase tracking-wider text-white/20 mb-1.5 flex items-center gap-1.5">
                                            <Lock className="h-2.5 w-2.5" />
                                            Built-in
                                        </div>
                                        <div className="space-y-1">
                                            {BUILTIN_PRESETS.map(p => (
                                                <div
                                                    key={p.name}
                                                    className={cn(
                                                        "group flex items-center gap-2.5 rounded-lg border p-2.5 transition-all cursor-pointer",
                                                        settings.activePreset === p.name
                                                            ? "bg-white/[0.08] border-purple-500/30 ring-1 ring-purple-500/20"
                                                            : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.05] hover:border-white/[0.1]"
                                                    )}
                                                    onClick={() => selectPreset(p.name)}
                                                >
                                                    {/* Radio indicator */}
                                                    <div className={cn(
                                                        "w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors",
                                                        settings.activePreset === p.name
                                                            ? "border-purple-400 bg-purple-500/20"
                                                            : "border-white/20"
                                                    )}>
                                                        {settings.activePreset === p.name && (
                                                            <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                                                        )}
                                                    </div>

                                                    {/* Info */}
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-xs font-medium text-white/80 truncate">{p.name}</span>
                                                            <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-white/5 text-white/25 shrink-0">
                                                                {p.mappings.length} mappings
                                                            </span>
                                                        </div>
                                                        {p.description && (
                                                            <div className="text-[10px] text-white/30 truncate mt-0.5">{p.description}</div>
                                                        )}
                                                    </div>

                                                    {/* Actions */}
                                                    <DropdownMenu>
                                                        <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
                                                            <button className="p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-white/10 text-white/30 hover:text-white/60 transition-all cursor-pointer">
                                                                <MoreHorizontal className="h-3.5 w-3.5" />
                                                            </button>
                                                        </DropdownMenuTrigger>
                                                        <DropdownMenuContent align="end" className="min-w-[140px] z-[90]">
                                                            <DropdownMenuItem onClick={() => duplicatePreset(p.name)} className="text-xs gap-2 cursor-pointer">
                                                                <Copy className="h-3 w-3" />
                                                                Duplicate
                                                            </DropdownMenuItem>
                                                            <DropdownMenuItem onClick={() => handleExportPreset(p.name)} className="text-xs gap-2 cursor-pointer">
                                                                <Download className="h-3 w-3" />
                                                                Export
                                                            </DropdownMenuItem>
                                                        </DropdownMenuContent>
                                                    </DropdownMenu>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Custom Presets */}
                                    {settings.customPresets.length > 0 && (
                                        <div>
                                            <div className="text-[9px] uppercase tracking-wider text-white/20 mb-1.5 flex items-center gap-1.5">
                                                <Pencil className="h-2.5 w-2.5" />
                                                Custom
                                            </div>
                                            <div className="space-y-1">
                                                {settings.customPresets.map(p => (
                                                    <div
                                                        key={p.name}
                                                        className={cn(
                                                            "group flex items-center gap-2.5 rounded-lg border p-2.5 transition-all cursor-pointer",
                                                            settings.activePreset === p.name
                                                                ? "bg-white/[0.08] border-purple-500/30 ring-1 ring-purple-500/20"
                                                                : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.05] hover:border-white/[0.1]"
                                                        )}
                                                        onClick={() => selectPreset(p.name)}
                                                    >
                                                        {/* Radio indicator */}
                                                        <div className={cn(
                                                            "w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors",
                                                            settings.activePreset === p.name
                                                                ? "border-purple-400 bg-purple-500/20"
                                                                : "border-white/20"
                                                        )}>
                                                            {settings.activePreset === p.name && (
                                                                <div className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                                                            )}
                                                        </div>

                                                        {/* Info */}
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-xs font-medium text-white/80 truncate">{p.name}</span>
                                                                <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-400/60 shrink-0">
                                                                    {p.mappings.length} mappings
                                                                </span>
                                                            </div>
                                                            {p.description && (
                                                                <div className="text-[10px] text-white/30 truncate mt-0.5">{p.description}</div>
                                                            )}
                                                            {p.author && (
                                                                <div className="text-[9px] text-white/20 mt-0.5">by {p.author}</div>
                                                            )}
                                                        </div>

                                                        {/* Actions */}
                                                        <DropdownMenu>
                                                            <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
                                                                <button className="p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-white/10 text-white/30 hover:text-white/60 transition-all cursor-pointer">
                                                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                                                </button>
                                                            </DropdownMenuTrigger>
                                                            <DropdownMenuContent align="end" className="min-w-[140px] z-[90]">
                                                                <DropdownMenuItem onClick={() => startEditPreset(p.name)} className="text-xs gap-2 cursor-pointer">
                                                                    <Pencil className="h-3 w-3" />
                                                                    Edit
                                                                </DropdownMenuItem>
                                                                <DropdownMenuItem onClick={() => duplicatePreset(p.name)} className="text-xs gap-2 cursor-pointer">
                                                                    <Copy className="h-3 w-3" />
                                                                    Duplicate
                                                                </DropdownMenuItem>
                                                                <DropdownMenuItem onClick={() => handleExportPreset(p.name)} className="text-xs gap-2 cursor-pointer">
                                                                    <Download className="h-3 w-3" />
                                                                    Export
                                                                </DropdownMenuItem>
                                                                <DropdownMenuSeparator />
                                                                <DropdownMenuItem onClick={() => deletePreset(p.name)} className="text-xs gap-2 cursor-pointer text-red-400 focus:text-red-400">
                                                                    <Trash2 className="h-3 w-3" />
                                                                    Delete
                                                                </DropdownMenuItem>
                                                            </DropdownMenuContent>
                                                        </DropdownMenu>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Active mapping summary */}
                                    {activePreset && (
                                        <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5">
                                            <div className="flex items-center justify-between mb-2">
                                                <div className="text-[10px] uppercase tracking-wider text-white/25">
                                                    Active: {activePreset.name}
                                                </div>
                                                <span className="text-[9px] text-white/20 tabular-nums">
                                                    {activePreset.mappings.length} controls mapped
                                                </span>
                                            </div>
                                            <div className="flex flex-wrap gap-1">
                                                {MAPPING_CATEGORIES.filter(cat =>
                                                    activePreset.mappings.some(m => cat.actions.includes(m.action))
                                                ).map(cat => {
                                                    const count = activePreset.mappings.filter(m => cat.actions.includes(m.action)).length;
                                                    return (
                                                        <span
                                                            key={cat.label}
                                                            className="text-[8px] px-1.5 py-0.5 rounded bg-white/[0.04] text-white/30 border border-white/[0.06]"
                                                        >
                                                            {cat.label} ({count})
                                                        </span>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* MIDI Learn quick access */}
                                    <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-3">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="text-[10px] uppercase tracking-wider text-white/25">Quick MIDI Learn</div>
                                            {learnTarget && (
                                                <button
                                                    onClick={() => setLearnTarget(null)}
                                                    className="text-[9px] px-2 py-0.5 rounded bg-red-500/20 text-red-300 cursor-pointer hover:bg-red-500/30 transition-colors"
                                                >
                                                    Cancel
                                                </button>
                                            )}
                                        </div>
                                        {learnTarget ? (
                                            <div className="text-center py-3">
                                                <div className="flex items-center justify-center gap-2 mb-2">
                                                    <Radio className="h-3.5 w-3.5 text-amber-400/70 animate-pulse" />
                                                    <span className="text-xs text-amber-400/70">Listening for MIDI input...</span>
                                                </div>
                                                <div className="text-[10px] text-white/30">Move a control on your MIDI controller to map:</div>
                                                <div className="text-xs text-white/60 mt-1 font-medium font-mono">{learnTarget}</div>
                                                {lastMessage && (
                                                    <div className="text-[9px] text-white/20 mt-2 font-mono">
                                                        Last: ch{lastMessage.channel + 1} {lastMessage.type} note={lastMessage.note} val={lastMessage.value}
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <div>
                                                <p className="text-[9px] text-white/25 mb-2">
                                                    Select an action, then move a knob/fader/button on your controller.
                                                </p>
                                                <div className="grid grid-cols-4 gap-1 max-h-24 overflow-y-auto">
                                                    {(["play", "cue", "sync", "volume-fader", "eq-hi", "eq-mid", "eq-low",
                                                        "filter", "crossfader", "tempo-slider", "loop-in", "reloop",
                                                        "hotcue-1", "hotcue-2", "hotcue-3", "hotcue-4",
                                                        "fx-on-off", "fx-level", "fx-select", "headphone-cue",
                                                    ] as MidiAction[]).map(action => (
                                                        <button
                                                            key={action}
                                                            onClick={() => setLearnTarget(action)}
                                                            className="text-[8px] px-1.5 py-1 rounded bg-white/[0.04] hover:bg-white/10 text-white/30 hover:text-white/50 cursor-pointer transition-colors border border-white/[0.06] truncate"
                                                        >
                                                            {action}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ) : editingPreset ? (
                                /* ── Preset Editor View ── */
                                <div className="space-y-3">
                                    {/* Editor Header */}
                                    <div className="flex items-center justify-between -mx-4 -mt-4 px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.02]">
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={cancelEditing}
                                                className="p-1 rounded-md hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors cursor-pointer"
                                            >
                                                <ArrowLeft className="h-4 w-4" />
                                            </button>
                                            <span className="text-xs font-medium text-white/70">
                                                {editingIsNew ? "Create Preset" : "Edit Preset"}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-1.5">
                                            <button
                                                onClick={cancelEditing}
                                                className="px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/40 hover:text-white/70 text-[10px] transition-colors cursor-pointer border border-white/5"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                onClick={saveEditingPreset}
                                                disabled={!editingPreset.name.trim()}
                                                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 text-[10px] font-medium transition-colors cursor-pointer border border-purple-500/20 disabled:opacity-30 disabled:cursor-not-allowed"
                                            >
                                                <Save className="h-3 w-3" />
                                                Save
                                            </button>
                                        </div>
                                    </div>

                                    {/* Preset Metadata */}
                                    <div className="grid grid-cols-2 gap-2">
                                        <div className="col-span-2">
                                            <label className="text-[9px] uppercase tracking-wider text-white/25 mb-1 block">Preset Name</label>
                                            <input
                                                type="text"
                                                value={editingPreset.name}
                                                onChange={e => setEditingPreset(prev => prev ? { ...prev, name: e.target.value } : prev)}
                                                className="w-full text-xs bg-black/30 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-white/80 outline-none focus:border-purple-500/40 transition-colors placeholder:text-white/15"
                                                placeholder="My Controller Mapping"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[9px] uppercase tracking-wider text-white/25 mb-1 block">Author</label>
                                            <input
                                                type="text"
                                                value={editingPreset.author}
                                                onChange={e => setEditingPreset(prev => prev ? { ...prev, author: e.target.value } : prev)}
                                                className="w-full text-[10px] bg-black/30 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-white/60 outline-none focus:border-purple-500/40 transition-colors placeholder:text-white/15"
                                                placeholder="Your name"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[9px] uppercase tracking-wider text-white/25 mb-1 block">Device Match (regex)</label>
                                            <input
                                                type="text"
                                                value={editingPreset.deviceNameMatch || ""}
                                                onChange={e => setEditingPreset(prev => prev ? { ...prev, deviceNameMatch: e.target.value } : prev)}
                                                className="w-full text-[10px] bg-black/30 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-white/60 outline-none focus:border-purple-500/40 transition-colors font-mono placeholder:text-white/15"
                                                placeholder="DDJ.FLX4|DDJ-FLX4"
                                            />
                                        </div>
                                        <div className="col-span-2">
                                            <label className="text-[9px] uppercase tracking-wider text-white/25 mb-1 block">Description</label>
                                            <input
                                                type="text"
                                                value={editingPreset.description}
                                                onChange={e => setEditingPreset(prev => prev ? { ...prev, description: e.target.value } : prev)}
                                                className="w-full text-[10px] bg-black/30 border border-white/[0.08] rounded-md px-2.5 py-1.5 text-white/60 outline-none focus:border-purple-500/40 transition-colors placeholder:text-white/15"
                                                placeholder="Full mapping for my controller"
                                            />
                                        </div>
                                    </div>

                                    {/* Mappings Header */}
                                    <div className="flex items-center justify-between">
                                        <div className="text-[10px] uppercase tracking-wider text-white/25">
                                            Mappings ({editingPreset.mappings.length})
                                        </div>
                                        <button
                                            onClick={addMappingRow}
                                            className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 text-white/40 hover:text-white/70 text-[9px] transition-colors cursor-pointer border border-white/5"
                                        >
                                            <Plus className="h-2.5 w-2.5" />
                                            Add
                                        </button>
                                    </div>

                                    {/* Filter bar */}
                                    <div className="flex items-center gap-2">
                                        <div className="relative flex-1">
                                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-white/20" />
                                            <input
                                                type="text"
                                                value={mappingSearch}
                                                onChange={e => setMappingSearch(e.target.value)}
                                                className="w-full text-[10px] bg-black/20 border border-white/[0.06] rounded-md pl-7 pr-2 py-1.5 text-white/60 outline-none focus:border-white/15 transition-colors placeholder:text-white/15"
                                                placeholder="Filter mappings..."
                                            />
                                            {mappingSearch && (
                                                <button
                                                    onClick={() => setMappingSearch("")}
                                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-white/20 hover:text-white/50 cursor-pointer"
                                                >
                                                    <X className="h-2.5 w-2.5" />
                                                </button>
                                            )}
                                        </div>
                                        <select
                                            value={mappingCategory}
                                            onChange={e => setMappingCategory(e.target.value)}
                                            className="text-[10px] bg-black/20 border border-white/[0.06] rounded-md px-2 py-1.5 text-white/50 outline-none cursor-pointer"
                                        >
                                            <option value="all">All Categories</option>
                                            {MAPPING_CATEGORIES.map(c => (
                                                <option key={c.label} value={c.label}>{c.label}</option>
                                            ))}
                                        </select>
                                    </div>

                                    {/* Mapping Table */}
                                    <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] max-h-[280px] overflow-y-auto">
                                        {editingPreset.mappings.length === 0 ? (
                                            <div className="text-center py-8 text-white/20 text-xs">
                                                <Keyboard className="h-6 w-6 mx-auto mb-2 opacity-30" />
                                                No mappings yet.
                                                <br />
                                                <button
                                                    onClick={addMappingRow}
                                                    className="text-purple-400/60 hover:text-purple-400 mt-1 inline-flex items-center gap-1 cursor-pointer"
                                                >
                                                    <Plus className="h-3 w-3" />
                                                    Add your first mapping
                                                </button>
                                            </div>
                                        ) : (
                                            <table className="w-full text-[10px]">
                                                <thead className="sticky top-0 bg-zinc-950/95 z-10">
                                                    <tr className="text-white/30 border-b border-white/[0.08]">
                                                        <th className="text-left p-1.5 pl-2.5 font-medium">Action</th>
                                                        <th className="text-left p-1.5 font-medium w-14">Deck</th>
                                                        <th className="text-left p-1.5 font-medium w-20">Type</th>
                                                        <th className="text-left p-1.5 font-medium w-16">Status</th>
                                                        <th className="text-left p-1.5 font-medium w-14">Note</th>
                                                        <th className="text-center p-1.5 font-medium w-20">Learn</th>
                                                        <th className="text-center p-1.5 pr-2 font-medium w-8"></th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {editingPreset.mappings
                                                        .map((m, originalIndex) => ({ m, originalIndex }))
                                                        .filter(({ m }) => {
                                                            if (mappingSearch) {
                                                                const q = mappingSearch.toLowerCase();
                                                                if (!(m.action.toLowerCase().includes(q) || (m.description || "").toLowerCase().includes(q))) return false;
                                                            }
                                                            if (mappingCategory !== "all") {
                                                                if (getCategoryForAction(m.action) !== mappingCategory) return false;
                                                            }
                                                            return true;
                                                        })
                                                        .map(({ m, originalIndex }) => (
                                                            <tr
                                                                key={originalIndex}
                                                                className={cn(
                                                                    "border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors",
                                                                    learnRowIndex === originalIndex && "bg-amber-500/[0.06] ring-1 ring-inset ring-amber-500/20"
                                                                )}
                                                            >
                                                                <td className="p-1 pl-2">
                                                                    <select
                                                                        value={m.action}
                                                                        onChange={e => updateEditingMapping(originalIndex, { action: e.target.value as MidiAction })}
                                                                        className="w-full text-[10px] bg-transparent border-none text-white/60 outline-none cursor-pointer hover:text-white/80"
                                                                    >
                                                                        {MAPPING_CATEGORIES.map(cat => (
                                                                            <optgroup key={cat.label} label={cat.label}>
                                                                                {cat.actions.map(a => (
                                                                                    <option key={a} value={a}>{a}</option>
                                                                                ))}
                                                                            </optgroup>
                                                                        ))}
                                                                    </select>
                                                                </td>
                                                                <td className="p-1">
                                                                    <select
                                                                        value={m.deck || ""}
                                                                        onChange={e => updateEditingMapping(originalIndex, { deck: (e.target.value || null) as DeckSide | null })}
                                                                        className="w-full text-[10px] bg-transparent border-none text-white/50 outline-none cursor-pointer"
                                                                    >
                                                                        <option value="">—</option>
                                                                        <option value="A">A</option>
                                                                        <option value="B">B</option>
                                                                    </select>
                                                                </td>
                                                                <td className="p-1">
                                                                    <select
                                                                        value={m.type}
                                                                        onChange={e => updateEditingMapping(originalIndex, { type: e.target.value as MidiMapping["type"] })}
                                                                        className="w-full text-[10px] bg-transparent border-none text-white/50 outline-none cursor-pointer font-mono"
                                                                    >
                                                                        <option value="note">note</option>
                                                                        <option value="cc">cc</option>
                                                                        <option value="cc-14bit-msb">cc-14bit-msb</option>
                                                                        <option value="cc-14bit-lsb">cc-14bit-lsb</option>
                                                                    </select>
                                                                </td>
                                                                <td className="p-1">
                                                                    <input
                                                                        type="text"
                                                                        value={`0x${m.status.toString(16).toUpperCase()}`}
                                                                        onChange={e => {
                                                                            const val = parseInt(e.target.value, 16);
                                                                            if (!isNaN(val) && val >= 0 && val <= 255) updateEditingMapping(originalIndex, { status: val });
                                                                        }}
                                                                        className="w-full text-[10px] bg-transparent border-none text-white/50 outline-none font-mono"
                                                                    />
                                                                </td>
                                                                <td className="p-1">
                                                                    <input
                                                                        type="text"
                                                                        value={`0x${m.midino.toString(16).padStart(2, "0").toUpperCase()}`}
                                                                        onChange={e => {
                                                                            const val = parseInt(e.target.value, 16);
                                                                            if (!isNaN(val) && val >= 0 && val <= 127) updateEditingMapping(originalIndex, { midino: val });
                                                                        }}
                                                                        className="w-full text-[10px] bg-transparent border-none text-white/50 outline-none font-mono"
                                                                    />
                                                                </td>
                                                                <td className="p-1 text-center">
                                                                    <button
                                                                        onClick={() => setLearnRowIndex(learnRowIndex === originalIndex ? null : originalIndex)}
                                                                        className={cn(
                                                                            "px-1.5 py-0.5 rounded text-[8px] font-medium transition-colors cursor-pointer",
                                                                            learnRowIndex === originalIndex
                                                                                ? "bg-amber-500/20 text-amber-300 animate-pulse"
                                                                                : "bg-white/[0.04] text-white/25 hover:bg-white/10 hover:text-white/50"
                                                                        )}
                                                                    >
                                                                        {learnRowIndex === originalIndex ? "Listening..." : "Learn"}
                                                                    </button>
                                                                </td>
                                                                <td className="p-1 pr-2 text-center">
                                                                    <button
                                                                        onClick={() => removeMappingRow(originalIndex)}
                                                                        className="p-0.5 rounded text-white/15 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                                                                    >
                                                                        <Trash2 className="h-3 w-3" />
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        ))}
                                                </tbody>
                                            </table>
                                        )}
                                    </div>

                                    {/* MIDI Monitor in editor */}
                                    {lastMessage && (
                                        <div className="rounded-md bg-white/[0.02] border border-white/[0.04] px-2.5 py-1.5 flex items-center gap-3 font-mono text-[9px] text-white/30">
                                            <Radio className="h-2.5 w-2.5 text-green-400/50" />
                                            <span>Ch: {lastMessage.channel + 1}</span>
                                            <span>{lastMessage.type}</span>
                                            <span>Note: 0x{lastMessage.note.toString(16).padStart(2, "0").toUpperCase()}</span>
                                            <span>Val: {lastMessage.value}</span>
                                        </div>
                                    )}
                                </div>
                            ) : null}
                        </TabsContent>

                        {/* ── Audio & Mix Tab ── */}
                        <TabsContent value="audio" className="mt-0 space-y-4">
                            {/* Beat Grid Overlay */}
                            <div className="flex items-center justify-between rounded-lg bg-white/[0.03] border border-white/[0.06] p-3">
                                <div>
                                    <div className="text-xs text-white/80">Beat Grid Overlay</div>
                                    <div className="text-[10px] text-white/30">
                                        Show bar.beat markers and divider lines on waveforms
                                    </div>
                                </div>
                                <button
                                    onClick={() => {
                                        const next = !beatGrid;
                                        setBeatGrid(next);
                                        saveBeatGridEnabled(next);
                                    }}
                                    className={cn(
                                        "relative w-10 h-5 rounded-full transition-colors cursor-pointer",
                                        beatGrid ? "bg-green-500/60" : "bg-white/10"
                                    )}
                                >
                                    <div className={cn(
                                        "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform",
                                        beatGrid ? "translate-x-5" : "translate-x-0.5"
                                    )} />
                                </button>
                            </div>

                            {/* Waveform Display Mode */}
                            <div>
                                <div className="text-[10px] uppercase tracking-wider text-white/25 mb-2">Waveform Mode</div>
                                <div className="flex gap-1.5">
                                    {([
                                        { id: "rgb" as WaveformMode, label: "RGB", desc: "Full color spectrum" },
                                        { id: "blue" as WaveformMode, label: "Blue", desc: "Classic blue waveform" },
                                        { id: "3band" as WaveformMode, label: "3-Band", desc: "Low/Mid/High split" },
                                    ]).map(mode => (
                                        <button
                                            key={mode.id}
                                            onClick={() => mixer.setWaveformMode(mode.id)}
                                            className={cn(
                                                "flex-1 py-1.5 rounded-md text-xs transition-colors cursor-pointer border",
                                                mixer.waveformMode === mode.id
                                                    ? "bg-white/15 border-white/20 text-white"
                                                    : "bg-white/[0.03] border-white/[0.06] text-white/30 hover:bg-white/[0.06]"
                                            )}
                                        >
                                            {mode.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* MIDI Clock */}
                            <div className="flex items-center justify-between rounded-lg bg-white/[0.03] border border-white/[0.06] p-3">
                                <div>
                                    <div className="text-xs text-white/80">MIDI Clock Output</div>
                                    <div className="text-[10px] text-white/30">
                                        Send MIDI clock (24ppqn) to sync external gear
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    {mixer.midiClockEnabled && (
                                        <span className="text-[9px] tabular-nums text-green-400/60">{mixer.midiClockBpm.toFixed(1)} BPM</span>
                                    )}
                                    <button
                                        onClick={() => mixer.setMidiClockEnabled(!mixer.midiClockEnabled)}
                                        className={cn(
                                            "relative w-10 h-5 rounded-full transition-colors cursor-pointer",
                                            mixer.midiClockEnabled ? "bg-green-500/60" : "bg-white/10"
                                        )}
                                    >
                                        <div className={cn(
                                            "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform",
                                            mixer.midiClockEnabled ? "translate-x-5" : "translate-x-0.5"
                                        )} />
                                    </button>
                                </div>
                            </div>

                            {/* Tempo Range */}
                            <div>
                                <div className="text-[10px] uppercase tracking-wider text-white/25 mb-2">Tempo Range</div>
                                <div className="flex gap-1.5">
                                    {[6, 10, 16, 25].map(range => (
                                        <button
                                            key={range}
                                            onClick={() => updateSettings({ tempoRange: range })}
                                            className={cn(
                                                "flex-1 py-1.5 rounded-md text-xs transition-colors cursor-pointer border",
                                                settings.tempoRange === range
                                                    ? "bg-white/15 border-white/20 text-white"
                                                    : "bg-white/[0.03] border-white/[0.06] text-white/30 hover:bg-white/[0.06]"
                                            )}
                                        >
                                            ±{range}%
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Jog Sensitivity */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">Jog Sensitivity</span>
                                    <span className="text-[10px] text-white/30 tabular-nums">{settings.jogSensitivity.toFixed(1)}x</span>
                                </div>
                                <input
                                    type="range"
                                    min="0.5"
                                    max="2.0"
                                    step="0.1"
                                    value={settings.jogSensitivity}
                                    onChange={(e) => updateSettings({ jogSensitivity: parseFloat(e.target.value) })}
                                    className="w-full accent-white/60"
                                />
                            </div>

                            {/* Crossfader Curve */}
                            <div>
                                <div className="text-[10px] uppercase tracking-wider text-white/25 mb-2">Crossfader Curve</div>
                                <div className="flex gap-1.5">
                                    {(["linear", "smooth", "sharp"] as const).map(curve => (
                                        <button
                                            key={curve}
                                            onClick={() => updateSettings({ crossfaderCurve: curve })}
                                            className={cn(
                                                "flex-1 py-1.5 rounded-md text-xs capitalize transition-colors cursor-pointer border",
                                                settings.crossfaderCurve === curve
                                                    ? "bg-white/15 border-white/20 text-white"
                                                    : "bg-white/[0.03] border-white/[0.06] text-white/30 hover:bg-white/[0.06]"
                                            )}
                                        >
                                            {curve}
                                        </button>
                                    ))}
                                </div>
                                <div className="mt-1.5 flex justify-center">
                                    <svg width="120" height="32" viewBox="0 0 120 32" className="text-white/20">
                                        {/* Crossfader curve preview */}
                                        <line x1="0" y1="30" x2="120" y2="30" stroke="currentColor" strokeWidth="0.5" />
                                        <line x1="60" y1="0" x2="60" y2="32" stroke="currentColor" strokeWidth="0.5" strokeDasharray="2,2" />
                                        {settings.crossfaderCurve === "linear" && (
                                            <>
                                                <path d="M0,30 L60,2 L120,30" fill="none" stroke="rgb(168,85,247)" strokeWidth="1.5" opacity="0.6" />
                                                <path d="M0,30 L60,2 L120,30" fill="none" stroke="rgb(59,130,246)" strokeWidth="1.5" opacity="0.6" transform="scale(-1,1) translate(-120,0)" />
                                            </>
                                        )}
                                        {settings.crossfaderCurve === "smooth" && (
                                            <>
                                                <path d="M0,30 Q30,30 60,2 Q90,30 120,30" fill="none" stroke="rgb(168,85,247)" strokeWidth="1.5" opacity="0.6" />
                                                <path d="M0,30 Q30,2 60,2 Q90,2 120,30" fill="none" stroke="rgb(59,130,246)" strokeWidth="1.5" opacity="0.6" />
                                            </>
                                        )}
                                        {settings.crossfaderCurve === "sharp" && (
                                            <>
                                                <path d="M0,30 L10,30 L55,2 L60,2" fill="none" stroke="rgb(168,85,247)" strokeWidth="1.5" opacity="0.6" />
                                                <path d="M60,2 L65,2 L110,30 L120,30" fill="none" stroke="rgb(168,85,247)" strokeWidth="1.5" opacity="0.6" />
                                                <path d="M0,30 L10,30 L55,2 L60,2" fill="none" stroke="rgb(59,130,246)" strokeWidth="1.5" opacity="0.6" transform="scale(-1,1) translate(-120,0)" />
                                                <path d="M60,2 L65,2 L110,30 L120,30" fill="none" stroke="rgb(59,130,246)" strokeWidth="1.5" opacity="0.6" transform="scale(-1,1) translate(-120,0)" />
                                            </>
                                        )}
                                    </svg>
                                </div>
                            </div>

                            {/* Audio Output Device */}
                            <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5">
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Volume2 className="w-3 h-3 text-white/30" />
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">Audio Output</span>
                                </div>

                                {audioPermission === "denied" ? (
                                    <div className="text-[10px] text-red-400/70 bg-red-500/[0.06] border border-red-500/10 rounded px-2 py-2">
                                        Audio permission denied. Please allow microphone access in your browser settings to select output devices.
                                    </div>
                                ) : audioPermission === "prompt" ? (
                                    <div className="space-y-2">
                                        <button
                                            onClick={requestAudioPermission}
                                            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-md text-[10px] font-medium bg-purple-500/20 border border-purple-500/30 text-purple-300 hover:bg-purple-500/30 transition-colors cursor-pointer"
                                        >
                                            <Volume2 className="w-3 h-3" />
                                            Grant Audio Permission
                                        </button>
                                        <p className="text-[9px] text-white/20">
                                            Browser permission is required to list and select audio output devices.
                                        </p>
                                    </div>
                                ) : (
                                    <>
                                        <select
                                            value={selectedAudioDevice}
                                            onChange={async (e) => {
                                                const deviceId = e.target.value;
                                                setSelectedAudioDevice(deviceId);
                                                try {
                                                    localStorage.setItem("mmo-audio-output", deviceId);
                                                    // Set sink on all audio elements
                                                    const audios = document.querySelectorAll("audio");
                                                    for (const audio of audios) {
                                                        if ("setSinkId" in audio) {
                                                            await (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId);
                                                        }
                                                    }
                                                } catch { /* setSinkId not supported */ }
                                            }}
                                            className="w-full text-[10px] bg-black/30 border border-white/[0.08] rounded px-2 py-1.5 text-white/70 outline-none cursor-pointer hover:bg-black/40 transition-colors"
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
                                        <p className="text-[9px] text-white/20 mt-1.5">
                                            Select the audio output device for playback.
                                        </p>
                                    </>
                                )}
                            </div>

                            {/* EQ Mode */}
                            <div>
                                <div className="text-[10px] uppercase tracking-wider text-white/25 mb-2">EQ Mode</div>
                                <div className="flex gap-1.5">
                                    {(["eq", "isolator"] as EQMode[]).map(mode => (
                                        <button
                                            key={mode}
                                            onClick={() => mixer.setEQMode(mode)}
                                            className={cn(
                                                "flex-1 py-1.5 rounded-md text-xs capitalize transition-colors cursor-pointer border",
                                                mixer.eqMode === mode
                                                    ? "bg-white/15 border-white/20 text-white"
                                                    : "bg-white/[0.03] border-white/[0.06] text-white/30 hover:bg-white/[0.06]"
                                            )}
                                        >
                                            {mode === "eq" ? "Standard EQ" : "Isolator"}
                                        </button>
                                    ))}
                                </div>
                                <p className="text-[9px] text-white/20 mt-1">
                                    {mixer.eqMode === "isolator" ? "Isolator: Full-cut capable, DJ mixer style" : "Standard EQ: Shelf and peak filters"}
                                </p>
                            </div>

                            {/* Audio Latency Info - Real values */}
                            <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5">
                                <div className="text-[10px] uppercase tracking-wider text-white/25 mb-1.5">Audio Engine</div>
                                {(() => {
                                    const info = mixer.getAudioInfo();
                                    return (
                                        <div className="grid grid-cols-2 gap-2 text-[10px]">
                                            <div>
                                                <span className="text-white/30">Sample Rate:</span>
                                                <span className="text-white/60 ml-1">{info?.sampleRate || "—"} Hz</span>
                                            </div>
                                            <div>
                                                <span className="text-white/30">Base Latency:</span>
                                                <span className="text-white/60 ml-1">{info?.baseLatency ? `${(info.baseLatency * 1000).toFixed(1)}ms` : "—"}</span>
                                            </div>
                                            <div>
                                                <span className="text-white/30">Output Latency:</span>
                                                <span className="text-white/60 ml-1">{info?.outputLatency ? `${(info.outputLatency * 1000).toFixed(1)}ms` : "—"}</span>
                                            </div>
                                            <div>
                                                <span className="text-white/30">Channels:</span>
                                                <span className="text-white/60 ml-1">{info?.channelCount || "—"} ({info?.channelCount === 2 ? "Stereo" : "Mono"})</span>
                                            </div>
                                            <div>
                                                <span className="text-white/30">State:</span>
                                                <span className={cn("ml-1", info?.state === "running" ? "text-green-400/60" : "text-yellow-400/60")}>{info?.state || "—"}</span>
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        </TabsContent>

                        {/* ── Personalize Tab ── */}
                        <TabsContent value="personalize" className="mt-0 space-y-4">
                            {/* Reset */}
                            <div className="flex items-center justify-between">
                                <div className="text-[10px] uppercase tracking-wider text-white/25">Appearance</div>
                                <button
                                    onClick={personalization.reset}
                                    className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 text-white/30 hover:text-white/60 text-[9px] transition-colors cursor-pointer border border-white/5"
                                >
                                    <RotateCcw className="h-2.5 w-2.5" />
                                    Reset All
                                </button>
                            </div>

                            {/* Background Mode */}
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Monitor className="w-3 h-3 text-white/30" />
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">Background</span>
                                </div>
                                <div className="grid grid-cols-4 gap-1.5 mb-3">
                                    {([
                                        { id: "blur" as MixerBackground, label: "Blur", desc: "Frosted glass" },
                                        { id: "solid" as MixerBackground, label: "Solid", desc: "Flat color" },
                                        { id: "gradient" as MixerBackground, label: "Gradient", desc: "Two-tone" },
                                        { id: "transparent" as MixerBackground, label: "None", desc: "See-through" },
                                    ]).map(bg => (
                                        <button
                                            key={bg.id}
                                            onClick={() => personalization.update({ mixerBackground: bg.id })}
                                            className={cn(
                                                "flex flex-col items-center gap-1 py-2 rounded-lg text-[10px] transition-all cursor-pointer border",
                                                personalization.mixerBackground === bg.id
                                                    ? "bg-white/10 border-white/20 text-white"
                                                    : "bg-white/[0.02] border-white/[0.06] text-white/30 hover:bg-white/[0.06]"
                                            )}
                                        >
                                            {/* Mini preview */}
                                            <div className={cn(
                                                "w-8 h-5 rounded",
                                                bg.id === "blur" && "bg-purple-900/40 backdrop-blur-sm border border-white/10",
                                                bg.id === "solid" && "bg-zinc-900 border border-white/10",
                                                bg.id === "gradient" && "bg-gradient-to-b from-purple-900/60 to-zinc-900 border border-white/10",
                                                bg.id === "transparent" && "bg-transparent border border-dashed border-white/20",
                                            )} />
                                            <span className="font-medium">{bg.label}</span>
                                        </button>
                                    ))}
                                </div>

                                {/* Background-specific controls */}
                                {personalization.mixerBackground === "blur" && (
                                    <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5 space-y-2.5">
                                        <div>
                                            <div className="flex items-center justify-between mb-1">
                                                <span className="text-[9px] text-white/30">Blur Intensity</span>
                                                <span className="text-[9px] text-white/25 tabular-nums">{personalization.blurIntensity}px</span>
                                            </div>
                                            <input
                                                type="range" min="0" max="30" step="1"
                                                value={personalization.blurIntensity}
                                                onChange={e => personalization.update({ blurIntensity: parseInt(e.target.value) })}
                                                className="w-full accent-white/60 h-1"
                                            />
                                        </div>
                                        <div>
                                            <div className="flex items-center justify-between mb-1">
                                                <span className="text-[9px] text-white/30">Opacity</span>
                                                <span className="text-[9px] text-white/25 tabular-nums">{Math.round(personalization.backgroundOpacity * 100)}%</span>
                                            </div>
                                            <input
                                                type="range" min="0.3" max="1" step="0.05"
                                                value={personalization.backgroundOpacity}
                                                onChange={e => personalization.update({ backgroundOpacity: parseFloat(e.target.value) })}
                                                className="w-full accent-white/60 h-1"
                                            />
                                        </div>
                                    </div>
                                )}

                                {personalization.mixerBackground === "solid" && (
                                    <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5 space-y-2.5">
                                        <div>
                                            <span className="text-[9px] text-white/30 block mb-1">Color</span>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="color"
                                                    value={personalization.solidBgColor}
                                                    onChange={e => personalization.update({ solidBgColor: e.target.value })}
                                                    className="w-8 h-6 rounded border border-white/10 cursor-pointer bg-transparent"
                                                />
                                                <span className="text-[9px] font-mono text-white/30">{personalization.solidBgColor}</span>
                                                <div className="flex gap-1 ml-auto">
                                                    {["#0a0a0a", "#0d1117", "#1a1a2e", "#0f172a", "#171717", "#18181b"].map(c => (
                                                        <button
                                                            key={c}
                                                            onClick={() => personalization.update({ solidBgColor: c })}
                                                            className={cn(
                                                                "w-4 h-4 rounded-full border cursor-pointer transition-transform hover:scale-125",
                                                                personalization.solidBgColor === c ? "border-white/50 scale-110" : "border-white/10"
                                                            )}
                                                            style={{ backgroundColor: c }}
                                                        />
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                        <div>
                                            <div className="flex items-center justify-between mb-1">
                                                <span className="text-[9px] text-white/30">Opacity</span>
                                                <span className="text-[9px] text-white/25 tabular-nums">{Math.round(personalization.backgroundOpacity * 100)}%</span>
                                            </div>
                                            <input
                                                type="range" min="0.3" max="1" step="0.05"
                                                value={personalization.backgroundOpacity}
                                                onChange={e => personalization.update({ backgroundOpacity: parseFloat(e.target.value) })}
                                                className="w-full accent-white/60 h-1"
                                            />
                                        </div>
                                    </div>
                                )}

                                {personalization.mixerBackground === "gradient" && (
                                    <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5 space-y-2.5">
                                        <div className="flex items-center gap-3">
                                            <div>
                                                <span className="text-[9px] text-white/30 block mb-1">From</span>
                                                <div className="flex items-center gap-1.5">
                                                    <input
                                                        type="color"
                                                        value={personalization.gradientFrom}
                                                        onChange={e => personalization.update({ gradientFrom: e.target.value })}
                                                        className="w-7 h-5 rounded border border-white/10 cursor-pointer bg-transparent"
                                                    />
                                                    <span className="text-[8px] font-mono text-white/25">{personalization.gradientFrom}</span>
                                                </div>
                                            </div>
                                            <div className="text-white/10 text-xs mt-3">→</div>
                                            <div>
                                                <span className="text-[9px] text-white/30 block mb-1">To</span>
                                                <div className="flex items-center gap-1.5">
                                                    <input
                                                        type="color"
                                                        value={personalization.gradientTo}
                                                        onChange={e => personalization.update({ gradientTo: e.target.value })}
                                                        className="w-7 h-5 rounded border border-white/10 cursor-pointer bg-transparent"
                                                    />
                                                    <span className="text-[8px] font-mono text-white/25">{personalization.gradientTo}</span>
                                                </div>
                                            </div>
                                            <div className="ml-auto">
                                                {/* Preview */}
                                                <div
                                                    className="w-16 h-8 rounded border border-white/10"
                                                    style={{ background: `linear-gradient(to bottom, ${personalization.gradientFrom}, ${personalization.gradientTo})` }}
                                                />
                                            </div>
                                        </div>
                                        {/* Preset gradients */}
                                        <div>
                                            <span className="text-[9px] text-white/20 block mb-1">Presets</span>
                                            <div className="flex gap-1.5">
                                                {[
                                                    { from: "#1a0a2e", to: "#0a0a0a", label: "Dark Purple" },
                                                    { from: "#0a1628", to: "#0a0a0a", label: "Deep Blue" },
                                                    { from: "#1a0a0a", to: "#0a0a0a", label: "Dark Red" },
                                                    { from: "#0a1a14", to: "#0a0a0a", label: "Forest" },
                                                    { from: "#1a1a0a", to: "#0a0a0a", label: "Warm" },
                                                    { from: "#0a0a1a", to: "#1a0a1a", label: "Night" },
                                                ].map(g => (
                                                    <button
                                                        key={g.label}
                                                        onClick={() => personalization.update({ gradientFrom: g.from, gradientTo: g.to })}
                                                        className="flex flex-col items-center gap-0.5 cursor-pointer group"
                                                        title={g.label}
                                                    >
                                                        <div
                                                            className={cn(
                                                                "w-6 h-6 rounded-full border transition-transform group-hover:scale-110",
                                                                personalization.gradientFrom === g.from && personalization.gradientTo === g.to
                                                                    ? "border-white/40 scale-110"
                                                                    : "border-white/10"
                                                            )}
                                                            style={{ background: `linear-gradient(to bottom, ${g.from}, ${g.to})` }}
                                                        />
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        <div>
                                            <div className="flex items-center justify-between mb-1">
                                                <span className="text-[9px] text-white/30">Opacity</span>
                                                <span className="text-[9px] text-white/25 tabular-nums">{Math.round(personalization.backgroundOpacity * 100)}%</span>
                                            </div>
                                            <input
                                                type="range" min="0.3" max="1" step="0.05"
                                                value={personalization.backgroundOpacity}
                                                onChange={e => personalization.update({ backgroundOpacity: parseFloat(e.target.value) })}
                                                className="w-full accent-white/60 h-1"
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Text Scale */}
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Type className="w-3 h-3 text-white/30" />
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">Text Size</span>
                                </div>
                                <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5">
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-[9px] text-white/30">Scale</span>
                                        <span className="text-[9px] text-white/25 tabular-nums">{Math.round(personalization.textScale * 100)}%</span>
                                    </div>
                                    <input
                                        type="range" min="0.75" max="1.25" step="0.05"
                                        value={personalization.textScale}
                                        onChange={e => personalization.update({ textScale: parseFloat(e.target.value) })}
                                        className="w-full accent-white/60 h-1"
                                    />
                                    <div className="flex justify-between mt-1">
                                        <span className="text-[8px] text-white/15">75%</span>
                                        <span className="text-[8px] text-white/15">100%</span>
                                        <span className="text-[8px] text-white/15">125%</span>
                                    </div>
                                    {/* Preview */}
                                    <div className="mt-2 p-2 rounded bg-white/[0.03] border border-white/[0.04]" style={{ fontSize: `${personalization.textScale * 100}%` }}>
                                        <span className="text-[10px] text-white/40">Preview: </span>
                                        <span className="text-[10px] text-white/60">130.0 BPM · 4A · Techno</span>
                                    </div>
                                </div>
                            </div>

                            {/* Accent Color */}
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Palette className="w-3 h-3 text-white/30" />
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">Accent Color</span>
                                </div>
                                <div className="flex gap-2">
                                    {(Object.entries(ACCENT_COLORS) as [AccentColor, typeof ACCENT_COLORS[AccentColor]][]).map(([key, color]) => (
                                        <button
                                            key={key}
                                            onClick={() => personalization.update({ accentColor: key })}
                                            className={cn(
                                                "flex flex-col items-center gap-1 cursor-pointer group"
                                            )}
                                            title={color.label}
                                        >
                                            <div className={cn(
                                                "w-7 h-7 rounded-full border-2 transition-all group-hover:scale-110",
                                                personalization.accentColor === key
                                                    ? "border-white/60 scale-110 shadow-lg"
                                                    : "border-white/10"
                                            )}
                                                style={{
                                                    backgroundColor: color.swatch,
                                                    boxShadow: personalization.accentColor === key ? `0 0 12px ${color.swatch}40` : undefined
                                                }}
                                            />
                                            <span className={cn(
                                                "text-[8px]",
                                                personalization.accentColor === key ? "text-white/60" : "text-white/20"
                                            )}>
                                                {color.label}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* UI Density */}
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Layers className="w-3 h-3 text-white/30" />
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">UI Density</span>
                                </div>
                                <div className="flex gap-1.5">
                                    {(Object.entries(DENSITY_VALUES) as [UIDensity, typeof DENSITY_VALUES[UIDensity]][]).map(([key, d]) => (
                                        <button
                                            key={key}
                                            onClick={() => personalization.update({ uiDensity: key })}
                                            className={cn(
                                                "flex-1 flex flex-col items-center gap-1.5 py-2 rounded-lg text-[10px] transition-all cursor-pointer border",
                                                personalization.uiDensity === key
                                                    ? "bg-white/10 border-white/20 text-white"
                                                    : "bg-white/[0.02] border-white/[0.06] text-white/30 hover:bg-white/[0.06]"
                                            )}
                                        >
                                            {/* Mini density preview */}
                                            <div className="flex flex-col items-center" style={{ gap: key === "compact" ? 1 : key === "spacious" ? 4 : 2 }}>
                                                <div className="w-6 h-0.5 rounded-full bg-white/20" />
                                                <div className="w-4 h-0.5 rounded-full bg-white/15" />
                                                <div className="w-5 h-0.5 rounded-full bg-white/10" />
                                            </div>
                                            <span className="font-medium">{d.label}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Knob Style */}
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Gauge className="w-3 h-3 text-white/30" />
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">Knob Style</span>
                                </div>
                                <div className="flex gap-1.5">
                                    {([
                                        { id: "arc" as KnobStyle, label: "Arc", desc: "Filled arc indicator" },
                                        { id: "dot" as KnobStyle, label: "Dot", desc: "Single dot pointer" },
                                        { id: "line" as KnobStyle, label: "Line", desc: "Line indicator" },
                                    ]).map(style => (
                                        <button
                                            key={style.id}
                                            onClick={() => personalization.update({ knobStyle: style.id })}
                                            className={cn(
                                                "flex-1 flex flex-col items-center gap-1.5 py-2 rounded-lg text-[10px] transition-all cursor-pointer border",
                                                personalization.knobStyle === style.id
                                                    ? "bg-white/10 border-white/20 text-white"
                                                    : "bg-white/[0.02] border-white/[0.06] text-white/30 hover:bg-white/[0.06]"
                                            )}
                                        >
                                            {/* Mini knob preview */}
                                            <svg width="24" height="24" viewBox="0 0 24 24">
                                                <circle cx="12" cy="12" r="10" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="2"
                                                    strokeDasharray={`${(270 / 360) * 2 * Math.PI * 10} ${2 * Math.PI * 10}`}
                                                    strokeDashoffset={`${-(135 / 360) * 2 * Math.PI * 10}`}
                                                    strokeLinecap="round"
                                                />
                                                {style.id === "arc" && (
                                                    <circle cx="12" cy="12" r="10" fill="none" stroke={personalization.accent.swatch} strokeWidth="2"
                                                        strokeDasharray={`${(180 / 360) * 2 * Math.PI * 10} ${2 * Math.PI * 10}`}
                                                        strokeDashoffset={`${-(135 / 360) * 2 * Math.PI * 10}`}
                                                        strokeLinecap="round"
                                                    />
                                                )}
                                                {style.id === "dot" && (
                                                    <circle cx="12" cy="3" r="2" fill={personalization.accent.swatch} />
                                                )}
                                                {style.id === "line" && (
                                                    <line x1="12" y1="2" x2="12" y2="7" stroke={personalization.accent.swatch} strokeWidth="2" strokeLinecap="round" />
                                                )}
                                            </svg>
                                            <span className="font-medium">{style.label}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Jogwheel Style */}
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Disc className="w-3 h-3 text-white/30" />
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">Jogwheel Style</span>
                                </div>
                                <div className="grid grid-cols-5 gap-1.5 max-h-[240px] overflow-y-auto pr-1 scrollbar-thin">
                                    {JOG_STYLES.map(style => {
                                        const previewProps: JogDesignProps = {
                                            side: "A",
                                            color: personalization.accent.swatch,
                                            progress: 0.65,
                                            rotation: 0,
                                            isPlaying: false,
                                            timeDisplay: "1:23",
                                            remainingDisplay: "-2:10",
                                            isWarning: false,
                                            warningIntensity: 0,
                                            warningFlicker: false,
                                        };
                                        return (
                                            <button
                                                key={style.id}
                                                onClick={() => personalization.update({ jogwheelStyle: style.id })}
                                                className={cn(
                                                    "flex flex-col items-center gap-1 py-1.5 rounded-lg transition-all cursor-pointer border",
                                                    personalization.jogwheelStyle === style.id
                                                        ? "bg-white/10 border-white/20"
                                                        : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.06]"
                                                )}
                                                title={style.description}
                                            >
                                                <svg viewBox="0 0 100 100" className="w-10 h-10">
                                                    {JOG_RENDERERS[style.id](previewProps)}
                                                </svg>
                                                <span className={cn(
                                                    "text-[7px] font-medium leading-tight",
                                                    personalization.jogwheelStyle === style.id ? "text-white/70" : "text-white/25"
                                                )}>
                                                    {style.name}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* End-of-Track Warning */}
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <AlertTriangle className="w-3 h-3 text-white/30" />
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">End-of-Track Warning</span>
                                </div>
                                <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5">
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-[9px] text-white/30">
                                            {personalization.endWarningSeconds === 0 ? "Disabled" : "Warning at"}
                                        </span>
                                        <span className="text-[9px] text-white/25 tabular-nums">
                                            {personalization.endWarningSeconds === 0 ? "Off" : `${personalization.endWarningSeconds}s remaining`}
                                        </span>
                                    </div>
                                    <input
                                        type="range" min="0" max="60" step="5"
                                        value={personalization.endWarningSeconds}
                                        onChange={e => personalization.update({ endWarningSeconds: parseInt(e.target.value) })}
                                        className="w-full accent-white/60 h-1"
                                    />
                                    <div className="flex justify-between mt-1">
                                        <span className="text-[8px] text-white/15">Off</span>
                                        <span className="text-[8px] text-white/15">15s</span>
                                        <span className="text-[8px] text-white/15">30s</span>
                                        <span className="text-[8px] text-white/15">45s</span>
                                        <span className="text-[8px] text-white/15">60s</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 mt-2 text-[8px] text-white/20">
                                        <Clock className="w-2.5 h-2.5" />
                                        <span>Jogwheel flickers orange/red when track is about to end</span>
                                    </div>
                                </div>
                            </div>

                            {/* Performance */}
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Sparkles className="w-3 h-3 text-white/30" />
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">Performance</span>
                                </div>
                                <div className="flex items-center justify-between rounded-lg bg-white/[0.03] border border-white/[0.06] p-2.5">
                                    <div>
                                        <div className="text-[10px] text-white/60">Reduced Animations</div>
                                        <div className="text-[9px] text-white/25">Disable transitions for better performance</div>
                                    </div>
                                    <button
                                        onClick={() => personalization.update({ reducedAnimations: !personalization.reducedAnimations })}
                                        className={cn(
                                            "relative w-10 h-5 rounded-full transition-colors cursor-pointer",
                                            personalization.reducedAnimations ? "bg-green-500/60" : "bg-white/10"
                                        )}
                                    >
                                        <div className={cn(
                                            "absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform",
                                            personalization.reducedAnimations ? "translate-x-5" : "translate-x-0.5"
                                        )} />
                                    </button>
                                </div>
                                <div className="flex items-center justify-between rounded-lg bg-white/[0.03] border border-white/[0.06] p-2.5 mt-1">
                                    <div>
                                        <div className="text-[10px] text-white/60">Performance Stats</div>
                                        <div className="text-[9px] text-white/25">FPS, memory, DOM nodes</div>
                                    </div>
                                    <div className="flex items-center gap-0.5">
                                        {(["off", "on"] as const).map(pos => (
                                            <button
                                                key={pos}
                                                onClick={() => personalization.update({ performanceStatsPosition: pos })}
                                                className={cn(
                                                    "px-1.5 py-0.5 rounded text-[8px] font-medium capitalize transition-colors cursor-pointer",
                                                    personalization.performanceStatsPosition === pos
                                                        ? "bg-purple-500/30 text-purple-300"
                                                        : "bg-white/[0.04] text-white/25 hover:text-white/50"
                                                )}
                                            >{pos}</button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* Visibility Toggles */}
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Eye className="w-3 h-3 text-white/30" />
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">Visibility</span>
                                </div>
                                <div className="space-y-1">
                                    {([
                                        { key: "showVuMeters" as const, label: "VU Meters", desc: "Level meters on channels" },
                                        { key: "showKeyDisplay" as const, label: "Key Display", desc: "Musical key on deck info" },
                                    ]).map(item => (
                                        <div key={item.key} className="flex items-center justify-between rounded-lg bg-white/[0.02] border border-white/[0.06] p-2">
                                            <div>
                                                <div className="text-[10px] text-white/60">{item.label}</div>
                                                <div className="text-[9px] text-white/20">{item.desc}</div>
                                            </div>
                                            <button
                                                onClick={() => personalization.update({ [item.key]: !personalization[item.key] })}
                                                className={cn(
                                                    "relative w-8 h-4 rounded-full transition-colors cursor-pointer",
                                                    personalization[item.key] ? "bg-green-500/60" : "bg-white/10"
                                                )}
                                            >
                                                <div className={cn(
                                                    "absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform",
                                                    personalization[item.key] ? "translate-x-4" : "translate-x-0.5"
                                                )} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* External Devices */}
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <span className="text-sm">🎛️</span>
                                    <span className="text-[10px] uppercase tracking-wider text-white/25">External Devices</span>
                                </div>
                                <div className="space-y-1">
                                    {([
                                        { key: "showExternalDevices" as const, label: "External Devices", desc: "Detect & show grooveboxes (Circuit Tracks, etc.)" },
                                        { key: "externalDeviceAutoConnect" as const, label: "Auto-Connect", desc: "Auto-show panel when device is plugged in" },
                                    ]).map(item => (
                                        <div key={item.key} className="flex items-center justify-between rounded-lg bg-white/[0.02] border border-white/[0.06] p-2">
                                            <div>
                                                <div className="text-[10px] text-white/60">{item.label}</div>
                                                <div className="text-[9px] text-white/20">{item.desc}</div>
                                            </div>
                                            <button
                                                onClick={() => personalization.update({ [item.key]: !personalization[item.key] })}
                                                className={cn(
                                                    "relative w-8 h-4 rounded-full transition-colors cursor-pointer",
                                                    personalization[item.key] ? "bg-green-500/60" : "bg-white/10"
                                                )}
                                            >
                                                <div className={cn(
                                                    "absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform",
                                                    personalization[item.key] ? "translate-x-4" : "translate-x-0.5"
                                                )} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </TabsContent>
                    </div>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}

