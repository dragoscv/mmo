import type { DeckId } from "@/bridge/types";
import { usePerfStore, type BeatFxUnit as Unit } from "@/state/perf-store";
import { BEAT_FX_FRACTIONS, formatBeats } from "@/lib/perf";
import { useT, type MessageKey } from "@/i18n";
import { Knob } from "./Knob";
import { ToggleChip } from "./ToggleChip";
import { RadioCells } from "./deck-tabs/RadioCells";

const KINDS: readonly { kind: Unit["kind"]; label: MessageKey }[] = [
    { kind: "echo", label: "fx.beat.echo" },
    { kind: "reverb", label: "fx.beat.reverb" },
    { kind: "roll", label: "fx.beat.roll" },
    { kind: "gate", label: "fx.beat.gate" },
];

/**
 * Beat FX unit (WP19-10), synced to the master clock: type, beat fraction (1/8..4), wet/dry,
 * on/off and the deck it is assigned to. `bare` drops the title when a popover already shows it.
 */
export function BeatFxUnit({ decks, bare = false }: { decks: DeckId[]; bare?: boolean }) {
    const t = useT();
    const fx = usePerfStore((s) => s.beatFx);
    const patch = usePerfStore((s) => s.patchBeatFx);
    const deckOptions = [...decks].sort();

    return (
        <section aria-label={t("fx.beat.title")} className="mx-beatfx" data-bare={bare}>
            <div className="mx-row-between">
                {!bare && <span className="dk-label">{t("fx.beat.title")}</span>}
                <ToggleChip size="xs" pressed={fx.on} onClick={() => patch({ on: !fx.on })} aria-label={t("fx.beat.onAria")}>
                    {fx.on ? t("fx.beat.on") : t("fx.beat.off")}
                </ToggleChip>
            </div>

            <RadioCells
                label={t("fx.beat.type")}
                groupClass="mx-seg mx-seg-fill"
                value={fx.kind}
                onChange={(kind) => patch({ kind })}
                options={KINDS.map((k) => ({ value: k.kind, label: t(k.label) }))}
            />

            <div className="mx-beatfx-row">
                <label className="mx-field">
                    <span className="dk-label">{t("fx.beat.beats")}</span>
                    <select value={fx.beats} onChange={(e) => patch({ beats: Number(e.target.value) })} className="mx-select dk-num">
                        {BEAT_FX_FRACTIONS.map((b) => (
                            <option key={b} value={b}>
                                {formatBeats(b)}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="mx-field">
                    <span className="dk-label">{t("fx.beat.deck")}</span>
                    <select value={fx.deck} onChange={(e) => patch({ deck: e.target.value as DeckId })} className="mx-select">
                        {deckOptions.map((d) => (
                            <option key={d} value={d}>
                                {d.toUpperCase()}
                            </option>
                        ))}
                    </select>
                </label>
                <Knob size={32} value={fx.wet} min={0} max={1} center={0.5} bipolar={false} label={t("fx.beat.wet")} ariaLabel={t("fx.beat.wetAria")} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => patch({ wet: v })} />
            </div>
        </section>
    );
}
