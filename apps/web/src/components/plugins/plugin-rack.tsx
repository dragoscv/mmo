"use client";

/**
 * PluginRack — reusable widget that surfaces the companion's plugin
 * host inside any feature page (DAW track inspector, Sound Editor
 * offline-FX tab, Live page master FX, Mixer per-deck inserts…).
 *
 * Design goals:
 *   • Self-fetches the plugin inventory (with a passed-in initial cache
 *     for instant first paint).
 *   • Stateless w.r.t. the audio: the host owns the chain, this widget
 *     just edits + emits it via `onChange`. The host is responsible
 *     for actually rendering / streaming the audio.
 *   • Two render modes:
 *       compact  — used inside a track inspector / per-deck strip
 *       full     — used in standalone FX panels (Sound Editor, Live)
 *
 * Render flow (when `audioPath` is provided + the user hits "Render"):
 *   1. Calls `renderWithPlugins(audioPath, chain)`.
 *   2. Polls `getPluginRenderStatus(jobId)` until done.
 *   3. Emits the rendered audio URL via `onRenderComplete`.
 * Hosts that don't supply `audioPath` get only chain editing.
 */

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    AlertCircle,
    ChevronDown,
    ChevronUp,
    GripVertical,
    Loader2,
    Plug,
    Plus,
    Power,
    PowerOff,
    Search,
    Sparkles,
    Trash2,
    X,
} from "lucide-react";
import {
    getPluginInventory,
    renderWithPlugins,
    getPluginRenderStatus,
    getPluginRenderAudioUrl,
} from "@/actions/plugins";
import type {
    PluginDescriptor,
    PluginScanResult,
    PluginChainStep,
    PluginRenderJobSnapshot,
} from "@/lib/companion-plugins";
import { cn } from "@/lib/utils";

export interface PluginChainSlot extends PluginChainStep {
    /** Stable client-side slot id so React keys + reorder work. */
    slotId: string;
    plugin: PluginDescriptor;
}

interface Props {
    /** The current chain. Caller persists this. */
    chain: PluginChainSlot[];
    /** Called whenever the user mutates the chain. */
    onChange: (next: PluginChainSlot[]) => void;
    /** Optional initial inventory (avoids first-paint flash). */
    initialInventory?: PluginScanResult | null;
    /** Display mode. `compact` = used inside a track-inspector lane;
     *  `full` = used in a dedicated FX panel. */
    mode?: "compact" | "full";
    /** Title label. Default depends on mode. */
    title?: string;
    /** When provided, exposes a "Render" button that runs the chain
     *  through this audio file via the companion. The rendered URL is
     *  passed back to `onRenderComplete`. */
    audioPath?: string;
    onRenderComplete?: (audioUrl: string, jobId: string) => void;
    /** Tag visible to the user, used to scope the empty/CTA copy. */
    role?: "track" | "deck" | "selection" | "master";
}

const ROLE_COPY: Record<NonNullable<Props["role"]>, string> = {
    track: "Insert effects on this track",
    deck: "Insert effects for this deck",
    selection: "Process the selected clip",
    master: "Master bus effects",
};

export function PluginRack({
    chain,
    onChange,
    initialInventory,
    mode = "compact",
    title,
    audioPath,
    onRenderComplete,
    role = "track",
}: Props) {
    const [inventory, setInventory] = useState<PluginScanResult | null>(
        initialInventory ?? null,
    );
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickerSearch, setPickerSearch] = useState("");
    const [expanded, setExpanded] = useState<string | null>(null);
    const [rendering, setRendering] = useState(false);
    const [renderJob, setRenderJob] = useState<PluginRenderJobSnapshot | null>(null);
    const [renderError, setRenderError] = useState<string | null>(null);

    // Lazy-load the plugin inventory the first time the user opens the
    // picker. Avoids a useless fetch on pages that never browse.
    useEffect(() => {
        if (!pickerOpen || inventory) return;
        let cancelled = false;
        void (async () => {
            try {
                const data = await getPluginInventory();
                if (!cancelled) setInventory(data.cached);
            } catch {
                /* render an empty list */
            }
        })();
        return () => { cancelled = true; };
    }, [pickerOpen, inventory]);

    const effects = useMemo(
        () => (inventory?.inventory ?? []).filter((p) => p.isEffect),
        [inventory],
    );
    const filteredPicker = useMemo(() => {
        const q = pickerSearch.trim().toLowerCase();
        if (!q) return effects;
        return effects.filter((p) =>
            p.name.toLowerCase().includes(q)
            || p.manufacturer.toLowerCase().includes(q),
        );
    }, [effects, pickerSearch]);

    const addPlugin = (plugin: PluginDescriptor) => {
        const slot: PluginChainSlot = {
            slotId: crypto.randomUUID(),
            plugin,
            path: plugin.path,
            params: {},
            bypass: false,
        };
        onChange([...chain, slot]);
        setPickerOpen(false);
        setPickerSearch("");
        setExpanded(slot.slotId);
    };

    const removeSlot = (slotId: string) => {
        onChange(chain.filter((s) => s.slotId !== slotId));
    };

    const toggleBypass = (slotId: string) => {
        onChange(chain.map((s) =>
            s.slotId === slotId ? { ...s, bypass: !s.bypass } : s,
        ));
    };

    const moveSlot = (slotId: string, direction: -1 | 1) => {
        const idx = chain.findIndex((s) => s.slotId === slotId);
        if (idx < 0) return;
        const swap = idx + direction;
        if (swap < 0 || swap >= chain.length) return;
        const next = chain.slice();
        [next[idx], next[swap]] = [next[swap], next[idx]];
        onChange(next);
    };

    const setParam = (slotId: string, paramId: string, value: number) => {
        onChange(chain.map((s) =>
            s.slotId === slotId
                ? { ...s, params: { ...(s.params ?? {}), [paramId]: value } }
                : s,
        ));
    };

    const triggerRender = async () => {
        if (!audioPath || rendering) return;
        const enabled = chain.filter((s) => !s.bypass);
        if (enabled.length === 0) {
            setRenderError("Add at least one effect first.");
            return;
        }
        setRenderError(null);
        setRendering(true);
        setRenderJob(null);
        try {
            const r = await renderWithPlugins(audioPath, chain);
            if (!r.ok || !r.jobId) {
                setRenderError(r.error ?? "Render failed");
                setRendering(false);
                return;
            }
            const jobId = r.jobId;
            // Poll until done.
            let done = false;
            while (!done) {
                await new Promise((res) => setTimeout(res, 700));
                const snap = await getPluginRenderStatus(jobId);
                if (!snap) continue;
                setRenderJob(snap);
                if (snap.stage === "done") {
                    const url = await getPluginRenderAudioUrl(jobId);
                    if (url && onRenderComplete) onRenderComplete(url, jobId);
                    done = true;
                } else if (snap.stage === "error") {
                    setRenderError(snap.error ?? "Render failed");
                    done = true;
                }
            }
        } catch (e) {
            setRenderError(e instanceof Error ? e.message : String(e));
        } finally {
            setRendering(false);
        }
    };

    return (
        <div className={cn(
            "rounded-md border border-white/10 bg-white/[0.03]",
            mode === "compact" ? "p-2.5" : "p-4",
        )}>
            <div className="flex items-center justify-between mb-2">
                <h3 className={cn(
                    "font-semibold flex items-center gap-1.5",
                    mode === "compact" ? "text-xs" : "text-sm",
                )}>
                    <Plug className={cn(mode === "compact" ? "h-3 w-3" : "h-4 w-4", "text-violet-400")} />
                    {title ?? (mode === "compact" ? "FX" : "Plugin chain")}
                </h3>
                <button
                    onClick={() => setPickerOpen(true)}
                    className={cn(
                        "rounded inline-flex items-center gap-1",
                        "bg-violet-500/20 hover:bg-violet-500/30 text-violet-200",
                        mode === "compact" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs",
                    )}
                >
                    <Plus className={mode === "compact" ? "h-2.5 w-2.5" : "h-3 w-3"} /> Add
                </button>
            </div>

            {chain.length === 0 ? (
                <p className={cn(
                    "text-white/40 text-center py-3",
                    mode === "compact" ? "text-[10px]" : "text-xs",
                )}>
                    {ROLE_COPY[role]}
                </p>
            ) : (
                <ul className="space-y-1.5">
                    {chain.map((slot, idx) => (
                        <SlotRow
                            key={slot.slotId}
                            slot={slot}
                            index={idx}
                            total={chain.length}
                            expanded={expanded === slot.slotId}
                            onToggleExpand={() => setExpanded(expanded === slot.slotId ? null : slot.slotId)}
                            onRemove={() => removeSlot(slot.slotId)}
                            onToggleBypass={() => toggleBypass(slot.slotId)}
                            onMoveUp={() => moveSlot(slot.slotId, -1)}
                            onMoveDown={() => moveSlot(slot.slotId, 1)}
                            onSetParam={(p, v) => setParam(slot.slotId, p, v)}
                            mode={mode}
                        />
                    ))}
                </ul>
            )}

            {audioPath ? (
                <div className="mt-3 pt-3 border-t border-white/10">
                    <button
                        onClick={triggerRender}
                        disabled={rendering || chain.filter((s) => !s.bypass).length === 0}
                        className={cn(
                            "w-full rounded-md py-1.5 text-xs font-medium",
                            "bg-violet-500 hover:bg-violet-400 text-white",
                            "disabled:opacity-40 disabled:cursor-not-allowed",
                            "inline-flex items-center justify-center gap-2",
                        )}
                    >
                        {rendering
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Sparkles className="h-3.5 w-3.5" />}
                        {rendering
                            ? (renderJob
                                ? `${Math.round((renderJob.progress ?? 0) * 100)}% — ${renderJob.message}`
                                : "Rendering…")
                            : "Render through chain"}
                    </button>
                    {renderError ? (
                        <p className="mt-2 text-[11px] text-red-300 flex items-start gap-1">
                            <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                            {renderError}
                        </p>
                    ) : null}
                </div>
            ) : null}

            {/* Picker modal */}
            <AnimatePresence>
                {pickerOpen ? (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
                        onClick={() => setPickerOpen(false)}
                    >
                        <motion.div
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full max-w-lg rounded-lg border border-white/10 bg-zinc-950 shadow-2xl"
                        >
                            <div className="flex items-center justify-between p-3 border-b border-white/10">
                                <h4 className="text-sm font-semibold flex items-center gap-2">
                                    <Plug className="h-4 w-4 text-violet-400" /> Add plugin
                                </h4>
                                <button
                                    onClick={() => setPickerOpen(false)}
                                    className="text-white/50 hover:text-white"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </div>
                            <div className="p-3">
                                <div className="relative mb-3">
                                    <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40" />
                                    <input
                                        autoFocus
                                        type="text"
                                        value={pickerSearch}
                                        onChange={(e) => setPickerSearch(e.target.value)}
                                        placeholder="Search effects…"
                                        className="w-full rounded bg-white/5 border border-white/10 pl-8 pr-3 py-1.5 text-xs"
                                    />
                                </div>
                                {!inventory ? (
                                    <div className="py-6 text-center text-xs text-white/50">
                                        <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
                                        Loading inventory…
                                    </div>
                                ) : effects.length === 0 ? (
                                    <p className="py-6 text-center text-xs text-white/50">
                                        No plugins discovered. Visit{" "}
                                        <a href="/plugins" className="text-violet-300 hover:underline">/plugins</a>
                                        {" "}to scan.
                                    </p>
                                ) : (
                                    <ul className="max-h-80 overflow-auto space-y-1">
                                        {filteredPicker.map((p) => (
                                            <li key={p.path}>
                                                <button
                                                    onClick={() => addPlugin(p)}
                                                    className={cn(
                                                        "w-full text-left rounded px-2 py-1.5",
                                                        "bg-white/[0.02] hover:bg-violet-500/15",
                                                        "border border-white/5 hover:border-violet-400/40 transition",
                                                    )}
                                                >
                                                    <div className="flex items-center gap-2">
                                                        <span className="rounded bg-violet-400/20 text-violet-200 px-1 py-0.5 text-[9px] font-bold">
                                                            {p.format}
                                                        </span>
                                                        <span className="text-xs font-medium truncate">{p.name}</span>
                                                        <span className="text-[10px] text-white/40 truncate ml-auto">
                                                            {p.manufacturer}
                                                        </span>
                                                    </div>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </motion.div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}

// ─── Slot row ───────────────────────────────────────────────────────

function SlotRow({
    slot,
    index,
    total,
    expanded,
    onToggleExpand,
    onRemove,
    onToggleBypass,
    onMoveUp,
    onMoveDown,
    onSetParam,
    mode,
}: {
    slot: PluginChainSlot;
    index: number;
    total: number;
    expanded: boolean;
    onToggleExpand: () => void;
    onRemove: () => void;
    onToggleBypass: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onSetParam: (paramId: string, value: number) => void;
    mode: "compact" | "full";
}) {
    return (
        <li className={cn(
            "rounded border bg-black/20 transition",
            slot.bypass
                ? "border-white/5 opacity-50"
                : "border-white/10",
        )}>
            <div className="flex items-center gap-1.5 px-2 py-1.5">
                <span className="text-white/30">
                    <GripVertical className="h-3 w-3" />
                </span>
                <button
                    onClick={onToggleExpand}
                    className="flex-1 min-w-0 text-left flex items-center gap-1.5"
                >
                    <span className={cn(
                        "rounded px-1 py-0.5 text-[9px] font-bold shrink-0",
                        slot.plugin.isInstrument ? "bg-amber-400/20 text-amber-300" : "bg-violet-400/20 text-violet-200",
                    )}>
                        {slot.plugin.format}
                    </span>
                    <span className={cn(
                        "font-medium truncate",
                        mode === "compact" ? "text-[11px]" : "text-xs",
                    )}>
                        {slot.plugin.name}
                    </span>
                </button>
                <button
                    onClick={onMoveUp}
                    disabled={index === 0}
                    className="text-white/40 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Move up"
                >
                    <ChevronUp className="h-3 w-3" />
                </button>
                <button
                    onClick={onMoveDown}
                    disabled={index === total - 1}
                    className="text-white/40 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Move down"
                >
                    <ChevronDown className="h-3 w-3" />
                </button>
                <button
                    onClick={onToggleBypass}
                    className={cn(
                        "transition",
                        slot.bypass ? "text-white/30 hover:text-white" : "text-emerald-400 hover:text-emerald-300",
                    )}
                    title={slot.bypass ? "Bypassed" : "Active"}
                >
                    {slot.bypass ? <PowerOff className="h-3 w-3" /> : <Power className="h-3 w-3" />}
                </button>
                <button
                    onClick={onRemove}
                    className="text-white/40 hover:text-red-300"
                    title="Remove"
                >
                    <Trash2 className="h-3 w-3" />
                </button>
            </div>
            <AnimatePresence initial={false}>
                {expanded && slot.plugin.parameters.length > 0 ? (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden border-t border-white/5"
                    >
                        <div className="p-2 space-y-1.5 max-h-64 overflow-auto">
                            {slot.plugin.parameters.slice(0, 16).map((param) => {
                                const isContinuous = typeof param.min_value === "number"
                                    && typeof param.max_value === "number";
                                if (!isContinuous) {
                                    // Skip discrete params for now (UX scope).
                                    return (
                                        <div key={param.id} className="text-[10px] text-white/40">
                                            {param.name}: {param.string_value ?? "—"}
                                        </div>
                                    );
                                }
                                const current = (slot.params?.[param.id] as number | undefined)
                                    ?? param.raw_value
                                    ?? param.default_raw_value
                                    ?? 0;
                                return (
                                    <label key={param.id} className="block">
                                        <div className="flex justify-between text-[10px] text-white/60 mb-0.5">
                                            <span className="truncate">{param.name}</span>
                                            <span className="tabular-nums text-white/40">
                                                {(typeof current === "number" ? current : 0).toFixed(2)}
                                                {param.label ?? ""}
                                            </span>
                                        </div>
                                        <input
                                            type="range"
                                            min={param.min_value}
                                            max={param.max_value}
                                            step={param.step_size ?? (param.max_value! - param.min_value!) / 200}
                                            value={typeof current === "number" ? current : 0}
                                            onChange={(e) => onSetParam(param.id, parseFloat(e.target.value))}
                                            className="w-full accent-violet-400 h-1"
                                        />
                                    </label>
                                );
                            })}
                            {slot.plugin.parameters.length > 16 ? (
                                <p className="text-[10px] text-white/30 text-center pt-1">
                                    + {slot.plugin.parameters.length - 16} more parameters
                                </p>
                            ) : null}
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </li>
    );
}
