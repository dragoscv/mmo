/**
 * Scroll-less virtualised list: renders exactly the rows that fit (see
 * `useWindowedList`), moves row by row with wheel / keys / touch drag / the
 * position thumb, and never uses native overflow scrolling. The container is
 * `overflow: hidden`; the indicator thumb is a plain element (not a scrollbar).
 *
 * a11y: `role="listbox"` with `aria-activedescendant`; options carry
 * `aria-setsize` / `aria-posinset` for their virtual position and an explicit
 * name (`getLabel`). The range text is announced politely only after the user
 * pauses. With no rows the listbox is replaced by the placeholder (which may
 * hold a button), so a listbox never contains anything but options.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";
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
    /** Accessible name of a row (its content also holds buttons, which must not end up in the name). */
    getLabel?: (item: T) => string;
    /** Enter / double-click on a row. `shift` = Shift held. */
    onActivate?: (index: number, opts: { shift: boolean }) => void;
    /** Shift+F10 / the Menu key on the list. */
    onMenuKey?: () => void;
    list: WindowedList;
    /** Accessible name of the listbox. */
    label: string;
    /** Tooltip of the listbox (keyboard hint). */
    hint?: string;
    /** Column header, rendered above the rows and aligned with them. */
    header?: ReactNode;
    /** Shown in place of the rows when there are none (loading, empty, error). */
    placeholder?: ReactNode;
    /** Text for the polite live region. */
    formatLive: (from: number, to: number, total: number) => string;
    listRef?: Ref<HTMLDivElement>;
}

const LIVE_DELAY_MS = 700;

/** True when the event started inside `el` in the DOM (React also bubbles events out of portals). */
function fromInside(e: { target: EventTarget; currentTarget: EventTarget }): boolean {
    return e.target instanceof Node && (e.currentTarget as Node).contains(e.target);
}

export function ScrolllessList<T>({
    items,
    getKey,
    renderRow,
    getLabel,
    onActivate,
    onMenuKey,
    list,
    label,
    hint,
    header,
    placeholder,
    formatLive,
    listRef,
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

    // Keys act only while the list itself has the focus: a row button or the portalled row menu
    // must keep its own Enter / arrow keys.
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (total > 0) onActivate?.(state.cursor, { shift: e.shiftKey });
            return;
        }
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            if (!onMenuKey) return;
            e.preventDefault();
            e.stopPropagation();
            onMenuKey();
            return;
        }
        const a = keyAction(e.key);
        if (!a) return;
        // The arrows are also global shortcuts (crossfader): here they belong to the list.
        e.preventDefault();
        e.stopPropagation();
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
        <div className="lib-list" style={{ ["--lib-row-h" as string]: `${rowHeight}px` } as CSSProperties}>
            {header && <div className="lib-list-head">{header}</div>}
            <div className="lib-list-body">
                <div ref={viewportRef} className="lib-viewport">
                    {total === 0 ? (
                        <div className="lib-placeholder">{placeholder}</div>
                    ) : (
                        <div
                            ref={setListNode}
                            role="listbox"
                            tabIndex={0}
                            aria-label={label}
                            title={hint}
                            aria-activedescendant={optionId(state.cursor)}
                            onKeyDown={onKeyDown}
                            onPointerDown={onPointerDown}
                            onPointerMove={onPointerMove}
                            onPointerUp={endTouch}
                            onPointerCancel={endTouch}
                            className="lib-listbox"
                        >
                            <div ref={stackEl}>
                                {rows.map((item, k) => {
                                    const index = state.offset + k;
                                    const selected = index === state.cursor;
                                    return (
                                        <div
                                            key={getKey(item)}
                                            id={optionId(index)}
                                            role="option"
                                            aria-label={getLabel?.(item)}
                                            aria-selected={selected}
                                            aria-setsize={total}
                                            aria-posinset={index + 1}
                                            onClick={(e: MouseEvent) => {
                                                if (!fromInside(e)) return;
                                                dispatch({ type: "jumpTo", index });
                                                listEl.current?.focus({ preventScroll: true });
                                            }}
                                            onDoubleClick={(e: MouseEvent) => {
                                                if (fromInside(e)) onActivate?.(index, { shift: e.shiftKey });
                                            }}
                                            className="lib-opt"
                                            data-selected={selected || undefined}
                                            data-odd={index % 2 === 1 || undefined}
                                            style={{ height: rowHeight }}
                                        >
                                            {renderRow(item, { index, selected, rowHeight })}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
                <PositionThumb list={list} />
            </div>
            <span className="sr-only" aria-live="polite" aria-atomic="true">
                {live}
            </span>
        </div>
    );
}

/**
 * Thin position track with a draggable thumb (pointer only; keyboard users have
 * PageUp/PageDown/Home/End on the list). Not a native scrollbar. The slot keeps its
 * width when everything fits, so the columns never shift.
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
            className="lib-thumb"
            data-on={scrollable || undefined}
            onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                seek(e.clientY);
            }}
            onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(e.clientY);
            }}
        >
            {scrollable && <i style={{ top, height: thumbH }} />}
        </div>
    );
}
