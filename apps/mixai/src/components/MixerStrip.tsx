import type { CSSProperties } from "react";
import { Headphones, SlidersHorizontal } from "lucide-react";
import { engine } from "@/bridge/engine";
import type { DeckId } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { usePanelTier } from "@/layout/panel-tier";
import { useT, type MessageKey } from "@/i18n";
import { Knob } from "./Knob";
import { Fader } from "./Fader";
import { RoutingPanel } from "./RoutingPanel";
import { BeatFxUnit } from "./BeatFxUnit";
import { ColorFx } from "./ColorFx";
import { MorePopover, useElementSize } from "./panel-ui";
import { MIXER, mixerFit, type KnobId, type MixerFit } from "./panel-fit";
import { useDeckUi } from "./deck-ui-store";
import { VuMeter } from "./mixer/VuMeter";
import { MasterKnob } from "./mixer/MasterKnob";
import { CurveSelect, XfaderAssign } from "./mixer/XfaderControls";
import { useAnnounceMixer } from "./mixer/presence";

const ALL_KNOBS: readonly KnobId[] = ["trim", "hi", "mid", "low", "filter"];

/** Hardware legends under the knobs (the accessible names are full sentences). */
const LEGEND: Record<KnobId, MessageKey> = {
    trim: "mix.legendTrim",
    hi: "mix.legendHi",
    mid: "mix.legendMid",
    low: "mix.legendLow",
    filter: "mix.legendFilter",
};

const deckVar = (deckId: DeckId) => ({ "--deck": `var(--deck-${deckId})` }) as CSSProperties;
const fmtDb = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} dB`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
/** Keyboard steps of the dB knobs: 0.5 dB per arrow, 0.1 dB with Shift, the same on both sides of 0. */
const DB_STEP = { step: 0.5, fineStep: 0.1 } as const;

/** Last trim the engine accepted per deck (its snapshot does not report trim). */
const trimAccepted: Partial<Record<DeckId, number>> = {};

/**
 * Channel trim, optimistic: the knob moves at once. A call the engine refuses puts the knob back
 * on the last value it accepted (unless a newer value was sent meanwhile), so the knob never shows
 * a gain the engine does not hold.
 */
function setTrim(deckId: DeckId, db: number): void {
    const ui = useDeckUi.getState();
    if (trimAccepted[deckId] === undefined) trimAccepted[deckId] = ui.trimDb[deckId];
    ui.setTrimDb(deckId, db);
    engine.setDeckTrim(deckId, db).then(
        () => {
            trimAccepted[deckId] = db;
        },
        () => {
            const now = useDeckUi.getState();
            if (now.trimDb[deckId] === db) now.setTrimDb(deckId, trimAccepted[deckId] ?? 0);
        },
    );
}

/** One channel knob. Subscribes to its own value only, so a playing deck does not re-render it. */
function ChannelKnob({ deckId, knob, size, showValue = false }: { deckId: DeckId; knob: KnobId; size: number; showValue?: boolean }) {
    const t = useT();
    const id = deckId.toUpperCase();
    const trimDb = useDeckUi((s) => s.trimDb[deckId]);
    const value = useMixerStore((s) => {
        const d = s.deck(deckId);
        return knob === "hi" ? d.eqHigh : knob === "mid" ? d.eqMid : knob === "low" ? d.eqLow : knob === "filter" ? d.filter : 0;
    });
    const legend = t(LEGEND[knob]);

    if (knob === "trim") {
        const set = (db: number) => setTrim(deckId, db);
        return <Knob size={size} value={trimDb} min={-24} max={12} center={0} {...DB_STEP} label={legend} ariaLabel={t("deckui.trimAria", { id })} format={fmtDb} showValue={showValue} onChange={set} />;
    }
    if (knob === "filter") {
        const set = (v: number) => {
            useMixerStore.getState().patchDeck(deckId, { filter: v });
            void engine.setFilter(deckId, v);
        };
        const format = (v: number) => (Math.abs(v) < 0.005 ? t("mix.filterOff") : v < 0 ? t("mix.filterLp", { n: pct(-v) }) : t("mix.filterHp", { n: pct(v) }));
        return <Knob size={size} value={value} min={-1} max={1} center={0} label={legend} ariaLabel={t("mixer.filterAria", { id })} format={format} showValue={showValue} onChange={set} />;
    }
    const band = knob === "hi" ? "high" : knob;
    const set = (db: number) => {
        useMixerStore.getState().patchDeck(deckId, band === "low" ? { eqLow: db } : band === "mid" ? { eqMid: db } : { eqHigh: db });
        void engine.setEq(deckId, band, db);
    };
    const aria = knob === "hi" ? t("mixer.eqHighAria", { id }) : knob === "mid" ? t("mixer.eqMidAria", { id }) : t("mixer.eqLowAria", { id });
    return <Knob size={size} value={value} min={-26} max={6} center={0} {...DB_STEP} label={legend} ariaLabel={aria} format={fmtDb} showValue={showValue} onChange={set} />;
}

function ChannelFader({ deckId, width }: { deckId: DeckId; width: number }) {
    const t = useT();
    const volume = useMixerStore((s) => s.deck(deckId).volume);
    const set = (v: number) => {
        useMixerStore.getState().patchDeck(deckId, { volume: v });
        void engine.setVolume(deckId, v);
    };
    return <Fader value={volume} onChange={set} ariaLabel={t("mixer.volumeAria", { id: deckId.toUpperCase() })} format={pct} width={width} />;
}

/** Headphone cue (PFL). ON = the accent + the inner line of `dk-btn`, plus `aria-pressed`. */
function CueToggle({ deckId, icon }: { deckId: DeckId; icon: boolean }) {
    const t = useT();
    const on = useMixerStore((s) => s.deck(deckId).cue);
    const toggle = () => {
        const next = !useMixerStore.getState().deck(deckId).cue;
        useMixerStore.getState().patchDeck(deckId, { cue: next });
        void engine.setCue(deckId, next);
    };
    return (
        <button type="button" onClick={toggle} aria-pressed={on} aria-label={t("mixer.cueAria", { id: deckId.toUpperCase() })} title={t("mixer.cueHint")} className="dk-btn mx-cue">
            {icon ? <Headphones size={13} aria-hidden /> : t("mixer.cue")}
        </button>
    );
}

/** Every control of one channel (popover content): five knobs with values, level meter, colour FX. */
function ChannelDetail({ deckId }: { deckId: DeckId }) {
    const t = useT();
    const id = deckId.toUpperCase();
    return (
        <section aria-label={t("mix.channel", { id })} className="mx-detail" style={deckVar(deckId)}>
            <div className="mx-detail-head">
                <span className="mx-ch-id" aria-hidden>
                    {id}
                </span>
                <VuMeter source={deckId} label={t("deckui.vuAria", { id })} orientation="horizontal" className="mx-detail-vu" />
            </div>
            <div className="mx-detail-knobs">
                {ALL_KNOBS.map((k) => (
                    <ChannelKnob key={k} deckId={deckId} knob={k} size={34} showValue />
                ))}
            </div>
            <ColorFx deckId={deckId} accent="var(--deck)" compact />
        </section>
    );
}

/** One channel column, drawn exactly as `fit` says. `side` mirrors the right half so the meters face the master column. */
function ChannelStrip({ deckId, fit, side }: { deckId: DeckId; fit: MixerFit; side: "left" | "right" }) {
    const t = useT();
    const id = deckId.toUpperCase();
    const detail = <ChannelDetail deckId={deckId} />;
    const knobs = fit.knobs.map((k) => <ChannelKnob key={k} deckId={deckId} knob={k} size={fit.knob} />);
    const knobCol = fit.knobs.length > 0 && (
        <div className="mx-knobs" style={{ width: fit.mode === "side" ? fit.knob + MIXER.knobColPad : undefined, maxHeight: fit.knobs.length * (fit.knob + MIXER.knobLabel + 14) }}>
            {knobs}
        </div>
    );
    const level = (
        <div className="mx-level" style={{ columnGap: fit.vuGap }}>
            <ChannelFader deckId={deckId} width={fit.faderW} />
            {fit.vuW > 0 && <VuMeter source={deckId} label={t("deckui.vuAria", { id })} className="mx-ch-vu" />}
        </div>
    );

    return (
        <div className="mx-ch" data-mode={fit.mode} data-side={side} style={{ ...deckVar(deckId), "--vu-w": `${fit.vuW}px` } as CSSProperties}>
            {fit.header === "label" && (
                <div className="mx-ch-head" aria-hidden>
                    <span className="mx-ch-id">{id}</span>
                </div>
            )}
            {fit.header === "button" && (
                <MorePopover label={t("mix.channelMore", { id })} title={t("mix.channel", { id })} side="bottom" triggerClassName="dk-btn mx-ch-btn" triggerContent={<span className="mx-ch-id">{id}</span>} contentClassName="mx-pop">
                    {detail}
                </MorePopover>
            )}
            <div className="mx-ch-body">
                {knobCol}
                {level}
            </div>
            <div className="mx-ch-foot">
                <CueToggle deckId={deckId} icon={fit.cueIcon} />
                {fit.header === "label" && (
                    <MorePopover label={t("mix.channelMore", { id })} title={t("mix.channel", { id })} side="top" icon={<SlidersHorizontal size={13} aria-hidden />} contentClassName="mx-pop">
                        {detail}
                    </MorePopover>
                )}
            </div>
        </div>
    );
}

/** Master column: level, meter, headphone sends, and the popover with everything else. */
function MasterColumn({ decks, fit }: { decks: DeckId[]; fit: MixerFit }) {
    const t = useT();
    return (
        <div className="mx-master" style={{ width: fit.masterW }}>
            {fit.master.knob && (
                <>
                    <span className="dk-label mx-master-label">{t("mix.masterShort")}</span>
                    <MasterKnob size={MIXER.masterKnob} />
                </>
            )}
            <VuMeter source="master" label={t("deckui.masterVuAria")} columns={2} className="mx-master-vu" />
            {fit.master.sends !== 0 && <RoutingPanel variant="column" count={fit.master.sends} />}
            <MorePopover label={t("mix.more")} title={t("deckui.mixer")} side="top" icon={<SlidersHorizontal size={13} aria-hidden />} contentClassName="mx-pop mx-pop-wide">
                {!fit.master.knob && (
                    <div className="mx-pop-master">
                        <MasterKnob size={40} label showValue />
                        <VuMeter source="master" label={t("deckui.masterVuAria")} orientation="horizontal" className="mx-detail-vu" />
                    </div>
                )}
                <RoutingPanel />
                <BeatFxUnit decks={decks} />
                <CurveSelect />
                <XfaderAssign decks={decks} />
                {fit.header === "none" && (
                    <div className="mx-pop-channels" data-many={decks.length > 2}>
                        {decks.map((d) => (
                            <ChannelDetail key={d} deckId={d} />
                        ))}
                    </div>
                )}
            </MorePopover>
        </div>
    );
}

/**
 * The mixer. It measures its own box; `mixerFit` (panel-fit.ts, unit-tested) decides what is
 * inline and how big, and this component renders exactly that:
 *  - channels (left half | master column | right half, mirrored): id, knobs beside the fader
 *    (wide channels) or stacked above it (narrow), fader + segmented level meter, CUE;
 *  - master column: master level + meter, cue mix / phones (/ booth) knobs when they fit;
 *  - popovers hold everything else: one per channel (all five knobs with values, colour FX)
 *    and "More" (routing, Beat FX, crossfader options; in the icon tier also every channel).
 */
export function MixerStrip({ decks }: { decks: DeckId[] }) {
    const t = useT();
    const tier = usePanelTier();
    useAnnounceMixer();
    const [ref, size] = useElementSize<HTMLElement>();
    const fit = mixerFit({ w: size.w, h: size.h, channels: decks.length, tier });
    const half = Math.ceil(decks.length / 2);

    return (
        <section ref={ref} aria-label={t("deckui.mixer")} data-tier={tier} className="panel mx-panel" style={{ padding: fit.pad, columnGap: MIXER.colGap }}>
            {size.w > 0 && (
                <>
                    {decks.slice(0, half).map((id) => (
                        <ChannelStrip key={id} deckId={id} fit={fit} side="left" />
                    ))}
                    <MasterColumn decks={decks} fit={fit} />
                    {decks.slice(half).map((id) => (
                        <ChannelStrip key={id} deckId={id} fit={fit} side="right" />
                    ))}
                </>
            )}
        </section>
    );
}
