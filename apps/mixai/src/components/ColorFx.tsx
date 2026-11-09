import type { ColorFxKind, DeckId } from "@/bridge/types";
import { usePerfStore } from "@/state/perf-store";
import { useT, type MessageKey } from "@/i18n";
import { Knob } from "./Knob";

const KINDS: readonly { kind: ColorFxKind; label: MessageKey }[] = [
    { kind: "none", label: "fx.color.none" },
    { kind: "filter", label: "fx.color.filter" },
    { kind: "phaser", label: "fx.color.phaser" },
    { kind: "flanger", label: "fx.color.flanger" },
    { kind: "noise", label: "fx.color.noise" },
    { kind: "dub_echo", label: "fx.color.dubEcho" },
];

/** Per-deck colour FX (WP19-10): one selector + one bipolar knob (−1..1). */
export function ColorFx({ deckId, accent }: { deckId: DeckId; accent: string }) {
    const t = useT();
    const id = deckId.toUpperCase();
    const kind = usePerfStore((s) => s.decks[deckId].colorFx);
    const param = usePerfStore((s) => s.decks[deckId].colorParam);
    const setColorFx = usePerfStore((s) => s.setColorFx);

    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ display: "grid", gap: 3, flex: 1 }}>
                <span style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: "0.12em" }}>{t("fx.color.title")}</span>
                <select
                    value={kind}
                    onChange={(e) => setColorFx(deckId, e.target.value as ColorFxKind)}
                    aria-label={t("fx.color.selectAria", { id })}
                    style={{
                        background: "var(--bg-elev-2)",
                        color: "var(--fg)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        padding: "4px 6px",
                        fontSize: 11,
                        fontWeight: 700,
                    }}
                >
                    {KINDS.map((k) => (
                        <option key={k.kind} value={k.kind}>
                            {t(k.label)}
                        </option>
                    ))}
                </select>
            </label>
            <Knob
                size={38}
                value={param}
                min={-1}
                max={1}
                center={0}
                color={accent}
                disabled={kind === "none"}
                ariaLabel={t("fx.color.knobAria", { id })}
                format={(v) => (v >= 0 ? "+" : "") + v.toFixed(2)}
                onChange={(v) => setColorFx(deckId, kind, v)}
            />
        </div>
    );
}
