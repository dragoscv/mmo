/**
 * "Does it fit?" for a deck tab body. The deck gives a tab body a box (as low as 56 px, 44 px
 * controls in touch mode, bigger ones in booth mode, longer words in another language), so a
 * body cannot know from numbers alone how much it can show. It renders its roomy form, this
 * hook looks whether anything sticks out of the box, and the body steps down one level at a
 * time (fewer rows, then controls into a popover) until it fits.
 *
 * Measured only when the box, the `key` or the level changes: never per frame.
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { subscribeLook } from "@/look/look";

/** Attributes of `<html>` that change the size of controls or of their text (`data-touch` stays first). */
const ROOT_ATTRS = ["data-touch", "data-booth", "data-density", "data-look", "lang", "data-skin"] as const;

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function rootMode(): string {
    const el = document.documentElement;
    return ROOT_ATTRS.map((a) => el.getAttribute(a) ?? "").join("|");
}

function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    if (!observer && typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(() => {
            sizes = null;
            for (const l of listeners) l();
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: [...ROOT_ATTRS] });
    }
    return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
            observer?.disconnect();
            observer = null;
        }
    };
}

/** The mode attributes of `<html>` as one string (one shared observer; changes are rare). */
export function useRootMode(): string {
    return useSyncExternalStore(subscribe, rootMode, () => "");
}

/** Touch mode (44 px targets) is on. */
export function useTouchMode(): boolean {
    return useRootMode().startsWith("on|");
}

/** Look values that size controls and their text; a skin may set them (`look/style-vars.ts`, `STYLE_SIZES`). */
const SIZE_PROPS = ["--ctl-h", "--panel-pad", "--panel-gap", "--titlebar-h"] as const;
let sizes: string | null = null;
let watchingLook = false;

function lookSizes(): string {
    // One invalidation for every hook: the signature is read from the computed style once per look change.
    if (!watchingLook) {
        watchingLook = true;
        subscribeLook(() => {
            sizes = null;
        });
    }
    if (sizes === null) {
        const cs = getComputedStyle(document.documentElement);
        sizes = `${SIZE_PROPS.map((p) => cs.getPropertyValue(p).trim()).join("|")}|${cs.fontSize}|${cs.fontFamily}`;
    }
    return sizes;
}

/**
 * The size-relevant part of the look as one string. The look bus fires on every `style` / `class`
 * change of `<html>` (a colour, the beat accent, a scroll lock); a fit only starts again when a
 * value that changes the size of a control or of its text is different.
 */
function useLookSizes(): string {
    return useSyncExternalStore(subscribeLook, lookSizes, () => "");
}

/** Something inside `el` sticks out of its box (half a pixel of tolerance). */
function spills(el: HTMLElement): boolean {
    const box = el.getBoundingClientRect();
    for (const child of el.querySelectorAll<HTMLElement>("*")) {
        const r = child.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Screen-reader-only text is clipped on purpose.
        if (child.closest(".sr-only")) continue;
        if (r.bottom > box.bottom + 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.left < box.left - 0.5) return true;
    }
    return false;
}

interface Fit {
    level: number;
    w: number;
    h: number;
    key: string;
}

/**
 * Returns to level 0 allowed within {@link RESET_WINDOW_MS}. Past that (a splitter being dragged,
 * or a box that follows its content) the level only steps DOWN, and the roomy form is judged
 * once more {@link SETTLE_MS} after the last change.
 */
const MAX_RESETS = 6;
const RESET_WINDOW_MS = 500;
const SETTLE_MS = 300;
/**
 * A settle retry that is back, within this time, in a state (box, key, level) a retry started
 * from is a loop (a box that changes size after the check because of the level): it stops there
 * until the box or the key changes. Without it the retry ran again every {@link SETTLE_MS}, forever.
 * A loop comes back within one settle delay; the window is short so that a user who drags a
 * splitter away and back is not mistaken for one.
 */
const LOOP_WINDOW_MS = 1000;
const LOOP_MEMORY = 4;

/**
 * The lowest level 0..`max` at which the content of the returned ref's element stays inside
 * it. Level 0 is the roomy form. `key` = whatever changes the content's size without changing
 * the box (a count, an error line): a new key starts again from level 0. Touch mode, booth
 * mode, density, language, the look and the skin's sizes are part of the key already.
 */
export function useFitLevel<T extends HTMLElement>(max: number, key = ""): readonly [RefObject<T | null>, number] {
    const ref = useRef<T>(null);
     const mode = useRootMode();
     const look = useLookSizes();
     const full = `${key}|${mode}|${look}`;
    const [fit, setFit] = useState<Fit>({ level: 0, w: 0, h: 0, key: full });
    const latest = useRef<() => void>(() => undefined);
    const current = useRef(fit);
    const resets = useRef({ n: 0, since: 0 });
    /** States the last settle retries started from, with the time they started. */
    const retries = useRef<(Fit & { at: number })[]>([]);
    /** The last state change was a level step of our own. */
    const stepped = useRef(false);
    const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

    useLayoutEffect(() => {
        current.current = fit;
        const check = () => {
            const el = ref.current;
            if (!el) return;
            const w = el.clientWidth;
            const h = el.clientHeight;
            const own = stepped.current;
            stepped.current = false;
            // A box that follows its content (a popover) changed size because WE stepped a level:
            // that is not a new box, keep the level.
            if (own && fit.key === full && (fit.w !== w || fit.h !== h)) {
                setFit({ ...fit, w, h });
                return;
            }
            // A new box or new content: judge the roomy form again.
            if (fit.w !== w || fit.h !== h || fit.key !== full) {
                const now = performance.now();
                const r = resets.current;
                if (now - r.since > RESET_WINDOW_MS) resets.current = { n: 1, since: now };
                else if (++r.n > MAX_RESETS) {
                    // Keep the level, remember the size, look at the roomy form again when it is quiet.
                    setFit({ ...fit, w, h, key: full });
                    if (settle.current) clearTimeout(settle.current);
                    settle.current = null;
                    // A retry started from this very state a moment ago and ended here again: stop.
                    if (retries.current.some((s) => now - s.at < LOOP_WINDOW_MS && s.w === w && s.h === h && s.key === full && s.level === fit.level)) return;
                    settle.current = setTimeout(() => {
                        settle.current = null;
                        resets.current = { n: 0, since: 0 };
                        retries.current = [...retries.current, { ...current.current, at: performance.now() }].slice(-LOOP_MEMORY);
                        setFit((f) => ({ ...f, level: 0, w: -1 }));
                    }, SETTLE_MS);
                    return;
                }
                setFit({ level: 0, w, h, key: full });
                return;
            }
            if (fit.level < max && spills(el)) {
                stepped.current = true;
                setFit({ ...fit, level: fit.level + 1 });
            }
        };
        latest.current = check;
        check();
    }, [fit, full, max]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => latest.current());
        ro.observe(el);
        return () => {
            ro.disconnect();
            if (settle.current) clearTimeout(settle.current);
        };
    }, []);

    return [ref, Math.min(fit.level, max)] as const;
}
