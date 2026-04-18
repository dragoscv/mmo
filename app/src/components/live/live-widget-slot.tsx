"use client";

/**
 * Shared context for widgets rendered inside LiveWidgetGrid.
 *
 * The grid passes `collapsed`, `onToggleCollapse`, `dragHandleClass`, and an
 * optional `requestAutoHeight` callback down via this context so a widget can:
 *   • Apply the drag-handle CSS class to its own header (so the grid library
 *     treats that bar as the drag affordance).
 *   • Render a collapse/expand button that toggles its body visibility.
 *   • Optionally fill the available height of the grid cell.
 *   • Request that the grid grow this widget's row count to fit content
 *     (auto-resize on overflow). Wrap the resizable content in `<AutoSize>`.
 *
 * Widgets that wrap themselves in `<Section>` get this auto-wired by Section.
 * Widgets with custom headers (visualizer, EQ, …) consume the hook directly.
 */

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

export interface LiveWidgetSlot {
    collapsed: boolean;
    onToggleCollapse: () => void;
    /** CSS class string to attach to the widget's drag-handle element. */
    dragHandleClass: string;
    /** Whether the widget body should fill the cell height. */
    fillHeight: boolean;
    /**
     * Whether this widget opts in to auto-resizing on content overflow.
     * When true, `<Section>` will NOT clamp its body with overflow-y-auto so
     * that natural content height bubbles up to <AutoSize>.
     */
    autoResize: boolean;
    /**
     * Ask the grid to grow this widget's row count so the rendered cell can
     * fit `pixels` of content. No-op when not provided / locked / collapsed.
     */
    requestAutoHeight?: (pixels: number) => void;
}

export const LiveWidgetSlotContext = createContext<LiveWidgetSlot | null>(null);

export function useLiveWidgetSlot(): LiveWidgetSlot | null {
    return useContext(LiveWidgetSlotContext);
}

// ─── AutoSize ────────────────────────────────────────────────────────────────

/**
 * Wrap a region whose vertical extent should drive the parent widget cell's
 * row count. Uses ResizeObserver on its child to detect natural content height
 * changes (e.g. when a section expands inside the widget) and asks the grid
 * to grow the cell. The grid handles the smooth CSS transition so the resize
 * feels fluid and animated.
 */
export function AutoSize({ children, padding = 0, className }: {
    children: ReactNode;
    /** Extra pixels to add to the measured child height (e.g. for a header). */
    padding?: number;
    className?: string;
}) {
    const slot = useLiveWidgetSlot();
    const ref = useRef<HTMLDivElement>(null);
    const lastReportedRef = useRef(0);

    useEffect(() => {
        const el = ref.current;
        if (!el || !slot?.requestAutoHeight) return;
        let raf = 0;
        const measure = () => {
            // Use scrollHeight so we observe the natural content height even
            // if the parent has clamped overflow. This responds to BOTH
            // expansions (e.g. opening an FX section) and contractions
            // (e.g. closing a section / removing items).
            const h = el.scrollHeight;
            // 2px dead-zone to ignore sub-pixel ResizeObserver flutter while
            // still being responsive to small UI changes.
            if (Math.abs(h - lastReportedRef.current) < 2) return;
            lastReportedRef.current = h;
            slot.requestAutoHeight!(h + padding);
        };
        const ro = new ResizeObserver(() => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(measure);
        });
        ro.observe(el);
        // Also observe direct children so a child collapsing (which doesn't
        // change the wrapper's box but does change scrollHeight) still fires.
        const childObservers: ResizeObserver[] = [];
        for (const child of Array.from(el.children)) {
            const cro = new ResizeObserver(() => {
                cancelAnimationFrame(raf);
                raf = requestAnimationFrame(measure);
            });
            cro.observe(child);
            childObservers.push(cro);
        }
        // MutationObserver — catches added/removed children (e.g. FX inserts).
        const mo = new MutationObserver(() => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(measure);
        });
        mo.observe(el, { childList: true, subtree: true });
        measure();
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            mo.disconnect();
            for (const c of childObservers) c.disconnect();
        };
    }, [slot, padding]);

    return <div ref={ref} className={className}>{children}</div>;
}
