/**
 * Library browse API — the one entry point for hardware and shortcuts to drive
 * the scroll-less Library list. Fire-and-forget commands; the mounted Library
 * subscribes and applies them to its own cursor (so mouse, keyboard and
 * controller move the same selection). With no Library mounted the commands
 * are no-ops.
 *
 * ```ts
 * import { libraryNav } from "@/library/library-nav";
 * libraryNav.move(+1);           // browse encoder tick (negative = up); any integer
 * libraryNav.page(-1);           // optional: page up/down by the rows that fit
 * libraryNav.loadSelected("a");  // controller LOAD A / B / C / D button
 * libraryNav.focusSearch();      // focus the search box (icon tier: opens the search popover)
 * libraryNav.search("daft punk"); // put text in the search box and run the search
 * ```
 *
 * Mapping MIDI: map the browse encoder's relative value to `move(delta)` and
 * its push to `loadSelected(<deck that is not playing>)`; the Library does not
 * read MIDI itself.
 */
import type { DeckId } from "@/bridge/types";

export type LibraryNavCommand =
    | { type: "move"; delta: number }
    | { type: "page"; dir: number }
    | { type: "load"; deck: DeckId }
    | { type: "focusSearch" }
    | { type: "search"; query: string };

type Listener = (cmd: LibraryNavCommand) => void;

const listeners = new Set<Listener>();

function emit(cmd: LibraryNavCommand): void {
    for (const l of listeners) l(cmd);
}

export const libraryNav = {
    /** Move the selection cursor by `delta` rows (the visible window follows). */
    move(delta: number): void {
        if (Number.isFinite(delta) && delta !== 0) emit({ type: "move", delta: Math.trunc(delta) });
    },
    /** Page the list by one screen of rows (`dir` > 0 down, < 0 up). */
    page(dir: number): void {
        if (dir !== 0) emit({ type: "page", dir: Math.sign(dir) });
    },
    /** Load the selected track onto `deck`. */
    loadSelected(deck: DeckId): void {
        emit({ type: "load", deck });
    },
    /** Focus the Library search field. */
    focusSearch(): void {
        emit({ type: "focusSearch" });
    },
    /** Replace the search text (the Library fetches that search and goes back to the top). */
    search(query: string): void {
        emit({ type: "search", query: query.slice(0, 200) });
    },
    /** Subscribe (used by the Library). Returns the unsubscribe function. */
    subscribe(listener: Listener): () => void {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },
};
