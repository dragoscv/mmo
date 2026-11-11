import type { DeckId } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { useT, type MessageKey } from "@/i18n";
import { RadioCells } from "../deck-tabs/RadioCells";
import { setAssign, setCurve, type XfAssign, type XfCurve } from "./xfader-bridge";

const CURVES: readonly { curve: XfCurve; label: MessageKey; d: string }[] = [
    // Gain of side A (falling) and side B (rising) across the fader travel.
    { curve: "linear", label: "mix.curveLinear", d: "M1 1 L17 9 M1 9 L17 1" },
    { curve: "smooth", label: "mix.curveSmooth", d: "M1 1 C9 1 15 4 17 9 M1 9 C3 4 9 1 17 1" },
    { curve: "sharp", label: "mix.curveSharp", d: "M1 1 H13 L17 9 M1 9 L5 1 H17" },
];

/**
 * Crossfader curve: three cells (linear / smooth / sharp), each drawn as its gain law.
 * The choice is optimistic; an engine that refuses it gets the previous cell back (`xfader-bridge.ts`).
 * A real radio group (`RadioCells`): one tab stop, arrows / Home / End move and select.
 */
export function CurveSelect() {
    const t = useT();
    const curve = useMixerStore((s) => s.crossfaderCurve);
    return (
        <RadioCells
            label={t("mix.curve")}
            groupClass="mx-seg"
            value={curve}
            onChange={setCurve}
            options={CURVES.map((c) => ({
                value: c.curve,
                ariaLabel: t(c.label),
                title: t(c.label),
                label: (
                    <svg width={18} height={10} viewBox="0 0 18 10" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d={c.d} />
                    </svg>
                ),
            }))}
        />
    );
}

const SIDES: readonly { side: XfAssign; label: MessageKey; name: MessageKey }[] = [
    { side: "a", label: "mix.assignA", name: "mix.assignAName" },
    { side: "thru", label: "mix.assignThru", name: "mix.assignThruName" },
    { side: "b", label: "mix.assignB", name: "mix.assignBName" },
];

function AssignRow({ deckId }: { deckId: DeckId }) {
    const t = useT();
    const id = deckId.toUpperCase();
    const side = useMixerStore((s) => s.deck(deckId).crossfaderAssign);
    return (
        <div className="mx-row-between" style={{ ["--deck" as string]: `var(--deck-${deckId})` }}>
            <span className="mx-ch-id" aria-hidden>
                {id}
            </span>
            <RadioCells
                label={t("mix.assignDeck", { id })}
                groupClass="mx-seg"
                value={side}
                onChange={(next) => setAssign(deckId, next)}
                options={SIDES.map((s) => ({ value: s.side, label: t(s.label), ariaLabel: t(s.name), title: t(s.name) }))}
            />
        </div>
    );
}

/** Crossfader side of every channel (A / THRU / B). */
export function XfaderAssign({ decks }: { decks: DeckId[] }) {
    const t = useT();
    return (
        <section aria-label={t("mix.assign")} className="mx-assign">
            <span className="dk-label">{t("mix.assign")}</span>
            {decks.map((d) => (
                <AssignRow key={d} deckId={d} />
            ))}
        </section>
    );
}
