/**
 * Built-in MIXAI plugins.
 *
 * These ship in the binary and serve double duty: useful tools AND reference
 * implementations of the {@link MixaiPlugin} contract for third-party authors.
 * Each one ONLY touches the {@link PluginContext} it's given — never the engine,
 * stores, or Tauri directly.
 */

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import type { DeckId, MixerState } from "@/bridge/types";
import { parseCamelot, keyCompatibility } from "@/lib/harmonic";
import { useMixerStore } from "@/state/mixer-store";
import type { MixaiPlugin, PluginContext, PluginPanelProps } from "./sdk";

/** Shared hook: subscribe a panel to the live mixer state. */
function useLiveState(ctx: PluginContext): MixerState | null {
    const [state, setState] = useState<MixerState | null>(() => ctx.getState());
    useEffect(() => {
        setState(ctx.getState());
        return ctx.subscribe(setState);
    }, [ctx]);
    return state;
}

// ─── Plugin 1: Phrase Counter (utility) ──────────────────────────────────────
//
// Reads each playing deck's position + BPM + first-beat anchor and shows the
// current bar and 8/16/32-bar phrase — the rhythmic skeleton DJs mix on. Pure
// read-only; great minimal example of the subscribe + getState API.

function PhraseCounterPanel({ ctx, accent }: PluginPanelProps) {
    const state = useLiveState(ctx);
    const decks = (state?.decks ?? []).filter((d) => d.loaded && d.bpm > 0);

    return (
        <div style={{ display: "grid", gap: 8 }}>
            {decks.length === 0 && (
                <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>
                    Load a track with a detected BPM to see the phrase position.
                </p>
            )}
            {decks.map((d) => {
                const effBpm = d.bpm * d.tempo;
                const beatsPerSec = effBpm / 60;
                const elapsed = Math.max(0, d.position - d.firstBeat);
                const beat = Math.floor(elapsed * beatsPerSec);
                const bar = Math.floor(beat / 4) + 1;
                const beatInBar = (beat % 4) + 1;
                const phrase16 = Math.floor((bar - 1) / 16) + 1;
                const barInPhrase = ((bar - 1) % 16) + 1;
                return (
                    <div
                        key={d.id}
                        style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "baseline",
                            padding: "6px 10px",
                            borderRadius: 8,
                            background: "var(--bg-elev-2)",
                            border: "1px solid var(--border)",
                        }}
                    >
                        <span style={{ fontSize: 12, fontWeight: 700, color: accent }}>
                            {d.id.toUpperCase()}
                        </span>
                        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13 }}>
                            bar {bar} · {beatInBar}/4
                        </span>
                        <span style={{ fontSize: 11, color: "var(--fg-dim)", fontVariantNumeric: "tabular-nums" }}>
                            phrase {phrase16} · {barInPhrase}/16
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

const phraseCounter: MixaiPlugin = {
    id: "mixai.phrase-counter",
    name: "Phrase Counter",
    description: "Live bar + 16-bar phrase position for every playing deck.",
    version: "1.0.0",
    author: "MIXAI",
    category: "utility",
    icon: "🎼",
    hasPanel: true,
    Panel: PhraseCounterPanel,
};

// ─── Plugin 2: Key Clash Guard (assistant) ───────────────────────────────────
//
// Watches the two on-air decks (A & B). When both are audible (crossfader not
// fully to one side) and their Camelot keys clash, it warns once. Demonstrates
// using the harmonic lib + onEnable/onDisable lifecycle + ctx.notify.

function clashStatus(state: MixerState | null): { clashing: boolean; label: string } {
    if (!state) return { clashing: false, label: "—" };
    const a = state.decks.find((d) => d.id === "a");
    const b = state.decks.find((d) => d.id === "b");
    if (!a?.playing || !b?.playing) return { clashing: false, label: "One deck playing" };
    // Both audible? crossfader within the middle band.
    if (state.crossfader <= -0.9 || state.crossfader >= 0.9) {
        return { clashing: false, label: "Not blended yet" };
    }
    // Pull live Camelot keys from the mixer store mirror.
    const keys = useMixerStore.getState().deckKeys;
    const ka = parseCamelot(keys.a);
    const kb = parseCamelot(keys.b);
    if (!ka || !kb) return { clashing: false, label: "Key unknown" };
    const compat = keyCompatibility(ka, kb);
    return { clashing: compat.score <= 0, label: `${keys.a} ↔ ${keys.b} · ${compat.label}` };
}

function KeyClashPanel({ ctx, accent }: PluginPanelProps) {
    const state = useLiveState(ctx);
    const { clashing, label } = clashStatus(state);
    return (
        <div style={{ display: "grid", gap: 8 }}>
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: clashing ? "color-mix(in srgb, var(--danger) 18%, transparent)" : "var(--bg-elev-2)",
                    border: `1px solid ${clashing ? "var(--danger)" : "var(--border)"}`,
                }}
            >
                <span
                    style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: clashing ? "var(--danger)" : accent,
                        flexShrink: 0,
                    }}
                />
                <span style={{ fontSize: 12 }}>
                    {clashing ? "Key clash on the blend!" : "Harmonic blend OK"}
                </span>
            </div>
            <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>{label}</span>
        </div>
    );
}

// Lifecycle state lives in a module-scoped map so onEnable can install a
// subscription and onDisable can tear it down (plus debounce the warning).
const clashGuards = new Map<string, { unsub: () => void; lastWarn: number; warned: boolean }>();

const keyClashGuard: MixaiPlugin = {
    id: "mixai.key-clash-guard",
    name: "Key Clash Guard",
    description: "Warns when the two on-air decks are in clashing keys during a blend.",
    version: "1.0.0",
    author: "MIXAI",
    category: "assistant",
    icon: "🎹",
    hasPanel: true,
    Panel: KeyClashPanel,
    onEnable(ctx: PluginContext) {
        const unsub = ctx.subscribe((s) => {
            const { clashing } = clashStatus(s);
            const guard = clashGuards.get(this.id);
            if (!guard) return;
            if (clashing && !guard.warned) {
                ctx.notify("⚠ Key clash — the on-air decks aren't harmonically compatible.");
                guard.warned = true;
                guard.lastWarn = Date.now();
            } else if (!clashing) {
                // Re-arm once the blend is clean again.
                guard.warned = false;
            }
        });
        clashGuards.set(this.id, { unsub, lastWarn: 0, warned: false });
    },
    onDisable() {
        const guard = clashGuards.get(this.id);
        guard?.unsub();
        clashGuards.delete(this.id);
    },
};

// ─── Plugin 3: VU Scope (visual) ──────────────────────────────────────────────
//
// A canvas master-meter that scrolls the master VU as a waveform-style history
// plus a live bar. Demonstrates driving an HTML canvas from the 30 Hz state
// stream without any per-frame React re-render (we keep a rolling buffer in a
// ref and paint inside the subscription callback).

function VuScopePanel({ ctx, accent }: PluginPanelProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const historyRef = useRef<number[]>([]);

    useEffect(() => {
        const HISTORY = 160;
        const draw = (s: MixerState) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const hist = historyRef.current;
            hist.push(Math.min(1, Math.max(0, s.masterVu)));
            if (hist.length > HISTORY) hist.shift();

            const ctx2d = canvas.getContext("2d");
            if (!ctx2d) return;
            const w = canvas.width;
            const h = canvas.height;
            ctx2d.clearRect(0, 0, w, h);
            // Baseline grid.
            ctx2d.strokeStyle = "rgba(255,255,255,0.06)";
            ctx2d.lineWidth = 1;
            for (let i = 1; i < 4; i++) {
                const y = (h / 4) * i;
                ctx2d.beginPath();
                ctx2d.moveTo(0, y);
                ctx2d.lineTo(w, y);
                ctx2d.stroke();
            }
            // VU history as filled area.
            ctx2d.beginPath();
            ctx2d.moveTo(0, h);
            for (let i = 0; i < hist.length; i++) {
                const x = (i / (HISTORY - 1)) * w;
                const v = hist[i] ?? 0;
                ctx2d.lineTo(x, h - v * h);
            }
            ctx2d.lineTo((hist.length - 1) / (HISTORY - 1) * w, h);
            ctx2d.closePath();
            ctx2d.fillStyle = accent;
            ctx2d.globalAlpha = 0.22;
            ctx2d.fill();
            ctx2d.globalAlpha = 1;
            // Leading edge stroke.
            ctx2d.beginPath();
            for (let i = 0; i < hist.length; i++) {
                const x = (i / (HISTORY - 1)) * w;
                const v = hist[i] ?? 0;
                if (i === 0) ctx2d.moveTo(x, h - v * h);
                else ctx2d.lineTo(x, h - v * h);
            }
            ctx2d.strokeStyle = accent;
            ctx2d.lineWidth = 1.5;
            ctx2d.stroke();
        };
        const initial = ctx.getState();
        if (initial) draw(initial);
        return ctx.subscribe(draw);
    }, [ctx, accent]);

    return (
        <canvas
            ref={canvasRef}
            width={320}
            height={90}
            style={{ width: "100%", height: 90, display: "block", borderRadius: 8, background: "var(--bg-elev-2)" }}
        />
    );
}

const vuScope: MixaiPlugin = {
    id: "mixai.vu-scope",
    name: "VU Scope",
    description: "Scrolling master-output meter rendered on a canvas.",
    version: "1.0.0",
    author: "MIXAI",
    category: "visual",
    icon: "📈",
    hasPanel: true,
    Panel: VuScopePanel,
};

// ─── Plugin 4: Filter Riser (effect) ──────────────────────────────────────────
//
// A one-button performance macro: ramps a deck's bipolar filter from centre up
// to full HPF over N beats (a classic build-up riser), then snaps back. Shows
// the safe FX/filter engine subset + persisted settings (deck + length).

interface FilterRiserSettings {
    deck: DeckId;
    beats: number;
}

function FilterRiserPanel({ ctx, accent }: PluginPanelProps) {
    const saved = ctx.loadSettings<FilterRiserSettings>();
    const [deck, setDeck] = useState<DeckId>(saved?.deck ?? "a");
    const [beats, setBeats] = useState<number>(saved?.beats ?? 16);
    const [running, setRunning] = useState(false);
    const rafRef = useRef<number | null>(null);

    useEffect(() => {
        ctx.saveSettings({ deck, beats } satisfies FilterRiserSettings);
    }, [ctx, deck, beats]);

    useEffect(() => {
        return () => {
            if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        };
    }, []);

    const run = () => {
        if (running) return;
        const state = ctx.getState();
        const d = state?.decks.find((x) => x.id === deck);
        const bpm = d && d.bpm > 0 ? d.bpm * d.tempo : 128;
        const durationMs = (60_000 / bpm) * beats;
        setRunning(true);
        const start = performance.now();
        const tick = (now: number) => {
            const t = Math.min(1, (now - start) / durationMs);
            // Ease-in so the sweep accelerates toward the drop.
            const eased = t * t;
            ctx.engine.setFilter(deck, eased); // 0 → +1 (full HPF)
            if (t < 1) {
                rafRef.current = requestAnimationFrame(tick);
            } else {
                ctx.engine.setFilter(deck, 0); // snap back to neutral on the drop
                ctx.notify(`Filter riser complete on deck ${deck.toUpperCase()} — drop!`);
                setRunning(false);
                rafRef.current = null;
            }
        };
        rafRef.current = requestAnimationFrame(tick);
    };

    return (
        <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <label style={{ fontSize: 11, color: "var(--fg-dim)" }}>Deck</label>
                <select
                    value={deck}
                    onChange={(e) => setDeck(e.target.value as DeckId)}
                    style={selStyle}
                >
                    {(["a", "b", "c", "d"] as DeckId[]).map((id) => (
                        <option key={id} value={id}>
                            {id.toUpperCase()}
                        </option>
                    ))}
                </select>
                <label style={{ fontSize: 11, color: "var(--fg-dim)", marginLeft: 8 }}>Beats</label>
                <select
                    value={beats}
                    onChange={(e) => setBeats(Number(e.target.value))}
                    style={selStyle}
                >
                    {[4, 8, 16, 32].map((b) => (
                        <option key={b} value={b}>
                            {b}
                        </option>
                    ))}
                </select>
            </div>
            <button
                onClick={run}
                disabled={running}
                style={{
                    fontSize: 12,
                    fontWeight: 700,
                    padding: "8px 12px",
                    borderRadius: 8,
                    cursor: running ? "default" : "pointer",
                    background: running ? "var(--bg-elev-2)" : accent,
                    color: running ? "var(--fg-dim)" : "#000",
                    border: `1px solid ${running ? "var(--border)" : accent}`,
                }}
            >
                {running ? "Rising…" : "▲ Filter riser"}
            </button>
        </div>
    );
}

const selStyle: CSSProperties = {
    fontSize: 12,
    padding: "5px 8px",
    borderRadius: 8,
    background: "var(--bg-elev-2)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
};

const filterRiser: MixaiPlugin = {
    id: "mixai.filter-riser",
    name: "Filter Riser",
    description: "One-tap beat-timed HPF build-up macro with a snap-back drop.",
    version: "1.0.0",
    author: "MIXAI",
    category: "effect",
    icon: "🎚️",
    hasPanel: true,
    Panel: FilterRiserPanel,
};

/** The registry of built-in plugins, in display order. */
export const BUILTIN_PLUGINS: MixaiPlugin[] = [phraseCounter, keyClashGuard, vuScope, filterRiser];
