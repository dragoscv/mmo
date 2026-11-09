/**
 * Scroll-less virtualised list: renders exactly the rows that fit (see
 * `useWindowedList`), moves row by row with wheel / keys / touch drag / the
 * position thumb, and never uses native overflow scrolling. The container is
 * `overflow: hidden`; the indicator thumb is a plain element (not a scrollbar).
 *
 * a11y: `role="listbox"` with `aria-activedescendant`; options carry
 * `aria-setsize` / `aria-posinset` for their virtual position. The range text
 * is announced politely only after the user pauses.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { cn } from "@mmo/ui";
import { visibleRange } from "./window-state.ts";
import { keyAction, motionAllowed, useSettledValue, useWheelRows, type WindowedList } from "./useWindowedList.ts";

export interface RowContext {
    index: number;
    selected: boolean;
    rowHeight: number;
}

export interface ScrolllessListProps<T> {
    items: readonly T[];
    getKey: (item: T) => string | number;
    renderRow: (item: T, ctx: RowContext) => ReactNode;
    /** Enter / double-click on a row. `shift` = Shift held. */
    onActivate?: (index: number, opts: { shift: boolean }) => void;
    list: WindowedList;
    /** Accessible name of the listbox. */
    label: string;
    /** Column header, rendered above the rows and aligned with them. */
    header?: ReactNode;
    /** Shown in place of the rows when there are none (loading, empty, error). */
    placeholder?: ReactNode;
    /** Short visual indicator text, e.g. "312–330 / 4 812". */
    formatPosition: (from: number, to: number, total: number) => string;
    /** Longer text for the polite live region. */
    formatLive: (from: number, to: number, total: number) => string;
    listRef?: Ref<HTMLDivElement>;
    className?: string;
}

const LIVE_DELAY_MS = 700;

export function ScrolllessList<T>({
    items,
    getKey,
    renderRow,
    onActivate,
    list,
    label,
    header,
    placeholder,
    formatPosition,
    formatLive,
    listRef,
    className,
}: ScrolllessListProps<T>) {
    const id = useId();
    const { state, dispatch, viewportRef, rowHeight } = list;
    const visibleRef = useRef(state.visible);
    visibleRef.current = state.visible;
    const listEl = useRef<HTMLDivElement | null>(null);
    const [listNode, setListNodeState] = useState<HTMLDivElement | null>(null);
    const stackEl = useRef<HTMLDivElement | null>(null);
    const total = items.length;
    const range = visibleRange(state);
    const rows = useMemo(() => items.slice(state.offset, state.offset + state.visible), [items, state.offset, state.visible]);

    useWheelRows(listNode, dispatch, rowHeight, visibleRef);

    // Touch drag: shift the window one row per rowHeight of finger travel.
    const touch = useRef<{ id: number; y: number } | null>(null);
    const onPointerDown = (e: React.PointerEvent) => {
        if (e.pointerType !== "touch") return;
        touch.current = { id: e.pointerId, y: e.clientY };
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const t = touch.current;
        if (!t || t.id !== e.pointerId) return;
        const dy = t.y - e.clientY;
        const n = dy > 0 ? Math.floor(dy / rowHeight) : Math.ceil(dy / rowHeight);
        if (n !== 0) {
            t.y -= n * rowHeight;
            dispatch({ type: "scroll", n });
        }
    };
    const endTouch = (e: React.PointerEvent) => {
        if (touch.current?.id === e.pointerId) touch.current = null;
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (total > 0) onActivate?.(state.cursor, { shift: e.shiftKey });
            return;
        }
        const a = keyAction(e.key);
        if (!a) return;
        e.preventDefault();
        dispatch(a);
    };

    // Subtle one-row shift animation when the window moves by exactly one row.
    const prevOffset = useRef(state.offset);
    useLayoutEffect(() => {
        const d = state.offset - prevOffset.current;
        prevOffset.current = state.offset;
        const el = stackEl.current;
        if (!el || Math.abs(d) !== 1 || !motionAllowed() || typeof el.animate !== "function") return;
        el.animate([{ transform: `translateY(${d * rowHeight}px)` }, { transform: "translateY(0)" }], { duration: 80, easing: "ease-out" });
    }, [state.offset, rowHeight]);

    // Polite announcement only after a pause.
    const live = useSettledValue(total > 0 ? formatLive(range.from, range.to, range.total) : "", LIVE_DELAY_MS);

    const setListNode = useCallback(
        (node: HTMLDivElement | null) => {
            listEl.current = node;
            setListNodeState(node);
            if (typeof listRef === "function") listRef(node);
            else if (listRef) (listRef as { current: HTMLDivElement | null }).current = node;
        },
        [listRef],
    );

    const optionId = (i: number) => `${id}-o${i}`;

    return (
        <div className={cn("grid min-h-0 min-w-0 overflow-hidden", className)} style={{ gridTemplateRows: header ? "auto minmax(0, 1fr) auto" : "minmax(0, 1fr) auto" }}>
            {header && <div className="min-w-0 overflow-hidden pr-3.5">{header}</div>}
            <div className="relative flex min-h-0 min-w-0 overflow-hidden">
                <div ref={viewportRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
                    <div
                        ref={setListNode}
                        role="listbox"
                        tabIndex={0}
                        aria-label={label}
                        aria-activedescendant={total > 0 ? optionId(state.cursor) : undefined}
                        onKeyDown={onKeyDown}
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={endTouch}
                        onPointerCancel={endTouch}
                        className="absolute inset-0 overflow-hidden rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        style={{ touchAction: "none" }}
                    >
                        {total === 0 ? (
                            <div className="flex h-full min-h-0 items-center justify-center overflow-hidden p-1">{placeholder}</div>
                        ) : (
                            <div ref={stackEl} style={{ willChange: "transform" }}>
                                {rows.map((item, k) => {
                                    const index = state.offset + k;
                                    const selected = index === state.cursor;
                                    return (
                                        <div
                                            key={getKey(item)}
                                            id={optionId(index)}
                                            role="option"
                                            aria-selected={selected}
                                            aria-setsize={total}
                                            aria-posinset={index + 1}
                                            onClick={() => {
                                                dispatch({ type: "jumpTo", index });
                                                listEl.current?.focus({ preventScroll: true });
                                            }}
                                            onDoubleClick={(e) => onActivate?.(index, { shift: e.shiftKey })}
                                            className="overflow-hidden rounded-md"
                                            style={{
                                                height: rowHeight,
                                                background: selected ? "color-mix(in oklch, var(--accent) 22%, var(--bg-elev))" : k % 2 ? "var(--bg-elev)" : "transparent",
                                                boxShadow: selected ? "inset 2px 0 0 var(--accent)" : undefined,
                                            }}
                                        >
                                            {renderRow(item, { index, selected, rowHeight })}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
                <PositionThumb list={list} />
            </div>
            <div className="flex min-w-0 items-center justify-end overflow-hidden pt-1 pr-3.5">
                <span className="mono truncate text-[10px] tabular-nums" style={{ color: "var(--fg-dim)" }} aria-hidden>
                    {formatPosition(range.from, range.to, range.total)}
                </span>
                <span className="sr-only" aria-live="polite" aria-atomic="true">
                    {live}
                </span>
            </div>
        </div>
    );
}

/**
 * Thin position track with a draggable thumb (pointer only; keyboard users have
 * PageUp/PageDown/Home/End on the list). Not a native scrollbar.
 */
function PositionThumb({ list }: { list: WindowedList }) {
    const { state, dispatch } = list;
    const trackEl = useRef<HTMLDivElement | null>(null);
    const stateRef = useRef(state);
    stateRef.current = state;
    const [h, setH] = useState(0);

    useEffect(() => {
        const el = trackEl.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver((e) => setH(e[0]?.contentRect.height ?? 0));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const { total, visible, offset } = state;
    const scrollable = total > visible;
    const thumbH = scrollable ? Math.max(16, Math.round((h * visible) / total)) : h;
    const maxOffset = Math.max(1, total - visible);
    const top = scrollable ? Math.round(((h - thumbH) * offset) / maxOffset) : 0;

    const seek = (clientY: number) => {
        const el = trackEl.current;
        const s = stateRef.current;
        if (!el || s.total <= s.visible) return;
        const r = el.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientY - r.top - thumbH / 2) / Math.max(1, r.height - thumbH)));
        const target = Math.round(ratio * (s.total - s.visible));
        if (target !== s.offset) dispatch({ type: "scroll", n: target - s.offset });
    };

    return (
        <div
            ref={trackEl}
            aria-hidden
            className="relative ml-1.5 w-2 shrink-0 cursor-pointer touch-none"
            onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                seek(e.clientY);
            }}
            onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(e.clientY);
            }}
        >
            <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full" style={{ background: "var(--border)" }} />
            {scrollable && (
                <div
                    className="absolute left-0 w-2 rounded-full"
                    style={{ top, height: thumbH, background: "color-mix(in oklch, var(--accent) 70%, transparent)" }}
                />
            )}
        </div>
    );
}
