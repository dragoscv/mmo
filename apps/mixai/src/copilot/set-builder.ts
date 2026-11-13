/**
 * Natural-language set builder: turns a typed RO / EN request ("90s hip-hop 95-105 BPM
 * harmonic", "mai multă energie", "same key as deck A", "techno peste 130 bpm fără vocal")
 * into filters over the local library, and applies them to the loaded pool. Pure: no DOM, no
 * store (tested with `node --test set-builder.test.ts`).
 *
 * Decades ("90s", "anii '90", "anii 80 și 90", "2010s") become a year window; numbers next to
 * "bpm" become a tempo window, and so do a bare range ("95-105"), "±5" and "până la 128";
 * "harmonic" / "in key" / "same key" / "relative" become a key relation against the reference
 * deck; "more energy" / "mai lent" an energy direction; "stems" / "acapella" ask for stems.
 * Every other word is a free-text search term (title, artist, genre, album).
 *
 * Rule-based on purpose: the same text always gives the same filters, offline. No regular
 * expression here may use a lookbehind: WKWebView before Safari 16.4 (macOS 10.15 to 12) fails
 * to PARSE the whole module on one (`no-lookbehind.test.ts` keeps it that way).
 */
import type { LibraryTrack } from "../bridge/types.ts";
import { parseCamelot, type CamelotKey } from "../lib/harmonic.ts";
import { KEY_CLASH_BELOW, crateKeyScore, proposeKeyShift } from "./key-shift.ts";

/** How the key must relate to the reference deck's key. */
export type KeyRelation = "harmonic" | "same" | "relative";
export type EnergyDirection = "hold" | "up" | "down";

export interface SetFilters {
    bpmMin: number | null;
    bpmMax: number | null;
    /** Free words: matched against title, artist, genre and album (all must match). */
    words: string[];
    keyRelation: KeyRelation | null;
    energyDirection: EnergyDirection | null;
    /** Inclusive year window from a decade word (null = any). */
    yearMin: number | null;
    yearMax: number | null;
    /** Only tracks with separated stems. */
    stems: boolean;
    /** Only favourites. */
    favorites: boolean;
    /** Not played tonight. */
    fresh: boolean;
}

export const EMPTY_FILTERS: SetFilters = {
    bpmMin: null,
    bpmMax: null,
    words: [],
    keyRelation: null,
    energyDirection: null,
    yearMin: null,
    yearMax: null,
    stems: false,
    favorites: false,
    fresh: false,
};

/**
 * Lower-case, diacritics folded (ș→s, ț→t, ă/â→a, î→i), compatibility forms unified (full-width
 * `１２８ ｂｐｍ` → `128 bpm`), punctuation kept for the tokenizer.
 */
export function fold(s: string): string {
    return s
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/ş/g, "s")
        .replace(/ţ/g, "t");
}

const UNIT_BPM = /^bpm$|^bpm[-.]?uri$/;
/** Words that only shape the request (never searched as text). */
const NOISE = new Set([
    "a", "an", "the", "and", "or", "with", "of", "in", "at", "to", "for", "from", "me", "my", "some", "please", "play", "give", "find", "tracks", "track", "songs", "song", "tunes", "music", "set", "next", "around", "about", "between", "as", "like",
    "si", "sau", "cu", "de", "din", "la", "pe", "intre", "imi", "mi", "da", "vreau", "pune", "cauta", "gaseste", "piese", "piesa", "melodii", "melodie", "muzica", "ceva", "niste", "cam", "pana", "te", "rog", "mele", "meu", "ca",
    "bpm", "tempo", "key", "cheie", "tonalitate", "tonalitatea", "deck", "deckul", "deck-ul", "energy", "energie", "energia", "stems", "stem", "stem-uri", "stemuri",
]);
const ENERGY_UP = ["more energy", "higher energy", "energy up", "harder", "faster", "build", "peak", "mai multa energie", "energie mai mare", "mai tare", "mai rapid", "mai rapide", "creste", "ridica"];
const ENERGY_DOWN = ["less energy", "lower energy", "energy down", "cool down", "calm", "calmer", "chill", "slower", "deeper", "warm up", "warmup", "mai putina energie", "energie mai mica", "mai lent", "mai lente", "mai linistit", "mai calm", "relax", "coboara"];
// "in key" is DJ talk for "harmonically compatible", not "the same key": it lives in KEY_HARMONIC.
const KEY_SAME = ["same key", "aceeasi cheie", "aceeasi tonalitate", "in cheia", "in tonalitatea"];
const KEY_RELATIVE = ["relative key", "relative major", "relative minor", "relativa", "cheia relativa"];
const KEY_HARMONIC = ["harmonic", "harmonically", "compatible", "compatibil", "compatibila", "compatibile", "armonic", "armonica", "armonice", "in key", "mixable"];
const STEMS = ["with stems", "stems ready", "has stems", "acapella", "acappella", "cu stems", "cu stem-uri", "cu stemuri", "separate"];
const FAVORITES = ["favorite", "favorites", "favourite", "favourites", "favorit", "favoritele", "preferate", "preferatele"];
const FRESH = ["not played", "unplayed", "fresh", "new tonight", "neredate", "neredata", "nu au fost redate", "necantate", "proaspete"];
const DEFAULT_SPAN_PCT = 4;

function phraseRe(p: string): RegExp {
    return new RegExp(`(^|\\s)${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "g");
}

/** True when one of `phrases` appears in `text` as whole words. */
function has(text: string, phrases: readonly string[]): boolean {
    return phrases.some((p) => phraseRe(p).test(text));
}

/** Remove the phrases found in `text` so their words are not searched as free text. */
function strip(text: string, phrases: readonly string[]): string {
    let out = text;
    for (const p of phrases) out = out.replace(phraseRe(p), " ");
    return out;
}

interface Decade {
    from: number;
    to: number;
    /** Where the matched text sits in the request (to cut it out of the free words). */
    start: number;
    end: number;
}

/** One decade: optional apostrophe, two digits ending in 0 or a full year ending in 0, optional "s" / "-uri". */
const DEC = String.raw`'?((?:19|20)?\d0)('?s|-?uri)?`;
/**
 * A decade, or two joined by "-", "and", "și", "to", "până la" ("anii 80 și 90", "80s and 90s").
 * Groups: 1 = the space before (kept), 2 = "anii " / "the ", 3-4 = first decade, 5-6 = second.
 * The leading `(^|\s)` is a capture, NOT a lookbehind (see the file comment).
 */
const DECADE_RE = new RegExp(String.raw`(^|\s)(anii\s+|the\s+)?${DEC}(?:\s*(?:-|–|si|sau|and|or|to|pana la|la)\s*(?:anii\s+|the\s+)?${DEC})?(?=\s|$)`, "g");

function decadeYear(digits: string): number {
    const y = Number(digits);
    return y < 100 ? y + (y < 30 ? 2000 : 1900) : y;
}

/**
 * Decade: "90s", "90's", "1990s", "2010s", "anii 90", "anii '90", "anii 2000", "the 80s", "1990",
 * and two of them ("anii 80 si 90" = 1980 to 1999). A bare two-digit number ("90", "80-90") is
 * not a decade: it could be a tempo or part of a title.
 */
function decade(text: string): Decade | null {
    for (const m of text.matchAll(DECADE_RE)) {
        const [whole, lead, prefix, d1, s1, d2, s2] = m;
        const start = m.index + lead!.length;
        const stop = m.index + whole.length;
        // A number followed by "bpm" is a tempo ("the 90 bpm tracks", "anii 90 si 80 bpm").
        const unitNext = /^\s*bpm\b/.test(text.slice(stop));
        const marked1 = Boolean(prefix) || Boolean(s1) || d1!.length === 4;
        const first = decadeYear(d1!);
        if (d2 === undefined) {
            if (!marked1 || (unitNext && !s1 && d1!.length < 4)) continue;
            return { from: first, to: first + 9, start, end: stop };
        }
        const marked2 = Boolean(s2) || d2.length === 4;
        if (!marked1 && !marked2) continue;
        if (unitNext && !marked2) {
            // Only the first is a decade; the joiner and the second number stay for the tempo.
            if (!marked1) continue;
            const at = lead!.length + (prefix?.length ?? 0);
            const firstLen = (whole[at] === "'" ? 1 : 0) + d1!.length + (s1?.length ?? 0);
            return { from: first, to: first + 9, start, end: m.index + at + firstLen };
        }
        const second = decadeYear(d2);
        return { from: Math.min(first, second), to: Math.max(first, second) + 9, start, end: stop };
    }
    return null;
}

interface Tempo {
    min: number | null;
    max: number | null;
    consumed: string[];
}

/** A tempo is 40..300 BPM. */
const isTempo = (n: number) => n >= 40 && n <= 300;

/**
 * Tempo window from "95-105 bpm", "120 bpm", "around 128", "peste 130 bpm", "under 100 bpm",
 * "pana la 128", "128 ± 3". Every keyword and number sits on word boundaries (`\b`): "cover 100
 * bpm" is the word "cover" and a tempo, not "over 100".
 */
function tempo(text: string): Tempo {
    const consumed: string[] = [];
    const range = /\b(\d{2,3})\s*(?:-|–|\bto\b|\bpana la\b|\bla\b|\bsi\b|\band\b)\s*(\d{2,3})\b(?:\s*bpm\b)?/.exec(text);
    if (range && isTempo(Number(range[1])) && isTempo(Number(range[2])) && Number(range[1]) < Number(range[2])) {
        consumed.push(range[0]);
        return { min: Number(range[1]), max: Number(range[2]), consumed };
    }
    const pm = /\b(\d{2,3})\s*(?:±|\+\/-|\+-|\bplus\s*minus\b)\s*(\d{1,2})\b(?:\s*bpm\b)?/.exec(text);
    if (pm && isTempo(Number(pm[1]))) {
        consumed.push(pm[0]);
        return { min: Number(pm[1]) - Number(pm[2]), max: Number(pm[1]) + Number(pm[2]), consumed };
    }
    // "from 100" / "de la 100" only with the unit: "tracks from 90 artists" is not a tempo.
    const over = /\b(?:over|above|more than|faster than|at least|peste|mai mult de|cel putin|minim|min)\s*(\d{2,3})\b(?:\s*bpm\b)?|\b(?:from|de la)\s*(\d{2,3})\s*bpm\b/.exec(text);
    const overValue = over ? Number(over[1] ?? over[2]) : NaN;
    if (over && isTempo(overValue)) {
        consumed.push(over[0]);
        return { min: overValue, max: null, consumed };
    }
    const under = /\b(?:under|below|less than|slower than|up to|at most|sub|pana la|mai putin de|cel mult|maxim|max)\s*(\d{2,3})\b(?:\s*bpm\b)?/.exec(text);
    if (under && isTempo(Number(under[1]))) {
        consumed.push(under[0]);
        return { min: null, max: Number(under[1]), consumed };
    }
    const single = /\b(?:around|about|approx|approximately|roughly|circa|cam|aproximativ|in jur de)\s+(\d{2,3})\b(?:\s*bpm\b)?|\b(\d{2,3})\s*bpm\b/.exec(text);
    const value = single ? Number(single[1] ?? single[2]) : NaN;
    if (single && isTempo(value)) {
        const v = value;
        const span = Math.round((v * DEFAULT_SPAN_PCT) / 100);
        consumed.push(single[0]);
        return { min: v - span, max: v + span, consumed };
    }
    return { min: null, max: null, consumed };
}

/** Parse free text into filters. Never throws; an empty / unknown text gives free words only. */
export function parseSetRequest(text: string): SetFilters {
    const f: SetFilters = { ...EMPTY_FILTERS, words: [] };
    let t = ` ${fold(text)
        .replace(/[\u2018\u2019\u02bc`\u00b4]/g, "'")
        .replace(/[,;!?]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()} `;
    if (t.trim().length === 0) return f;

    // Decades first: "anii 80 si 90" is two decades, not a tempo of 80 to 90.
    const dec = decade(t);
    if (dec) {
        f.yearMin = dec.from;
        f.yearMax = dec.to;
        t = `${t.slice(0, dec.start)} ${t.slice(dec.end)}`;
    }

    const tp = tempo(t);
    f.bpmMin = tp.min;
    f.bpmMax = tp.max;
    for (const c of tp.consumed) t = t.replace(c, " ");

    if (has(t, ENERGY_UP)) f.energyDirection = "up";
    else if (has(t, ENERGY_DOWN)) f.energyDirection = "down";
    t = strip(strip(t, ENERGY_UP), ENERGY_DOWN);

    if (has(t, KEY_SAME)) f.keyRelation = "same";
    else if (has(t, KEY_RELATIVE)) f.keyRelation = "relative";
    else if (has(t, KEY_HARMONIC)) f.keyRelation = "harmonic";
    t = strip(strip(strip(t, KEY_SAME), KEY_RELATIVE), KEY_HARMONIC);
    // "as deck A" / "ca deck-ul B" only names the reference, which is always the playing deck.
    t = t.replace(/\b(?:as|like|ca|cu)\s+(?:on\s+)?deck(?:-?ul)?\s+[abcd]\b/g, " ").replace(/\bdeck(?:-?ul)?\s+[abcd]\b/g, " ");

    if (has(t, STEMS)) f.stems = true;
    t = strip(t, STEMS);
    if (has(t, FAVORITES)) f.favorites = true;
    t = strip(t, FAVORITES);
    if (has(t, FRESH)) f.fresh = true;
    t = strip(t, FRESH);

    f.words = t
        .split(/\s+/)
        .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
        .filter((w) => w.length > 1 && !NOISE.has(w) && !UNIT_BPM.test(w) && !/^\d+$/.test(w));
    return f;
}

/** True when the request asks for something (a filter or a word). */
export function hasAnyFilter(f: SetFilters): boolean {
    return f.bpmMin !== null || f.bpmMax !== null || f.words.length > 0 || f.keyRelation !== null || f.energyDirection !== null || f.yearMin !== null || f.stems || f.favorites || f.fresh;
}

/** What the playing deck provides for the key / energy relations. */
export interface SetReference {
    /**
     * Key of the reference deck AS IT SOUNDS (its key shift applied, see `soundingKey`): the
     * same key the ranking and the row's key chip compare against.
     */
    key: string | null;
    /** Energy 1..10 of the playing track (null = unknown). */
    energy: number | null;
    /** Track id on the playing deck: never suggested. */
    trackId: string | null;
    /**
     * The shell proposes key shifts (WP19-61): a "harmonic" request then keeps a clashing
     * track that one or two semitones of key shift make compatible. Left out / false (a shell
     * without proposals): such a track is filtered out, as before.
     */
    shiftable?: boolean;
}

/** `fits` = the relation holds as the track is; `shift` = only after a key shift the co-pilot can propose. */
type KeyVerdict = "fits" | "shift" | "no";

function keyVerdict(rel: KeyRelation, ref: CamelotKey | null, track: string | null, shiftable: boolean): KeyVerdict {
    if (!ref) return "fits";
    const k = parseCamelot(track);
    if (!k) return "no";
    // "Same key" and "relative key" name one key: they stay strict, a shift is not offered.
    if (rel === "same") return k.number === ref.number && k.letter === ref.letter ? "fits" : "no";
    if (rel === "relative") return k.number === ref.number && k.letter !== ref.letter ? "fits" : "no";
    // One key verdict inside the co-pilot: the score the ranking uses (the crate's `key_score`,
    // mirrored by `crateKeyScore`), not the Library's own rule. They differ on one class: the
    // same letter five wheel steps apart (8A against 1A or 3A, keys one semitone apart) is
    // "workable" for the Library and a clash for the ranking. Here it is a clash, like on the
    // row next to it: kept only when a key shift fixes it (it always does: one semitone).
    if (crateKeyScore(ref, k).score >= KEY_CLASH_BELOW) return "fits";
    // "Harmonic" / "in key": a clash the co-pilot can fix with one or two semitones stays in.
    return shiftable && proposeKeyShift(`${ref.number}${ref.letter}`, `${k.number}${k.letter}`) !== null ? "shift" : "no";
}

/**
 * A closed window counts half / double time too (87 counts for 170-180). An open range ("over
 * 140", "under 100") compares the tempo as written: with one bound, doubling or halving would
 * let every track through (136 doubles to 272, which is "over 140").
 */
function bpmOk(bpm: number | null, min: number | null, max: number | null): boolean {
    if (min === null && max === null) return true;
    if (!bpm || bpm <= 0) return false;
    const folds = min !== null && max !== null ? [bpm, bpm * 2, bpm / 2] : [bpm];
    return folds.some((b) => (min === null || b >= min - 1e-9) && (max === null || b <= max + 1e-9));
}

/** Search tokens of a text: folded, split on anything that is not a letter or digit. */
function tokens(s: string): string[] {
    return fold(s)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 0);
}

/** Search text of a track (title, file name, artist, genre, album as folded tokens), built once per row object. */
const hayCache = new WeakMap<LibraryTrack, string>();

function haystack(t: LibraryTrack): string {
    let hay = hayCache.get(t);
    if (hay === undefined) {
        hay = ` ${tokens([t.title ?? "", t.filename, t.artist ?? "", t.genre ?? "", t.album ?? ""].join(" ")).join(" ")} `;
        hayCache.set(t, hay);
    }
    return hay;
}

/** Genre and album tokens of a track, built once per row object (the pool grows page by page with the same rows). */
const tagCache = new WeakMap<LibraryTrack, readonly string[]>();

export function tagTokens(t: LibraryTrack): readonly string[] {
    let tags = tagCache.get(t);
    if (tags === undefined) {
        tags = tokens(`${t.genre ?? ""} ${t.album ?? ""}`);
        tagCache.set(t, tags);
    }
    return tags;
}

/**
 * The tracks of the pool that pass `f`, in two groups, each in pool order: `natural` = pass as
 * they are; `shift` = pass every filter, but their key fits only after a key shift of one or
 * two semitones (only a "harmonic" request with `ref.shiftable` has such tracks). The store
 * ranks the two groups apart (`rankInGroups` in features.ts), so a track that needs a shift is
 * never listed above one that does not.
 *
 * Text words are matched against title, artist, genre and album (every token must appear in
 * one of them; "hip-hop" matches "Hip Hop"). The energy direction keeps tracks 1–3 steps up
 * (or down) from the reference; without a reference energy every analysed track passes. A
 * clash that no shift within two semitones fixes stays out of a "harmonic" request.
 */
export function filterSet(tracks: readonly LibraryTrack[], f: SetFilters, ref: SetReference, isPlayed: (trackId: string) => boolean): { natural: LibraryTrack[]; shift: LibraryTrack[] } {
    const refKey = parseCamelot(ref.key);
    const words = f.words.flatMap(tokens);
    const shiftable = ref.shiftable === true;
    /** Passed every filter, but its key needs a shift. */
    const afterShift: LibraryTrack[] = [];
    const natural = tracks.filter((t) => {
        if (ref.trackId !== null && String(t.id) === ref.trackId) return false;
        if (!bpmOk(t.bpm, f.bpmMin, f.bpmMax)) return false;
        const key = f.keyRelation ? keyVerdict(f.keyRelation, refKey, t.keyCamelot, shiftable) : "fits";
        if (key === "no") return false;
        if (f.yearMin !== null && f.yearMax !== null && !(typeof t.year === "number" && t.year >= f.yearMin && t.year <= f.yearMax)) return false;
        if (f.stems && t.stemsStatus !== "ready") return false;
        if (f.favorites && t.isFavorite !== true) return false;
        if (f.fresh && isPlayed(String(t.id))) return false;
        if (f.energyDirection) {
            const e = t.energy;
            if (typeof e !== "number") return false;
            if (ref.energy !== null) {
                const d = e - ref.energy;
                if (f.energyDirection === "up" ? d < 1 || d > 3 : d > -1 || d < -3) return false;
            }
        }
        if (words.length > 0) {
            const hay = haystack(t);
            if (!words.every((w) => hay.includes(w))) return false;
        }
        if (key === "shift") {
            afterShift.push(t);
            return false;
        }
        return true;
    });
    return { natural, shift: afterShift };
}

/**
 * `filterSet` as one list: the tracks that pass as they are first, then the ones that need a
 * key shift (each group in pool order).
 */
export function applySetFilters(tracks: readonly LibraryTrack[], f: SetFilters, ref: SetReference, isPlayed: (trackId: string) => boolean): LibraryTrack[] {
    const { natural, shift } = filterSet(tracks, f, ref, isPlayed);
    return shift.length > 0 ? [...natural, ...shift] : natural;
}

/**
 * Words the offline intent parser treats as commands ("mix", "play", "sync", …). A request is a
 * command only when every word in it is command vocabulary: "daft punk remix" contains "mix"
 * but is a search, "mix next in 8 bars" is a command.
 */
const COMMAND_WORDS = new Set([
    "mix", "mixeaza", "transition", "tranzitie", "tranzitia", "next", "track", "piesa", "urmatoare", "urmatoarea", "in", "on", "for", "the", "a", "with", "cu", "de", "la", "bars", "bar", "masuri", "masura", "beats", "beat", "batai", "timpi", "fa", "faci", "do", "make", "start", "porneste", "canta", "play", "pause", "stop", "pauza", "opreste", "sync", "sincronizeaza", "loop", "bucla", "pune", "o", "pe", "deck", "deckul", "left", "right", "stanga", "dreapta", "cancel", "abort", "anuleaza", "suggest", "recommend", "sugereaza", "recomanda", "propune", "what", "ce", "urmeaza", "pun", "bass", "swap", "schimb", "schimba", "basul", "filter", "filtru", "echo", "ecou", "stem", "stems", "acapella", "vocal", "cut", "taie", "brusc", "more", "energy", "harder", "up", "mai", "multa", "energie", "creste", "energia", "tare", "cool", "down", "calm", "less", "lent", "putina", "relax", "now", "acum", "please", "te", "rog", "vreau", "and", "si", "out", "into", "to", "b", "c", "d", "one", "two", "four", "eight", "sixteen", "thirty", "thirtytwo", "unu", "una", "doua", "doi", "patru", "opt", "saisprezece", "treizeci", "treizecisidoua",
]);

/** True when `text` reads as a DJ command (every word is command vocabulary or a number). */
export function isCommandText(text: string): boolean {
    const words = fold(text)
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 0);
    return words.length > 0 && words.every((w) => COMMAND_WORDS.has(w) || /^\d+$/.test(w));
}

/**
 * The first `max` characters of `text`, counted in code points: an emoji or any other character
 * outside the basic plane is never cut in half (a lone surrogate breaks JSON for the shell).
 */
export function clipText(text: string, max: number): string {
    if (text.length <= max) return text;
    let out = "";
    let n = 0;
    for (const ch of text) {
        if (n >= max) break;
        out += ch;
        n++;
    }
    return out;
}

/** A request that is nothing but "stop" / "cancel" ("Oprește!", "STOP."). */
export function isBareStop(text: string): boolean {
    const words = fold(text)
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 0);
    return words.length === 1 && /^(cancel|abort|stop|anuleaza|opreste)$/.test(words[0]!);
}

/** For this long after a transition ends, a bare "stop" still means that transition. */
export const STOP_GRACE_MS = 8000;

/**
 * What a bare "stop" means: `cancel` the running transition; `nothing` when one ended within
 * the last [`STOP_GRACE_MS`] (the word was meant for it, and passing it on would PAUSE the deck
 * that is on air); otherwise it is an ordinary `command` for the intent parser.
 */
export function bareStopMeans(running: boolean, runEndedAt: number | null, now: number): "cancel" | "nothing" | "command" {
    if (running) return "cancel";
    if (runEndedAt !== null && now >= runEndedAt && now - runEndedAt < STOP_GRACE_MS) return "nothing";
    return "command";
}
