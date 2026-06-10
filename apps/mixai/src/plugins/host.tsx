/**
 * Plugin host UI: the dock that renders enabled plugin panels, the toast layer
 * for `ctx.notify`, and the manager used in the settings panel.
 */

import { usePluginStore } from "./plugin-store";
import type { MixaiPlugin } from "./sdk";
import { useEffect, useState } from "react";
import { PluginBuilder } from "./builder";
import { PLUGIN_CATALOG } from "./catalog";
import { hotkeyFromEvent, runMacro, readMetric, triggerMet } from "./external";
import type { MacroTrigger } from "./external";

/** Renders the panels of all enabled plugins that declare `hasPanel`. Mounted
 *  in the app's right rail. Renders nothing when no panel plugins are on. */
export function PluginDock({ accent = "var(--accent)" }: { accent?: string }) {
    const plugins = usePluginStore((s) => s.plugins);
    const enabled = usePluginStore((s) => s.enabled);
    const contextFor = usePluginStore((s) => s.contextFor);

    const active = plugins.filter((p) => p.hasPanel && p.Panel && enabled.includes(p.id));
    if (active.length === 0) return null;

    return (
        <>
            {active.map((p) => {
                const Panel = p.Panel!;
                return (
                    <div key={p.id} className="panel" style={{ padding: 12 }}>
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                marginBottom: 10,
                            }}
                        >
                            <span style={{ fontSize: 16 }}>{p.icon}</span>
                            <span style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</span>
                            <span style={{ fontSize: 10, color: "var(--fg-dim)", marginLeft: "auto" }}>
                                v{p.version}
                            </span>
                        </div>
                        <Panel ctx={contextFor(p.id)} accent={accent} />
                    </div>
                );
            })}
        </>
    );
}

/** Floating toast stack for plugin notifications. Mount once near the app root. */
export function PluginToasts() {
    const toasts = usePluginStore((s) => s.toasts);
    const dismiss = usePluginStore((s) => s.dismissToast);
    if (toasts.length === 0) return null;

    return (
        <div
            style={{
                position: "fixed",
                bottom: 16,
                left: "50%",
                transform: "translateX(-50%)",
                display: "grid",
                gap: 8,
                zIndex: 1000,
                pointerEvents: "none",
            }}
        >
            {toasts.map((t) => (
                <div
                    key={t.id}
                    onClick={() => dismiss(t.id)}
                    style={{
                        pointerEvents: "auto",
                        cursor: "pointer",
                        maxWidth: 420,
                        padding: "10px 14px",
                        borderRadius: 10,
                        background: "var(--bg-elev-2)",
                        border: "1px solid var(--border)",
                        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                        fontSize: 12,
                    }}
                >
                    {t.message}
                </div>
            ))}
        </div>
    );
}

/**
 * Global hotkey listener for enabled declarative plugins. Mount once near the
 * app root. While a plugin is enabled, any of its macro buttons that declare a
 * `hotkey` fires globally — making shared macros instantly playable. Typing
 * into an input/textarea/select is ignored so bindings never fight the UI.
 */
export function PluginHotkeys() {
    const enabled = usePluginStore((s) => s.enabled);
    const externalSpecs = usePluginStore((s) => s.externalSpecs);
    const contextFor = usePluginStore((s) => s.contextFor);

    useEffect(() => {
        // Build a hotkey → {pluginId, steps} map from enabled externals only.
        const bindings = new Map<string, { pluginId: string; steps: Parameters<typeof runMacro>[0] }>();
        for (const spec of externalSpecs) {
            if (!enabled.includes(spec.id)) continue;
            for (const b of spec.buttons) {
                if (b.hotkey && !bindings.has(b.hotkey)) {
                    bindings.set(b.hotkey, { pluginId: spec.id, steps: b.steps });
                }
            }
        }
        if (bindings.size === 0) return;

        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target) {
                const tag = target.tagName;
                if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
                    return;
                }
            }
            const match = bindings.get(hotkeyFromEvent(e));
            if (!match) return;
            e.preventDefault();
            void runMacro(match.steps, contextFor(match.pluginId));
        };

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [enabled, externalSpecs, contextFor]);

    return null;
}

/**
 * Automation runtime for enabled declarative plugins. Mount once near the app
 * root. Subscribes to the ~30 Hz mixer state stream and fires a trigger's macro
 * on the false→true edge of its condition (with an optional cooldown), so a
 * shared plugin can react to the mix (e.g. "deck A < 15s left → notify").
 */
export function PluginAutomation() {
    const enabled = usePluginStore((s) => s.enabled);
    const externalSpecs = usePluginStore((s) => s.externalSpecs);
    const contextFor = usePluginStore((s) => s.contextFor);

    useEffect(() => {
        // Collect active triggers from enabled externals; key each uniquely so
        // we can track its previous edge + last-fire timestamp across ticks.
        const active: { key: string; pluginId: string; trigger: MacroTrigger }[] = [];
        for (const spec of externalSpecs) {
            if (!enabled.includes(spec.id) || !spec.triggers) continue;
            spec.triggers.forEach((trigger, i) => {
                active.push({ key: `${spec.id}#${i}`, pluginId: spec.id, trigger });
            });
        }
        if (active.length === 0) return;

        const wasMet = new Map<string, boolean>();
        const lastFire = new Map<string, number>();

        // Reuse the curated context's state subscription (shared 30 Hz fan-out).
        const ctx = contextFor(active[0]!.pluginId);
        const unsub = ctx.subscribe((state) => {
            const now = Date.now();
            for (const { key, pluginId, trigger } of active) {
                const deckState = state.decks.find((d) => d.id === trigger.deck);
                if (!deckState) continue;
                const met = triggerMet(trigger, readMetric(deckState, trigger.metric));
                const prev = wasMet.get(key) ?? false;
                wasMet.set(key, met);
                if (met && !prev) {
                    const cooldown = trigger.cooldownMs ?? 0;
                    const last = lastFire.get(key) ?? 0;
                    if (now - last < cooldown) continue;
                    lastFire.set(key, now);
                    void runMacro(trigger.steps, contextFor(pluginId));
                }
            }
        });
        return unsub;
    }, [enabled, externalSpecs, contextFor]);

    return null;
}

/** The plugin manager: a list with enable/disable toggles. Rendered inside the
 *  settings panel. */
export function PluginManager() {
    const plugins = usePluginStore((s) => s.plugins);
    const enabled = usePluginStore((s) => s.enabled);
    const toggle = usePluginStore((s) => s.toggle);
    const isExternal = usePluginStore((s) => s.isExternal);
    const removeExternal = usePluginStore((s) => s.removeExternal);

    return (
        <div style={{ display: "grid", gap: 8 }}>
            <p style={{ fontSize: 12, color: "var(--fg-dim)" }}>
                Enable extensions that add panels, assistants and effects. Built-ins ship with
                MIXAI; the same SDK powers third-party plugins.
            </p>
            {plugins.map((p) => (
                <PluginRow
                    key={p.id}
                    plugin={p}
                    on={enabled.includes(p.id)}
                    onToggle={() => toggle(p.id)}
                    external={isExternal(p.id)}
                    onRemove={isExternal(p.id) ? () => removeExternal(p.id) : undefined}
                />
            ))}
            <ExternalLoader />
            <PluginBuilder />
            <PluginCatalog />
        </div>
    );
}

function PluginRow({
    plugin,
    on,
    onToggle,
    external,
    onRemove,
}: {
    plugin: MixaiPlugin;
    on: boolean;
    onToggle: () => void;
    external?: boolean;
    onRemove?: () => void;
}) {
    return (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 8,
                background: "var(--bg-elev-2)",
                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
            }}
        >
            <span style={{ fontSize: 18 }}>{plugin.icon}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{plugin.name}</span>
                    <span style={{ fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase" }}>
                        {plugin.category}
                    </span>
                    {external && (
                        <span
                            style={{
                                fontSize: 9,
                                fontWeight: 700,
                                color: "var(--accent)",
                                border: "1px solid var(--accent)",
                                borderRadius: 4,
                                padding: "1px 4px",
                                textTransform: "uppercase",
                            }}
                        >
                            External
                        </span>
                    )}
                </div>
                <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>{plugin.description}</div>
            </div>
            {onRemove && (
                <button
                    onClick={onRemove}
                    title="Remove plugin"
                    style={{
                        fontSize: 12,
                        fontWeight: 700,
                        padding: "5px 10px",
                        borderRadius: 8,
                        cursor: "pointer",
                        background: "transparent",
                        color: "var(--fg-dim)",
                        border: "1px solid var(--border)",
                    }}
                >
                    ✕
                </button>
            )}
            <button
                onClick={onToggle}
                style={{
                    fontSize: 12,
                    fontWeight: 700,
                    padding: "5px 12px",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: on ? "var(--accent)" : "transparent",
                    color: on ? "#000" : "var(--fg)",
                    border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                }}
            >
                {on ? "On" : "Off"}
            </button>
        </div>
    );
}

/** Paste-a-JSON-spec loader for declarative external plugins. */
function ExternalLoader() {
    const installExternal = usePluginStore((s) => s.installExternal);
    const [open, setOpen] = useState(false);
    const [text, setText] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [ok, setOk] = useState(false);

    function doInstall() {
        const err = installExternal(text);
        if (err) {
            setError(err);
            setOk(false);
        } else {
            setError(null);
            setOk(true);
            setText("");
            setTimeout(() => setOk(false), 2400);
        }
    }

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                style={{
                    fontSize: 12,
                    fontWeight: 700,
                    padding: "8px 12px",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: "transparent",
                    color: "var(--fg)",
                    border: "1px dashed var(--border)",
                }}
            >
                + Load plugin from JSON
            </button>
        );
    }

    return (
        <div style={{ display: "grid", gap: 6 }}>
            <p style={{ fontSize: 11, color: "var(--fg-dim)" }}>
                Paste a declarative plugin spec (JSON). These run only curated engine macros — no
                arbitrary code.
            </p>
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder='{ "id": "...", "name": "...", "buttons": [...] }'
                rows={6}
                spellCheck={false}
                style={{
                    fontSize: 11,
                    fontFamily: "monospace",
                    padding: 8,
                    borderRadius: 8,
                    background: "var(--bg-elev)",
                    color: "var(--fg)",
                    border: "1px solid var(--border)",
                    resize: "vertical",
                }}
            />
            {error && <span style={{ fontSize: 11, color: "#ff6b6b" }}>{error}</span>}
            {ok && <span style={{ fontSize: 11, color: "var(--accent)" }}>Plugin installed.</span>}
            <div style={{ display: "flex", gap: 6 }}>
                <button
                    onClick={doInstall}
                    disabled={text.trim().length === 0}
                    style={{
                        fontSize: 12,
                        fontWeight: 700,
                        padding: "6px 14px",
                        borderRadius: 8,
                        cursor: text.trim() ? "pointer" : "not-allowed",
                        background: "var(--accent)",
                        color: "#000",
                        border: "1px solid var(--accent)",
                        opacity: text.trim() ? 1 : 0.5,
                    }}
                >
                    Install
                </button>
                <button
                    onClick={() => {
                        setOpen(false);
                        setError(null);
                        setOk(false);
                    }}
                    style={{
                        fontSize: 12,
                        fontWeight: 700,
                        padding: "6px 14px",
                        borderRadius: 8,
                        cursor: "pointer",
                        background: "transparent",
                        color: "var(--fg)",
                        border: "1px solid var(--border)",
                    }}
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}

/** One-click catalog of ready-made macro plugins. Installs through the same
 *  validated `installExternal` path as pasted JSON / the builder. */
function PluginCatalog() {
    const installExternal = usePluginStore((s) => s.installExternal);
    const plugins = usePluginStore((s) => s.plugins);
    const [open, setOpen] = useState(false);

    if (!open) {
        return (
            <button
                onClick={() => setOpen(true)}
                style={{
                    fontSize: 12,
                    fontWeight: 700,
                    padding: "8px 12px",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: "transparent",
                    color: "var(--fg)",
                    border: "1px dashed var(--border)",
                }}
            >
                📦 Browse plugin catalog
            </button>
        );
    }

    return (
        <div style={{ display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>Plugin catalog</span>
                <button
                    onClick={() => setOpen(false)}
                    style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: "4px 10px",
                        borderRadius: 6,
                        cursor: "pointer",
                        background: "transparent",
                        color: "var(--fg-dim)",
                        border: "1px solid var(--border)",
                        marginLeft: "auto",
                    }}
                >
                    Close
                </button>
            </div>
            {PLUGIN_CATALOG.map((spec) => {
                const installed = plugins.some((p) => p.id === spec.id);
                return (
                    <div
                        key={spec.id}
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "8px 10px",
                            borderRadius: 8,
                            background: "var(--bg-elev-2)",
                            border: "1px solid var(--border)",
                        }}
                    >
                        <span style={{ fontSize: 18 }}>{spec.icon}</span>
                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                                <span style={{ fontSize: 13, fontWeight: 700 }}>{spec.name}</span>
                                <span style={{ fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase" }}>
                                    {spec.category}
                                </span>
                            </div>
                            <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>{spec.description}</div>
                        </div>
                        <button
                            onClick={() => installExternal(JSON.stringify(spec))}
                            disabled={installed}
                            style={{
                                fontSize: 12,
                                fontWeight: 700,
                                padding: "5px 12px",
                                borderRadius: 8,
                                cursor: installed ? "default" : "pointer",
                                background: installed ? "transparent" : "var(--accent)",
                                color: installed ? "var(--fg-dim)" : "#000",
                                border: `1px solid ${installed ? "var(--border)" : "var(--accent)"}`,
                            }}
                        >
                            {installed ? "Installed" : "Install"}
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
