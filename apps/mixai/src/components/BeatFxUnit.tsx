import type { DeckId } from "@/bridge/types";
import { usePerfStore, type BeatFxUnit as Unit } from "@/state/perf-store";
import { BEAT_FX_FRACTIONS, formatBeats } from "@/lib/perf";
import { useT, type MessageKey } from "@/i18n";
import { Knob } from "./Knob";
import { ToggleChip } from "./ToggleChip";

const KINDS: readonly { kind: Unit["kind"]; label: MessageKey }[] = [
    { kind: "echo", label: "fx.beat.echo" },
    { kind: "reverb", label: "fx.beat.reverb" },
    { kind: "roll", label: "fx.beat.roll" },
    { kind: "gate", label: "fx.beat.gate" },
];

/**
 * Beat FX unit (WP19-10), synced to the master clock: type, beat fraction
 * (1/8..4), wet/dry, on/off and the deck it is assigned to.
 */
export function BeatFxUnit({ decks }: { decks: DeckId[] }) {
    const t = useT();
    const fx = usePerfStore((s) => s.beatFx);
    const patch = usePerfStore((s) => s.patchBeatFx);
    const deckOptions = [...decks].sort();

    return (
        <section aria-label={t("fx.beat.title")} style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <span style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.12em" }}>{t("fx.beat.title")}</span>
                <ToggleChip size="xs" pressed={fx.on} onClick={() => patch({ on: !fx.on })} aria-label={t("fx.beat.onAria")}>
                    {fx.on ? t("fx.beat.on") : t("fx.beat.off")}
                </ToggleChip>
            </div>

            <div role="radiogroup" aria-label={t("fx.beat.type")} style={{ display: "flex", gap: 3, flexWrap: "wrap", justifyContent: "center" }}>
                {KINDS.map((k) => (
                    <ToggleChip
                        key={k.kind}
                        size="xs"
                        role="radio"
                        aria-checked={fx.kind === k.kind}
                        onClick={() => patch({ kind: k.kind })}
                        style={fx.kind === k.kind ? { background: "var(--accent)", color: "var(--accent-fg)" } : undefined}
                    >
                        {t(k.label)}
                    </ToggleChip>
                ))}
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}>
                <label style={{ display: "grid", gap: 3, fontSize: 9, color: "var(--fg-dim)" }}>
                    {t("fx.beat.beats")}
                    <select
                        value={fx.beats}
                        onChange={(e) => patch({ beats: Number(e.target.value) })}
                        className="mono"
                        style={{
                            background: "var(--bg-elev-2)",
                            color: "var(--fg)",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            padding: "3px 4px",
                            fontSize: 11,
                            fontWeight: 700,
                        }}
                    >
                        {BEAT_FX_FRACTIONS.map((b) => (
                            <option key={b} value={b}>
                                {formatBeats(b)}
                            </option>
                        ))}
                    </select>
                </label>
                <label style={{ display: "grid", gap: 3, fontSize: 9, color: "var(--fg-dim)" }}>
                    {t("fx.beat.deck")}
                    <select
                        value={fx.deck}
                        onChange={(e) => patch({ deck: e.target.value as DeckId })}
                        style={{
                            background: "var(--bg-elev-2)",
                            color: "var(--fg)",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            padding: "3px 4px",
                            fontSize: 11,
                            fontWeight: 700,
                        }}
                    >
                        {deckOptions.map((d) => (
                            <option key={d} value={d}>
                                {d.toUpperCase()}
                            </option>
                        ))}
                    </select>
                </label>
                <Knob
                    size={40}
                    value={fx.wet}
                    min={0}
                    max={1}
                    center={0.5}
                    label={t("fx.beat.wet")}
                    ariaLabel={t("fx.beat.wetAria")}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={(v) => patch({ wet: v })}
                />
            </div>
        </section>
    );
}
