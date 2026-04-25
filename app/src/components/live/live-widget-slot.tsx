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
    // Stash the latest callback in a ref so the effect can run ONCE per mount
    // (callbacks are typically re-created each parent render, so depending on
    // them directly would tear down + re-create the observers every render and
    // synchronously re-trigger requestAutoHeight → setLayouts → infinite loop).
    const reqRef = useRef<((pixels: number) => void) | undefined>(undefined);
    reqRef.current = slot?.requestAutoHeight;

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        let raf = 0;
        let lastFireAt = 0;
        const measure = () => {
            const cb = reqRef.current;
            if (!cb) return;
            // 8px dead-zone gives proper hysteresis: meter text wobble & sub-pixel
            // ResizeObserver flutter never trigger a layout write, but real UI
            // expansions (opening a section, adding a band) still come through.
            const h = el.scrollHeight;
            if (Math.abs(h - lastReportedRef.current) < 8) return;
            // Cooldown: if we just reported, wait at least 250ms before another
            // dispatch — prevents the 200ms grid-item CSS transition from
            // re-triggering us mid-animation.
            const now = performance.now();
            if (now - lastFireAt < 250) return;
            lastFireAt = now;
            lastReportedRef.current = h;
            cb(h + padding);
        };
        const ro = new ResizeObserver(() => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(measure);
        });
        ro.observe(el);
        // Defer the initial measure so the wrapper picks up its real size
        // (RGL needs one layout tick to set the cell dimensions).
        raf = requestAnimationFrame(measure);
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, [padding]);

    return <div ref={ref} className={className}>{children}</div>;
}
