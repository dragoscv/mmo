import type { ColorFxKind, DeckId } from "@/bridge/types";
import { usePerfStore } from "@/state/perf-store";
import { useT, type MessageKey } from "@/i18n";
import { cn } from "@mmo/ui";
import { Knob } from "./Knob";

const KINDS: readonly { kind: ColorFxKind; label: MessageKey }[] = [
    { kind: "none", label: "fx.color.none" },
    { kind: "filter", label: "fx.color.filter" },
    { kind: "phaser", label: "fx.color.phaser" },
    { kind: "flanger", label: "fx.color.flanger" },
    { kind: "noise", label: "fx.color.noise" },
    { kind: "dub_echo", label: "fx.color.dubEcho" },
];

/** Colour FX type selector alone (the mixer channel shows the knob, the popover the select). */
export function ColorFxSelect({ deckId, className }: { deckId: DeckId; className?: string }) {
    const t = useT();
    const kind = usePerfStore((s) => s.decks[deckId].colorFx);
    const setColorFx = usePerfStore((s) => s.setColorFx);
    return (
        <select
            value={kind}
            onChange={(e) => setColorFx(deckId, e.target.value as ColorFxKind)}
            aria-label={t("fx.color.selectAria", { id: deckId.toUpperCase() })}
            className={cn("min-h-6 min-w-0", className)}
            style={{
                background: "var(--bg-elev-2)",
                color: "var(--fg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "0 6px",
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
    );
}

/** Colour FX bipolar amount knob (−1..1). The value line is shown only when there is no label and `showValue`. */
export function ColorFxKnob({
    deckId,
    accent,
    size = 38,
    label,
    showValue = true,
}: {
    deckId: DeckId;
    accent: string;
    size?: number;
    label?: string;
    showValue?: boolean;
}) {
    const t = useT();
    const kind = usePerfStore((s) => s.decks[deckId].colorFx);
    const param = usePerfStore((s) => s.decks[deckId].colorParam);
    const setColorFx = usePerfStore((s) => s.setColorFx);
    return (
        <Knob
            size={size}
            value={param}
            min={-1}
            max={1}
            center={0}
            color={accent}
            label={label}
            disabled={kind === "none"}
            ariaLabel={t("fx.color.knobAria", { id: deckId.toUpperCase() })}
            format={(v) => (v >= 0 ? "+" : "") + v.toFixed(2)}
            showValue={showValue && !label}
            onChange={(v) => setColorFx(deckId, kind, v)}
        />
    );
}

/** Per-deck colour FX (WP19-10): one selector + one bipolar knob (−1..1). `compact`: 30 px knob, no value line. */
export function ColorFx({ deckId, accent, compact = false }: { deckId: DeckId; accent: string; compact?: boolean }) {
    const t = useT();
    return (
        <div className="flex min-w-0 items-center gap-2">
            <label className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-[10px] tracking-[0.12em] text-[var(--fg-dim)]">{t("fx.color.title")}</span>
                <ColorFxSelect deckId={deckId} />
            </label>
            <ColorFxKnob deckId={deckId} accent={accent} size={compact ? 30 : 38} showValue={!compact} />
        </div>
    );
}
