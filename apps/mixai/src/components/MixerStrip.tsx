import { motion } from "motion/react";
import { SlidersHorizontal, Sparkles } from "lucide-react";
import { cn } from "@mmo/ui";
import { engine } from "@/bridge/engine";
import type { DeckId } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { usePanelTier } from "@/layout/panel-tier";
import type { Tier } from "@/layout/types";
import { useT } from "@/i18n";
import { Knob } from "./Knob";
import { Fader } from "./Fader";
import { RoutingPanel } from "./RoutingPanel";
import { BeatFxUnit } from "./BeatFxUnit";
import { ColorFxKnob, ColorFxSelect } from "./ColorFx";
import { MorePopover, tierLayout, useElementSize, useMotionOK } from "./panel-ui";
import { MIXER, mixerFit, type MixerFit } from "./panel-fit";
import { useDeckUi } from "./deck-ui-store";

const accentFor = (deckId: DeckId) => (deckId === "a" || deckId === "c" ? "var(--accent-deck-a)" : "var(--accent-deck-b)");

/** All per-channel actions in one place (shared by every tier and the popovers). */
function useChannel(deckId: DeckId) {
    const deck = useMixerStore((s) => s.deck(deckId));
    const patchDeck = useMixerStore((s) => s.patchDeck);
    const trimDb = useDeckUi((s) => s.trimDb[deckId]);
    const setTrimDb = useDeckUi((s) => s.setTrimDb);
    return {
        deck,
        trimDb,
        setTrim: (db: number) => {
            setTrimDb(deckId, db);
            void engine.setDeckTrim(deckId, db);
        },
        setEq: (band: "low" | "mid" | "high", db: number) => {
            patchDeck(deckId, band === "low" ? { eqLow: db } : band === "mid" ? { eqMid: db } : { eqHigh: db });
            void engine.setEq(deckId, band, db);
        },
        setFilter: (v: number) => {
            patchDeck(deckId, { filter: v });
            void engine.setFilter(deckId, v);
        },
        setVolume: (v: number) => {
            patchDeck(deckId, { volume: v });
            void engine.setVolume(deckId, v);
        },
        toggleCue: () => {
            const next = !deck.cue;
            patchDeck(deckId, { cue: next });
            void engine.setCue(deckId, next);
        },
    };
}

const fmtDb = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1) + " dB";

function VuMeter({ level, deckId }: { level: number; deckId: DeckId }) {
    const t = useT();
    const pct = Math.round(Math.min(1, Math.max(0, level)) * 100);
    return (
        <div
            role="meter"
            aria-label={t("deckui.vuAria", { id: deckId.toUpperCase() })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="relative h-full w-1.5 shrink-0 overflow-hidden rounded-sm bg-[var(--bg-elev-2)]"
        >
            <div className="absolute inset-x-0 bottom-0" style={{ height: `${pct}%`, background: "linear-gradient(0deg, var(--good), var(--warn) 80%, var(--danger))" }} />
        </div>
    );
}

function CueToggle({ deckId, on, onToggle }: { deckId: DeckId; on: boolean; onToggle: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={on}
            aria-label={t("mixer.cueAria", { id: deckId.toUpperCase() })}
            title={t("mixer.cueHint")}
            className="inline-flex h-6 min-w-6 w-full max-w-14 items-center justify-center rounded-md text-[10px] font-bold focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
            style={{
                background: on ? "var(--good)" : "var(--bg-elev-2)",
                color: on ? "var(--accent-fg)" : "var(--fg)",
                // Not colour-only: pressed state also gets an inset ring.
                boxShadow: on ? "inset 0 0 0 2px var(--fg)" : "none",
            }}
        >
            {t("mixer.cue")}
        </button>
    );
}

/** One channel column; rows come from `mixerFit` so the stack always fits the measured box. */
function ChannelStrip({ deckId, tier, fit }: { deckId: DeckId; tier: Tier; fit: MixerFit }) {
    const t = useT();
    const id = deckId.toUpperCase();
    const accent = accentFor(deckId);
    const ch = useChannel(deckId);
    const { deck } = ch;
    const k = fit.knob;

    const knobs =
        tier === "full"
            ? [
                  <Knob key="trim" size={k} value={ch.trimDb} min={-24} max={12} center={0} label={t("deckui.trim")} ariaLabel={t("deckui.trimAria", { id })} format={fmtDb} showValue={false} onChange={ch.setTrim} />,
                  <Knob key="hi" size={k} value={deck.eqHigh} min={-26} max={6} center={0} label={t("deckui.eqHi")} ariaLabel={t("mixer.eqHighAria", { id })} onChange={(v) => ch.setEq("high", v)} />,
                  <Knob key="mid" size={k} value={deck.eqMid} min={-26} max={6} center={0} label={t("deckui.eqMid")} ariaLabel={t("mixer.eqMidAria", { id })} onChange={(v) => ch.setEq("mid", v)} />,
                  <Knob key="low" size={k} value={deck.eqLow} min={-26} max={6} center={0} label={t("deckui.eqLow")} ariaLabel={t("mixer.eqLowAria", { id })} onChange={(v) => ch.setEq("low", v)} />,
                  <Knob key="flt" size={k} value={deck.filter} min={-1} max={1} center={0} label={t("deckui.filter")} ariaLabel={t("mixer.filterAria", { id })} color={accent} onChange={ch.setFilter} />,
              ]
            : tier === "compact"
              ? [
                    <Knob key="low" size={k} value={deck.eqLow} min={-26} max={6} center={0} label={t("deckui.eqLow")} ariaLabel={t("mixer.eqLowAria", { id })} onChange={(v) => ch.setEq("low", v)} />,
                    <Knob key="flt" size={k} value={deck.filter} min={-1} max={1} center={0} label={t("deckui.filter")} ariaLabel={t("mixer.filterAria", { id })} color={accent} onChange={ch.setFilter} />,
                ]
              : [];

    const rows = [
        tier === "icon" ? null : `${MIXER.labelRow}px`,
        ...knobs.map(() => `${k + MIXER.knobLabel}px`),
        `minmax(${MIXER.faderMin[tier]}px, 1fr)`,
        `${MIXER.cueRow}px`,
    ].filter(Boolean);

    return (
        <div className="grid min-h-0 min-w-0 flex-1 justify-items-center" style={{ gridTemplateRows: rows.join(" "), rowGap: MIXER.gap }}>
            {tier !== "icon" && (
                <span className="text-[10px] font-bold leading-[14px]" style={{ color: accent }}>
                    {id}
                </span>
            )}
            {knobs}
            <div className="flex h-full min-h-0 items-stretch justify-center gap-1">
                <Fader value={deck.volume} color={accent} onChange={ch.setVolume} ariaLabel={t("mixer.volumeAria", { id })} height="100%" width={fit.faderWidth} />
                <VuMeter level={deck.vu} deckId={deckId} />
            </div>
            <CueToggle deckId={deckId} on={deck.cue} onToggle={ch.toggleCue} />
        </div>
    );
}

/** Every channel control, for popovers of the smaller tiers (nothing is ever lost). */
function ChannelDetails({ decks }: { decks: DeckId[] }) {
    return (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${decks.length}, minmax(0, 1fr))` }}>
            {decks.map((d) => (
                <ChannelDetail key={d} deckId={d} />
            ))}
        </div>
    );
}

function ChannelDetail({ deckId }: { deckId: DeckId }) {
    const t = useT();
    const id = deckId.toUpperCase();
    const accent = accentFor(deckId);
    const ch = useChannel(deckId);
    const { deck } = ch;
    const s = 34;
    return (
        <div className="grid justify-items-center gap-1.5">
            <span className="text-[10px] font-bold" style={{ color: accent }}>
                {id}
            </span>
            <Knob size={s} value={ch.trimDb} min={-24} max={12} center={0} label={t("deckui.trim")} ariaLabel={t("deckui.trimAria", { id })} format={fmtDb} onChange={ch.setTrim} />
            <Knob size={s} value={deck.eqHigh} min={-26} max={6} center={0} label={t("deckui.eqHi")} ariaLabel={t("mixer.eqHighAria", { id })} onChange={(v) => ch.setEq("high", v)} />
            <Knob size={s} value={deck.eqMid} min={-26} max={6} center={0} label={t("deckui.eqMid")} ariaLabel={t("mixer.eqMidAria", { id })} onChange={(v) => ch.setEq("mid", v)} />
            <Knob size={s} value={deck.eqLow} min={-26} max={6} center={0} label={t("deckui.eqLow")} ariaLabel={t("mixer.eqLowAria", { id })} onChange={(v) => ch.setEq("low", v)} />
            <Knob size={s} value={deck.filter} min={-1} max={1} center={0} label={t("deckui.filter")} ariaLabel={t("mixer.filterAria", { id })} color={accent} onChange={ch.setFilter} />
            <ColorFxSelect deckId={deckId} className="w-full max-w-24" />
            <ColorFxKnob deckId={deckId} accent={accent} size={s} label={t("deckui.colorFx")} />
        </div>
    );
}

function BeatFxPopover({ decks, side = "top" }: { decks: DeckId[]; side?: "top" | "bottom" }) {
    const t = useT();
    return (
        <MorePopover
            label={t("deckui.beatFxOpen")}
            title={t("fx.beat.title")}
            side={side}
            triggerClassName="inline-flex h-6 min-w-6 items-center justify-center gap-1 rounded-md bg-[var(--bg-elev-2)] px-1.5 text-[10px] font-bold text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
            triggerContent={
                <>
                    <Sparkles size={12} aria-hidden />
                    {t("deckui.fxShort")}
                </>
            }
            contentClassName="w-72"
        >
            <BeatFxUnit decks={decks} bare />
        </MorePopover>
    );
}

/**
 * The mixer, rendered for its tier. The panel measures itself and `mixerFit`
 * decides knob size and which optional sections fit inline (all maths is
 * unit-tested in panel-fit.test.ts); the rest moves into popovers.
 *  - full: per channel trim / hi / mid / low / filter, fader + VU, cue;
 *    phones/booth knobs in a bottom row; Beat FX inline only when it fits.
 *  - compact: per channel low + filter, fader, cue; everything else in popovers.
 *  - icon: faders + cue buttons; one popover holds every other control.
 */
export function MixerStrip({ decks }: { decks: DeckId[] }) {
    const t = useT();
    const tier = usePanelTier();
    const motionOK = useMotionOK();
    const lay = tierLayout(motionOK, tier, "mixer");
    const [ref, size] = useElementSize<HTMLElement>();
    const fit = mixerFit({ w: size.w, h: size.h, channels: decks.length, tier });

    const rows = [
        tier === "icon" ? `${MIXER.iconLabelRow}px` : null,
        "minmax(0, 1fr)",
        MIXER.bottom[tier] > 0 ? `${MIXER.bottom[tier]}px` : null,
        fit.beatFxInline ? `${MIXER.beatFx}px` : null,
    ].filter(Boolean);

    return (
        <section
            ref={ref}
            aria-label={t("deckui.mixer")}
            data-tier={tier}
            className="panel mixer-tier h-full w-full min-h-0 min-w-0 overflow-hidden p-2"
        >
            <div className="grid h-full min-h-0 min-w-0" style={{ gridTemplateRows: rows.join(" "), rowGap: MIXER.gap }}>
                {tier === "icon" && (
                    <div className="flex min-w-0 items-center justify-between gap-1">
                        <span className="truncate text-[10px] uppercase tracking-[0.12em] text-[var(--fg-dim)]">{t("deckui.mixer")}</span>
                        <MorePopover label={t("deckui.mixerMore")} icon={<SlidersHorizontal size={13} aria-hidden />} contentClassName="max-w-[min(92vw,30rem)]">
                            <ChannelDetails decks={decks} />
                            <RoutingPanel />
                            <BeatFxUnit decks={decks} />
                        </MorePopover>
                    </div>
                )}

                <motion.div {...lay("channels")} className="flex min-h-0 min-w-0 items-stretch" style={{ columnGap: MIXER.colGap }}>
                    {decks.map((id) => (
                        <ChannelStrip key={id} deckId={id} tier={tier} fit={fit} />
                    ))}
                </motion.div>

                {tier === "full" && (
                    <motion.div {...lay("bottom")} className="flex min-w-0 items-center justify-center gap-1.5 border-t border-[var(--border)]">
                        <RoutingPanel variant="inline" />
                        <MorePopover label={t("routing.title")} icon={<SlidersHorizontal size={13} aria-hidden />} side="top" contentClassName="max-w-[min(92vw,30rem)]">
                            <RoutingPanel />
                            <ChannelDetails decks={decks} />
                        </MorePopover>
                        {!fit.beatFxInline && <BeatFxPopover decks={decks} />}
                    </motion.div>
                )}

                {tier === "compact" && (
                    <motion.div {...lay("bottom")} className="flex min-w-0 items-center justify-center gap-1.5">
                        <MorePopover
                            label={t("deckui.mixerMore")}
                            side="top"
                            contentClassName="max-w-[min(92vw,30rem)]"
                            triggerClassName="inline-flex h-6 min-w-6 items-center justify-center gap-1 rounded-md bg-[var(--bg-elev-2)] px-1.5 text-[10px] font-bold text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                            triggerContent={
                                <>
                                    <SlidersHorizontal size={12} aria-hidden />
                                    {t("deckui.eqShort")}
                                </>
                            }
                        >
                            <ChannelDetails decks={decks} />
                            <RoutingPanel />
                        </MorePopover>
                        <BeatFxPopover decks={decks} />
                    </motion.div>
                )}

                {fit.beatFxInline && (
                    <motion.div {...lay("beatfx")} className={cn("min-h-0 overflow-hidden")}>
                        <BeatFxUnit decks={decks} />
                    </motion.div>
                )}
            </div>
        </section>
    );
}
