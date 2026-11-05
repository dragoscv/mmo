/**
 * Horizontal, virtualised row. Renders only items within the visible window ± `OVERSCAN` using a known card
 * width (rem), positions them absolutely and slides the track with `transform` (no layout, no native scroll).
 * Focus moves through spatial nav (`data-focus-row`); the row itself keeps the focused card on screen.
 *
 *   <Row rowId="trending" title="Trending" items={cards} kind="poster"
 *        itemKey={(c) => c.id} renderItem={(c, i) => <PosterCard focusKey={`trending:${c.id}`} … />} />
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { remPx } from "../lib/image";
import { CARD_REM } from "./Cards";

export const OVERSCAN = 6;

export interface RowProps<T> {
    /** Stable id: row memory (`data-focus-row`) + focus keys. */
    rowId: string;
    title?: ReactNode;
    items: T[];
    itemKey: (item: T, index: number) => string;
    renderItem: (item: T, index: number) => ReactNode;
    /** Card shape → width (CARD_REM). Ignored when `itemWidthRem` is set. */
    kind?: "poster" | "landscape" | "square";
    itemWidthRem?: number;
    /** Track height in rem (default: from kind, includes the focus title band). */
    heightRem?: number;
    /** ←/→ wrap at the ends. */
    wrap?: boolean;
    /** Called when focus gets within OVERSCAN of the end (paging). */
    onEndReached?: () => void;
    /** Called with the focused item (backdrop, preload). */
    onItemFocus?: (item: T, index: number) => void;
    className?: string;
    testId?: string;
}

const HEIGHT_REM = { poster: 9.5 * 1.5 + 3.4, square: 9.5 + 3.4, landscape: 15 * 9 / 16 + 3.4 } as const;

export function Row<T>(p: RowProps<T>) {
    const kind = p.kind ?? "poster";
    const wRem = p.itemWidthRem ?? CARD_REM[kind];
    const stepRem = wRem + CARD_REM.gap;
    const viewport = useRef<HTMLDivElement>(null);
    const [vpPx, setVpPx] = useState(0);
    const [first, setFirst] = useState(0);
    const firstRef = useRef(0);
    firstRef.current = first;

    useLayoutEffect(() => {
        const el = viewport.current;
        if (!el) return;
        const measure = () => setVpPx(el.clientWidth);
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, []);

    const stepPx = remPx(stepRem);
    const visible = Math.max(1, Math.floor((vpPx + remPx(CARD_REM.gap)) / Math.max(1, stepPx)) || 6);
    const n = p.items.length;

    // Clamp when the list shrinks.
    useEffect(() => {
        const max = Math.max(0, n - visible);
        if (first > max) setFirst(max);
    }, [n, visible, first]);

    const onFocusIndex = useCallback((i: number) => {
        let f = firstRef.current;
        if (i < f) f = i;
        else if (i > f + visible - 1) f = i - visible + 1;
        if (f !== firstRef.current) setFirst(f);
        if (p.onEndReached && i >= n - OVERSCAN) p.onEndReached();
        const it = p.items[i];
        if (it !== undefined) p.onItemFocus?.(it, i);
        // Vertical reveal of the whole row inside its scroll container.
        const el = viewport.current?.parentElement;
        if (el) {
            try { el.scrollIntoView({ block: "nearest", behavior: document.documentElement.getAttribute("data-motion") === "reduced" ? "auto" : "smooth" }); }
            catch { el.scrollIntoView(); }
        }
    }, [visible, n, p]);

    const from = Math.max(0, first - OVERSCAN);
    const to = Math.min(n, first + visible + OVERSCAN);
    const slice: ReactNode[] = [];
    for (let i = from; i < to; i++) {
        const it = p.items[i]!;
        slice.push(
            <div key={p.itemKey(it, i)} className="row-cell" data-index={i}
                style={{ transform: `translateX(${i * stepRem}rem)`, width: `${wRem}rem` }}
                onFocus={() => onFocusIndex(i)}>
                {p.renderItem(it, i)}
            </div>,
        );
    }

    return (
        <section className={`vrow${p.className ? ` ${p.className}` : ""}`} data-testid={p.testId}>
            {p.title && <h2 className="vrow-title">{p.title}</h2>}
            <div ref={viewport} className="vrow-viewport" style={{ height: `${p.heightRem ?? HEIGHT_REM[kind]}rem` }}
                data-focus-row={p.rowId} data-focus-noscroll="" {...(p.wrap ? { "data-focus-wrap": "" } : {})}>
                <div className="vrow-track" style={{ transform: `translateX(${-first * stepRem}rem)` }}>
                    {slice}
                </div>
            </div>
        </section>
    );
}
