/**
 * Tracklist text export: byte-identical to `export::text` of the Rust crate
 * `src-tauri/crates/decks-setlog/src/export.rs` (`01. [0:00] Artist – Title`, one line per
 * entry, `h:mm:ss` from one hour, `ID – ID` when nothing is known). Pure; tested by export.test.ts.
 */
import type { Entry } from "./set-logger.ts";

/** `m:ss`, or `h:mm:ss` from one hour; negative or fractional seconds floor to whole seconds. */
export function stamp(sec: number): string {
    const s = Math.floor(Math.max(0, Number.isFinite(sec) ? sec : 0));
    const two = (n: number) => String(n).padStart(2, "0");
    if (s >= 3600) return `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
    return `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** `Artist – Title`; a missing part reads `ID` (both missing: `ID – ID`; title alone stands by itself). */
export function label(e: Pick<Entry, "track">): string {
    const a = e.track.artist.trim();
    const t = e.track.title.trim();
    if (a === "" && t === "") return "ID – ID";
    if (a === "") return t;
    if (t === "") return `${a} – ID`;
    return `${a} – ${t}`;
}

/** `01. [0:00] Artist – Title\n` lines (Mixcloud / YouTube / SoundCloud descriptions). */
export function tracklistText(entries: readonly Pick<Entry, "track" | "startSec">[]): string {
    return entries.map((e, i) => `${String(i + 1).padStart(2, "0")}. [${stamp(e.startSec)}] ${label(e)}\n`).join("");
}
