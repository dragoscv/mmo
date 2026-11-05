/**
 * Keep-alive navigation stack (WP16-30).
 *
 *  - `NavProvider` owns the stack; `useNav()` returns the `NavApi` (push/pop/replace/resetTo/canPop/current).
 *  - `Outlet` renders the TOP `MAX_MOUNTED` entries, each in its own `.nav-entry` container; only the current
 *    one is shown, the others are `display:none` but stay mounted (state, data, scroll, virtualised rows survive),
 *    so Back is instant with no refetch. Deeper entries keep only their route and remount when popped to.
 *  - Before an entry is hidden its focused element's `data-focus-key` and the scroll offsets of the entry and
 *    of every `[data-scroll]` descendant are saved; on show they are restored (fallback: first focusable).
 *  - `useScreenActive()` tells a screen whether it is the visible entry (pause timers/videos when false).
 */
import { createContext, memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { contentRoot, focusByKey, focusFirst, focusRail, invalidateRects, isInRail } from "../lib/focus";
import { routeKey, type Route } from "./routes";

export const MAX_MOUNTED = 6;

export interface NavEntry {
    id: number;
    route: Route;
}

export interface NavApi {
    /** Current (top) route. */
    readonly current: Route;
    /** Number of entries in the stack (≥ 1). */
    readonly depth: number;
    readonly canPop: boolean;
    push(route: Route): void;
    /** Pops one entry; false when already at the root. */
    pop(): boolean;
    /** Replaces the top entry (new screen instance). */
    replace(route: Route): void;
    /** Clears the stack to a single root route. Reuses the live root when it is the same screen + params. */
    resetTo(route: Route): void;
}

const NavCtx = createContext<NavApi | null>(null);
const EntryCtx = createContext<{ id: number; active: boolean }>({ id: 0, active: true });

/**
 * The nav API. The returned object is STABLE (same identity for the app's lifetime; `current`/`depth`/`canPop`
 * are live getters), but the calling component re-renders on every stack change.
 */
export function useNav(): NavApi {
    const n = useContext(NavCtx);
    useContext(StackCtx); // subscribe → re-render on navigation
    if (!n) throw new Error("useNav() outside <NavProvider>");
    return n;
}

/** True while this screen is the visible stack entry. */
export function useScreenActive(): boolean {
    return useContext(EntryCtx).active;
}

interface SavedView {
    focusKey: string | null;
    scroll: Array<{ sel: string | null; top: number; left: number }>;
}

let nextId = 1;

export function NavProvider({ initial, children }: { initial: Route; children: ReactNode }) {
    const [stack, setStack] = useState<NavEntry[]>(() => [{ id: nextId++, route: initial }]);
    const stackRef = useRef(stack);
    // The ref is the synchronous source of truth (push+current in the same tick see the new top).
    const commit = useCallback((next: NavEntry[]) => {
        if (next === stackRef.current) return;
        stackRef.current = next;
        setStack(next);
    }, []);

    const push = useCallback((route: Route) => {
        commit([...stackRef.current, { id: nextId++, route }]);
    }, [commit]);
    const pop = useCallback((): boolean => {
        const s = stackRef.current;
        if (s.length <= 1) return false;
        commit(s.slice(0, -1));
        return true;
    }, [commit]);
    const replace = useCallback((route: Route) => {
        commit([...stackRef.current.slice(0, -1), { id: nextId++, route }]);
    }, [commit]);
    const resetTo = useCallback((route: Route) => {
        const s = stackRef.current;
        const root = s[0];
        if (root && routeKey(root.route) === routeKey(route)) commit(s.length === 1 ? s : [root]);
        else commit([{ id: nextId++, route }]);
    }, [commit]);

    const api = useMemo<NavApi>(() => ({
        get current() { const s = stackRef.current; return s[s.length - 1]!.route; },
        get depth() { return stackRef.current.length; },
        get canPop() { return stackRef.current.length > 1; },
        push, pop, replace, resetTo,
    }), [push, pop, replace, resetTo]);

    return (
        <NavCtx.Provider value={api}>
            <StackCtx.Provider value={stack}>{children}</StackCtx.Provider>
        </NavCtx.Provider>
    );
}

const StackCtx = createContext<NavEntry[]>([]);

function saveView(el: HTMLElement): SavedView {
    const active = document.activeElement as HTMLElement | null;
    const keyed = active && el.contains(active) ? active.closest<HTMLElement>("[data-focus-key]") : null;
    const scroll: SavedView["scroll"] = [{ sel: null, top: el.scrollTop, left: el.scrollLeft }];
    el.querySelectorAll<HTMLElement>("[data-scroll]").forEach((s) => {
        const id = s.getAttribute("data-scroll") || null;
        if (s.scrollTop || s.scrollLeft) scroll.push({ sel: id, top: s.scrollTop, left: s.scrollLeft });
    });
    return { focusKey: keyed?.getAttribute("data-focus-key") ?? null, scroll };
}

function restoreScroll(el: HTMLElement, v: SavedView): void {
    for (const s of v.scroll) {
        const target = s.sel === null ? el : el.querySelector<HTMLElement>(`[data-scroll="${s.sel}"]`);
        if (target) { target.scrollTop = s.top; target.scrollLeft = s.left; }
    }
}

/** Retries `focusFirst` while an async screen renders its first focusable (≤ ~1.2 s). */
function focusWhenReady(entry: HTMLElement, key: string | null): void {
    let tries = 0;
    const attempt = () => {
        if (!entry.isConnected || entry.getAttribute("data-nav-active") !== "true") return;
        const act = document.activeElement as HTMLElement | null;
        // A screen (or a dialog) already focused something inside → done. Rail focus is respected too.
        if (act && act !== document.body && act.isConnected && act.offsetParent !== null
            && (entry.contains(act) || isInRail(act) || act.closest("[data-focus-scope]"))) return;
        if (key && focusByKey(key, entry)) return;
        if (focusFirst(entry)) return;
        if (++tries < 8) setTimeout(attempt, tries < 3 ? 40 : 150);
        else focusRail(); // screen without focusables (empty state) → the rail, never "nowhere"
    };
    requestAnimationFrame(attempt);
}

/**
 * Renders the stack. `render(route, entryId)` returns the screen element for a route.
 * Each entry: `<div class="nav-entry" data-nav-entry data-nav-active>`.
 */
export function Outlet({ render, className }: { render: (route: Route, id: number) => ReactNode; className?: string }) {
    const stack = useContext(StackCtx);
    const mounted = stack.slice(-MAX_MOUNTED);
    const topId = stack[stack.length - 1]!.id;
    const refs = useRef(new Map<number, HTMLElement>());
    const saved = useRef(new Map<number, SavedView>());
    const prevTop = useRef<number | null>(null);

    // Runs before paint: save the view of the entry being hidden, restore the one being shown.
    useLayoutEffect(() => {
        const prev = prevTop.current;
        if (prev !== null && prev !== topId) {
            const el = refs.current.get(prev);
            // `display` already flipped this render — read from the saved snapshot taken in the ref callback.
            if (el && !saved.current.has(prev)) saved.current.set(prev, saveView(el));
        }
        prevTop.current = topId;
        // Drop saved views of entries no longer in the stack.
        const live = new Set(stack.map((e) => e.id));
        for (const id of Array.from(saved.current.keys())) if (!live.has(id)) saved.current.delete(id);
        const el = refs.current.get(topId);
        if (!el) return;
        invalidateRects();
        const v = saved.current.get(topId);
        if (v) { restoreScroll(el, v); saved.current.delete(topId); }
        focusWhenReady(el, v?.focusKey ?? null);
    }, [topId, stack]);

    return (
        <>
            {mounted.map((e) => {
                const active = e.id === topId;
                return (
                    <div
                        key={e.id}
                        className={className ? `nav-entry ${className}` : "nav-entry"}
                        data-nav-entry=""
                        data-nav-active={active ? "true" : "false"}
                        style={active ? undefined : { display: "none" }}
                        ref={(el) => {
                            if (el) refs.current.set(e.id, el);
                            else refs.current.delete(e.id);
                        }}
                    >
                        <EntryCtx.Provider value={{ id: e.id, active }}>
                            <SnapshotOnHide id={e.id} active={active} refs={refs} saved={saved} />
                            <EntryView route={e.route} id={e.id} render={render} />
                        </EntryCtx.Provider>
                    </div>
                );
            })}
        </>
    );
}

/** Re-renders only when the route object, the entry or the render function (ctx) changes. */
const EntryView = memo(function EntryView({ route, id, render }: { route: Route; id: number; render: (route: Route, id: number) => ReactNode }) {
    return <>{render(route, id)}</>;
});

/** Saves the view of an entry right before React hides it (`active` true → false). */
function SnapshotOnHide({ id, active, refs, saved }: {
    id: number; active: boolean;
    refs: { current: Map<number, HTMLElement> };
    saved: { current: Map<number, SavedView> };
}) {
    const wasActive = useRef(active);
    // Render phase runs BEFORE the DOM gets display:none → scroll/focus are still readable here.
    if (wasActive.current && !active) {
        const el = refs.current.get(id);
        if (el) saved.current.set(id, saveView(el));
    }
    wasActive.current = active;
    return null;
}

/** Current content root element (the active entry) — for screens that need to query their own DOM. */
export function activeEntryElement(): HTMLElement | null {
    const r = contentRoot();
    return r instanceof HTMLElement ? r : null;
}
