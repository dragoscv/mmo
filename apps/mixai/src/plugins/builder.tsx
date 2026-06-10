/**
 * Visual macro-plugin builder.
 *
 * Lets a user assemble a declarative {@link ExternalPluginSpec} through a form
 * — metadata plus macro buttons, each a sequence of curated engine steps — and
 * either install it directly or copy the shareable JSON. It's the friendly
 * front-end to the same loader that {@link ExternalLoader} accepts pasted JSON
 * through: no code, no `eval`, only the curated `PluginContext.engine`.
 */

import type { CSSProperties } from "react";
import { useState } from "react";
import type { DeckId } from "@/bridge/types";
import { usePluginStore } from "./plugin-store";
import type { PluginCategory } from "./sdk";
import {
    exportExternalSpec,
    normalizeHotkey,
    type ExternalPluginSpec,
    type MacroAction,
    type MacroButton,
    type MacroTrigger,
    type TriggerMetric,
} from "./external";

const DECKS: DeckId[] = ["a", "b", "c", "d"];
const CATEGORIES: PluginCategory[] = ["effect", "visual", "assistant", "utility"];
const METRICS: TriggerMetric[] = ["remaining", "position", "progress", "bpm", "volume"];
const ACTION_KINDS: MacroAction["kind"][] = [
    "play",
    "pause",
    "setVolume",
    "setEq",
    "setFilter",
    "setCrossfader",
    "sync",
    "setFxKind",
    "setFxWet",
    "setFxBeats",
    "notify",
    "wait",
];

const inputStyle: CSSProperties = {
    fontSize: 11,
    padding: "5px 7px",
    borderRadius: 6,
    background: "var(--bg-elev)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    minWidth: 0,
};
const selStyle: CSSProperties = { ...inputStyle, cursor: "pointer" };
const labelStyle: CSSProperties = { fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase" };

/** Build a default step for a freshly-chosen kind. */
function defaultStep(kind: MacroAction["kind"]): MacroAction {
    switch (kind) {
        case "play":
        case "pause":
        case "sync":
            return { kind, deck: "a" };
        case "setVolume":
        case "setFilter":
            return { kind, deck: "a", value: kind === "setVolume" ? 1 : 0 };
        case "setEq":
            return { kind: "setEq", deck: "a", band: "low", db: 0 };
        case "setCrossfader":
            return { kind: "setCrossfader", value: 0 };
        case "setFxKind":
            return { kind: "setFxKind", deck: "a", fx: 1 };
        case "setFxWet":
            return { kind: "setFxWet", deck: "a", wet: 0.5 };
        case "setFxBeats":
            return { kind: "setFxBeats", deck: "a", beats: 4 };
        case "notify":
            return { kind: "notify", message: "Hello from my plugin" };
        case "wait":
            return { kind: "wait", ms: 500 };
    }
}

function deckSelect(value: DeckId, onChange: (d: DeckId) => void) {
    return (
        <select value={value} onChange={(e) => onChange(e.target.value as DeckId)} style={selStyle}>
            {DECKS.map((d) => (
                <option key={d} value={d}>
                    Deck {d.toUpperCase()}
                </option>
            ))}
        </select>
    );
}

function numInput(value: number, onChange: (n: number) => void, step = 0.1) {
    return (
        <input
            type="number"
            value={value}
            step={step}
            onChange={(e) => onChange(Number(e.target.value))}
            style={{ ...inputStyle, width: 80 }}
        />
    );
}

/** Render the kind-specific fields of one step. */
function StepFields({ step, onChange }: { step: MacroAction; onChange: (s: MacroAction) => void }) {
    switch (step.kind) {
        case "play":
        case "pause":
        case "sync":
            return deckSelect(step.deck, (deck) => onChange({ ...step, deck }));
        case "setVolume":
        case "setFilter":
            return (
                <>
                    {deckSelect(step.deck, (deck) => onChange({ ...step, deck }))}
                    {numInput(step.value, (value) => onChange({ ...step, value }))}
                </>
            );
        case "setEq":
            return (
                <>
                    {deckSelect(step.deck, (deck) => onChange({ ...step, deck }))}
                    <select
                        value={step.band}
                        onChange={(e) => onChange({ ...step, band: e.target.value as "low" | "mid" | "high" })}
                        style={selStyle}
                    >
                        <option value="low">Low</option>
                        <option value="mid">Mid</option>
                        <option value="high">High</option>
                    </select>
                    {numInput(step.db, (db) => onChange({ ...step, db }), 1)}
                </>
            );
        case "setCrossfader":
            return numInput(step.value, (value) => onChange({ ...step, value }));
        case "setFxKind":
            return (
                <>
                    {deckSelect(step.deck, (deck) => onChange({ ...step, deck }))}
                    <select
                        value={step.fx}
                        onChange={(e) => onChange({ ...step, fx: Number(e.target.value) })}
                        style={selStyle}
                    >
                        <option value={0}>Off</option>
                        <option value={1}>Echo</option>
                        <option value={2}>Reverb</option>
                    </select>
                </>
            );
        case "setFxWet":
            return (
                <>
                    {deckSelect(step.deck, (deck) => onChange({ ...step, deck }))}
                    {numInput(step.wet, (wet) => onChange({ ...step, wet }))}
                </>
            );
        case "setFxBeats":
            return (
                <>
                    {deckSelect(step.deck, (deck) => onChange({ ...step, deck }))}
                    {numInput(step.beats, (beats) => onChange({ ...step, beats }), 1)}
                </>
            );
        case "notify":
            return (
                <input
                    value={step.message}
                    onChange={(e) => onChange({ ...step, message: e.target.value })}
                    style={{ ...inputStyle, flex: 1 }}
                    placeholder="Message"
                />
            );
        case "wait":
            return numInput(step.ms, (ms) => onChange({ ...step, ms }), 50);
    }
}

const btn = (bg: string, fg: string): CSSProperties => ({
    fontSize: 11,
    fontWeight: 700,
    padding: "5px 10px",
    borderRadius: 6,
    cursor: "pointer",
    background: bg,
    color: fg,
    border: `1px solid ${bg === "transparent" ? "var(--border)" : bg}`,
});

/** The collapsible builder, mounted under the Plugin Manager. */
export function PluginBuilder() {
    const installExternal = usePluginStore((s) => s.installExternal);
    const [open, setOpen] = useState(false);
    const [id, setId] = useState("my.macro-pack");
    const [name, setName] = useState("My Macro Pack");
    const [description, setDescription] = useState("Custom one-tap mix macros.");
    const [author, setAuthor] = useState("me");
    const [icon, setIcon] = useState("✨");
    const [category, setCategory] = useState<PluginCategory>("utility");
    const [buttons, setButtons] = useState<MacroButton[]>([
        { label: "Drop", steps: [{ kind: "play", deck: "b" }, { kind: "setCrossfader", value: 1 }] },
    ]);
    const [triggers, setTriggers] = useState<MacroTrigger[]>([]);
    const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

    function buildSpec(): ExternalPluginSpec {
        const spec: ExternalPluginSpec = { id, name, description, version: "1.0.0", author, category, icon, buttons };
        if (triggers.length > 0) spec.triggers = triggers;
        return spec;
    }

    function updateButton(i: number, patch: Partial<MacroButton>) {
        setButtons((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)));
    }
    function addButton() {
        setButtons((bs) => [...bs, { label: `Macro ${bs.length + 1}`, steps: [{ kind: "play", deck: "a" }] }]);
    }
    function removeButton(i: number) {
        setButtons((bs) => bs.filter((_, j) => j !== i));
    }
    function updateStep(bi: number, si: number, step: MacroAction) {
        setButtons((bs) => bs.map((b, j) => (j === bi ? { ...b, steps: b.steps.map((s, k) => (k === si ? step : s)) } : b)));
    }
    function addStep(bi: number) {
        setButtons((bs) => bs.map((b, j) => (j === bi ? { ...b, steps: [...b.steps, { kind: "play", deck: "a" }] } : b)));
    }
    function removeStep(bi: number, si: number) {
        setButtons((bs) => bs.map((b, j) => (j === bi ? { ...b, steps: b.steps.filter((_, k) => k !== si) } : b)));
    }

    // ── Triggers ──────────────────────────────────────────────────────────────
    function addTrigger() {
        setTriggers((ts) => [
            ...ts,
            {
                label: `Trigger ${ts.length + 1}`,
                deck: "a",
                metric: "remaining",
                op: "lt",
                value: 20,
                steps: [{ kind: "notify", message: "Heads up!" }],
            },
        ]);
    }
    function updateTrigger(i: number, patch: Partial<MacroTrigger>) {
        setTriggers((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
    }
    function removeTrigger(i: number) {
        setTriggers((ts) => ts.filter((_, j) => j !== i));
    }
    function updateTriggerStep(ti: number, si: number, step: MacroAction) {
        setTriggers((ts) =>
            ts.map((t, j) => (j === ti ? { ...t, steps: t.steps.map((s, k) => (k === si ? step : s)) } : t)),
        );
    }
    function addTriggerStep(ti: number) {
        setTriggers((ts) =>
            ts.map((t, j) => (j === ti ? { ...t, steps: [...t.steps, { kind: "notify", message: "..." }] } : t)),
        );
    }
    function removeTriggerStep(ti: number, si: number) {
        setTriggers((ts) =>
            ts.map((t, j) => (j === ti ? { ...t, steps: t.steps.filter((_, k) => k !== si) } : t)),
        );
    }

    function doInstall() {
        const err = installExternal(JSON.stringify(buildSpec()));
        setStatus(err ? { ok: false, msg: err } : { ok: true, msg: "Plugin installed." });
        if (!err) setTimeout(() => setStatus(null), 2400);
    }
    async function copyJson() {
        try {
            await navigator.clipboard.writeText(exportExternalSpec(buildSpec()));
            setStatus({ ok: true, msg: "JSON copied to clipboard." });
            setTimeout(() => setStatus(null), 2400);
        } catch {
            setStatus({ ok: false, msg: "Clipboard unavailable." });
        }
    }

    if (!open) {
        return (
            <button onClick={() => setOpen(true)} style={{ ...btn("transparent", "var(--fg)"), borderStyle: "dashed" }}>
                ✨ Build a macro plugin
            </button>
        );
    }

    return (
        <div
            style={{
                display: "grid",
                gap: 8,
                padding: 10,
                borderRadius: 8,
                background: "var(--bg-elev)",
                border: "1px solid var(--border)",
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>Macro plugin builder</span>
                <button onClick={() => setOpen(false)} style={{ ...btn("transparent", "var(--fg-dim)"), marginLeft: "auto" }}>
                    Close
                </button>
            </div>

            {/* Metadata */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                <label style={{ display: "grid", gap: 2 }}>
                    <span style={labelStyle}>Id</span>
                    <input value={id} onChange={(e) => setId(e.target.value)} style={inputStyle} />
                </label>
                <label style={{ display: "grid", gap: 2 }}>
                    <span style={labelStyle}>Name</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
                </label>
                <label style={{ display: "grid", gap: 2 }}>
                    <span style={labelStyle}>Author</span>
                    <input value={author} onChange={(e) => setAuthor(e.target.value)} style={inputStyle} />
                </label>
                <label style={{ display: "grid", gap: 2 }}>
                    <span style={labelStyle}>Icon</span>
                    <input value={icon} onChange={(e) => setIcon(e.target.value)} style={inputStyle} maxLength={2} />
                </label>
                <label style={{ display: "grid", gap: 2 }}>
                    <span style={labelStyle}>Category</span>
                    <select value={category} onChange={(e) => setCategory(e.target.value as PluginCategory)} style={selStyle}>
                        {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                                {c}
                            </option>
                        ))}
                    </select>
                </label>
                <label style={{ display: "grid", gap: 2, gridColumn: "1 / -1" }}>
                    <span style={labelStyle}>Description</span>
                    <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} />
                </label>
            </div>

            {/* Buttons */}
            {buttons.map((b, bi) => (
                <div
                    key={bi}
                    style={{ display: "grid", gap: 6, padding: 8, borderRadius: 6, border: "1px solid var(--border)" }}
                >
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                            value={b.label}
                            onChange={(e) => updateButton(bi, { label: e.target.value })}
                            style={{ ...inputStyle, flex: 1, fontWeight: 700 }}
                            placeholder="Button label"
                        />
                        <input
                            value={b.hotkey ?? ""}
                            onChange={(e) => updateButton(bi, { hotkey: e.target.value })}
                            onBlur={(e) =>
                                updateButton(bi, { hotkey: normalizeHotkey(e.target.value) ?? undefined })
                            }
                            style={{ ...inputStyle, width: 90 }}
                            placeholder="hotkey"
                            title="Optional global hotkey, e.g. shift+a"
                        />
                        <button onClick={() => removeButton(bi)} style={btn("transparent", "var(--fg-dim)")} title="Remove button">
                            ✕
                        </button>
                    </div>
                    {b.steps.map((s, si) => (
                        <div key={si} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <select
                                value={s.kind}
                                onChange={(e) => updateStep(bi, si, defaultStep(e.target.value as MacroAction["kind"]))}
                                style={selStyle}
                            >
                                {ACTION_KINDS.map((k) => (
                                    <option key={k} value={k}>
                                        {k}
                                    </option>
                                ))}
                            </select>
                            <StepFields step={s} onChange={(ns) => updateStep(bi, si, ns)} />
                            <button
                                onClick={() => removeStep(bi, si)}
                                style={{ ...btn("transparent", "var(--fg-dim)"), marginLeft: "auto" }}
                                title="Remove step"
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                    <button onClick={() => addStep(bi)} style={btn("transparent", "var(--fg)")}>
                        + Add step
                    </button>
                </div>
            ))}
            <button onClick={addButton} style={btn("transparent", "var(--fg)")}>
                + Add button
            </button>

            {/* Automation triggers */}
            <span style={{ ...labelStyle, marginTop: 4 }}>Automation triggers (optional)</span>
            {triggers.map((t, ti) => (
                <div
                    key={ti}
                    style={{ display: "grid", gap: 6, padding: 8, borderRadius: 6, border: "1px solid var(--border)" }}
                >
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                            value={t.label}
                            onChange={(e) => updateTrigger(ti, { label: e.target.value })}
                            style={{ ...inputStyle, flex: 1, fontWeight: 700 }}
                            placeholder="Trigger label"
                        />
                        <button onClick={() => removeTrigger(ti)} style={btn("transparent", "var(--fg-dim)")} title="Remove trigger">
                            ✕
                        </button>
                    </div>
                    {/* Condition row: when <deck> <metric> <op> <value> */}
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>When</span>
                        {deckSelect(t.deck, (deck) => updateTrigger(ti, { deck }))}
                        <select
                            value={t.metric}
                            onChange={(e) => updateTrigger(ti, { metric: e.target.value as TriggerMetric })}
                            style={selStyle}
                        >
                            {METRICS.map((m) => (
                                <option key={m} value={m}>
                                    {m}
                                </option>
                            ))}
                        </select>
                        <select
                            value={t.op}
                            onChange={(e) => updateTrigger(ti, { op: e.target.value as "lt" | "gt" })}
                            style={selStyle}
                        >
                            <option value="lt">&lt;</option>
                            <option value="gt">&gt;</option>
                        </select>
                        {numInput(t.value, (value) => updateTrigger(ti, { value }), 1)}
                    </div>
                    {/* Cooldown */}
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>Cooldown ms</span>
                        {numInput(t.cooldownMs ?? 0, (ms) => updateTrigger(ti, { cooldownMs: ms > 0 ? ms : undefined }), 500)}
                    </div>
                    {/* Steps */}
                    {t.steps.map((s, si) => (
                        <div key={si} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <select
                                value={s.kind}
                                onChange={(e) => updateTriggerStep(ti, si, defaultStep(e.target.value as MacroAction["kind"]))}
                                style={selStyle}
                            >
                                {ACTION_KINDS.map((k) => (
                                    <option key={k} value={k}>
                                        {k}
                                    </option>
                                ))}
                            </select>
                            <StepFields step={s} onChange={(ns) => updateTriggerStep(ti, si, ns)} />
                            <button
                                onClick={() => removeTriggerStep(ti, si)}
                                style={{ ...btn("transparent", "var(--fg-dim)"), marginLeft: "auto" }}
                                title="Remove step"
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                    <button onClick={() => addTriggerStep(ti)} style={btn("transparent", "var(--fg)")}>
                        + Add step
                    </button>
                </div>
            ))}
            <button onClick={addTrigger} style={{ ...btn("transparent", "var(--fg)"), borderStyle: "dashed" }}>
                + Add trigger
            </button>

            {status && (
                <span style={{ fontSize: 11, color: status.ok ? "var(--accent)" : "#ff6b6b" }}>{status.msg}</span>
            )}
            <div style={{ display: "flex", gap: 6 }}>
                <button onClick={doInstall} style={btn("var(--accent)", "#000")}>
                    Install
                </button>
                <button onClick={copyJson} style={btn("transparent", "var(--fg)")}>
                    Copy JSON
                </button>
            </div>
        </div>
    );
}
