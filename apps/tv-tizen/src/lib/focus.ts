/**
 * Spatial D-pad navigation v2 (WP16-30).
 *
 * Attributes (the whole contract — screens only set these):
 *   data-focusable              element can take D-pad focus (any element; give non-buttons tabIndex={-1})
 *   data-focus-row="<id>"       container of a horizontal row; ↑/↓ into it restores the last focused child
 *   data-focus-wrap             on a row: ← on the first child wraps to the last and vice versa
 *   data-focus-key="<key>"      stable id used to restore focus when a keep-alive screen is shown again
 *   data-focus-scope            focus trap (dialogs, side panels): while one is registered via `pushFocusScope`
 *                               (or `useFocusScope` in ui/), only its descendants are candidates
 *   data-focus-zone="rail"      the left navigation rail (one per app)
 *   data-focus-noscroll         on an ancestor: never call scrollIntoView (the container scrolls itself,
 *                               e.g. virtualised `Row`/`Grid` which translate their track)
 *   data-nav-entry / data-nav-active="true"   keep-alive containers (set by nav/Outlet) — the content zone
 *
 * Rules:
 *   - Candidates = focusables inside the active scope (top dialog → else the active nav entry, or the rail
 *     while the rail has focus) whose rect lies within the viewport ± 1 screen. Rows entirely off-screen are
 *     skipped without measuring their children → O(visible) per key press.
 *   - Rects are cached per element for one "layout generation"; scroll (capture), resize and DOM mutations
 *     bump the generation.
 *   - ← at the content's left edge enters the rail; → from the rail returns to the last content focus.
 */

const SELECTOR = "[data-focusable]:not([disabled])";
const ROW_SELECTOR = "[data-focus-row]";
const RAIL_SELECTOR = '[data-focus-zone="rail"]';
const ACTIVE_ENTRY = '[data-nav-active="true"]';

export type Dir = "up" | "down" | "left" | "right";

// ─── layout generation + rect cache ─────────────────────────────────────────

let generation = 0;
const rectCache = new WeakMap<Element, { gen: number; r: DOMRect }>();
let installed = false;

/** Forget cached rects (called automatically on scroll / resize / DOM mutation). */
export function invalidateRects(): void { generation++; }

function rectOf(el: Element): DOMRect {
    const hit = rectCache.get(el);
    if (hit && hit.gen === generation) return hit.r;
    const r = el.getBoundingClientRect();
    rectCache.set(el, { gen: generation, r });
    return r;
}

function visibleRect(r: DOMRect): boolean { return r.width > 0 && r.height > 0; }

/** Viewport ± one screen in each direction. */
function nearViewport(r: DOMRect): boolean {
    const w = window.innerWidth, h = window.innerHeight;
    return r.bottom >= -h && r.top <= 2 * h && r.right >= -w && r.left <= 2 * w;
}

// ─── scopes ────────────────────────────────────────────────────────────────

const scopes: HTMLElement[] = [];

/** Trap focus inside `el` until the returned function is called. Focuses its first focusable when `autoFocus`. */
export function pushFocusScope(el: HTMLElement, autoFocus = true): () => void {
    const prev = currentFocus();
    scopes.push(el);
    if (autoFocus) requestAnimationFrame(() => { if (!el.contains(document.activeElement)) focusFirst(el); });
    return () => {
        const i = scopes.lastIndexOf(el);
        if (i >= 0) scopes.splice(i, 1);
        // Give focus back to where it was before the overlay opened.
        if (prev && prev.isConnected && visibleRect(prev.getBoundingClientRect())) focusEl(prev, false);
    };
}

function topScope(): HTMLElement | null {
    for (let i = scopes.length - 1; i >= 0; i--) {
        const s = scopes[i]!;
        if (s.isConnected) return s;
        scopes.splice(i, 1);
    }
    return null;
}

export function hasFocusScope(): boolean { return topScope() !== null; }

/** The active keep-alive entry (content zone) or `document`. */
export function contentRoot(): ParentNode {
    return document.querySelector<HTMLElement>(ACTIVE_ENTRY) ?? document;
}

export function railRoot(): HTMLElement | null {
    const r = document.querySelector<HTMLElement>(RAIL_SELECTOR);
    return r && visibleRect(r.getBoundingClientRect()) ? r : null;
}

export function isInRail(el: Element | null = document.activeElement): boolean {
    return !!el && !!el.closest?.(RAIL_SELECTOR);
}

/** Root that D-pad candidates come from right now. */
function activeRoot(from: HTMLElement | null): ParentNode {
    const s = topScope();
    if (s) return s;
    if (from && isInRail(from)) return railRoot() ?? document;
    return contentRoot();
}

// ─── row memory + last content focus ───────────────────────────────────────

const lastInRow = new Map<string, HTMLElement>();
let lastContent: HTMLElement | null = null;
let lastRail: HTMLElement | null = null;

function rowOf(el: HTMLElement): HTMLElement | null {
    return el.closest<HTMLElement>(ROW_SELECTOR);
}

/** Idempotent; installs focus tracking + rect invalidation. Called from the App once. */
export function installRowMemory(): void {
    if (installed || typeof document === "undefined") return;
    installed = true;
    document.addEventListener("focusin", (e) => {
        const el = e.target as HTMLElement | null;
        if (!el || !el.matches?.(SELECTOR)) return;
        const id = rowOf(el)?.getAttribute("data-focus-row");
        if (id) lastInRow.set(id, el);
        if (isInRail(el)) lastRail = el;
        else if (!topScope()) lastContent = el;
    });
    window.addEventListener("scroll", invalidateRects, true);
    window.addEventListener("resize", invalidateRects);
    if (typeof MutationObserver !== "undefined") {
        new MutationObserver(invalidateRects).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "data-nav-active", "hidden"] });
    }
}

/**
 * Mouse/trackpad support for desktop + browser (WP17-25): hovering a focusable focuses it (no scroll jump, the
 * focus ring follows the pointer like on Apple TV), and the wheel moves focus — vertical wheel = up/down, horizontal
 * or Shift+wheel = left/right — throttled so one notch is one step. Idempotent; a no-op on TVs (no pointer).
 */
let pointerInstalled = false;
export function installPointer(): void {
    if (pointerInstalled || typeof document === "undefined") return;
    pointerInstalled = true;
    document.documentElement.setAttribute("data-pointer", "");
    document.addEventListener("pointerover", (e) => {
        if (e.pointerType !== "mouse") return;
        const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(SELECTOR);
        if (!el || el === document.activeElement) return;
        const scope = topScope();
        if (scope && !scope.contains(el)) return;
        focusEl(el, false);
    });
    let last = 0;
    document.addEventListener("wheel", (e) => {
        // Let real scrollers (text panels, lists with native overflow) scroll themselves.
        const t = e.target as HTMLElement | null;
        if (t?.closest?.("[data-native-scroll], input, textarea, select")) return;
        const now = performance.now();
        e.preventDefault();
        if (now - last < 110) return;
        last = now;
        const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
        const d = horizontal ? (e.shiftKey ? e.deltaY : e.deltaX) : e.deltaY;
        if (Math.abs(d) < 2) return;
        if (!currentFocus()) { focusFirst(); return; }
        moveFocus(horizontal ? (d > 0 ? "right" : "left") : (d > 0 ? "down" : "up"));
    }, { passive: false });
}

function usable(el: HTMLElement | null | undefined): el is HTMLElement {
    return !!el && el.isConnected && el.matches(SELECTOR) && visibleRect(el.getBoundingClientRect());
}

function rememberedIn(row: HTMLElement | null, fallback: HTMLElement): HTMLElement {
    const id = row?.getAttribute("data-focus-row");
    const mem = id ? lastInRow.get(id) : undefined;
    return mem && mem !== fallback && row!.contains(mem) && usable(mem) ? mem : fallback;
}

// ─── queries ───────────────────────────────────────────────────────────────

/** Visible focusables under `root` (document order). Off-screen rows are skipped cheaply. */
export function focusables(root: ParentNode = contentRoot()): HTMLElement[] {
    const out: HTMLElement[] = [];
    const rowVisible = new Map<HTMLElement, boolean>();
    const list = root.querySelectorAll<HTMLElement>(SELECTOR);
    for (let i = 0; i < list.length; i++) {
        const el = list[i]!;
        const row = rowOf(el);
        if (row) {
            let v = rowVisible.get(row);
            if (v === undefined) { const rr = rectOf(row); v = visibleRect(rr) && nearViewport(rr); rowVisible.set(row, v); }
            if (!v) continue;
        }
        const r = rectOf(el);
        if (visibleRect(r) && nearViewport(r)) out.push(el);
    }
    return out;
}

export function currentFocus(): HTMLElement | null {
    const el = document.activeElement as HTMLElement | null;
    return el && el.matches?.(SELECTOR) ? el : null;
}

function scrollMode(): ScrollBehavior {
    return document.documentElement.getAttribute("data-motion") === "reduced" ? "auto" : "smooth";
}

/** Focus without the browser's jump-scroll, then reveal unless an ancestor scrolls itself. */
export function focusEl(el: HTMLElement, reveal = true): void {
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
    if (reveal && !el.closest("[data-focus-noscroll]")) {
        try { el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollMode() }); } catch { el.scrollIntoView(); }
    }
    invalidateRects();
}

/** Focus the first visible focusable under `root` (default: the active screen, never the rail). */
export function focusFirst(root: ParentNode = topScope() ?? contentRoot()): boolean {
    const el = focusables(root)[0];
    if (!el) return false;
    focusEl(el);
    return true;
}

/** Focus `[data-focus-key="<key>"]` under `root`; false when it is not rendered/visible. */
export function focusByKey(key: string, root: ParentNode = contentRoot()): boolean {
    let el: HTMLElement | null = null;
    try { el = root.querySelector<HTMLElement>(`[data-focus-key="${cssEscape(key)}"]`); } catch { el = null; }
    if (!usable(el)) return false;
    focusEl(el);
    return true;
}

/** Focus the rail: the active item (`aria-current`), else the last rail focus, else its first item. */
export function focusRail(): boolean {
    const rail = railRoot();
    if (!rail) return false;
    const cur = rail.querySelector<HTMLElement>('[data-focusable][aria-current="page"]');
    const target = usable(cur) ? cur : usable(lastRail) && rail.contains(lastRail) ? lastRail : focusables(rail)[0];
    if (!target) return false;
    focusEl(target, false);
    return true;
}

/** Return from the rail to the last focused element of the active screen (or its first focusable). */
export function focusContent(): boolean {
    const root = contentRoot();
    if (usable(lastContent) && (root === document || (root as HTMLElement).contains(lastContent))) { focusEl(lastContent); return true; }
    return focusFirst(root);
}

export function lastContentFocus(): HTMLElement | null { return usable(lastContent) ? lastContent : null; }

function cssEscape(s: string): string {
    const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
    return css?.escape ? css.escape(s) : s.replace(/["\\]/g, "\\$&");
}

// ─── movement ──────────────────────────────────────────────────────────────

function center(r: DOMRect): { x: number; y: number } {
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Wrap inside a `data-focus-wrap` row: ← on the first → last, → on the last → first. */
function wrapTarget(from: HTMLElement, dir: Dir): HTMLElement | null {
    if (dir !== "left" && dir !== "right") return null;
    const row = rowOf(from);
    if (!row || !row.hasAttribute("data-focus-wrap")) return null;
    const items = Array.from(row.querySelectorAll<HTMLElement>(SELECTOR)).filter((e) => visibleRect(rectOf(e)));
    if (items.length < 2) return null;
    const i = items.indexOf(from);
    if (dir === "left" && i === 0) return items[items.length - 1]!;
    if (dir === "right" && i === items.length - 1) return items[0]!;
    return null;
}

interface Cand { el: HTMLElement; r: DOMRect; primary: number; secondary: number }

function pick(from: HTMLElement, dir: Dir, candidates: HTMLElement[]): HTMLElement | null {
    const fr = rectOf(from);
    const fc = center(fr);
    const horizontal = dir === "left" || dir === "right";
    let bestAligned: HTMLElement | null = null; let alignedScore = Infinity;
    let bestCone: HTMLElement | null = null; let coneScore = Infinity;
    let nearest: Cand | null = null;
    const band: Cand[] = [];
    for (const el of candidates) {
        if (el === from) continue;
        const r = rectOf(el);
        const c = center(r);
        const dx = c.x - fc.x;
        const dy = c.y - fc.y;
        let primary: number;
        let secondary: number;
        switch (dir) {
            case "left": primary = -dx; secondary = Math.abs(dy); break;
            case "right": primary = dx; secondary = Math.abs(dy); break;
            case "up": primary = -dy; secondary = Math.abs(dx); break;
            case "down": primary = dy; secondary = Math.abs(dx); break;
        }
        if (primary <= 2) continue;
        if (!horizontal) {
            const cand = { el, r, primary, secondary };
            band.push(cand);
            if (!nearest || primary < nearest.primary) nearest = cand;
            continue;
        }
        // Aligned = overlaps ≥ 40 % of the smaller height; a graze must not beat a card in the same row.
        const overlapPx = Math.min(r.bottom, fr.bottom) - Math.max(r.top, fr.top);
        const overlaps = overlapPx >= Math.min(r.height, fr.height) * 0.4;
        const score = primary + secondary * 2;
        if (overlaps) {
            if (score < alignedScore) { alignedScore = score; bestAligned = el; }
        } else if (secondary <= primary) {
            if (score < coneScore) { coneScore = score; bestCone = el; }
        }
    }
    if (horizontal) return bestAligned ?? bestCone;
    if (!nearest) return null;
    // Vertical: the nearest band (row) wins regardless of column; inside it, the closest column.
    const nr = nearest.r;
    const inBand = band.filter((c) => Math.min(c.r.bottom, nr.bottom) - Math.max(c.r.top, nr.top) > 0);
    inBand.sort((a, b) => a.secondary - b.secondary || a.primary - b.primary);
    let best = inBand[0]?.el ?? nearest.el;
    const toRow = rowOf(best);
    if (toRow && toRow !== rowOf(from)) best = rememberedIn(toRow, best);
    return best;
}

/** Move focus one step. Returns true when focus moved. */
export function moveFocus(dir: Dir): boolean {
    const from = currentFocus();
    const scope = topScope();
    if (!from || (scope && !scope.contains(from))) return focusFirst(scope ?? contentRoot()) || (!scope && focusRail());

    const inRail = isInRail(from);
    if (inRail && !scope && dir === "right") return focusContent() || false;

    const wrapped = wrapTarget(from, dir);
    if (wrapped) { focusEl(wrapped); return true; }

    const best = pick(from, dir, focusables(activeRoot(from)));
    if (best) { focusEl(best, !inRail); return true; }

    // Left edge of the content → rail.
    if (!scope && !inRail && dir === "left") return focusRail();
    return false;
}
