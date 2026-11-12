/**
 * Co-pilot state (WP19-39): next-track suggestions against the playing deck, the set-builder
 * request, the transition plan and its run, and the set-safety warnings. The work is done by
 * the Rust `decks-transition` crate through `bridge/copilot.ts`; this store only gathers the
 * inputs (decks, library pool, play history) and keeps the answers.
 *
 * Nothing here runs by itself: the popover asks for a ranking while it is open, the toolbar
 * button asks for the safety check while a deck plays, and the shell pushes progress while a
 * transition runs. An idle app makes no call and no store update.
 *
 * Cost while the popover is open: a ranking sends every pool row to the shell, so the same
 * question is never asked twice (`rankKey`: playing track with its tempo on a half-BPM grid,
 * energy direction, pool, request, play history), triggers are debounced (`REFRESH_MS`), and
 * what is derived from a row (features, search text, tag words) is cached per row object.
 */
import { create } from "zustand";
import {
    copilot,
    isUnknownCommand,
    subscribeCopilotProgress,
    type EnergyDirection,
    type Intent,
    type PlanInfo,
    type Progress,
    type Ranked,
    type SafetyWarning,
    type TransitionStyle,
} from "@/bridge/copilot";
import { engine } from "@/bridge/engine";
import type { DeckId, DeckState, LibraryTrack } from "@/bridge/types";
import { devExpose } from "@/dev/expose";
import type { MessageKey } from "@/i18n";
import { loadLibraryTrack, restoreDeckWave } from "@/lib/load-track";
import { libraryNav } from "@/library/library-nav";
import { useLibraryPool } from "@/library/pool-store";
import { playedTonight, useHistoryStore } from "@/state/history-store";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";
import { candidates, deckFeat, errorKey, intentDeck, otherDeck, playingDeck, quantBpm, rankKey, referenceDeck, rowOf, trackChangedDeck } from "./features.ts";
import { applySetFilters, bareStopMeans, clipText, fold, hasAnyFilter, isBareStop, isCommandText, parseSetRequest, tagTokens, type SetFilters } from "./set-builder.ts";
import type { CountKind } from "./texts.ts";

/** Whether the running shell has the co-pilot commands. */
export type Availability = "unknown" | "yes" | "no";

export interface Suggestion {
    track: LibraryTrack;
    /** Score and reasons; null when the list is not ranked (no deck loaded, or no shell). */
    ranked: Ranked | null;
}

/** A status line: catalogue key + values; `detail` is the shell's own (English) message. */
export interface Note {
    key: MessageKey;
    vars?: Record<string, string | number>;
    /** Counted nouns of the message: variable name → what is counted (the view picks the plural form). */
    counts?: Record<string, { kind: CountKind; n: number }>;
    detail?: string;
    tone: "info" | "error";
}

/** The active set-builder request. */
export interface SetRequest {
    text: string;
    filters: SetFilters;
    /** Tracks of the pool that pass the filters. */
    matched: number;
}

export interface PlanOptions {
    bars?: number | null;
    style?: TransitionStyle | null;
}

/** Longest list the popover shows. */
export const MAX_SUGGESTIONS = 8;
/** Longest request, in characters (code points). */
export const MAX_ASK = 200;
/** Quiet time after the last trigger before the pool is ranked again. */
export const REFRESH_MS = 250;
/** The play history ages: a ranking is asked again at most this often for that reason alone. */
const HISTORY_BUCKET_MS = 5 * 60_000;

/** Counters for tests and the dev console (`window.__decksExt.copilotStats`). */
export const copilotStats = {
    /** Rankings sent to the shell. */
    ranks: 0,
    /** Rankings answered from the last one (same question). */
    rankHits: 0,
    /** Pool rows whose tag words were read. */
    rowsLearned: 0,
};

interface CopilotStore {
    available: Availability;
    /** The popover is open (rankings are only computed then). */
    open: boolean;
    energy: EnergyDirection;
    /** Deck the list is ranked against (null = nothing loaded). */
    refDeck: DeckId | null;
    suggestions: Suggestion[];
    request: SetRequest | null;
    ranking: boolean;
    plan: PlanInfo | null;
    planOpts: PlanOptions;
    planning: boolean;
    run: Progress | null;
    warnings: SafetyWarning[];
    note: Note | null;

    setOpen: (open: boolean) => void;
    /** Ask the shell whether it knows the co-pilot (and pick up a transition already running). */
    probe: () => Promise<Availability>;
    /** Rank the pool (or the set request's matches) against the reference deck. */
    refresh: () => Promise<void>;
    setEnergy: (energy: EnergyDirection) => void;
    /** Typed request: a DJ command, or a set-builder request over the library. */
    ask: (text: string) => Promise<void>;
    clearRequest: () => void;
    /** Load a library track onto a deck; false when the load failed. */
    load: (deck: DeckId, track: LibraryTrack) => Promise<boolean>;
    /** Plan the transition from the playing deck to the other main deck (loads the top suggestion there when it is empty). */
    planMix: (opts?: PlanOptions) => Promise<PlanInfo | null>;
    /** Run the current plan (plans first when there is none, plans again when it went stale). */
    go: () => Promise<boolean>;
    cancel: () => Promise<void>;
    dropPlan: () => void;
    /** Drop a plan made for tracks that are no longer on its decks. */
    checkPlan: () => void;
    /** Length / style for the next plan; a plan on screen is planned again with them. */
    setPlanOpts: (opts: PlanOptions) => void;
    refreshSafety: () => Promise<void>;
    setNote: (note: Note | null) => void;
}

let rankSeq = 0;
let planSeq = 0;
let refreshTimer = 0;
/** Track ids (outgoing, incoming) the current plan was made for. */
let planTracks: readonly [string | null, string | null] = [null, null];
/** Library search text before the first request replaced it (put back when the request is cleared). */
let searchBefore: string | null = null;
const loadSeq: Partial<Record<DeckId, number>> = {};
/** Genre / album tokens seen in any pool so far: such words are matched here, not by the companion search (title, artist, file name only). */
const tagWords = new Set<string>();
/** Rows whose tag words are already in `tagWords` (the pool grows page by page with the same row objects). */
const learned = new WeakSet<LibraryTrack>();
/** The question the ranking on screen answers (null = the list on screen is not a ranking). */
let rankedKey: string | null = null;
/** The question a ranking in flight will answer. */
let pendingKey: string | null = null;
/** When the last transition ended (epoch ms): a bare "stop" right after still means that transition. */
let runEndedAt: number | null = null;
/** Identity → version of the three things a ranking's candidates depend on. */
const seen: { pool: unknown; filters: unknown; played: unknown; poolV: number; playedV: number } = { pool: null, filters: null, played: null, poolV: 0, playedV: 0 };

function poolVersion(pool: readonly LibraryTrack[], filters: SetFilters | null): number {
    if (pool !== seen.pool || filters !== seen.filters) {
        seen.pool = pool;
        seen.filters = filters;
        seen.poolV++;
    }
    return seen.poolV;
}

function historyVersion(played: unknown, now: number): number {
    if (played !== seen.played) {
        seen.played = played;
        seen.playedV++;
    }
    // "Played 12 minutes ago" changes the score slowly: fold the time in coarse steps.
    return seen.playedV * 1_000_000 + (Math.floor(now / HISTORY_BUCKET_MS) % 1_000_000);
}

function tokens(s: string): string[] {
    return fold(s)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 0);
}

function learnTags(tracks: readonly LibraryTrack[]): void {
    for (const t of tracks) {
        // A page of the progressive load adds rows; the rows already seen are skipped.
        if (learned.has(t)) continue;
        learned.add(t);
        copilotStats.rowsLearned++;
        for (const w of tagTokens(t)) tagWords.add(w);
    }
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function errorNote(err: unknown): Note {
    const detail = message(err);
    const deck = /deck ([a-d])\b/i.exec(detail)?.[1]?.toUpperCase() ?? "";
    return { key: errorKey(detail), vars: { deck }, detail, tone: "error" };
}

/** Deck states straight from the engine when it answers (after a load the store may lag one snapshot). */
async function freshDecks(): Promise<readonly DeckState[]> {
    try {
        const snap = await engine.getState();
        if (snap) return snap.decks;
    } catch {
        // fall through to the store
    }
    return useMixerStore.getState().decks;
}

export const useCopilotStore = create<CopilotStore>((set, get) => {
    const unavailable = (): void => {
        set({ available: "no", note: { key: "copilot.unavailable", tone: "info" } });
    };

    /** A command failed: "not available" when the shell predates it, the mapped message otherwise. */
    const failed = (err: unknown): void => {
        if (isUnknownCommand(err)) unavailable();
        else set({ note: errorNote(err) });
    };

    const runIntent = async (intent: Intent): Promise<void> => {
        const mixer = useMixerStore.getState();
        const source = usePerfStore.getState().clock?.source;
        switch (intent.action) {
            case "mix_next": {
                const plan = await get().planMix({ bars: intent.bars, style: intent.style });
                if (plan) await get().go();
                return;
            }
            case "suggest":
                set({ request: null, energy: intent.energy ?? get().energy, note: null });
                await get().refresh();
                return;
            case "cancel":
                if (get().run) await get().cancel();
                else set({ note: { key: "copilot.nothingRunning", tone: "info" } });
                return;
            default: {
                const deck = intentDeck(intent.action, intent.deck, mixer.decks, source);
                if (!deck || !mixer.deck(deck).loaded) {
                    set({ note: { key: "copilot.err.noDeck", tone: "error" } });
                    return;
                }
                const name = deck.toUpperCase();
                const beats = intent.beats ?? 4;
                if (intent.action === "play") await engine.play(deck);
                else if (intent.action === "pause") await engine.pause(deck);
                else if (intent.action === "sync") usePerfStore.getState().phaseSync(deck);
                else await engine.beatloop(deck, beats);
                const note: Note = { key: `copilot.did.${intent.action}`, vars: { deck: name }, tone: "info" };
                if (intent.action === "loop") note.counts = { beats: { kind: "beats", n: beats } };
                set({ note });
            }
        }
    };

    return {
        available: "unknown",
        open: false,
        energy: "hold",
        refDeck: null,
        suggestions: [],
        request: null,
        ranking: false,
        plan: null,
        planOpts: {},
        planning: false,
        run: null,
        warnings: [],
        note: null,

        setOpen: (open) => {
            set({ open });
            if (!open) return;
            if (get().available !== "yes") void get().probe().then(() => get().refresh());
            else void get().refresh();
        },

        probe: async () => {
            try {
                // A phrase the offline parser always recognises: null = no shell (browser preview).
                const intent = await copilot.intent("mix next");
                if (!intent) {
                    set({ available: "no" });
                    return "no";
                }
                const was = get().available;
                set({ available: "yes" });
                if (was !== "yes") {
                    if (get().note?.key === "copilot.unavailable") set({ note: null });
                    const running = await copilot.status().catch(() => null);
                    if (running && !running.done) set({ run: running });
                }
                return "yes";
            } catch {
                set({ available: "no" });
                return "no";
            }
        },

        refresh: async () => {
            const mixer = useMixerStore.getState();
            const pool = useLibraryPool.getState().tracks;
            const played = useHistoryStore.getState().played;
            const now = Date.now();
            const ref = referenceDeck(mixer.decks, usePerfStore.getState().clock?.source);
            const deck = ref ? mixer.deck(ref) : null;
            const row = deck ? rowOf(pool, deck.trackId) : null;
            const key = ref ? mixer.deckKeys[ref] : null;
            const request = get().request;
            const matches = request
                ? applySetFilters(pool, request.filters, { key, energy: row?.energy ?? null, trackId: deck?.trackId ?? null }, (id) => playedTonight(played[id], now))
                : pool;
            const nextRequest = request ? (request.matched === matches.length ? request : { ...request, matched: matches.length }) : null;
            const unranked = (): void => {
                // Without a deck (or a shell) there is nothing to rank against: a request still lists its matches.
                const list = request ? matches.slice(0, MAX_SUGGESTIONS).map((track) => ({ track, ranked: null })) : [];
                // An answer still on its way belongs to a question nobody asks any more.
                rankSeq++;
                rankedKey = null;
                pendingKey = null;
                set({ refDeck: ref, suggestions: list, request: nextRequest, ranking: false });
            };
            if (!deck || matches.length === 0 || get().available !== "yes") {
                unranked();
                return;
            }
            // Ranked against what the deck sounds like now: its tempo with the pitch fader
            // applied, on a half-BPM grid (a pitch ride is not a new question every 0.1 BPM).
            const feat = deckFeat(deck, key, row);
            const live = feat.bpm !== null && deck.tempo > 0 ? quantBpm(feat.bpm * deck.tempo) : 0;
            const playing = { ...feat, bpm: live > 0 ? live : feat.bpm };
            // Plus the deck's own key: a request's key filter is applied against it (the features
            // fall back to the library row's key, which can hide a change of the deck's).
            const question = `${rankKey(playing, get().energy, poolVersion(pool, request?.filters ?? null), historyVersion(played, now), MAX_SUGGESTIONS)}\u0001${key ?? ""}`;
            if (question === rankedKey) {
                // The list on screen already answers this; a ranking in flight is for another
                // question (the pitch went there and back) and must not replace it.
                if (pendingKey !== null) {
                    rankSeq++;
                    pendingKey = null;
                }
                copilotStats.rankHits++;
                if (get().refDeck !== ref || get().request !== nextRequest || get().ranking) set({ refDeck: ref, request: nextRequest, ranking: false });
                return;
            }
            if (question === pendingKey) {
                // Already asked; the answer is on its way.
                copilotStats.rankHits++;
                return;
            }
            const seq = ++rankSeq;
            pendingKey = question;
            set({ ranking: true });
            try {
                copilotStats.ranks++;
                const ranked = await copilot.rank(playing, candidates(matches, played, now), get().energy, MAX_SUGGESTIONS);
                if (seq !== rankSeq) return;
                if (!ranked) {
                    unranked();
                    return;
                }
                const byId = new Map(matches.map((t) => [String(t.id), t]));
                const suggestions = ranked.flatMap((r) => {
                    const track = byId.get(r.id);
                    return track ? [{ track, ranked: r }] : [];
                });
                rankedKey = question;
                pendingKey = null;
                set({ refDeck: ref, suggestions, request: nextRequest, ranking: false });
            } catch (err) {
                if (seq !== rankSeq) return;
                unranked();
                failed(err);
            }
        },

        setEnergy: (energy) => {
            if (energy === get().energy) return;
            set({ energy });
            void get().refresh();
        },

        ask: async (text) => {
            // By code point: `slice` would cut an emoji in half and leave a lone surrogate.
            const trimmed = clipText(text.trim(), MAX_ASK).trim();
            if (!trimmed) return;
            // A bare "cancel" / "stop" means the transition: the one running, or the one that
            // ended a moment ago. Without this, "stop" typed as a transition ends is read as a
            // deck command and pauses the deck that has just gone on air.
            if (isBareStop(trimmed)) {
                const means = bareStopMeans(get().run !== null, runEndedAt, Date.now());
                if (means === "cancel") {
                    await get().cancel();
                    return;
                }
                if (means === "nothing") {
                    set({ note: { key: "copilot.stopNothing", tone: "info" } });
                    return;
                }
            }
            if (isCommandText(trimmed)) {
                if (get().available !== "yes" && (await get().probe()) !== "yes") {
                    // Without the shell only the set builder works. Text made of command words is
                    // a request only when it also carries a real filter ("more energy"); otherwise
                    // it is a command that cannot run ("mix next" must not become a search for "mix").
                    if (!hasAnyFilter({ ...parseSetRequest(trimmed), words: [] })) {
                        unavailable();
                        return;
                    }
                } else {
                    try {
                        const intent = await copilot.intent(trimmed);
                        if (intent) {
                            set({ note: null });
                            await runIntent(intent);
                            return;
                        }
                    } catch (err) {
                        failed(err);
                        return;
                    }
                }
            }
            const filters = parseSetRequest(trimmed);
            if (!hasAnyFilter(filters)) {
                set({ note: { key: "copilot.notUnderstood", tone: "info" } });
                return;
            }
            // Words the companion can search (title, artist, file name) go to the library search,
            // which also reaches tracks beyond the loaded page; genre / album words are matched here.
            const searchable = filters.words.filter((w) => !tokens(w).every((tok) => tagWords.has(tok)));
            if (!get().request) searchBefore = useLibraryPool.getState().query;
            libraryNav.search(searchable.join(" "));
            set({ request: { text: trimmed, filters, matched: 0 }, energy: filters.energyDirection ?? get().energy, note: null });
            await get().refresh();
        },

        clearRequest: () => {
            if (!get().request) return;
            set({ request: null, note: null });
            // The request replaced the library's search text: put the previous one back.
            if (searchBefore !== null) libraryNav.search(searchBefore);
            searchBefore = null;
            void get().refresh();
        },

        load: async (deck, track) => {
            const mixer = useMixerStore.getState();
            const before = { key: mixer.deckKeys[deck], wave: mixer.waveforms[deck] };
            const seq = (loadSeq[deck] ?? 0) + 1;
            loadSeq[deck] = seq;
            const title = (track.title ?? "").trim() || track.filename;
            try {
                await loadLibraryTrack(deck, track);
                return true;
            } catch (err) {
                // A newer load on this deck owns its state now.
                if (loadSeq[deck] !== seq) return false;
                // The loader is optimistic (key + empty waveform before the decode): the deck still
                // holds its previous track, so put both back (same recovery as the library rows).
                const m = useMixerStore.getState();
                if (m.deckKeys[deck] === (track.keyCamelot ?? null)) m.setDeckKey(deck, before.key);
                if (m.waveforms[deck].length === 0) m.setWaveform(deck, before.wave);
                if (before.wave.length === 0) void restoreDeckWave(deck, () => loadSeq[deck] === seq);
                set({ note: { key: "copilot.loadFailed", vars: { title, deck: deck.toUpperCase() }, detail: message(err), tone: "error" } });
                return false;
            }
        },

        planMix: async (opts) => {
            const planOpts = opts ?? get().planOpts;
            if (get().available !== "yes" && (await get().probe()) !== "yes") {
                unavailable();
                return null;
            }
            const seq = ++planSeq;
            const source = usePerfStore.getState().clock?.source;
            const from = playingDeck(useMixerStore.getState().decks, source);
            if (!from) {
                set({ plan: null, note: { key: "copilot.err.nothingPlaying", tone: "error" } });
                return null;
            }
            const to = otherDeck(from, useMixerStore.getState().decks);
            set({ planning: true, planOpts, note: null });
            try {
                if (!useMixerStore.getState().deck(to).loaded) {
                    if (get().suggestions.every((s) => s.ranked === null)) await get().refresh();
                    const fromTrack = useMixerStore.getState().deck(from).trackId;
                    const top = get().suggestions.find((s) => String(s.track.id) !== fromTrack);
                    if (!top) {
                        set({ plan: null, note: { key: "copilot.err.noNext", vars: { deck: to.toUpperCase() }, tone: "error" } });
                        return null;
                    }
                    const title = (top.track.title ?? "").trim() || top.track.filename;
                    set({ note: { key: "copilot.loadingNext", vars: { title, deck: to.toUpperCase() }, tone: "info" } });
                    if (!(await get().load(to, top.track))) return null;
                    if (seq !== planSeq) return null;
                    set({ note: null });
                }
                const decks = await freshDecks();
                const f = decks.find((d) => d.id === from);
                const t = decks.find((d) => d.id === to);
                if (!f || !t) {
                    set({ plan: null, note: { key: "copilot.err.failed", tone: "error" } });
                    return null;
                }
                const pool = useLibraryPool.getState().tracks;
                const keys = useMixerStore.getState().deckKeys;
                const plan = await copilot.plan({
                    from: deckFeat(f, keys[from], rowOf(pool, f.trackId)),
                    to: deckFeat(t, keys[to], rowOf(pool, t.trackId)),
                    fromDeck: from,
                    toDeck: to,
                    fromPosSec: Math.max(0, f.position),
                    bars: planOpts.bars ?? null,
                    style: planOpts.style ?? null,
                });
                if (seq !== planSeq) return null;
                if (!plan) {
                    unavailable();
                    return null;
                }
                planTracks = [f.trackId, t.trackId];
                set({ plan });
                return plan;
            } catch (err) {
                if (seq === planSeq) {
                    set({ plan: null });
                    failed(err);
                }
                return null;
            } finally {
                if (seq === planSeq) set({ planning: false });
            }
        },

        go: async () => {
            if (get().run) {
                set({ note: { key: "copilot.err.running", tone: "error" } });
                return false;
            }
            for (let attempt = 0; attempt < 2; attempt++) {
                get().checkPlan();
                const plan = get().plan ?? (await get().planMix());
                if (!plan) return false;
                try {
                    const started = await copilot.run(plan);
                    if (!started) {
                        unavailable();
                        return false;
                    }
                    // A run that ended already (a one-bar cut on a slow UI) is reported by its last event.
                    set((s) => ({ run: started.done ? s.run : started, note: null }));
                    return true;
                } catch (err) {
                    // The phrase the plan aimed at has passed while it sat on screen: plan the next one.
                    if (attempt === 0 && errorKey(message(err)) === "copilot.err.stale") {
                        set({ plan: null });
                        continue;
                    }
                    failed(err);
                    return false;
                }
            }
            return false;
        },

        cancel: async () => {
            try {
                await copilot.cancel();
            } catch (err) {
                failed(err);
            }
            // The shell's last event (cancelled) clears the run; without it (no shell) do it here.
            if (get().available !== "yes") set({ run: null });
        },

        dropPlan: () => {
            planSeq++;
            set({ plan: null, planning: false });
        },

        checkPlan: () => {
            const plan = get().plan;
            if (!plan || get().run) return;
            const mixer = useMixerStore.getState();
            const held = (id: DeckId) => (mixer.deck(id).loaded ? mixer.deck(id).trackId : null);
            if (held(plan.fromDeck) !== planTracks[0] || held(plan.toDeck) !== planTracks[1]) set({ plan: null });
        },

        setPlanOpts: (opts) => {
            set({ planOpts: opts });
            if (get().plan && !get().run) void get().planMix(opts);
        },

        refreshSafety: async () => {
            const clear = (): void => {
                if (get().warnings.length > 0) set({ warnings: [] });
            };
            if (get().available !== "yes" || get().run) {
                clear();
                return;
            }
            const mixer = useMixerStore.getState();
            const from = playingDeck(mixer.decks, usePerfStore.getState().clock?.source);
            if (!from) {
                clear();
                return;
            }
            const pool = useLibraryPool.getState().tracks;
            const d = mixer.deck(from);
            const to = otherDeck(from, mixer.decks);
            const n = mixer.deck(to);
            // A track that already played tonight and sits paused on the other deck is not "next".
            const ready = n.loaded && n.trackId !== d.trackId && (n.playing || !playedTonight(n.trackId ? useHistoryStore.getState().played[n.trackId] : undefined, Date.now()));
            try {
                const warnings = await copilot.safety({
                    playing: deckFeat(d, mixer.deckKeys[from], rowOf(pool, d.trackId)),
                    positionSec: Math.max(0, d.position),
                    tempoRatio: Math.min(4, Math.max(0.25, d.tempo > 0 ? d.tempo : 1)),
                    next: ready ? deckFeat(n, mixer.deckKeys[to], rowOf(pool, n.trackId)) : null,
                    plannedBars: get().plan?.bars ?? null,
                });
                const next = warnings ?? [];
                if (JSON.stringify(next) !== JSON.stringify(get().warnings)) set({ warnings: next });
            } catch (err) {
                clear();
                if (isUnknownCommand(err)) set({ available: "no" });
            }
        },

        setNote: (note) => set({ note }),
    };
});

/** Rank again shortly (several triggers in a row give one ranking); only while the popover is open. */
export function scheduleRefresh(delayMs = REFRESH_MS): void {
    if (typeof window === "undefined") return;
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
        if (useCopilotStore.getState().open) void useCopilotStore.getState().refresh();
    }, delayMs);
}

/** The status line for a transition that ended (pure: tested without the store). */
export function endNote(p: Pick<Progress, "cancelled" | "errors" | "toDeck">): Note {
    const detail = p.errors.join("; ");
    if (p.cancelled) {
        if (p.errors.length === 0) return { key: "copilot.runCancelled", tone: "info" };
        // A deck got another track mid-run: the shell stopped and touched nothing on it.
        const deck = trackChangedDeck(p.errors);
        if (deck) return { key: "copilot.runTrackChanged", vars: { deck }, detail, tone: "error" };
        return { key: "copilot.runStopped", detail, tone: "error" };
    }
    if (p.errors.length > 0) return { key: "copilot.runDoneErrors", counts: { commands: { kind: "commands", n: p.errors.length } }, detail, tone: "error" };
    return { key: "copilot.runDone", vars: { deck: p.toDeck.toUpperCase() }, tone: "info" };
}

function onProgress(p: Progress): void {
    if (!p.done) {
        useCopilotStore.setState({ run: p });
        return;
    }
    runEndedAt = Date.now();
    useCopilotStore.setState({ run: null, plan: null, note: endNote(p) });
    scheduleRefresh();
}

// One progress listener and one pool subscription for the app's lifetime (dropped on hot reload).
if (typeof window !== "undefined") {
    let stopped = false;
    let unlisten: (() => void) | null = null;
    void subscribeCopilotProgress(onProgress).then(
        (u) => {
            if (stopped) u();
            else unlisten = u;
        },
        () => undefined,
    );
    learnTags(useLibraryPool.getState().tracks);
    const unsubPool = useLibraryPool.subscribe((s, prev) => {
        if (s.tracks === prev.tracks) return;
        learnTags(s.tracks);
        // One ranking after the last page of a progressive load, not one per page.
        scheduleRefresh();
    });
    import.meta.hot?.dispose(() => {
        stopped = true;
        unlisten?.();
        unsubPool();
        window.clearTimeout(refreshTimer);
    });
}

devExpose("copilot", useCopilotStore);
devExpose("copilotStats", copilotStats);
