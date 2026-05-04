"use client";

import { useState, useCallback } from "react";
import { useDAW } from "./daw-context";
import { cn } from "@/lib/utils";
import {
    Power, Trash2, GripVertical, Plus, ChevronDown, ChevronRight,
    Sliders, RotateCcw, Copy,
} from "lucide-react";
import { EFFECT_TYPES, DEFAULT_EFFECT_PARAMS, type EffectType, type InsertEffect } from "@/lib/daw-engine";
import { useContextMenu, type MenuEntry } from "./daw-context-menu";
import { useScrollAdjust } from "./daw-ui-utils";
import { useRenderCount } from "@/lib/dev-debugger";
import { PluginRack, type PluginChainSlot } from "@/components/plugins/plugin-rack";

export function DAWEffectsRack() {
    useRenderCount("DAWEffectsRack");
    const daw = useDAW();
    const ctxMenu = useContextMenu();
    const track = daw.project.tracks.find(t => t.id === daw.selectedTrackId);
    const [selectedFx, setSelectedFx] = useState<string | null>(null);
    // Per-track VST/AU/LV2 chain. Stored in component state for now;
    // persisting into project state lives in a follow-up PR — keeping
    // this map in-memory keeps the chain across re-renders without
    // disturbing the existing project schema.
    const [pluginChains, setPluginChains] = useState<Record<string, PluginChainSlot[]>>({});

    const handleInsertContextMenu = useCallback((e: React.MouseEvent, insert: InsertEffect, idx: number) => {
        e.preventDefault();
        e.stopPropagation();
        if (!track) return;

        const items: MenuEntry[] = [
            { type: "label", label: insert.type.replace(/_/g, " ") },
            { type: "separator" },
            {
                label: insert.enabled ? "Bypass Effect" : "Enable Effect",
                icon: <Power className="h-3.5 w-3.5" />,
                checked: insert.enabled,
                onClick: () => daw.toggleInsert(track.id, insert.id),
            },
            { type: "separator" },
            {
                label: "Delete Effect",
                icon: <Trash2 className="h-3.5 w-3.5" />,
                destructive: true,
                onClick: () => {
                    daw.removeInsert(track.id, insert.id);
                    if (selectedFx === insert.id) setSelectedFx(null);
                },
            },
        ];
        ctxMenu.show(e.clientX, e.clientY, items);
    }, [daw, track, selectedFx, ctxMenu]);

    if (!track) {
        return (
            <div className="h-full flex items-center justify-center text-white/20 text-sm">
                Select a track to view its effects
            </div>
        );
    }

    const selected = track.inserts.find(i => i.id === selectedFx);

    return (
        <div className="h-full flex bg-[var(--daw-bg)]">
            {/* Effect chain list */}
            <div className="w-[140px] sm:w-[200px] flex-shrink-0 border-r border-white/10 flex flex-col">
                {/* Header */}
                <div className="h-7 flex items-center justify-between px-2 border-b border-[var(--daw-border)] bg-[var(--daw-surface)]">
                    <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full" style={{ background: track.color }} />
                        <span className="text-[10px] text-white/60 truncate">{track.name}</span>
                    </div>
                    <AddEffectDropdown
                        onAdd={type => {
                            daw.addInsert(track.id, type);
                        }}
                    />
                </div>

                {/* Insert chain */}
                <div className="flex-1 overflow-y-auto">
                    {track.inserts.length === 0 ? (
                        <div className="p-3 text-center text-[10px] text-white/15">
                            No effects. Click + to add.
                        </div>
                    ) : (
                        track.inserts.map((insert, idx) => (
                            <div
                                key={insert.id}
                                className={cn(
                                    "flex items-center gap-1 px-2 py-1.5 border-b border-white/5 cursor-pointer transition-colors group",
                                    selectedFx === insert.id ? "bg-white/5" : "hover:bg-white/[0.02]"
                                )}
                                onClick={() => setSelectedFx(insert.id)}
                                onContextMenu={e => handleInsertContextMenu(e, insert, idx)}
                            >
                                <GripVertical className="h-3 w-3 text-white/10 flex-shrink-0 cursor-grab" />

                                <button
                                    onClick={e => {
                                        e.stopPropagation();
                                        daw.toggleInsert(track.id, insert.id);
                                    }}
                                    className={cn(
                                        "w-4 h-4 rounded flex items-center justify-center flex-shrink-0",
                                        insert.enabled ? "text-cyan-400" : "text-white/20"
                                    )}
                                >
                                    <Power className="h-2.5 w-2.5" />
                                </button>

                                <span className="text-[10px] text-white/60 flex-1 truncate capitalize">
                                    {insert.type.replace(/_/g, " ")}
                                </span>

                                <span className="text-[8px] text-white/15">{idx + 1}</span>

                                <button
                                    onClick={e => {
                                        e.stopPropagation();
                                        daw.removeInsert(track.id, insert.id);
                                        if (selectedFx === insert.id) setSelectedFx(null);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 w-4 h-4 flex items-center justify-center text-white/20 hover:text-red-400"
                                >
                                    <Trash2 className="h-2.5 w-2.5" />
                                </button>
                            </div>
                        ))
                    )}
                </div>

                {/* Send slots */}
                <div className="border-t border-white/10">
                    <div className="h-6 flex items-center px-2 bg-[var(--daw-surface)]">
                        <span className="text-[9px] text-white/30 uppercase">Sends</span>
                    </div>
                    {track.sends.map((send, i) => (
                        <div key={send.returnTrackId} className="flex items-center gap-1 px-2 py-1 border-b border-white/5">
                            <span className="text-[9px] text-white/30">S{i + 1}</span>
                            <span className="text-[10px] text-white/40 flex-1 truncate">{send.returnTrackId || "—"}</span>
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.01}
                                value={send.amount}
                                onChange={e => daw.setSendAmount(track.id, send.returnTrackId, Number(e.target.value))}
                                className="w-12 h-0.5 accent-green-500"
                            />
                        </div>
                    ))}
                </div>

                {/* VST / AU / LV2 plugin rack — companion-hosted, offline render */}
                <div className="border-t border-white/10 p-1.5">
                    <PluginRack
                        mode="compact"
                        role="track"
                        title="Plugins"
                        chain={pluginChains[track.id] ?? []}
                        onChange={(next) => setPluginChains((prev) => ({ ...prev, [track.id]: next }))}
                    />
                </div>
            </div>

            {/* Effect parameter editor */}
            <div className="flex-1 overflow-y-auto p-3">
                {selected ? (
                    <EffectEditor track={track} insert={selected} />
                ) : (
                    <div className="h-full flex items-center justify-center text-white/15 text-sm">
                        Select an effect to edit parameters
                    </div>
                )}
            </div>
        </div>
    );
}

function EffectEditor({ track, insert }: { track: { id: string }; insert: InsertEffect }) {
    const daw = useDAW();
    const params = insert.params;

    const paramEntries = Object.entries(params);

    return (
        <div>
            <div className="flex items-center gap-2 mb-4">
                <Sliders className="h-4 w-4 text-cyan-400/60" />
                <h3 className="text-sm text-white/70 capitalize font-medium">
                    {insert.type.replace(/_/g, " ")}
                </h3>
                <div
                    className={cn(
                        "ml-auto px-1.5 py-0.5 rounded text-[9px]",
                        insert.enabled ? "bg-cyan-500/20 text-cyan-400" : "bg-white/5 text-white/20"
                    )}
                >
                    {insert.enabled ? "ON" : "OFF"}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
                {paramEntries.map(([key, value]) => (
                    <ParamControl
                        key={key}
                        name={key}
                        value={value as number}
                        onChange={v => daw.setInsertParam(track.id, insert.id, key, v)}
                    />
                ))}
            </div>
        </div>
    );
}

function ParamControl({ name, value, onChange }: { name: string; value: number; onChange: (v: number) => void }) {
    // Infer range from param name
    const isFreq = name.includes("freq") || name.includes("cutoff");
    const isQ = name === "q" || name === "resonance";
    const isTime = name.includes("time") || name.includes("delay") || name.includes("attack") || name.includes("release") || name.includes("decay");
    const isRatio = name === "ratio" || name === "threshold";
    const isGain = name.includes("gain") || name.includes("drive");

    let min = 0, max = 1, step = 0.01;
    if (isFreq) { min = 20; max = 20000; step = 1; }
    else if (isQ) { min = 0.1; max = 30; step = 0.1; }
    else if (isTime) { min = 0; max = 5; step = 0.01; }
    else if (isRatio) { min = -60; max = 60; step = 0.1; }
    else if (isGain) { min = -24; max = 24; step = 0.1; }

    const display = isFreq
        ? value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value)}`
        : isTime ? `${value.toFixed(2)}s` : `${value.toFixed(2)}`;

    const paramRef = useScrollAdjust({
        value,
        min,
        max,
        step: isFreq ? 10 : step * 5,
        fineStep: step,
        onChange,
    });

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
                <span className="text-[9px] text-white/30 uppercase">{name.replace(/_/g, " ")}</span>
                <span className="text-[9px] text-white/40 font-mono">{display}</span>
            </div>
            <input
                ref={paramRef}
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                className="w-full h-1 accent-cyan-500"
            />
        </div>
    );
}

function AddEffectDropdown({ onAdd }: { onAdd: (type: EffectType) => void }) {
    const [open, setOpen] = useState(false);

    const categories: { label: string; types: EffectType[] }[] = [
        { label: "Dynamics", types: ["compressor", "limiter", "gate"] },
        { label: "EQ & Filter", types: ["eq3", "parametricEq", "filter"] },
        { label: "Delay & Reverb", types: ["reverb", "delay", "pingPongDelay", "convolutionReverb"] },
        { label: "Modulation", types: ["chorus", "flanger", "phaser", "tremolo"] },
        { label: "Distortion", types: ["distortion", "bitcrusher", "saturator"] },
        { label: "Stereo", types: ["stereoWidth", "deEsser"] },
    ];

    return (
        <div className="relative">
            <button
                onClick={() => setOpen(!open)}
                className="w-5 h-5 rounded bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/30 hover:text-white/60"
            >
                <Plus className="h-3 w-3" />
            </button>

            {open && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
                    <div className="absolute right-0 top-6 z-50 w-48 bg-[var(--daw-surface)] border border-[var(--daw-border)] rounded-lg shadow-xl overflow-hidden">
                        {categories.map(cat => (
                            <div key={cat.label}>
                                <div className="px-2 py-1 text-[9px] text-white/20 uppercase bg-white/[0.02]">
                                    {cat.label}
                                </div>
                                {cat.types.map(type => (
                                    <button
                                        key={type}
                                        onClick={() => {
                                            onAdd(type);
                                            setOpen(false);
                                        }}
                                        className="w-full text-left px-3 py-1 text-[11px] text-white/50 hover:bg-white/5 hover:text-white/70 capitalize"
                                    >
                                        {type.replace(/_/g, " ")}
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
