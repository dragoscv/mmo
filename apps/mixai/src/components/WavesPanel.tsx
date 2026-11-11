/**
 * Waveform band: the scrolling waveforms of every deck in the layout, stacked (or side by
 * side when the box is taller than wide), with the phase meter and beat keeper between them.
 *
 * Drawing lives in `waves/stage.ts` (one frame loop for every lane, free while nothing plays)
 * and `waves/lane-paint.ts`; this file is the DOM around the canvases: lane header chips, the
 * seek surface of each deck, the beat keeper, the phase meter and the zoom buttons.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Minus, Plus } from "lucide-react";
import { engine } from "@/bridge/engine";
import type { ClockState, DeckId } from "@/bridge/types";
import { useDeckGrid } from "@/grid/grid-store";
import { gridFromDeck, type GridModel } from "@/grid/markers";
import { useT } from "@/i18n";
import { usePanelTier } from "@/layout/panel-tier";
import { formatBars, phaseOffset, remainWarn, remainingSec, splitTime } from "@/lib/deck-time";
import { useClockPoll } from "@/lib/use-clock-poll";
import { makeColorResolver, type ColorResolver } from "@/look/canvas-colors";
import { readLookNumber, useLookVersion, useWaveMode } from "@/look/look";
import { useMotionOK } from "@/shell/motion";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";
import { useWaveStore } from "@/state/wave-store";
import { WaveStage } from "./waves/stage";
import {
    DEFAULT_WINDOW_INDEX,
    PHASE_LOCK,
    WINDOWS,
    barsReadout,
    beatsPerBar as clockBeatsPerBar,
    cellIndex,
    dragTarget,
    effectiveTier,
    isVertical,
    parseBars,
    phaseScale,
    seekByBeats,
    stepWindow,
    type WaveTier,
} from "./waves/wave-math";

const deckVar = (id: DeckId) => ({ "--deck": `var(--deck-${id})` }) as CSSProperties;

/** The deck's grid as the lanes draw it: the edited grid, else the constant one of the track. */
function useLaneGrid(id: DeckId): GridModel | null {
    const trackId = useMixerStore((s) => s.deck(id).trackId);
    const bpm = useMixerStore((s) => s.deck(id).bpm);
    const firstBeat = useMixerStore((s) => s.deck(id).firstBeat);
    const ready = useMixerStore((s) => {
        const d = s.deck(id);
        return d.loaded && d.duration > 0;
    });
    const stored = useDeckGrid(id, trackId);
    return useMemo(() => (ready && bpm > 0 ? (stored ?? gridFromDeck(bpm, firstBeat)) : null), [ready, bpm, firstBeat, stored]);
}

/** Feeds one deck's drawing data to the stage. Renders only the colour probe element. */
function DeckFeed({ id, stage, flagsAtEnd }: { id: DeckId; stage: WaveStage; flagsAtEnd: boolean }) {
    const t = useT();
    const look = useLookVersion();
    const probe = useRef<HTMLElement>(null);
    const resolver = useRef<ColorResolver | null>(null);
    const trackId = useMixerStore((s) => s.deck(id).trackId);
    const stemsActive = useMixerStore((s) => s.deck(id).stemsActive);
    const bands = useWaveStore((s) => s.bands[id]);
    const stemLanes = useWaveStore((s) => s.stems[id]);
    const grid = useLaneGrid(id);
    // REV is not in the engine snapshot: the stage needs it to extrapolate in the right direction.
    const reverse = usePerfStore((s) => s.decks[id].reverse);
    // Between a load and the end of its decode the store may still hold the previous track's wave.
    const wave = bands && bands.trackId === trackId ? bands : null;
    const stems = stemsActive && stemLanes && stemLanes.trackId === trackId ? stemLanes : null;
    const stemLabels = useMemo(() => [t("waves.stemV"), t("waves.stemD"), t("waves.stemB"), t("waves.stemM")], [t]);

    useEffect(() => {
        const el = probe.current;
        if (!el) return;
        const r = makeColorResolver(el);
        resolver.current = r;
        return () => {
            resolver.current = null;
            r.dispose();
            stage.setLayer(id, null);
        };
    }, [id, stage]);
    useEffect(() => {
        const r = resolver.current;
        if (r) stage.setLayer(id, { wave, stems, grid, resolve: r, stemLabels, flagsAtEnd });
    }, [id, stage, wave, stems, grid, stemLabels, flagsAtEnd, look]);
    useEffect(() => {
        stage.setReverse(id, reverse);
    }, [id, stage, reverse]);

    return <i ref={probe} aria-hidden="true" className="dk-wave waves-probe" style={deckVar(id)} />;
}

function LaneCanvas({ stage, decks }: { stage: WaveStage; decks: readonly DeckId[] }) {
    const ref = useRef<HTMLCanvasElement>(null);
    const key = decks.join("");
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        return stage.addLane(el, key.split("") as DeckId[]);
    }, [stage, key]);
    return <canvas ref={ref} aria-hidden="true" className="waves-canvas" />;
}

/** Lane header chip: deck letter, BPM, bars to the next cue, remaining time. */
function LaneChip({ id, tier }: { id: DeckId; tier: WaveTier }) {
    const t = useT();
    const full = tier === "full";
    const grid = useLaneGrid(id);
    const bpb = usePerfStore((s) => clockBeatsPerBar(s.clock));
    const loaded = useMixerStore((s) => s.deck(id).loaded);
    const bpm = useMixerStore((s) => {
        const d = s.deck(id);
        return d.loaded && d.bpm > 0 ? (d.bpm * (d.tempo > 0 ? d.tempo : 1)).toFixed(1) : "";
    });
    const barsKey = useMixerStore((s) => (full ? barsReadout(s.deck(id), grid, bpb) : ""));
    const remain = useMixerStore((s) => {
        if (!full) return "";
        const d = s.deck(id);
        return d.loaded && d.duration > 0 ? splitTime(remainingSec(d)).main : "";
    });
    const warn = useMixerStore((s) => (full ? remainWarn(s.deck(id)) : "none"));
    const bars = barsKey ? parseBars(barsKey) : null;
    const dot = bpm.indexOf(".");
    return (
        <div className="waves-chip" style={deckVar(id)}>
            <span className="waves-letter">{id.toUpperCase()}</span>
            {!loaded ? <span className="dk-label">{t("waves.noTrack")}</span> : null}
            {bpm ? (
                <span className="dk-num dk-num-sm waves-bpm" title={t("waves.bpm")}>
                    {bpm.slice(0, dot)}
                    <span className="dk-num-frac">{bpm.slice(dot)}</span>
                </span>
            ) : null}
            {bars ? (
                <span
                    className="dk-num dk-num-sm waves-bars"
                    title={bars.cue > 0 ? t("waves.barsToCue", { n: formatBars(bars), cue: bars.cue }) : t("waves.barsToEnd", { n: formatBars(bars) })}
                >
                    {formatBars(bars)} <span className="dk-label">{t("waves.bars")}</span>
                </span>
            ) : null}
            {remain ? (
                <span className="dk-num dk-num-sm dk-time waves-remain" data-warn={warn} title={t("waves.remain")}>
                    −{remain}
                </span>
            ) : null}
        </div>
    );
}

interface SeekProps {
    id: DeckId;
    stage: WaveStage;
    vertical: boolean;
    windowSec: number;
    onZoom: (dir: -1 | 1) => void;
}

/** The seek surface of one deck: drag scrubs, arrows move by a beat, wheel / + / − zoom. */
function LaneSeek({ id, stage, vertical, windowSec, onZoom }: SeekProps) {
    const t = useT();
    const grid = useLaneGrid(id);
    const bpb = usePerfStore((s) => clockBeatsPerBar(s.clock));
    const duration = useMixerStore((s) => {
        const d = s.deck(id);
        return d.loaded && d.duration > 0 ? Math.floor(d.duration) : 0;
    });
    const now = useMixerStore((s) => Math.floor(s.deck(id).position));
    const drag = useRef<{ pointer: number; from: number; pos: number; pxPerSec: number; next: number; raf: number } | null>(null);
    const wheelAt = useRef(0);
    const can = duration > 0;

    const seekTo = (sec: number) => {
        const st = useMixerStore.getState();
        const d = st.deck(id);
        if (!d.loaded || !(d.duration > 0)) return;
        st.patchDeck(id, { position: sec });
        void engine.seek(id, sec);
    };
    const flush = () => {
        const d = drag.current;
        if (!d) return;
        d.raf = 0;
        seekTo(d.next);
    };
    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!can || e.button !== 0) return;
        const r = e.currentTarget.getBoundingClientRect();
        const len = vertical ? r.height : r.width;
        if (!(len > 0)) return;
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // A pointer that is already gone cannot be captured: the drag still works inside the lane.
        }
        drag.current = { pointer: e.pointerId, from: vertical ? e.clientY : e.clientX, pos: stage.positionOf(id), pxPerSec: len / windowSec, next: 0, raf: 0 };
    };
    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || d.pointer !== e.pointerId) return;
        const delta = (vertical ? e.clientY : e.clientX) - d.from;
        if (Math.abs(delta) < 2 && !d.raf && d.next === 0) return;
        d.next = dragTarget(d.pos, delta, d.pxPerSec, useMixerStore.getState().deck(id).duration);
        if (!d.raf) d.raf = requestAnimationFrame(flush);
    };
    const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d || d.pointer !== e.pointerId) return;
        if (d.raf) {
            cancelAnimationFrame(d.raf);
            flush();
        }
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    };
    useEffect(
        () => () => {
            if (drag.current?.raf) cancelAnimationFrame(drag.current.raf);
        },
        [],
    );
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        let beats = 0;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") beats = 1;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") beats = -1;
        else if (e.key === "+" || e.key === "=") onZoom(-1);
        else if (e.key === "-" || e.key === "_") onZoom(1);
        else if (e.key === "Home" && can) seekTo(0);
        else return;
        // The arrows are also global shortcuts (crossfader): here they belong to the lane.
        e.preventDefault();
        e.stopPropagation();
        if (beats === 0 || !can) return;
        const d = useMixerStore.getState().deck(id);
        seekTo(seekByBeats(grid, stage.positionOf(id), beats * (e.shiftKey ? bpb : 1), d.duration));
    };
    return (
        <div
            role="slider"
            tabIndex={0}
            className="waves-hit"
            aria-label={t("waves.lane", { id: id.toUpperCase() })}
            aria-description={t("waves.laneHint")}
            aria-orientation={vertical ? "vertical" : "horizontal"}
            aria-disabled={can ? undefined : true}
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={can ? Math.min(now, duration) : 0}
            aria-valuetext={can ? splitTime(now).main : t("waves.noTrack")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onKeyDown}
            onWheel={(e) => {
                if (e.deltaY === 0 || e.timeStamp - wheelAt.current < 140) return;
                wheelAt.current = e.timeStamp;
                onZoom(e.deltaY > 0 ? 1 : -1);
            }}
        />
    );
}

/**
 * Beat keeper of one deck: a cell per beat of the bar; the downbeat cell is wider. The lit
 * cell is written straight to the DOM from the clock store: no React render per beat.
 */
function BeatKeeper({ id }: { id: DeckId }) {
    const t = useT();
    const bpb = usePerfStore((s) => clockBeatsPerBar(s.clock));
    const root = useRef<HTMLSpanElement>(null);
    const name = id.toUpperCase();

    useEffect(() => {
        const el = root.current;
        if (!el) return;
        const cells = el.querySelectorAll<HTMLElement>(".waves-cell");
        for (const c of cells) c.dataset.on = "false";
        let last = -2;
        const apply = (clock: ClockState | null) => {
            const cell = cellIndex(clock, id);
            if (cell === last) return;
            const before = last >= 0 ? cells[last] : undefined;
            const now = cell >= 0 ? cells[cell] : undefined;
            if (before) before.dataset.on = "false";
            if (now) now.dataset.on = "true";
            last = cell;
            el.setAttribute("aria-label", cell >= 0 ? t("waves.beat", { id: name, beat: cell + 1, bar: bpb }) : t("waves.beatNone", { id: name }));
        };
        apply(usePerfStore.getState().clock);
        return usePerfStore.subscribe((s, prev) => {
            if (s.clock !== prev.clock) apply(s.clock);
        });
    }, [id, name, bpb, t]);

    return (
        <span ref={root} className="waves-keeper" role="img" style={deckVar(id)}>
            <span className="waves-keeper-id" aria-hidden="true">
                {name}
            </span>
            {Array.from({ length: bpb }, (_, i) => (
                <i key={i} className="dk-led waves-cell" data-downbeat={i === 0} />
            ))}
        </span>
    );
}

/**
 * Phase meter: one row per deck, always (the rows do not come and go with the master). A deck
 * that is off the master beat grows a bar from the centre tick to the side it is off by
 * (right = ahead); in phase = no bar and a diamond on the tick; the master's own row carries a
 * block on the tick (it is the reference). Written straight to the DOM from the clock store:
 * no React render per clock report.
 */
function PhaseMeter({ decks }: { decks: readonly DeckId[] }) {
    const t = useT();
    const coarse = !useMotionOK();
    const key = decks.join("");
    const rows = useRef<Partial<Record<DeckId, HTMLElement | null>>>({});

    useEffect(() => {
        const ids = key.split("") as DeckId[];
        const lastScale: Partial<Record<DeckId, number>> = {};
        const lastState: Partial<Record<DeckId, string>> = {};
        const lastPct: Partial<Record<DeckId, number>> = {};
        const apply = (clock: ClockState | null) => {
            const source = clock?.source ?? "internal";
            for (const id of ids) {
                const el = rows.current[id];
                if (!el) continue;
                const master = id === source;
                let dc = null;
                if (clock && !master) for (const d of clock.decks) if (d.id === id) dc = d;
                // A stopped deck has no phase: the internal clock keeps counting under it.
                const has = !!clock && !!dc && dc.bpm > 0 && clock.bpm > 0 && useMixerStore.getState().deck(id).playing;
                const off = has ? phaseOffset(dc!.beat, clock!.beat) : 0;
                const state = master ? "master" : !has ? "none" : Math.abs(off) < PHASE_LOCK ? "locked" : off > 0 ? "ahead" : "behind";
                const scale = state === "ahead" || state === "behind" ? phaseScale(off, coarse) : 0;
                if (lastScale[id] !== scale) {
                    lastScale[id] = scale;
                    el.style.setProperty("--phase", String(scale));
                }
                // The spoken value moves in 5 % steps of a beat.
                const pct = has ? Math.round((off * 100) / 5) * 5 : 0;
                if (lastState[id] !== state || lastPct[id] !== pct) {
                    lastState[id] = state;
                    lastPct[id] = pct;
                    el.dataset.state = state;
                    el.setAttribute("aria-valuenow", String(pct));
                    el.setAttribute(
                        "aria-valuetext",
                        master
                            ? t("waves.phaseMaster")
                            : !has
                              ? t("waves.phaseNone")
                              : state === "locked" || pct === 0
                                ? t("waves.phaseLocked")
                                : pct > 0
                                  ? t("waves.phaseAhead", { n: pct })
                                  : t("waves.phaseBehind", { n: -pct }),
                    );
                }
            }
        };
        apply(usePerfStore.getState().clock);
        return usePerfStore.subscribe((s, prev) => {
            if (s.clock !== prev.clock) apply(s.clock);
        });
    }, [key, coarse, t]);

    return (
        <div className="waves-phase" data-rows={decks.length}>
            {decks.map((id) => (
                <div
                    key={id}
                    ref={(el) => {
                        rows.current[id] = el;
                    }}
                    role="meter"
                    className="waves-phase-row"
                    style={deckVar(id)}
                    aria-label={t("waves.phaseAria", { id: id.toUpperCase() })}
                    aria-valuemin={-50}
                    aria-valuemax={50}
                >
                    <span className="waves-phase-bar" />
                </div>
            ))}
        </div>
    );
}

function ZoomButtons({ index, onZoom, readout }: { index: number; onZoom: (dir: -1 | 1) => void; readout: boolean }) {
    const t = useT();
    const sec = WINDOWS[index] ?? WINDOWS[DEFAULT_WINDOW_INDEX];
    const win = t("waves.windowAria", { n: sec });
    return (
        <div className="waves-zoom" role="group" aria-label={`${t("waves.zoom")}: ${win}`}>
            <button type="button" className="dk-btn dk-btn-xs dk-btn-icon" aria-label={t("waves.zoomOut")} title={`${t("waves.zoomOut")} (${win})`} disabled={index >= WINDOWS.length - 1} onClick={() => onZoom(1)}>
                <Minus size={12} aria-hidden="true" />
            </button>
            {readout ? (
                <span className="dk-num dk-num-sm waves-window" title={win}>
                    {t("waves.window", { n: sec })}
                </span>
            ) : null}
            <button type="button" className="dk-btn dk-btn-xs dk-btn-icon" aria-label={t("waves.zoomIn")} title={`${t("waves.zoomIn")} (${win})`} disabled={index <= 0} onClick={() => onZoom(-1)}>
                <Plus size={12} aria-hidden="true" />
            </button>
        </div>
    );
}

/**
 * DEV only: `window.__wavesDecks(["a", "b", "c", "d"])` shows these decks whatever the layout
 * holds (no layout has the waves panel next to four decks); `__wavesDecks()` puts the layout's
 * decks back. Not part of a production bundle's behaviour: the hook is never installed there.
 */
function useDeckList(layoutDecks: DeckId[]): DeckId[] {
    const [override, setOverride] = useState<DeckId[] | null>(null);
    useEffect(() => {
        if (!import.meta.env.DEV) return;
        const w = window as unknown as { __wavesDecks?: (decks?: DeckId[]) => string };
        w.__wavesDecks = (decks) => {
            const next = decks && decks.length > 0 ? decks.filter((d) => d === "a" || d === "b" || d === "c" || d === "d") : null;
            setOverride(next && next.length > 0 ? next : null);
            return next && next.length > 0 ? `waves decks: ${next.join("")}` : "waves decks: layout";
        };
        return () => {
            delete w.__wavesDecks;
        };
    }, []);
    return override ?? layoutDecks;
}

export function WavesPanel({ decks: layoutDecks }: { decks: DeckId[] }) {
    const decks = useDeckList(layoutDecks);
    const t = useT();
    const solverTier = usePanelTier();
    const mode = useWaveMode();
    const look = useLookVersion();
    const rootRef = useRef<HTMLElement>(null);
    const [box, setBox] = useState({ w: 0, h: 0 });
    const [zoom, setZoom] = useState<number>(DEFAULT_WINDOW_INDEX);
    const [stage] = useState(() => new WaveStage());
    const bpb = usePerfStore((s) => clockBeatsPerBar(s.clock));
    useClockPoll();

    useEffect(() => {
        const el = rootRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const measure = () => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const overlay = mode === "overlay" && decks.length > 1;
    const lanes = overlay ? 1 : decks.length;
    const vertical = isVertical(box.w, box.h);
    const tier = effectiveTier(solverTier, box.w, box.h, lanes);
    const windowSec = WINDOWS[zoom] ?? WINDOWS[DEFAULT_WINDOW_INDEX];
    const onZoom = (dir: -1 | 1) => setZoom((z) => stepWindow(z, dir));

    useEffect(() => stage.start(), [stage]);
    useEffect(() => {
        const el = rootRef.current;
        void look;
        stage.configure({
            windowSec,
            tier,
            vertical,
            halves: overlay,
            beatsPerBar: bpb,
            playedAlpha: Math.min(1, Math.max(0.1, readLookNumber("--wave-played-alpha", 0.4))),
            fontFamily: (el && getComputedStyle(el).fontFamily) || "sans-serif",
        });
    }, [stage, windowSec, tier, vertical, overlay, bpb, look]);

    const half = Math.ceil(decks.length / 2);
    const first = decks.slice(0, half);
    const second = decks.slice(half);
    // Room for the "Phase" label and the window readout next to the keepers and the meter.
    const roomy = !vertical && box.w >= 560 + decks.length * 60;
    const zoomEl = tier === "full" ? <ZoomButtons index={zoom} onZoom={onZoom} readout={roomy || vertical} /> : null;
    const strip =
        tier === "icon" ? null : (
            <div className="waves-strip" key="strip">
                <div className="waves-strip-side">
                    {tier === "full" && roomy ? <span className="dk-label">{t("waves.phase")}</span> : null}
                    <div className="waves-keepers">
                        {first.map((id) => (
                            <BeatKeeper key={id} id={id} />
                        ))}
                    </div>
                </div>
                {tier === "full" ? (
                    <div className="waves-strip-mid">
                        <PhaseMeter decks={decks} />
                        {vertical ? zoomEl : null}
                    </div>
                ) : null}
                <div className="waves-strip-side" data-side="end">
                    <div className="waves-keepers">
                        {second.map((id) => (
                            <BeatKeeper key={id} id={id} />
                        ))}
                    </div>
                    {vertical ? null : zoomEl}
                </div>
            </div>
        );

    /** Place of deck `i` inside its lane: the whole lane, or its share of an overlay lane. */
    const slotStyle = (i: number): CSSProperties | undefined => {
        if (!overlay) return undefined;
        const from = `${(i * 100) / decks.length}%`;
        const size = `${100 / decks.length}%`;
        return vertical ? { left: from, width: size } : { top: from, height: size };
    };
    const slot = (id: DeckId, i: number) => (
        <div key={id} className="waves-slot" style={slotStyle(i)} data-edge={i < half ? "start" : "end"}>
            <LaneSeek id={id} stage={stage} vertical={vertical} windowSec={windowSec} onZoom={onZoom} />
            {tier !== "icon" ? <LaneChip id={id} tier={tier} /> : null}
        </div>
    );

    const laneEls = overlay
        ? [
              <div key="all" className="waves-lane dk-wave">
                  <LaneCanvas stage={stage} decks={decks} />
                  {decks.map(slot)}
              </div>,
          ]
        : decks.map((id, i) => (
              <div key={id} className="waves-lane dk-wave" style={deckVar(id)}>
                  <LaneCanvas stage={stage} decks={[id]} />
                  {slot(id, i)}
              </div>
          ));
    // Stacked lanes: the strip sits between the two halves. Columns / overlay: under the lanes.
    const between = !vertical && !overlay && strip;

    return (
        <section
            ref={rootRef}
            aria-label={t("waves.title")}
            data-tier={tier}
            data-decks={decks.join("")}
            data-vertical={vertical ? "true" : "false"}
            data-mode={overlay ? "overlay" : "stacked"}
            data-dense={roomy || vertical ? "false" : "true"}
            data-many={decks.length > 2 ? "true" : "false"}
            className="panel waves h-full w-full min-h-0 min-w-0 overflow-hidden"
        >
            {decks.map((id, i) => (
                // The chip of the first lanes is at the top, so their flags go to the bottom (and vice versa).
                <DeckFeed key={id} id={id} stage={stage} flagsAtEnd={vertical || i < half} />
            ))}
            <div className="waves-lanes">
                {between ? [...laneEls.slice(0, half), strip, ...laneEls.slice(half)] : laneEls}
            </div>
            {between ? null : strip}
        </section>
    );
}
