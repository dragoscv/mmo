/**
 * Vertical, virtualised grid for large libraries (1000+ items). Columns derive from the container width and
 * the card width; only the rows within the viewport ± 1 screen are rendered (absolute rows inside a spacer of
 * the full height). Native scrolling on the container (`data-scroll` → keep-alive restores the offset), so
 * spatial nav's `scrollIntoView` reveals the focused card.
 *
 *   <Grid gridId="movies" items={cards} kind="poster" itemKey={(c) => c.id}
 *         renderItem={(c) => <PosterCard focusKey={`movies:${c.id}`} alwaysShowTitle … />} />
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { remPx } from "../lib/image";
import { CARD_REM } from "./Cards";

export interface GridProps<T> {
    gridId: string;
    items: T[];
    itemKey: (item: T, index: number) => string;
    renderItem: (item: T, index: number) => ReactNode;
    kind?: "poster" | "landscape" | "square";
    itemWidthRem?: number;
    /** Row height in rem (card + title). Default from kind. */
    rowHeightRem?: number;
    /** Called when the rendered window reaches the last 2 rows (paging). */
    onEndReached?: () => void;
    onItemFocus?: (item: T, index: number) => void;
    className?: string;
    /** Content above the grid inside the same scroll container (filters, heading). */
    header?: ReactNode;
}

const ROW_REM = { poster: 9.5 * 1.5 + 3.6, square: 9.5 + 3.6, landscape: 15 * 9 / 16 + 3.6 } as const;

export function Grid<T>(p: GridProps<T>) {
    const kind = p.kind ?? "poster";
    const wRem = p.itemWidthRem ?? CARD_REM[kind];
    const stepRem = wRem + CARD_REM.gap;
    const rowRem = p.rowHeightRem ?? ROW_REM[kind];
    const scroller = useRef<HTMLDivElement>(null);
    const body = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ w: 0, h: 0 });
    const [scrollTop, setScrollTop] = useState(0);
    const [bodyTop, setBodyTop] = useState(0);

    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const measure = () => {
            setSize({ w: body.current?.clientWidth ?? el.clientWidth, h: el.clientHeight });
            setBodyTop(body.current?.offsetTop ?? 0);
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, []);

    useEffect(() => {
        const el = scroller.current;
        if (!el) return;
        let raf = 0;
        const on = () => {
            if (raf) return;
            raf = requestAnimationFrame(() => { raf = 0; setScrollTop(el.scrollTop); });
        };
        el.addEventListener("scroll", on, { passive: true });
        return () => { el.removeEventListener("scroll", on); if (raf) cancelAnimationFrame(raf); };
    }, []);

    const stepPx = Math.max(1, remPx(stepRem));
    const rowPx = Math.max(1, remPx(rowRem));
    const cols = Math.max(1, Math.floor((size.w + remPx(CARD_REM.gap)) / stepPx) || 6);
    const rows = Math.ceil(p.items.length / cols);
    const screenRows = Math.ceil((size.h || window.innerHeight) / rowPx);
    const top = Math.max(0, scrollTop - bodyTop);
    const firstRow = Math.max(0, Math.floor(top / rowPx) - screenRows);
    const lastRow = Math.min(rows, Math.ceil(top / rowPx) + 2 * screenRows);

    useEffect(() => {
        if (p.onEndReached && rows > 0 && lastRow >= rows - 2) p.onEndReached();
    }, [lastRow, rows, p]);

    const cells: ReactNode[] = [];
    for (let r = firstRow; r < lastRow; r++) {
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            const it = p.items[i];
            if (it === undefined) break;
            cells.push(
                <div key={p.itemKey(it, i)} className="grid-cell" data-index={i}
                    style={{ transform: `translate(${c * stepRem}rem, ${r * rowRem}rem)`, width: `${wRem}rem` }}
                    onFocus={p.onItemFocus ? () => p.onItemFocus!(it, i) : undefined}>
                    {p.renderItem(it, i)}
                </div>,
            );
        }
    }

    return (
        <div ref={scroller} className={`vgrid${p.className ? ` ${p.className}` : ""}`} data-scroll={p.gridId}>
            {p.header}
            <div ref={body} className="vgrid-body" style={{ height: `${rows * rowRem}rem` }}>
                {cells}
            </div>
        </div>
    );
}
