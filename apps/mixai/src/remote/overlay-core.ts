/**
 * Pure helpers of the stream overlay ("Now playing" page for OBS, WP19-59): the fixed port, what
 * the UI keeps between starts (the overlay code, never a port), what it sends at a start, and
 * Copy with an injectable clipboard. Unit-tested in overlay-core.test.ts; no store, no bridge,
 * no DOM.
 */

/**
 * The port Connect asks for, so the address pasted into OBS stays the same between starts.
 * In the user range (1024-49151), not registered with IANA for another service and outside the
 * ranges Windows reserves by default. When it is taken the shell starts on a free port and says
 * so (`portFallback`); that port is for that run only: the next start asks for this one again
 * (it is never stored). Documented in docs/decks/remote.md (pinned by contract.test.ts).
 */
export const REMOTE_DEFAULT_PORT = 47831;

/**
 * localStorage key of the overlay settings. Its own key on purpose: the overlay code is a
 * credential of this computer, so it is NOT part of the settings export nor of the cloud profile
 * (neither reads this key; contract.test.ts pins that).
 */
export const OVERLAY_STORE_KEY = "mixai-remote-overlay";

/**
 * What the UI keeps between starts: the overlay code only. A port is NOT kept: a fallback port
 * comes from the system's dynamic range, and asking for it again at the next start would make
 * the address drift (taken again, another fallback, and the fixed port never asked for again).
 */
export interface OverlaySaved {
    /** The overlay code the shell last reported. */
    token: string | null;
}

/** The exact form of a code the shell makes (`decks_remote::is_token`): 32 lower-case hex characters. */
export function isOverlayToken(v: unknown): v is string {
    return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}

/**
 * Read the stored value; anything malformed reads as nothing (never throws). A value written
 * before the port stopped being kept (`{ port, token }`) still gives its code; its port is
 * ignored.
 */
export function parseOverlaySaved(raw: string | null | undefined): OverlaySaved {
    const none: OverlaySaved = { token: null };
    if (!raw) return none;
    let v: unknown;
    try {
        v = JSON.parse(raw);
    } catch {
        return none;
    }
    if (typeof v !== "object" || v === null) return none;
    const o = v as { token?: unknown };
    return { token: isOverlayToken(o.token) ? o.token : null };
}

/** The value to store (the code only), or null when there is nothing worth keeping. */
export function overlaySavedJson(saved: OverlaySaved): string | null {
    return isOverlayToken(saved.token) ? JSON.stringify({ token: saved.token }) : null;
}

/** The part of a status answer this module reads. */
export interface OverlayStatusLike {
    running: boolean;
    port: number | null;
    overlayToken?: string | null;
    portFallback?: boolean;
}

/**
 * A shell that knows the stream overlay always sends `portFallback` (false while off too); one
 * built before it never does. The UI offers the overlay, the fixed port and the saved code only
 * to a shell that knows them: an older one is driven exactly as before.
 */
export function overlaySupported(status: { portFallback?: boolean } | null | undefined): boolean {
    return typeof status?.portFallback === "boolean";
}

/** What to keep after a status answer: the code of a running server; unchanged while off. Never its port. */
export function savedAfter(prev: OverlaySaved, status: OverlayStatusLike): OverlaySaved {
    if (!status.running || !overlaySupported(status)) return prev;
    return { token: isOverlayToken(status.overlayToken) ? status.overlayToken : prev.token };
}

export interface StartOpts {
    bind?: string;
    port?: number;
}

export interface StartArgs {
    bind?: string;
    port?: number;
    overlayToken?: string;
}

/**
 * What a start sends. To a shell that knows the overlay: the caller's port, else ALWAYS the fixed
 * default (a fallback port of an earlier run is never asked for again); and the saved code. To
 * an older shell: only what the caller gave (it would fail on a busy fixed port, and it has no
 * overlay).
 */
export function startArgs(opts: StartOpts | undefined, saved: OverlaySaved, supported: boolean): StartArgs {
    const out: StartArgs = {};
    if (opts?.bind !== undefined) out.bind = opts.bind;
    if (opts?.port !== undefined) out.port = opts.port;
    if (!supported) return out;
    if (out.port === undefined) out.port = REMOTE_DEFAULT_PORT;
    if (isOverlayToken(saved.token)) out.overlayToken = saved.token;
    return out;
}

/** Storage as the helpers below need it (localStorage, or a stand-in in tests). */
export interface StorageLike {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
}

/** Read what was kept; a storage that throws (private mode, disabled) reads as nothing. */
export function loadOverlaySaved(storage: StorageLike | null | undefined): OverlaySaved {
    try {
        return parseOverlaySaved(storage?.getItem(OVERLAY_STORE_KEY));
    } catch {
        return { token: null };
    }
}

/** Keep `saved`; false when the storage refused (the overlay then gets a new code at the next start). */
export function storeOverlaySaved(storage: StorageLike | null | undefined, saved: OverlaySaved): boolean {
    if (!storage) return false;
    try {
        const json = overlaySavedJson(saved);
        if (json === null) storage.removeItem(OVERLAY_STORE_KEY);
        else storage.setItem(OVERLAY_STORE_KEY, json);
        return true;
    } catch {
        return false;
    }
}

/**
 * After a status answer: keep what [`savedAfter`] says, writing only when the stored text is not
 * already exactly that (so a running server costs no write per answer, and a value stored before
 * the port stopped being kept is rewritten once, without its port). Never throws.
 */
export function rememberOverlay(storage: StorageLike | null | undefined, status: OverlayStatusLike): void {
    // Off, or a shell without the overlay: nothing is taken from the answer, nothing is written.
    if (!status.running || !overlaySupported(status)) return;
    let raw: string | null = null;
    try {
        raw = storage?.getItem(OVERLAY_STORE_KEY) ?? null;
    } catch {
        return;
    }
    const next = savedAfter(parseOverlaySaved(raw), status);
    if (raw !== overlaySavedJson(next)) storeOverlaySaved(storage, next);
}

// ---- copy -------------------------------------------------------------------------------------

/** `copied` = on the clipboard; `empty` = nothing to copy, nothing written; `failed` = the clipboard refused. */
export type CopyResult = "copied" | "empty" | "failed";

export interface ClipboardLike {
    writeText: (text: string) => Promise<void>;
}

function systemClipboard(): ClipboardLike | null {
    return typeof navigator !== "undefined" && navigator.clipboard ? navigator.clipboard : null;
}

/**
 * Put `text` on the clipboard. Never throws. `clipboard`: undefined = the system one, null = none
 * (reads as `failed`).
 */
export async function copyText(text: string | null | undefined, clipboard?: ClipboardLike | null): Promise<CopyResult> {
    if (!text) return "empty";
    const target = clipboard === undefined ? systemClipboard() : clipboard;
    if (!target) return "failed";
    try {
        await target.writeText(text);
        return "copied";
    } catch {
        return "failed";
    }
}

export type CopyKey = "remote.overlay.copied" | "remote.overlay.copyFailed";

/** The sentence that says what Copy did (`empty` cannot happen from the UI: reads as a failure). */
export function copyKey(r: CopyResult): CopyKey {
    return r === "copied" ? "remote.overlay.copied" : "remote.overlay.copyFailed";
}

// ---- what is on air ---------------------------------------------------------------------------

/**
 * The line that says what the overlay shows: "Title · Artist", one of the two alone, or null
 * when nothing is on air (never "undefined", "null" or a lone separator).
 */
export function onAirLine(onAir: { title?: string | null; artist?: string | null } | null | undefined): string | null {
    const title = typeof onAir?.title === "string" ? onAir.title.trim() : "";
    const artist = typeof onAir?.artist === "string" ? onAir.artist.trim() : "";
    if (title && artist) return `${title} · ${artist}`;
    return title || artist || null;
}
