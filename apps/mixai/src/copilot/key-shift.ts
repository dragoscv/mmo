/**
 * Key-shift proposals of the co-pilot (WP19-61), the part that needs no DOM and no store
 * (tested with `node --test key-shift.test.ts`):
 *
 * 1. THE SOUNDING KEY of a deck (`soundingKey`): the track's key moved by the deck's whole key
 *    shift. The ranking, the row's key chip and the set builder all compare against it.
 * 2. THE PROPOSAL RULE (`proposeKeyShift`): a port of `propose_key_shift` in the Rust crate
 *    `decks-transition` (camelot.rs). The ranking's proposals come from the crate; this port
 *    only lets the set builder keep a track the co-pilot could make compatible. Both sides are
 *    checked against one table (`crates/decks-transition/fixtures/key-shift-proposals.txt`).
 *    `keyVerdict` is the ONE key verdict of the co-pilot (the crate's score): the row's key
 *    chip, the set builder's "in key" filter and the ranking agree by using it.
 * 3. WHAT A RANKED ROW CARRIES (`proposalOf`, `knowsProposals`): validated from the wire; a
 *    shell that predates proposals sends no such field.
 * 4. APPLYING AND UNDOING (`applyProposal`, `createShiftKeeper`): the shift is set as soon as
 *    the ENGINE holds the track on the deck (never before, never under a deck that already
 *    plays it, and without waiting for the rest of the load), the keeper remembers what was
 *    applied and puts it back to 0 when that deck gets another track, unless the DJ changed
 *    the shift by hand.
 *
 * No regular expression here may use a lookbehind (`no-lookbehind.test.ts`).
 */
import type { DeckId } from "../bridge/types.ts";
import { parseCamelot, type CamelotKey } from "../lib/harmonic.ts";
import { shiftCamelot } from "../lib/perf.ts";

// ─── 1. the sounding key ────────────────────────────────────────────────────

/**
 * The key a deck sounds in: the track's key moved by the deck's key shift, rounded to a whole
 * semitone (the same rule as the deck's own key display, `useDeckKey`). A key that is not
 * Camelot is returned as it is; no key gives null.
 *
 * Limit, on purpose: with key lock OFF a tempo change bends the pitch further (6 % is one
 * semitone). That drift is not counted here, because the deck's key display does not count it
 * either: the co-pilot and the deck must never name two different keys for the same deck.
 */
export function soundingKey(trackKey: string | null | undefined, keyShift: number | null | undefined): string | null {
    const key = trackKey?.trim() || null;
    if (!key) return null;
    const shift = typeof keyShift === "number" && Number.isFinite(keyShift) ? Math.round(keyShift) : 0;
    return shiftCamelot(key, shift) ?? key;
}

// ─── 2. the proposal rule (port of the crate) ───────────────────────────────

/** Below this key score a pair is a clash (crate: `KEY_CLASH_BELOW`). */
export const KEY_CLASH_BELOW = 0.45;
/** From this key score a pair fits as it is: same, relative, adjacent (crate: `KEY_FITS_FROM`). */
export const KEY_FITS_FROM = 0.85;
/** Largest shift the co-pilot proposes, in semitones. */
export const MAX_PROPOSED_SHIFT = 2;

export type KeyRelationTag = "same" | "relative" | "adjacent" | "boost" | "diagonal" | "clash";

function wheelDistance(a: number, b: number): number {
    const d = Math.abs(a - b) % 12;
    return Math.min(d, 12 - d);
}

/** Key term of the Rust ranking for a pair (crate: `key_score`). */
export function crateKeyScore(from: CamelotKey, to: CamelotKey): { score: number; relation: KeyRelationTag } {
    const d = wheelDistance(from.number, to.number);
    const same = from.letter === to.letter;
    if (d === 0) return same ? { score: 1, relation: "same" } : { score: 0.9, relation: "relative" };
    if (d === 1) return same ? { score: 0.85, relation: "adjacent" } : { score: 0.5, relation: "diagonal" };
    if (d === 2 && same) return { score: 0.6, relation: "boost" };
    return { score: Math.max(0, 0.4 - 0.08 * d), relation: "clash" };
}

/** How a track's key stands against the reference key, in the three levels a key chip shows. */
export type KeyVerdict = "match" | "near" | "clash";

/**
 * THE key verdict of the co-pilot: how `key` mixes with the reference key `against`, by the
 * score the ranking uses (`crateKeyScore`): `match` from [`KEY_FITS_FROM`] (same, relative,
 * adjacent), `clash` below [`KEY_CLASH_BELOW`], `near` between (boost, diagonal). Null when
 * either key is unknown or not Camelot.
 *
 * The row's key chip, the set builder's "in key" filter and the ranking all use this one
 * score, so a row never shows "workable" next to "Key +1 fits". It is NOT the Library's rule
 * (`lib/harmonic`): the two differ on one class, the same letter five wheel steps apart (keys
 * one semitone apart: 8A against 1A or 3A), which the Library calls workable ("energy boost")
 * and the ranking a clash that one semitone of key shift turns into the SAME key.
 */
export function keyVerdict(key: string | null | undefined, against: string | null | undefined): KeyVerdict | null {
    const a = parseCamelot(against);
    const b = parseCamelot(key);
    if (!a || !b) return null;
    const { score } = crateKeyScore(a, b);
    return score >= KEY_FITS_FROM ? "match" : score >= KEY_CLASH_BELOW ? "near" : "clash";
}

export interface KeyShiftProposal {
    /** Semitones to shift the candidate by: +1, -1, +2 or -2. */
    semitones: number;
    /** The candidate's key after the shift (Camelot). */
    key: string;
    /** Relation of the pair after the shift. */
    relation: "same" | "relative" | "adjacent";
}

const label = (k: CamelotKey): string => `${k.number}${k.letter}`;

function fits(from: CamelotKey, to: CamelotKey, semitones: number): { score: number; proposal: KeyShiftProposal } | null {
    const key = parseCamelot(shiftCamelot(label(to), semitones));
    if (!key) return null;
    const { score, relation } = crateKeyScore(from, key);
    if (score < KEY_FITS_FROM || (relation !== "same" && relation !== "relative" && relation !== "adjacent")) return null;
    return { score, proposal: { semitones, key: label(key), relation } };
}

/**
 * The smallest key shift of `to` (+1, -1, +2, -2 semitones) that turns a clashing pair into
 * one that fits (same, relative or adjacent key). Null when a key is unknown, when the pair is
 * not a clash, or when no such shift exists. Tie rule: the smaller shift first; for the same
 * size the better resulting relation, then the upward one.
 */
export function proposeKeyShift(from: string | null | undefined, to: string | null | undefined): KeyShiftProposal | null {
    const a = parseCamelot(from);
    const b = parseCamelot(to);
    if (!a || !b) return null;
    if (crateKeyScore(a, b).score >= KEY_CLASH_BELOW) return null;
    for (let size = 1; size <= MAX_PROPOSED_SHIFT; size++) {
        const up = fits(a, b, size);
        const down = fits(a, b, -size);
        if (up && down) return (down.score > up.score ? down : up).proposal;
        if (up) return up.proposal;
        if (down) return down.proposal;
    }
    return null;
}

/** The 24 Camelot keys in table order: 1A, 1B, 2A, … 12B. */
export function allCamelotKeys(): string[] {
    const out: string[] = [];
    for (let n = 1; n <= 12; n++) out.push(`${n}A`, `${n}B`);
    return out;
}

/** One line of the shared table: `8A 1A +1 8A same`, or `8A 2B -` when nothing is proposed. */
export function proposalLine(from: string, to: string): string {
    const p = proposeKeyShift(from, to);
    return p ? `${from} ${to} ${p.semitones > 0 ? "+" : ""}${p.semitones} ${p.key} ${p.relation}` : `${from} ${to} -`;
}

/** Every pair of the 24 keys, one line each (576 lines): what the shared table holds. */
export function proposalTable(): string[] {
    const keys = allCamelotKeys();
    return keys.flatMap((from) => keys.map((to) => proposalLine(from, to)));
}

// ─── 3. what a ranked row carries ───────────────────────────────────────────

/** The proposal of a ranked row as the UI uses it. */
export interface RowProposal {
    /** +1, -1, +2 or -2. */
    shift: number;
    /** Key after the shift, canonical Camelot. */
    key: string;
}

/**
 * The proposal a ranked row carries, validated: a whole, non-zero shift of at most two
 * semitones and a Camelot key. Anything else (an older shell sends no field at all, a
 * suggestion without a proposal sends null) is "no proposal".
 */
export function proposalOf(ranked: { keyShift?: unknown; keyAfter?: unknown } | null | undefined): RowProposal | null {
    if (!ranked) return null;
    const { keyShift, keyAfter } = ranked;
    if (typeof keyShift !== "number" || !Number.isInteger(keyShift) || keyShift === 0 || Math.abs(keyShift) > MAX_PROPOSED_SHIFT) return null;
    const key = typeof keyAfter === "string" ? parseCamelot(keyAfter) : null;
    if (!key) return null;
    return { shift: keyShift, key: label(key) };
}

/**
 * Does the shell that sent `rows` know proposals? It then sends the field on every row (set,
 * or null). Null = cannot tell (no rows).
 */
export function knowsProposals(rows: readonly object[] | null | undefined): boolean | null {
    if (!rows || rows.length === 0) return null;
    return rows.every((r) => "keyShift" in r);
}

// ─── 4. applying and undoing ────────────────────────────────────────────────

/** A key shift the co-pilot applied: which deck, for which track, how much. */
export interface ShiftRecord {
    deck: DeckId;
    trackId: string;
    shift: number;
}

/** What the ENGINE says about a deck (the UI store is optimistic during a load). */
export interface EngineDeck {
    /** Track id the engine holds (null = empty deck, or a file without an id). */
    trackId: string | null;
    keyShift: number;
    /**
     * The engine's own transport state of the deck, from the same answer as `trackId` (a load
     * stops the deck, so "this track AND playing" means somebody started it). Left out = not
     * playing.
     */
    playing?: boolean;
}

export type ShiftEvent =
    /** The deck got another track and still had the co-pilot's shift: put back to 0. */
    | { kind: "undone"; record: ShiftRecord }
    /** The deck got another track, but the shift was no longer the co-pilot's: left alone. */
    | { kind: "kept"; record: ShiftRecord }
    /** The DJ changed the shift by hand: the co-pilot forgets it, nothing else. */
    | { kind: "dropped"; record: ShiftRecord };

export interface ShiftKeeperDeps {
    /** Ask the engine; null = it did not answer (nothing is decided then). */
    engineDeck: (deck: DeckId) => Promise<EngineDeck | null>;
    /** The deck's key shift as the UI store has it right now. */
    storeShift: (deck: DeckId) => number;
    setKeyShift: (deck: DeckId, semitones: number) => void;
    /** The set of records changed (persist it, show it). */
    changed: (records: readonly ShiftRecord[]) => void;
    notify: (event: ShiftEvent) => void;
    /** Pause between two looks while the engine and the UI store disagree (default: a timer). */
    wait?: (ms: number) => Promise<void>;
    /** Longest wait for one engine answer, in ms (default [`ENGINE_WAIT_MS`]). */
    engineWaitMs?: number;
}

/** Most looks at a deck until its key shift reads settled, and the pause between two looks. */
export const SETTLE_TRIES = 8;
export const SETTLE_MS = 120;
/**
 * Longest wait for one answer of the engine. A call that never answers (a stuck IPC call)
 * otherwise keeps the deck's check in flight for ever, and every later check of that deck
 * queues behind it: nothing would ever be undone on that deck again.
 */
export const ENGINE_WAIT_MS = 2000;

/** `p`, or null when it rejects or does not answer within `ms`. Never rejects; the timer is cleared. */
export function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const id = setTimeout(() => resolve(null), ms);
        p.then(
            (v) => {
                clearTimeout(id);
                resolve(v);
            },
            () => {
                clearTimeout(id);
                resolve(null);
            },
        );
    });
}

export interface ShiftKeeper {
    records: () => readonly ShiftRecord[];
    recordOn: (deck: DeckId) => ShiftRecord | null;
    /** The co-pilot set `record.shift` on `record.deck` for `record.trackId` (replaces the deck's record). */
    applied: (record: ShiftRecord) => void;
    /** Take over records read back after a page reload (validated; see `parseRecords`). */
    restore: (records: readonly ShiftRecord[]) => void;
    /**
     * Something about the deck changed in the UI (another track id, another key shift): look at
     * the engine and apply the rules. Calls for a deck never overlap; one that arrives while
     * another is in flight is run once more afterwards. Resolves when the deck is settled.
     */
    check: (deck: DeckId) => Promise<void>;
}

/**
 * Keeps what the co-pilot applied and undoes it by these rules, decided on what the ENGINE
 * holds (the UI store shows a new track id before the file is decoded, and the old one again
 * when the load fails):
 *
 * (a) the deck holds ANOTHER track (or none): the record goes; the shift is put back to 0 only
 *     when the deck's shift still is what the co-pilot set (a DJ who changed it owns it);
 * (b) the same track, another shift: the DJ changed it by hand, the record goes, nothing else
 *     is touched;
 * otherwise nothing happens. A transition (plan, go, cancel, end) is no input here at all.
 *
 * The key shift is read from two places that are briefly out of step: the UI store changes at
 * once when a shift is set here or on the deck (the command to the engine is still on its
 * way), and it is overwritten by the engine's clock answers (one of which may predate the
 * command). Both can show the OLD value at the same moment. Measured on a real engine: right
 * after the co-pilot set +1, the UI store was back at 0 for 71 ms while the engine had +1, and
 * the record was dropped as "changed by hand" (a look whose engine answer predates the command
 * reads 0 and 0: that part is inferred, the dropped record was seen). So a decision is made
 * only on a SETTLED reading: the engine and the UI store say the same, on two looks in a row
 * ([`SETTLE_MS`] apart, at most [`SETTLE_TRIES`] looks). A reading that never settles resets
 * nothing.
 */
export function createShiftKeeper(deps: ShiftKeeperDeps): ShiftKeeper {
    const byDeck = new Map<DeckId, ShiftRecord>();
    let list: readonly ShiftRecord[] = [];
    const flights = new Map<DeckId, Promise<void>>();
    const again = new Set<DeckId>();
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const engineWaitMs = deps.engineWaitMs ?? ENGINE_WAIT_MS;

    const publish = (): void => {
        list = [...byDeck.values()];
        deps.changed(list);
    };

    const settle = async (deck: DeckId): Promise<void> => {
        let seen: string | null = null;
        for (let look = 1; ; look++) {
            const record = byDeck.get(deck);
            if (!record) return;
            // Bounded: an engine call that never answers ends this look (nothing is decided),
            // so the deck's later checks are not queued behind it for ever.
            const now = await within(deps.engineDeck(deck), engineWaitMs);
            // No answer, or the record was replaced / removed while the engine was asked.
            if (!now || byDeck.get(deck) !== record) return;
            const inEngine = Math.round(now.keyShift);
            const inStore = Math.round(deps.storeShift(deck));
            // The deck is as the co-pilot left it: nothing to decide, whatever a second look says.
            if (now.trackId === record.trackId && inEngine === record.shift && inStore === record.shift) return;
            const reading = `${now.trackId ?? ""}\u0001${inEngine}\u0001${inStore}`;
            const settled = inEngine === inStore && reading === seen;
            seen = reading;
            if (!settled && look < SETTLE_TRIES) {
                await wait(SETTLE_MS);
                continue;
            }
            if (now.trackId !== record.trackId) {
                // (a) Another track. Reset only a shift that is beyond doubt still the co-pilot's.
                byDeck.delete(deck);
                publish();
                if (settled && inEngine === record.shift) {
                    deps.setKeyShift(deck, 0);
                    deps.notify({ kind: "undone", record });
                } else deps.notify({ kind: "kept", record });
                return;
            }
            // (b) The same track with another shift, read the same twice: a change by hand.
            if (settled && inEngine !== record.shift) {
                byDeck.delete(deck);
                publish();
                deps.notify({ kind: "dropped", record });
            }
            return;
        }
    };

    const check = (deck: DeckId): Promise<void> => {
        const running = flights.get(deck);
        if (running) {
            again.add(deck);
            return running;
        }
        const flight = (async () => {
            try {
                do {
                    again.delete(deck);
                    await settle(deck);
                } while (again.has(deck));
            } finally {
                flights.delete(deck);
            }
        })();
        flights.set(deck, flight);
        return flight;
    };

    return {
        records: () => list,
        recordOn: (deck) => byDeck.get(deck) ?? null,
        applied: (record) => {
            byDeck.set(record.deck, { deck: record.deck, trackId: record.trackId, shift: record.shift });
            publish();
        },
        restore: (records) => {
            byDeck.clear();
            for (const r of records) byDeck.set(r.deck, { deck: r.deck, trackId: r.trackId, shift: r.shift });
            publish();
        },
        check,
    };
}

export interface ApplyDeps {
    engineDeck: (deck: DeckId) => Promise<EngineDeck | null>;
    /** The existing load path for the track; false = the load failed (or lost to a newer one). */
    load: (deck: DeckId) => Promise<boolean>;
    setKeyShift: (deck: DeckId, semitones: number) => void;
    /** Pause between two looks at the engine while the load runs (default: a timer). */
    wait?: (ms: number) => Promise<void>;
    /** Longest wait for one engine answer, in ms (default [`ENGINE_WAIT_MS`]). */
    engineWaitMs?: number;
}

/**
 * `applied`: the track is on the deck with the shift. `playing`: the track is on the deck but
 * the deck was already playing it when the moment came (the DJ was faster): nothing was
 * shifted under the audience. `load-failed`: the load failed, nothing was shifted. `lost`: the
 * engine holds another track now (another load won), nothing was shifted. `no-engine`: the
 * engine did not answer, nothing was shifted.
 */
export type ApplyResult = "applied" | "playing" | "load-failed" | "lost" | "no-engine";

/** How often the engine is asked whether the track has landed while the load runs. */
export const LAND_POLL_MS = 100;
/**
 * Most looks at the engine while a load runs (a minute). A load that takes longer is no longer
 * watched: its own answer decides, as before. Nothing may poll for ever behind a stuck call.
 */
export const LAND_POLLS_MAX = 600;

/**
 * Load the track onto `deck` (skipped when the engine already holds it there) and set the key
 * shift AS SOON AS the engine reports that very track on the deck, not when the whole load
 * settles: the load promise also waits for the track's stems (an HTTP call with a 15 s limit
 * and four decodes), seconds after the deck is playable, and a pitch that jumps then may jump
 * on air. While the load runs the engine is asked every [`LAND_POLL_MS`] (for a minute at
 * most); the first answer that names the track decides. Never before the track is there;
 * never when the load failed or another load won (the engine holds another track); and never
 * under a deck that is already PLAYING the track when the moment comes: then nothing is
 * shifted and `playing` says so. "Playing" is the engine's own transport state in the answer
 * that names the track, read the same on two looks one poll apart: for a moment after a load
 * landed the engine can still report the transport of the track that was there before (the
 * track id is written at once, the transport one audio block later), and that must not be
 * taken for the DJ having started the new track. A failed load leaves the key shift of
 * whatever is on the deck untouched.
 */
export async function applyProposal(keeper: Pick<ShiftKeeper, "applied">, deps: ApplyDeps, deck: DeckId, trackId: string, shift: number): Promise<ApplyResult> {
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // Bounded like the keeper's look: one engine call that never answers must not hold the
    // press (and the deck's "still loading" state) for ever.
    const ask = () => within(deps.engineDeck(deck), deps.engineWaitMs ?? ENGINE_WAIT_MS);
    /** The engine names the track (`held`): shift it now, unless the deck already plays it. */
    const land = async (held: EngineDeck): Promise<ApplyResult> => {
        if (held.playing === true) {
            // Look once more: the transport of the track that was there before, or a deck
            // the DJ really started?
            await wait(LAND_POLL_MS);
            const again = await ask();
            if (!again) return "no-engine";
            if (again.trackId !== trackId) return "lost";
            if (again.playing === true) return "playing";
        }
        // Remembered first, so the UI store's own change of the shift is already the co-pilot's.
        keeper.applied({ deck, trackId, shift });
        deps.setKeyShift(deck, shift);
        return "applied";
    };
    const before = await ask();
    if (before?.trackId === trackId) return land(before);
    // The load runs; the engine is watched meanwhile. `done` = the load promise answered.
    const load: { done: { ok: boolean } | null } = { done: null };
    const loading = deps.load(deck).then(
        (ok) => {
            load.done = { ok };
        },
        () => {
            load.done = { ok: false };
        },
    );
    for (let polls = 1; ; polls++) {
        const now = await ask();
        if (now?.trackId === trackId) {
            // The engine has it. The load promise may still be running (stems): that part is
            // best-effort in the loader and does not change what plays.
            return land(now);
        }
        if (load.done) break;
        if (polls >= LAND_POLLS_MAX) {
            await loading;
            break;
        }
        await Promise.race([loading, wait(LAND_POLL_MS)]);
    }
    // The load promise ended without the engine ever naming the track.
    if (!load.done?.ok) return "load-failed";
    const held = await ask();
    if (!held) return "no-engine";
    if (held.trackId !== trackId) return "lost";
    return land(held);
}

const DECK_IDS: readonly DeckId[] = ["a", "b", "c", "d"];
const MAX_ID_CHARS = 200;

/** What tells "this deck may hold another track now" in the UI's deck state. */
export interface DeckTrackFields {
    trackId: string | null;
    loaded: boolean;
    duration: number;
    title: string | null;
    artist: string | null;
}

/**
 * Did the track fields of a deck change? The UI store shows a new track id the moment a load
 * STARTS and the engine's length when it LANDS, so both moments count; the keeper then asks
 * the engine what the deck really holds. Everything a transition or the DJ moves while the
 * same track plays (transport, position, tempo, faders, EQ, filter, sync lock, stems, loops)
 * is not a track field: such a change never makes the keeper look, let alone undo.
 */
export function trackFieldsChanged(prev: DeckTrackFields | null | undefined, next: DeckTrackFields | null | undefined): boolean {
    if (!prev || !next) return prev !== next;
    return prev.trackId !== next.trackId || prev.loaded !== next.loaded || prev.duration !== next.duration || prev.title !== next.title || prev.artist !== next.artist;
}

/** A store that can be read and listened to (a zustand store fits). */
export interface Watchable<S> {
    getState: () => S;
    subscribe: (listener: (state: S, prev: S) => void) => () => void;
}
/** What the keeper's watcher reads from the mixer store. */
export interface MixerView {
    /** The first engine snapshot arrived. */
    hydrated: boolean;
    decks: readonly (DeckTrackFields & { id: DeckId })[];
}
/** What the keeper's watcher reads from the performance store. */
export interface PerfView {
    decks: Record<DeckId, { keyShift: number }>;
}

/**
 * Tell the keeper when to look at a deck: only a deck that carries a record, and only when
 * its track fields change (a load started, landed or failed), when its key shift changes in
 * the UI store (the DJ's hand, a clock answer, the keeper's own command), or when the first
 * engine snapshot arrives after a page reload. Nothing else is watched: transport, position,
 * tempo, sync lock, faders, EQ, filter and stems (all a transition moves) never reach the
 * keeper, and without a record nothing is compared at all. Returns the unsubscribe function.
 */
export function watchShifts(keeper: Pick<ShiftKeeper, "records" | "check">, mixer: Watchable<MixerView>, perf: Watchable<PerfView>): () => void {
    const offMixer = mixer.subscribe((s, prev) => {
        const records = keeper.records();
        if (records.length === 0) return;
        const woke = s.hydrated && !prev.hydrated;
        if (s.decks === prev.decks && !woke) return;
        for (const r of records) {
            const now = s.decks.find((d) => d.id === r.deck);
            const was = prev.decks.find((d) => d.id === r.deck);
            if (woke || (now !== was && trackFieldsChanged(was, now))) void keeper.check(r.deck);
        }
    });
    const offPerf = perf.subscribe((s, prev) => {
        if (s.decks === prev.decks) return;
        for (const r of keeper.records()) {
            if (s.decks[r.deck].keyShift !== prev.decks[r.deck].keyShift) void keeper.check(r.deck);
        }
    });
    return () => {
        offMixer();
        offPerf();
    };
}

/** Records as stored text (session storage: it lives as long as the engine does). */
export function encodeRecords(records: readonly ShiftRecord[]): string {
    return JSON.stringify({ v: 1, records: records.map((r) => ({ deck: r.deck, trackId: r.trackId, shift: r.shift })) });
}

/**
 * Read stored records back. Anything unreadable gives no records (the shift then simply stays
 * until the DJ changes it); a record must name a deck, a track id and a whole shift of one or
 * two semitones; one record per deck (the last wins).
 */
export function parseRecords(raw: string | null | undefined): ShiftRecord[] {
    if (!raw) return [];
    let data: unknown;
    try {
        data = JSON.parse(raw);
    } catch {
        return [];
    }
    if (typeof data !== "object" || data === null || (data as { v?: unknown }).v !== 1) return [];
    const rows = (data as { records?: unknown }).records;
    if (!Array.isArray(rows)) return [];
    const byDeck = new Map<DeckId, ShiftRecord>();
    for (const row of rows.slice(0, 16)) {
        if (typeof row !== "object" || row === null) continue;
        const { deck, trackId, shift } = row as { deck?: unknown; trackId?: unknown; shift?: unknown };
        const id = DECK_IDS.find((d) => d === deck);
        if (!id || typeof trackId !== "string" || trackId.length === 0 || trackId.length > MAX_ID_CHARS) continue;
        if (typeof shift !== "number" || !Number.isInteger(shift) || shift === 0 || Math.abs(shift) > MAX_PROPOSED_SHIFT) continue;
        byDeck.set(id, { deck: id, trackId, shift });
    }
    return [...byDeck.values()];
}
