"use client";

/**
 * AudioDeviceSelect — unified, prettier device picker with autocomplete.
 *
 * • Wraps a custom popover (rendered into a portal so it never clips inside
 *   modals or scroll containers) and groups devices by source: Browser
 *   MediaDevices vs. Companion native devices (RtAudio/ASIO/WASAPI/…).
 * • Built-in search box: type to filter across both groups.
 * • Keyboard navigable: ↑/↓ to move, Enter to pick, Escape to close.
 * • Single string `value` scheme:
 *     ""             → system default
 *     "<deviceId>"   → browser MediaDevice
 *     "native:<n>"   → companion native device with id n
 */

import { useMemo, useCallback, useId, useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import {
    ChevronDown,
    Headphones,
    Loader2,
    Mic,
    MonitorSpeaker,
    RefreshCw,
    Search,
    Sparkles,
    Speaker,
    X,
} from "lucide-react";
import { useAudioDevices, decodeNativeValue, isNativeValue, encodeNativeValue } from "@/hooks/use-audio-devices";
import { cn } from "@/lib/utils";

export type AudioDeviceKind = "input" | "output";

export interface AudioDeviceSelectChange {
    value: string;
    source: "browser" | "native" | "default";
    nativeId: number | null;
    label: string;
}

export interface AudioDeviceSelectProps {
    kind: AudioDeviceKind;
    value: string;
    onValueChange: (next: AudioDeviceSelectChange) => void;
    nativeDisabled?: boolean;
    nativeDisabledHint?: string;
    placeholder?: string;
    size?: "sm" | "default";
    className?: string;
    disabled?: boolean;
    showPermissionHint?: boolean;
}

interface FlatItem {
    key: string;
    value: string;
    label: string;
    sublabel: string | null;
    source: "default" | "browser" | "native";
    accent: "rose" | "purple" | "cyan";
    disabled: boolean;
    searchHaystack: string;
}

function backendBadge(backend: string): { label: string; tone: string } {
    const normalised = backend.toLowerCase();
    if (normalised.includes("asio")) return { label: "ASIO", tone: "text-amber-300" };
    if (normalised.includes("wasapi")) return { label: "WASAPI", tone: "text-cyan-300" };
    if (normalised.includes("core")) return { label: "CoreAudio", tone: "text-purple-300" };
    if (normalised.includes("alsa")) return { label: "ALSA", tone: "text-emerald-300" };
    if (normalised.includes("jack")) return { label: "JACK", tone: "text-pink-300" };
    if (normalised.includes("pulse")) return { label: "PulseAudio", tone: "text-blue-300" };
    return { label: backend, tone: "text-white/70" };
}

function defaultPlaceholder(kind: AudioDeviceKind): string {
    return kind === "input" ? "System default microphone" : "System default output";
}

interface PopoverPosition {
    top: number;
    left: number;
    width: number;
    placement: "below" | "above";
    maxHeight: number;
}

function usePopoverPosition(triggerRef: React.RefObject<HTMLElement | null>, open: boolean): PopoverPosition | null {
    const [pos, setPos] = useState<PopoverPosition | null>(null);

    useLayoutEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when popover closes
        if (!open) { setPos(null); return; }
        const compute = () => {
            const trigger = triggerRef.current;
            if (!trigger) return;
            const rect = trigger.getBoundingClientRect();
            const vh = window.innerHeight;
            const margin = 8;
            const desired = 360;
            const spaceBelow = vh - rect.bottom - margin;
            const spaceAbove = rect.top - margin;
            const placeBelow = spaceBelow >= 200 || spaceBelow >= spaceAbove;
            const maxHeight = Math.min(desired, Math.max(180, placeBelow ? spaceBelow : spaceAbove));
            // eslint-disable-next-line react-hooks/set-state-in-effect -- imperative DOM measurement (resize/scroll)
            setPos({
                top: placeBelow ? rect.bottom + 4 : rect.top - 4,
                left: rect.left,
                width: rect.width,
                placement: placeBelow ? "below" : "above",
                maxHeight,
            });
        };
        compute();
        const onScroll = () => compute();
        window.addEventListener("scroll", onScroll, true);
        window.addEventListener("resize", onScroll);
        return () => {
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onScroll);
        };
    }, [open, triggerRef]);

    return pos;
}

export function AudioDeviceSelect({
    kind,
    value,
    onValueChange,
    nativeDisabled,
    nativeDisabledHint,
    placeholder,
    size = "default",
    className,
    disabled,
    showPermissionHint,
}: AudioDeviceSelectProps) {
    const devices = useAudioDevices();
    const popoverId = useId();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeIdx, setActiveIdx] = useState(0);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const pos = usePopoverPosition(triggerRef, open);

    const browserList = kind === "input" ? devices.browserInputs : devices.browserOutputs;
    const nativeList = kind === "input" ? devices.nativeInputs : devices.nativeOutputs;
    const backend = devices.companionGroup?.backend ?? "Companion";

    const items = useMemo<FlatItem[]>(() => {
        const list: FlatItem[] = [];
        const placeholderLabel = placeholder ?? defaultPlaceholder(kind);
        list.push({
            key: "__default",
            value: "default",
            label: placeholderLabel,
            sublabel: "Follows the OS / browser default",
            source: "default",
            accent: "rose",
            disabled: false,
            searchHaystack: `default system ${placeholderLabel}`.toLowerCase(),
        });
        for (const d of browserList) {
            const lbl = d.label || `${kind === "input" ? "Microphone" : "Output"} ${d.deviceId.slice(0, 6)}`;
            list.push({
                key: `browser:${d.deviceId}`,
                value: d.deviceId,
                label: lbl,
                sublabel: null,
                source: "browser",
                accent: "rose",
                disabled: false,
                searchHaystack: `browser ${lbl} ${d.deviceId}`.toLowerCase(),
            });
        }
        if (devices.nativeAvailable) {
            for (const d of nativeList) {
                const v = encodeNativeValue(d.id);
                const isDefault = kind === "input" ? d.isDefaultInput : d.isDefaultOutput;
                const ch = kind === "input" ? d.inputChannels : d.outputChannels;
                list.push({
                    key: `native:${d.id}`,
                    value: v,
                    label: d.name,
                    sublabel: `${ch}ch · ${Math.round(d.preferredSampleRate / 1000)} kHz${isDefault ? " · system default" : ""}`,
                    source: "native",
                    accent: "purple",
                    disabled: !!nativeDisabled,
                    searchHaystack: `${backend} native companion ${d.name}`.toLowerCase(),
                });
            }
        }
        return list;
    }, [browserList, nativeList, devices.nativeAvailable, kind, placeholder, backend, nativeDisabled]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return items;
        return items.filter(it => it.searchHaystack.includes(q));
    }, [items, query]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- derived clamp on filtered length change; cannot useMemo
        if (activeIdx >= filtered.length) setActiveIdx(Math.max(0, filtered.length - 1));
    }, [filtered.length, activeIdx]);

    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- imperative reset on open transition
        setQuery("");
        const selectedIdx = items.findIndex(it => it.value === value || (!value && it.value === "default"));
        setActiveIdx(selectedIdx >= 0 ? selectedIdx : 0);
        const t = window.setTimeout(() => searchRef.current?.focus(), 30);
        return () => window.clearTimeout(t);
    }, [open, items, value]);

    useEffect(() => {
        if (!open) return;
        const onDocPointer = (e: PointerEvent) => {
            const t = e.target as Node;
            if (popoverRef.current?.contains(t)) return;
            if (triggerRef.current?.contains(t)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onDocPointer);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("pointerdown", onDocPointer);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const el = optionRefs.current[activeIdx];
        if (el) el.scrollIntoView({ block: "nearest" });
    }, [open, activeIdx]);

    const currentLabel = useMemo(() => {
        if (!value || value === "default") return placeholder ?? defaultPlaceholder(kind);
        const nativeId = decodeNativeValue(value);
        if (nativeId !== null) {
            const nd = nativeList.find(d => d.id === nativeId);
            return nd ? nd.name : `Native device #${nativeId}`;
        }
        const bd = browserList.find(d => d.deviceId === value);
        return bd?.label || (kind === "input" ? "Custom microphone" : "Custom output");
    }, [value, browserList, nativeList, placeholder, kind]);

    const currentIsNative = isNativeValue(value);
    const badge = currentIsNative && devices.companionGroup ? backendBadge(devices.companionGroup.backend) : null;

    const choose = useCallback((it: FlatItem) => {
        if (it.disabled) return;
        const source: "browser" | "native" | "default" =
            it.source === "default" ? "default" : it.source === "native" ? "native" : "browser";
        const nativeId = decodeNativeValue(it.value);
        onValueChange({ value: it.value, source, nativeId, label: it.label });
        setOpen(false);
        triggerRef.current?.focus();
    }, [onValueChange]);

    const onSearchKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIdx(i => Math.min(filtered.length - 1, i + 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIdx(i => Math.max(0, i - 1));
        } else if (e.key === "Enter") {
            e.preventDefault();
            const it = filtered[activeIdx];
            if (it) choose(it);
        } else if (e.key === "Home") {
            e.preventDefault();
            setActiveIdx(0);
        } else if (e.key === "End") {
            e.preventDefault();
            setActiveIdx(filtered.length - 1);
        } else if (e.key === "Tab") {
            setOpen(false);
        }
    }, [filtered, activeIdx, choose]);

    const sizeClass = size === "sm" ? "h-8 text-[11px] px-2.5" : "h-9 text-xs px-3";
    const iconSize = size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5";

    const browserCount = filtered.filter(i => i.source === "default" || i.source === "browser").length;
    const nativeCount = filtered.filter(i => i.source === "native").length;

    const portalTarget = typeof document !== "undefined" ? document.body : null;

    return (
        <div className={cn("relative w-full", className)}>
            {showPermissionHint && devices.permission === "prompt" && (
                <button
                    type="button"
                    onClick={() => void devices.requestPermission()}
                    className="mb-1 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] uppercase tracking-wider text-amber-300/90 bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20 cursor-pointer"
                >
                    <Mic className="w-2.5 h-2.5" /> Tap to enable microphone labels
                </button>
            )}
            <button
                ref={triggerRef}
                type="button"
                disabled={disabled}
                onClick={() => setOpen(o => !o)}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={popoverId}
                className={cn(
                    "group flex w-full items-center justify-between gap-2 rounded-lg border bg-black/40 text-left text-white/85",
                    "border-white/10 hover:border-white/20 hover:bg-black/60 transition-colors cursor-pointer",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    open && "border-rose-500/50 bg-black/60",
                    sizeClass,
                )}
            >
                <span className="flex min-w-0 items-center gap-2">
                    {kind === "input"
                        ? <Mic className={cn(iconSize, "shrink-0 text-rose-300/80")} />
                        : <Speaker className={cn(iconSize, "shrink-0 text-cyan-300/80")} />}
                    <span className="truncate font-medium">{currentLabel}</span>
                    {badge && (
                        <span className={cn("shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider", badge.tone)}>
                            {badge.label}
                        </span>
                    )}
                </span>
                <ChevronDown className={cn(iconSize, "shrink-0 text-white/40 transition-transform", open && "rotate-180")} />
            </button>

            {open && pos && portalTarget && createPortal(
                <div
                    ref={popoverRef}
                    id={popoverId}
                    role="listbox"
                    aria-label={`Pick ${kind === "input" ? "microphone" : "output"}`}
                    style={{
                        position: "fixed",
                        top: pos.placement === "below" ? pos.top : undefined,
                        bottom: pos.placement === "above" ? window.innerHeight - pos.top : undefined,
                        left: pos.left,
                        width: pos.width,
                        maxHeight: pos.maxHeight,
                    }}
                    className="z-[1000] flex flex-col overflow-hidden rounded-xl border border-white/10 bg-zinc-950/95 backdrop-blur-xl shadow-2xl shadow-black/70 ring-1 ring-white/[0.04]"
                >
                    {/* Search header */}
                    <div className="flex items-center gap-2 border-b border-white/[0.06] bg-zinc-950/95 px-2.5 py-2">
                        <Search className="w-3.5 h-3.5 shrink-0 text-white/40" />
                        <input
                            ref={searchRef}
                            type="text"
                            value={query}
                            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
                            onKeyDown={onSearchKey}
                            placeholder={`Search ${kind === "input" ? "microphones" : "outputs"}…`}
                            className="flex-1 bg-transparent text-[11px] text-white/90 placeholder:text-white/30 focus:outline-none"
                            autoComplete="off"
                            spellCheck={false}
                        />
                        {query && (
                            <button
                                type="button"
                                onClick={() => { setQuery(""); searchRef.current?.focus(); }}
                                className="rounded p-0.5 text-white/40 hover:bg-white/5 hover:text-white/80 cursor-pointer"
                                title="Clear search"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void devices.refresh(); }}
                            disabled={devices.loading}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-white/50 hover:bg-white/5 hover:text-white/90 disabled:opacity-50 cursor-pointer"
                            title="Re-scan devices"
                        >
                            {devices.loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                        </button>
                    </div>

                    {/* Body */}
                    <div className="flex-1 overflow-y-auto px-1 py-1">
                        {filtered.length === 0 ? (
                            <div className="px-3 py-6 text-center text-[10px] text-white/40">
                                No matches for <span className="text-white/70">&ldquo;{query}&rdquo;</span>
                            </div>
                        ) : (
                            <>
                                {browserCount > 0 && (
                                    <div className="px-2 pb-1 pt-1.5 text-[9px] font-bold uppercase tracking-wider text-white/40">
                                        <span className="inline-flex items-center gap-1.5">
                                            <MonitorSpeaker className="w-2.5 h-2.5" />
                                            Browser ({browserCount})
                                        </span>
                                    </div>
                                )}
                                {browserList.length === 0 && devices.permission !== "granted" && !query && (
                                    <div className="px-3 py-2 text-[10px] text-white/40">
                                        Grant microphone permission to reveal device names.
                                    </div>
                                )}
                                {filtered.map((it, idx) => {
                                    const showNativeHeader = it.source === "native" && (idx === 0 || filtered[idx - 1]!.source !== "native");
                                    return (
                                        <div key={it.key}>
                                            {showNativeHeader && (
                                                <div className="mt-1 border-t border-white/[0.06] px-2 pb-1 pt-2 text-[9px] font-bold uppercase tracking-wider">
                                                    <span className="inline-flex items-center gap-1.5 text-purple-300/80">
                                                        <Sparkles className="w-2.5 h-2.5" />
                                                        Companion · {backend} ({nativeCount})
                                                    </span>
                                                    {nativeDisabled && (
                                                        <span className="ml-2 text-[8px] normal-case text-white/30">{nativeDisabledHint ?? "Available in Live's native mode"}</span>
                                                    )}
                                                </div>
                                            )}
                                            <DeviceOption
                                                refCallback={(el) => { optionRefs.current[idx] = el; }}
                                                label={it.label}
                                                sublabel={it.sublabel}
                                                selected={value === it.value || (!value && it.value === "default")}
                                                active={idx === activeIdx}
                                                disabled={it.disabled}
                                                accent={it.accent}
                                                icon={iconForSource(it.source, kind)}
                                                onClick={() => choose(it)}
                                                onMouseEnter={() => setActiveIdx(idx)}
                                            />
                                        </div>
                                    );
                                })}
                            </>
                        )}
                    </div>

                    {!devices.nativeAvailable && (
                        <div className="border-t border-white/[0.06] px-3 py-2 text-[9px] uppercase tracking-wider text-white/30">
                            Companion not detected · install the desktop app for native low-latency devices
                        </div>
                    )}
                </div>,
                portalTarget,
            )}
        </div>
    );
}

function iconForSource(source: "default" | "browser" | "native", kind: AudioDeviceKind): React.ReactNode {
    if (source === "default") return <Sparkles className="w-3 h-3" />;
    if (source === "native") return <Sparkles className="w-3 h-3" />;
    return kind === "input" ? <Mic className="w-3 h-3" /> : <Headphones className="w-3 h-3" />;
}

interface DeviceOptionProps {
    label: string;
    sublabel?: string | null;
    selected?: boolean;
    active?: boolean;
    disabled?: boolean;
    icon?: React.ReactNode;
    accent?: "rose" | "purple" | "cyan";
    onClick: () => void;
    onMouseEnter?: () => void;
    refCallback?: (el: HTMLButtonElement | null) => void;
}

function DeviceOption({ label, sublabel, selected, active, disabled, icon, accent = "rose", onClick, onMouseEnter, refCallback }: DeviceOptionProps) {
    const accentRing =
        accent === "purple" ? "ring-purple-500/30 bg-purple-500/10 text-purple-100"
            : accent === "cyan" ? "ring-cyan-500/30 bg-cyan-500/10 text-cyan-100"
                : "ring-rose-500/30 bg-rose-500/10 text-rose-100";
    return (
        <button
            ref={refCallback}
            type="button"
            role="option"
            aria-selected={selected}
            disabled={disabled}
            onClick={onClick}
            onMouseEnter={onMouseEnter}
            className={cn(
                "group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-colors",
                "text-white/80 hover:bg-white/5 hover:text-white",
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                active && !selected && "bg-white/[0.06]",
                selected && cn("ring-1", accentRing),
                !selected && !disabled && "cursor-pointer",
            )}
        >
            <span className={cn("shrink-0 rounded-md border border-white/10 p-1", selected && "border-white/20")}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate font-medium leading-tight">{label}</span>
                {sublabel && <span className="block truncate text-[9px] uppercase tracking-wider text-white/40">{sublabel}</span>}
            </span>
            {selected && <span className="shrink-0 text-[8px] font-bold uppercase tracking-wider text-white/60">Selected</span>}
        </button>
    );
}
