/**
 * React binding for the pure `windowState` reducer: measures the list viewport
 * with a ResizeObserver and derives how many fixed-height rows fit
 * (floor(height / rowHeight)). Row height follows the theme (`rowHeightFor` in
 * ./track-view.ts: 22 px in the dense default, 26 px otherwise, 28 px in booth
 * mode, 44 px in touch mode).
 */
import { useCallback, useEffect, useReducer, useState, useSyncExternalStore, type Dispatch } from "react";
import { rowHeightFor } from "./track-view.ts";
import { initialWindow, windowState, type WindowAction, type WindowState } from "./window-state.ts";

const ROW_HEIGHT_SSR = 22;

function subscribeRoot(cb: () => void): () => void {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
    const mo = new MutationObserver(cb);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density", "data-touch", "data-booth"] });
    return () => mo.disconnect();
}

function readRowHeight(): number {
    if (typeof document === "undefined") return ROW_HEIGHT_SSR;
    const d = document.documentElement.dataset;
    return rowHeightFor({ density: d.density, touch: d.touch, booth: d.booth });
}

function readTouch(): boolean {
    return typeof document !== "undefined" && document.documentElement.dataset.touch === "on";
}

/** Fixed row height for the current theme; re-renders when density / booth / touch mode change. */
export function useRowHeight(): number {
    return useSyncExternalStore(subscribeRoot, readRowHeight, () => ROW_HEIGHT_SSR);
}

/** True in touch mode (every target is at least 44 px, so fixed button columns are wider). */
export function useTouchMode(): boolean {
    return useSyncExternalStore(subscribeRoot, readTouch, () => false);
}

export interface WindowedList {
    state: WindowState;
    dispatch: Dispatch<WindowAction>;
    /** Callback ref for the element whose height decides how many rows fit. */
    viewportRef: (node: HTMLElement | null) => void | (() => void);
    rowHeight: number;
    /** Measured viewport width in px (0 before the first measure). */
    width: number;
}

/** `fixedVisible` overrides the measured row count (e.g. 1 for the icon tier). */
export function useWindowedList(total: number, fixedVisible?: number): WindowedList {
    const rowHeight = useRowHeight();
    const [state, dispatch] = useReducer(windowState, initialWindow);
    const [size, setSize] = useState({ w: 0, h: 0 });

    const viewportRef = useCallback((node: HTMLElement | null) => {
        if (!node || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver((entries) => {
            const r = entries[0]?.contentRect;
            if (r) setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
        });
        ro.observe(node);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        dispatch({ type: "setTotal", n: total });
    }, [total]);

    useEffect(() => {
        dispatch({ type: "setVisible", n: fixedVisible ?? Math.max(1, Math.floor(size.h / rowHeight)) });
    }, [size.h, rowHeight, fixedVisible]);

    return { state, dispatch, viewportRef, rowHeight, width: size.w };
}

/** True when animations are allowed (theme motion pref, frame-budget governor, OS setting). */
export function motionAllowed(): boolean {
    if (typeof document === "undefined") return false;
    const d = document.documentElement.dataset;
    if (d.motion === "reduced" || d.motionGovernor === "reduced") return false;
    return !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** `value`, but only after it stopped changing for `ms` (for polite live regions). */
export function useSettledValue<T>(value: T, ms: number): T {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setSettled(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return settled;
}

/** Keyboard → window action (arrows, PageUp/PageDown, Home/End). */
export function keyAction(key: string): WindowAction | null {
    switch (key) {
        case "ArrowDown":
            return { type: "move", n: 1 };
        case "ArrowUp":
            return { type: "move", n: -1 };
        case "PageDown":
            return { type: "page", dir: 1 };
        case "PageUp":
            return { type: "page", dir: -1 };
        case "Home":
            return { type: "home" };
        case "End":
            return { type: "end" };
        default:
            return null;
    }
}

/**
 * Mouse wheel → cursor moves, row by row. The listener sits on `el` itself, so
 * it only fires while the pointer is over it; it is non-passive so the wheel
 * never moves anything else.
 */
export function useWheelRows(el: HTMLElement | null, dispatch: Dispatch<WindowAction>, rowHeight: number, visibleRef: { current: number }): void {
    useEffect(() => {
        if (!el) return;
        let acc = 0;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            if (e.deltaMode === 1) acc += e.deltaY;
            else if (e.deltaMode === 2) acc += e.deltaY * visibleRef.current;
            else acc += e.deltaY / rowHeight;
            const n = acc > 0 ? Math.floor(acc) : Math.ceil(acc);
            if (n !== 0) {
                acc -= n;
                dispatch({ type: "move", n });
            }
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [el, dispatch, rowHeight, visibleRef]);
}
