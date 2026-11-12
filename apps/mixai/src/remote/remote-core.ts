/**
 * Pure helpers of connected mode (unit-tested in remote-core.test.ts; no store, no bridge).
 * The types are structural copies of the ones in bridge/remote.ts so this module loads under
 * `node --test` without the Vite alias.
 */

export type Status = "pending" | "accepted" | "rejected" | "played";
export type Decision = Exclude<Status, "pending">;

/** A parsed QR code: `size` units square (quiet zone included), `d` = path of the dark modules. */
export interface QrPath {
    size: number;
    d: string;
}

/**
 * The exact shape `decks_remote::qr_svg` writes: one square viewBox and one path made only of
 * unit squares. Anything else is refused, so the string is never handed to the HTML parser:
 * the caller draws `<svg><path d=…/></svg>` itself from the two captured values.
 */
const QR_SVG = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d{1,3}) (\d{1,3})" shape-rendering="crispEdges"><path fill="currentColor" d="((?:M\d{1,3} \d{1,3}h1v1h-1z)+)"\/><\/svg>$/;
/** A version 40 code has 177 modules (+ 8 quiet zone) = 31 329 squares at most. */
const QR_MAX_CHARS = 600_000;

export function parseQrSvg(svg: string | null | undefined): QrPath | null {
    if (!svg || svg.length > QR_MAX_CHARS) return null;
    const m = QR_SVG.exec(svg);
    if (!m || m[1] !== m[2]) return null;
    const size = Number(m[1]);
    if (size < 29 || size > 185) return null;
    return { size, d: m[3]! };
}

/** Decisions the DJ can take on a request in `status`, in button order. */
export function decisionsFor(status: Status): Decision[] {
    switch (status) {
        case "pending":
            return ["accepted", "rejected"];
        case "accepted":
            return ["played", "rejected"];
        case "rejected":
            // Undo a wrong reject.
            return ["accepted"];
        case "played":
            return [];
    }
}

export function countStatus(requests: readonly { status: Status }[], status: Status): number {
    let n = 0;
    for (const r of requests) if (r.status === status) n++;
    return n;
}

export interface Page<T> {
    items: T[];
    /** 0-based, clamped into range. */
    page: number;
    pages: number;
}

/** Page `page` of `list` (`size` per page); an out-of-range page is clamped (the list shrank). */
export function pageOf<T>(list: readonly T[], page: number, size: number): Page<T> {
    const per = Math.max(1, Math.floor(size));
    const pages = Math.max(1, Math.ceil(list.length / per));
    const p = Math.min(pages - 1, Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0));
    return { items: list.slice(p * per, p * per + per), page: p, pages };
}

/** The first `n` code points of `s` (never half an emoji: a lone surrogate breaks a search). */
export function cutCodePoints(s: string, n: number): string {
    return Array.from(s).slice(0, n).join("");
}

/** Library search text for a request: "title artist", single spaces, at most 200 code points. */
export function findQuery(title: string, artist: string): string {
    return cutCodePoints(`${title} ${artist}`.replace(/\s+/g, " ").trim(), 200);
}

export interface LabelDeck {
    id: string;
    loaded: boolean;
    trackId: string | null;
    title: string | null;
    artist: string | null;
}

export interface Label {
    deck: string;
    trackId: string | null;
    title: string | null;
    artist: string | null;
    cueSec: number;
}

/**
 * What the shell must know about the decks: one entry per deck, empty for an unloaded deck (so
 * an ejected track's label is dropped). `cueOf` is the UI's cue point of that deck in seconds.
 */
export function buildLabels<D extends LabelDeck>(decks: readonly D[], cueOf: (deck: D) => number): Label[] {
    return decks.map((d) => {
        if (!d.loaded) return { deck: d.id, trackId: null, title: null, artist: null, cueSec: 0 };
        const cue = cueOf(d);
        return { deck: d.id, trackId: d.trackId, title: d.title, artist: d.artist, cueSec: Number.isFinite(cue) && cue > 0 ? cue : 0 };
    });
}

/** Changes exactly when the labels do (so they are sent once per change). */
export function labelsKey(labels: readonly Label[]): string {
    return labels.map((l) => [l.deck, l.trackId ?? "", l.title ?? "", l.artist ?? "", l.cueSec.toFixed(3)].join("\u0001")).join("\u0002");
}

/** The scaffold shell of an older build answers every command with this. */
export function isMissingFeature(error: unknown): boolean {
    return /not available in this build/i.test(String(error));
}

/** The message of a rejected command, without the "Error: " a thrown Error adds. */
export function errorText(error: unknown): string {
    const s = error instanceof Error ? error.message : String(error);
    return cutCodePoints(s.replace(/^Error:\s*/, ""), 200);
}

/**
 * The known refusals of the shell (`src-tauri/src/remote.rs`), each with a catalogue string;
 * `unknown` = any other text (shown as a generic sentence plus the raw text).
 */
export type ErrorKind = "off" | "port" | "worker" | "notFound" | "bind" | "role" | "lock" | "unknown";

/** Set by the store when the shell does not know the controls lock (an older build). */
export const LOCK_UNSUPPORTED = "controls lock is not available in this build";

const ERROR_KINDS: readonly [ErrorKind, RegExp][] = [
    ["off", /^connected mode is off/i],
    ["port", /^cannot open the remote port/i],
    ["worker", /^connected mode worker is not running/i],
    ["notFound", /^request \d+ not found/i],
    ["bind", /^(invalid bind address|bind to 0\.0\.0\.0)/i],
    ["role", /^invalid (role|status|deck)/i],
    ["lock", /^controls lock is not available/i],
];

export function errorKind(text: string): ErrorKind {
    for (const [kind, re] of ERROR_KINDS) if (re.test(text)) return kind;
    return "unknown";
}

/** For the "port in use" case: what follows the colon (the OS reason), or null. */
export function errorDetail(text: string): string | null {
    const i = text.indexOf(": ");
    return i >= 0 ? text.slice(i + 2).trim() || null : null;
}

/**
 * Ids of requests that are pending now and were not in `before` as pending (new arrivals and
 * re-opened ones), in list order. Used for the one polite announcement of a new request.
 */
export function newPending<R extends { id: number; status: Status }>(before: readonly R[], now: readonly R[]): R[] {
    const seen = new Set<number>();
    for (const r of before) if (r.status === "pending") seen.add(r.id);
    return now.filter((r) => r.status === "pending" && !seen.has(r.id));
}

/**
 * Where keyboard focus should land after the row of request `id` changed under it: the same
 * row when it is still on the page, else the row that took its place (or the last one), else
 * null (the page is empty: the caller focuses a fixed control).
 */
export function focusRowAfter<R extends { id: number }>(id: number, page: readonly R[], prevIndex: number): number | null {
    if (page.length === 0) return null;
    const same = page.findIndex((r) => r.id === id);
    if (same >= 0) return same;
    return Math.min(Math.max(0, prevIndex), page.length - 1);
}

/** `ip` of an `ip:port` peer address (`[v6]:port` too); the input when it has no port. */
export function hostOf(addr: string): string {
    const m = /^\[(.+)\]:\d+$/.exec(addr) ?? /^([^:]+):\d+$/.exec(addr);
    return m ? m[1]! : addr;
}

// ---- keyboard ---------------------------------------------------------------------------------

/** The part of a key event the helpers below decide on. */
export interface KeyLike {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
}

const ARROWS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/**
 * A bare arrow key (no Ctrl / Cmd / Alt). The app binds bare arrows GLOBALLY to the crossfader
 * (lib/shortcuts: left / right = hard to A / B, down = centre) and only skips a key that a
 * control already used (`defaultPrevented`). So every arrow pressed inside a popover must be
 * consumed by the popover, or a keyboard user moving between tabs cuts the crossfader on air.
 */
export function isBareArrow(e: KeyLike): boolean {
    return ARROWS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey;
}

/** A key event as a popover root sees it (structural: this module has no DOM types to lean on). */
export interface GuardedKey extends KeyLike {
    defaultPrevented: boolean;
    preventDefault: () => void;
    target: unknown;
}

const EDITABLE: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * `onKeyDown` of a popover's root: a bare arrow nothing inside used is consumed here, so it
 * never reaches the app's crossfader shortcut. Arrows in a field that edits with them (input,
 * textarea, select, contenteditable) are left alone: the global handler skips those itself.
 * Returns true when it consumed the key.
 */
export function consumeBareArrows(e: GuardedKey): boolean {
    if (e.defaultPrevented || !isBareArrow(e)) return false;
    const el = e.target as { tagName?: unknown; isContentEditable?: unknown } | null;
    if (el && ((typeof el.tagName === "string" && EDITABLE.has(el.tagName)) || el.isContentEditable === true)) return false;
    e.preventDefault();
    return true;
}

/**
 * Roving focus in a horizontal row of `count` items (a tablist): the index to move to from
 * `index` for this key (left / right wrap, Home / End jump), or null when the key is not a
 * navigation key (or a modifier is held: those belong to the OS).
 */
export function rovingTarget(e: KeyLike, index: number, count: number): number | null {
    if (count <= 0 || e.ctrlKey || e.metaKey || e.altKey) return null;
    const cur = Math.min(count - 1, Math.max(0, index));
    switch (e.key) {
        case "ArrowRight":
            return (cur + 1) % count;
        case "ArrowLeft":
            return (cur - 1 + count) % count;
        case "Home":
            return 0;
        case "End":
            return count - 1;
        default:
            return null;
    }
}

/** The page a bare left / right arrow turns to from `page` of `pages` (clamped), or null for another key. */
export function pagerTarget(e: KeyLike, page: number, pages: number): number | null {
    if (!isBareArrow(e) || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return null;
    const next = page + (e.key === "ArrowRight" ? 1 : -1);
    return Math.min(Math.max(0, pages - 1), Math.max(0, next));
}
