/**
 * Practice mode: while it is on, the mix is sampled four times a second and scored
 * (./scoring.ts). Off = no timer, no subscription, nothing runs.
 *
 * The session itself lives outside the store (it changes on every sample); the store only
 * holds what the chip and the popover show, and is written only when one of those values
 * changed, so a steady mix renders nothing.
 */
import { create } from "zustand";
import { devExpose } from "@/dev/expose";
import { engine } from "@/bridge/engine";
import type { ClockState } from "@/bridge/types";
import { useDeckUi } from "@/components/deck-ui-store";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";
import { CRITERIA, addSample, buildSample, meterCells, newSession, summarize, type Criterion, type PracticeSession, type TipId } from "./scoring";

export const SAMPLE_MS = 250;
/** Cells of a criterion meter in the popover. */
export const METER_CELLS = 5;

export interface PracticeState {
    on: boolean;
    /** 0..100; null until two decks were in the mix. */
    score: number | null;
    /** Lit meter cells per criterion (0..METER_CELLS) and whether the criterion has data. */
    cells: Record<Criterion, number>;
    known: Record<Criterion, boolean>;
    tips: TipId[];
    /** Whole seconds with two decks in the mix. */
    mixSec: number;
    blends: number;
    /** Two decks are in the mix right now. */
    mixing: boolean;
    setOn: (on: boolean) => void;
    toggle: () => void;
    reset: () => void;
}

const all = <T,>(v: T): Record<Criterion, T> => ({ tempo: v, phase: v, key: v, level: v });

const EMPTY = { score: null, cells: all(0), known: all(false), tips: [] as TipId[], mixSec: 0, blends: 0, mixing: false };

let session: PracticeSession = newSession();
let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Publish the summary; only the values that changed are written. */
function publish(mixing: boolean): void {
    const sum = summarize(session);
    const cur = usePracticeStore.getState();
    const cells = all(0);
    const known = all(false);
    for (const c of CRITERIA) {
        cells[c] = meterCells(sum.sub[c], METER_CELLS);
        known[c] = sum.sub[c] !== null;
    }
    const patch: Partial<PracticeState> = {};
    if (cur.score !== sum.score) patch.score = sum.score;
    if (CRITERIA.some((c) => cur.cells[c] !== cells[c])) patch.cells = cells;
    if (CRITERIA.some((c) => cur.known[c] !== known[c])) patch.known = known;
    if (!sameList(cur.tips, sum.tips)) patch.tips = sum.tips;
    const mixSec = Math.floor(sum.mixSec);
    if (cur.mixSec !== mixSec) patch.mixSec = mixSec;
    if (cur.blends !== sum.blends) patch.blends = sum.blends;
    if (cur.mixing !== mixing) patch.mixing = mixing;
    if (Object.keys(patch).length > 0) usePracticeStore.setState(patch);
}

/** One sample from the mixer store as it is now and `clock` (default: the one in the perf store). */
function tick(clock: ClockState | null = usePerfStore.getState().clock): void {
    const mixer = useMixerStore.getState();
    // The trims live in the deck UI store (the engine snapshot has no trim).
    const x = buildSample(performance.now() / 1000, mixer, clock?.decks ?? null, mixer.deckKeys, useDeckUi.getState().trimDb);
    session = addSample(session, x);
    publish(x.bpmA !== null && x.bpmB !== null);
}

/**
 * The clock in the perf store is refreshed by `useClockPoll` only while a panel that shows it
 * is mounted. Practice must not depend on which panels the layout has, so in the desktop app
 * it reads the engine clock itself for every sample (one cheap call, four times a second, only
 * while on) and writes nothing shared. Outside the app (browser preview) there is no engine:
 * the perf store's clock is used as it is.
 */
function sampleNow(): void {
    if (polling) return;
    if (!useMixerStore.getState().native) {
        tick();
        return;
    }
    polling = true;
    let clock: ClockState | null = null;
    engine
        .clockState()
        .then((c) => {
            clock = c;
        })
        .catch(() => undefined)
        .finally(() => {
            polling = false;
            if (usePracticeStore.getState().on) tick(clock ?? usePerfStore.getState().clock);
        });
}

function start(): void {
    if (timer !== null) return;
    sampleNow();
    timer = setInterval(sampleNow, SAMPLE_MS);
}

function stop(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
}

export const usePracticeStore = create<PracticeState>((set, get) => ({
    on: false,
    ...EMPTY,
    setOn: (on) => {
        if (get().on === on) return;
        set({ on, mixing: false });
        // Turning it on continues the session; a gap in the samples counts as no time.
        if (on) start();
        else stop();
    },
    toggle: () => get().setOn(!get().on),
    reset: () => {
        session = newSession();
        set({ ...EMPTY, tips: [] });
    },
}));

devExpose("practice", usePracticeStore);
// CDP tests: the raw session and one forced sample.
devExpose("practiceDebug", { session: () => session, summary: () => summarize(session), tick: () => tick() });
