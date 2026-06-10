/**
 * External (declarative) plugins.
 *
 * The first step toward third-party plugins WITHOUT executing untrusted code:
 * a plugin can be described entirely as **data** — metadata plus a set of
 * "macro" buttons, where each button runs a sequence of curated engine actions.
 * The host compiles that JSON into a real {@link MixaiPlugin} (validated via the
 * same `isValidPlugin` contract) and renders a generated panel.
 *
 * This keeps the security story simple (no `eval`, no remote code — only the
 * curated `PluginContext.engine` surface is reachable) while still letting the
 * community share useful one-tap macros (drop transitions, kill-EQ slams,
 * filter sweeps, instant doubles, etc.). Code-bearing external plugins behind a
 * worker/iframe sandbox can come later on top of this same loader + manager UI.
 */

import type { CSSProperties } from "react";
import type { DeckId, DeckState } from "@/bridge/types";
import type { MixaiPlugin, PluginCategory, PluginContext, PluginPanelProps } from "./sdk";

/** A single curated engine action a macro step can perform. */
export type MacroAction =
    | { kind: "play"; deck: DeckId }
    | { kind: "pause"; deck: DeckId }
    | { kind: "setVolume"; deck: DeckId; value: number }
    | { kind: "setEq"; deck: DeckId; band: "low" | "mid" | "high"; db: number }
    | { kind: "setFilter"; deck: DeckId; value: number }
    | { kind: "setCrossfader"; value: number }
    | { kind: "sync"; deck: DeckId }
    | { kind: "setFxKind"; deck: DeckId; fx: number }
    | { kind: "setFxWet"; deck: DeckId; wet: number }
    | { kind: "setFxBeats"; deck: DeckId; beats: number }
    | { kind: "notify"; message: string }
    | { kind: "wait"; ms: number };

/** A labelled button that runs a sequence of {@link MacroAction}s. */
export interface MacroButton {
    label: string;
    steps: MacroAction[];
    /** Optional canonical keyboard shortcut (e.g. `"shift+a"`) that fires the
     *  macro globally while the plugin is enabled. Travels inside the spec so
     *  shared plugins keep their key bindings. */
    hotkey?: string;
}

/** The numeric facet of a deck a trigger can watch. */
export type TriggerMetric = "remaining" | "position" | "progress" | "bpm" | "volume";

/** A declarative automation trigger: when a deck metric crosses a threshold,
 *  run a macro. Edge-triggered (fires once per false→true transition) so it
 *  won't spam every state tick. */
export interface MacroTrigger {
    label: string;
    deck: DeckId;
    metric: TriggerMetric;
    op: "lt" | "gt";
    value: number;
    steps: MacroAction[];
    /** Minimum ms between re-fires after the condition resets. Default 0. */
    cooldownMs?: number;
}

/** The declarative plugin spec (JSON-serialisable, shareable). */
export interface ExternalPluginSpec {
    id: string;
    name: string;
    description: string;
    version: string;
    author: string;
    category: PluginCategory;
    icon: string;
    buttons: MacroButton[];
    /** Optional automation triggers (state-driven macros). */
    triggers?: MacroTrigger[];
}

const VALID_DECKS: ReadonlySet<string> = new Set(["a", "b", "c", "d"]);
const VALID_CATEGORIES: ReadonlySet<string> = new Set([
    "effect",
    "visual",
    "assistant",
    "utility",
]);
const VALID_METRICS: ReadonlySet<string> = new Set([
    "remaining",
    "position",
    "progress",
    "bpm",
    "volume",
]);

function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function deck(v: unknown): DeckId | null {
    return typeof v === "string" && VALID_DECKS.has(v) ? (v as DeckId) : null;
}
function str(v: unknown): v is string {
    return typeof v === "string" && v.length > 0;
}

// ── Hotkeys ───────────────────────────────────────────────────────────────────
const HOTKEY_MODS = ["ctrl", "alt", "shift", "meta"] as const;

/** Normalize a raw hotkey string (e.g. `"Shift + A"`) into a canonical form
 *  (`"shift+a"`), or null if it has no usable main key. Modifiers are sorted
 *  in a fixed order so two equivalent bindings always compare equal. */
export function normalizeHotkey(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const parts = raw
        .toLowerCase()
        .split("+")
        .map((p) => p.trim())
        .filter(Boolean);
    if (parts.length === 0) return null;
    const mods = new Set<string>();
    let key = "";
    for (const p of parts) {
        if (p === "control" || p === "ctrl") mods.add("ctrl");
        else if (p === "option" || p === "alt") mods.add("alt");
        else if (p === "shift") mods.add("shift");
        else if (p === "cmd" || p === "command" || p === "meta" || p === "win") mods.add("meta");
        else key = p;
    }
    if (!key) return null;
    const ordered = HOTKEY_MODS.filter((m) => mods.has(m));
    return [...ordered, key].join("+");
}

/** Build the canonical hotkey string for a live keyboard event. */
export function hotkeyFromEvent(e: KeyboardEvent): string {
    const mods: string[] = [];
    if (e.ctrlKey) mods.push("ctrl");
    if (e.altKey) mods.push("alt");
    if (e.shiftKey) mods.push("shift");
    if (e.metaKey) mods.push("meta");
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
    return [...mods, key].join("+");
}

/** Human-friendly label for a canonical hotkey (e.g. `"Shift + A"`). */
export function formatHotkey(hotkey: string): string {
    return hotkey
        .split("+")
        .map((p) => (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
        .join(" + ");
}

/** Validate one macro step, returning a typed action or null. */
function parseAction(raw: unknown): MacroAction | null {
    if (!raw || typeof raw !== "object") return null;
    const a = raw as Record<string, unknown>;
    switch (a.kind) {
        case "play":
        case "pause":
        case "sync": {
            const d = deck(a.deck);
            return d ? ({ kind: a.kind, deck: d } as MacroAction) : null;
        }
        case "setVolume":
        case "setFilter": {
            const d = deck(a.deck);
            const value = num(a.value);
            return d && value !== null ? ({ kind: a.kind, deck: d, value } as MacroAction) : null;
        }
        case "setEq": {
            const d = deck(a.deck);
            const db = num(a.db);
            const band = a.band === "low" || a.band === "mid" || a.band === "high" ? a.band : null;
            return d && band && db !== null ? { kind: "setEq", deck: d, band, db } : null;
        }
        case "setCrossfader": {
            const value = num(a.value);
            return value !== null ? { kind: "setCrossfader", value } : null;
        }
        case "setFxKind": {
            const d = deck(a.deck);
            const fx = num(a.fx);
            return d && fx !== null ? { kind: "setFxKind", deck: d, fx } : null;
        }
        case "setFxWet": {
            const d = deck(a.deck);
            const wet = num(a.wet);
            return d && wet !== null ? { kind: "setFxWet", deck: d, wet } : null;
        }
        case "setFxBeats": {
            const d = deck(a.deck);
            const beats = num(a.beats);
            return d && beats !== null ? { kind: "setFxBeats", deck: d, beats } : null;
        }
        case "notify":
            return str(a.message) ? { kind: "notify", message: a.message } : null;
        case "wait": {
            const ms = num(a.ms);
            return ms !== null ? { kind: "wait", ms: Math.max(0, Math.min(10000, ms)) } : null;
        }
        default:
            return null;
    }
}

/** Parse + validate a declarative plugin spec from a JSON string. */
export function parseExternalSpec(json: string): ExternalPluginSpec | null {
    try {
        const data = JSON.parse(json) as Record<string, unknown>;
        if (!str(data.id) || !str(data.name) || !str(data.version)) return null;
        if (!str(data.description) || !str(data.author) || !str(data.icon)) return null;
        if (typeof data.category !== "string" || !VALID_CATEGORIES.has(data.category)) return null;
        const rawButtons = Array.isArray(data.buttons) ? data.buttons : [];
        const buttons: MacroButton[] = [];
        for (const rb of rawButtons) {
            if (!rb || typeof rb !== "object") continue;
            const b = rb as Record<string, unknown>;
            if (!str(b.label)) continue;
            const steps = (Array.isArray(b.steps) ? b.steps : [])
                .map(parseAction)
                .filter((s): s is MacroAction => s !== null);
            if (steps.length === 0) continue;
            const hotkey = normalizeHotkey(b.hotkey);
            buttons.push(hotkey ? { label: b.label, steps, hotkey } : { label: b.label, steps });
        }
        if (buttons.length === 0) return null;
        const rawTriggers = Array.isArray(data.triggers) ? data.triggers : [];
        const triggers = rawTriggers
            .map(parseTrigger)
            .filter((t): t is MacroTrigger => t !== null);
        const spec: ExternalPluginSpec = {
            id: data.id,
            name: data.name,
            description: data.description,
            version: data.version,
            author: data.author,
            category: data.category as PluginCategory,
            icon: data.icon,
            buttons,
        };
        if (triggers.length > 0) spec.triggers = triggers;
        return spec;
    } catch {
        return null;
    }
}

/** Serialize a spec back to a shareable JSON string. */
export function exportExternalSpec(spec: ExternalPluginSpec): string {
    return JSON.stringify({ v: 1, ...spec }, null, 2);
}

/** Validate one automation trigger, returning a typed trigger or null. */
function parseTrigger(raw: unknown): MacroTrigger | null {
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    if (!str(t.label)) return null;
    const d = deck(t.deck);
    if (!d) return null;
    if (typeof t.metric !== "string" || !VALID_METRICS.has(t.metric)) return null;
    if (t.op !== "lt" && t.op !== "gt") return null;
    const value = num(t.value);
    if (value === null) return null;
    const steps = (Array.isArray(t.steps) ? t.steps : [])
        .map(parseAction)
        .filter((s): s is MacroAction => s !== null);
    if (steps.length === 0) return null;
    const cooldown = num(t.cooldownMs);
    const trigger: MacroTrigger = {
        label: t.label,
        deck: d,
        metric: t.metric as TriggerMetric,
        op: t.op,
        value,
        steps,
    };
    if (cooldown !== null && cooldown > 0) trigger.cooldownMs = Math.min(600000, cooldown);
    return trigger;
}

/** Read the watched metric from a deck state. */
export function readMetric(deckState: DeckState, metric: TriggerMetric): number {
    switch (metric) {
        case "remaining":
            return Math.max(0, deckState.duration - deckState.position);
        case "position":
            return deckState.position;
        case "progress":
            return deckState.duration > 0 ? deckState.position / deckState.duration : 0;
        case "bpm":
            return deckState.bpm * deckState.tempo;
        case "volume":
            return deckState.volume;
    }
}

/** Evaluate a trigger's condition against a metric value. */
export function triggerMet(trigger: MacroTrigger, metricValue: number): boolean {
    return trigger.op === "lt" ? metricValue < trigger.value : metricValue > trigger.value;
}

/** Run a macro's steps in order through the curated context. */
export async function runMacro(steps: MacroAction[], ctx: PluginContext): Promise<void> {
    for (const step of steps) {
        switch (step.kind) {
            case "play":
                ctx.engine.play(step.deck);
                break;
            case "pause":
                ctx.engine.pause(step.deck);
                break;
            case "setVolume":
                ctx.engine.setVolume(step.deck, step.value);
                break;
            case "setEq":
                ctx.engine.setEq(step.deck, step.band, step.db);
                break;
            case "setFilter":
                ctx.engine.setFilter(step.deck, step.value);
                break;
            case "setCrossfader":
                ctx.engine.setCrossfader(step.value);
                break;
            case "sync":
                ctx.engine.sync(step.deck);
                break;
            case "setFxKind":
                ctx.engine.setFxKind(step.deck, step.fx);
                break;
            case "setFxWet":
                ctx.engine.setFxWet(step.deck, step.wet);
                break;
            case "setFxBeats":
                ctx.engine.setFxBeats(step.deck, step.beats);
                break;
            case "notify":
                ctx.notify(step.message);
                break;
            case "wait":
                await new Promise((r) => setTimeout(r, step.ms));
                break;
        }
    }
}

const btnStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 700,
    padding: "8px 10px",
    borderRadius: 8,
    background: "var(--bg-elev-2)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    textAlign: "left",
};

/** The generated panel: one button per macro. */
function makePanel(spec: ExternalPluginSpec) {
    return function ExternalPanel({ ctx }: PluginPanelProps) {
        return (
            <div style={{ display: "grid", gap: 6 }}>
                {spec.buttons.map((b, i) => (
                    <button
                        key={`${b.label}-${i}`}
                        onClick={() => void runMacro(b.steps, ctx)}
                        style={{ ...btnStyle, display: "flex", alignItems: "center", gap: 8 }}
                    >
                        <span>{b.label}</span>
                        {b.hotkey && (
                            <span
                                style={{
                                    marginLeft: "auto",
                                    fontSize: 10,
                                    fontWeight: 600,
                                    padding: "2px 6px",
                                    borderRadius: 5,
                                    background: "var(--bg-elev)",
                                    border: "1px solid var(--border)",
                                    color: "var(--fg-dim)",
                                }}
                            >
                                {formatHotkey(b.hotkey)}
                            </span>
                        )}
                    </button>
                ))}
            </div>
        );
    };
}

/** Compile a validated spec into a real, host-ready plugin. */
export function compileExternalPlugin(spec: ExternalPluginSpec): MixaiPlugin {
    return {
        id: spec.id,
        name: spec.name,
        description: spec.description,
        version: spec.version,
        author: spec.author,
        category: spec.category,
        icon: spec.icon,
        hasPanel: true,
        Panel: makePanel(spec),
    };
}
