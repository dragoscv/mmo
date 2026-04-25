"use client";

/**
 * LiveWidgetGrid — fully responsive, draggable, resizable, collapsible widget
 * grid for the Live Performance page. Built on react-grid-layout.
 *
 * Features:
 *   • Drag any widget anywhere (cross-column, free placement)
 *   • Resize from the bottom-right corner; per-widget min/max constraints
 *   • Per-breakpoint layouts (lg/md/sm/xs/xxs) auto-persisted to localStorage
 *   • Collapse-to-header (forces h=2 while keeping previous h on expand)
 *   • Edit-mode lock (disables drag/resize during performance, prevents fat-fingers)
 *   • Touch-friendly with custom resize handle styling
 *   • Reset Layout, Collapse All / Expand All toolbar actions
 *   • Sync via the existing `mmo-preference-changed` event
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type ComponentType } from "react";
import { Responsive, WidthProvider, type Layout, type LayoutItem, type ResponsiveLayouts } from "react-grid-layout/legacy";
import { Lock, Unlock, RotateCcw, Minimize2, Maximize2, LayoutGrid, Eye, EyeOff, ChevronDown, ChevronRight, Crosshair, Square } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useRenderCount } from "@/lib/dev-debugger";
import "react-grid-layout/css/styles.css";

// `WidthProvider(Responsive)` is the v1-style HOC; the legacy types from RGL v2
// don't quite line up because `Responsive` uses a generic Breakpoint param the HOC
// can't infer, so we cast the wrapped component to a permissive functional component.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ResponsiveGridLayout = WidthProvider(Responsive) as unknown as React.ComponentType<any>;

// Convenient mutable layout-item type (RGL's `Layout` is `readonly LayoutItem[]`)
type Layouts = Record<string, LayoutItem[]>;

// ─── Public types ────────────────────────────────────────────────────────

export interface WidgetMeta<Id extends string> {
    id: Id;
    title: string;
    /** Default layout per breakpoint. Missing breakpoints are derived. */
    defaults: Partial<Record<Breakpoint, { x: number; y: number; w: number; h: number }>>;
    /** Hard min sizes (also used as collapsed-height floor when collapsed=2). */
    minW: number;
    minH: number;
    maxW?: number;
    maxH?: number;
    /** Icon to show in the widget manager popover. */
    icon?: ComponentType<{ className?: string }>;
    /** Accent hex used in the widget manager (badge / icon tint). */
    accent?: string;
    /** Short description shown beneath the title in the manager. */
    description?: string;
    /**
     * Opt this widget into auto-resizing on content overflow. The widget body
     * should wrap the section that may grow in `<AutoSize>` (from
     * live-widget-slot). The grid will smoothly grow the cell's row count
     * (capped at maxH or 40) so the content fits without an internal scroll.
     */
    autoResize?: boolean;
}

export type Breakpoint = "lg" | "md" | "sm" | "xs" | "xxs";

const BREAKPOINTS = { lg: 1280, md: 996, sm: 768, xs: 480, xxs: 0 };
const COLS = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 };
const ALL_BPS: Breakpoint[] = ["lg", "md", "sm", "xs", "xxs"];

const ROW_HEIGHT = 32;
const MARGIN: [number, number] = [12, 12];
const PADDING: [number, number] = [12, 12];
const COLLAPSED_H = 2;

// ─── Persistence ─────────────────────────────────────────────────────────

interface PersistedState {
    layouts: Layouts;
    collapsed: Record<string, boolean>;
    locked: boolean;
    expandedH: Record<string, number>; // remembered h per widget so we can restore on expand
    hidden: Record<string, boolean>;
}

function loadPersisted(key: string): PersistedState | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const p = JSON.parse(raw) as PersistedState;
        if (!p || typeof p !== "object" || !p.layouts) return null;
        return {
            layouts: p.layouts ?? {},
            collapsed: p.collapsed ?? {},
            locked: p.locked ?? false,
            expandedH: p.expandedH ?? {},
            hidden: p.hidden ?? {},
        };
    } catch {
        return null;
    }
}

function savePersisted(key: string, state: PersistedState) {
    try {
        localStorage.setItem(key, JSON.stringify(state));
        window.dispatchEvent(new Event("mmo-preference-changed"));
    } catch { /* noop */ }
}

// ─── Default layout builder ──────────────────────────────────────────────

function buildDefaultLayouts<Id extends string>(widgets: WidgetMeta<Id>[]): Layouts {
    const out: Layouts = {};
    for (const bp of ALL_BPS) {
        const items: LayoutItem[] = [];
        let curY = 0;
        let curX = 0;
        const cols = COLS[bp];
        let rowMaxH = 0;
        for (const w of widgets) {
            const def = w.defaults[bp] ?? w.defaults.lg ?? { x: 0, y: 0, w: Math.min(w.minW, cols), h: w.minH };
            // For smaller breakpoints, fall back to a vertical stack auto-flow if no per-bp default.
            if (!w.defaults[bp] && bp !== "lg") {
                const widgetW = Math.min(cols, Math.max(w.minW, Math.ceil(cols * 0.5)));
                if (curX + widgetW > cols) { curX = 0; curY += rowMaxH; rowMaxH = 0; }
                items.push({
                    i: w.id, x: curX, y: curY, w: widgetW, h: def.h,
                    minW: Math.min(w.minW, cols), minH: w.minH,
                    maxW: w.maxW, maxH: w.maxH,
                });
                curX += widgetW;
                rowMaxH = Math.max(rowMaxH, def.h);
            } else {
                items.push({
                    i: w.id, x: def.x, y: def.y, w: def.w, h: def.h,
                    minW: Math.min(w.minW, cols), minH: w.minH,
                    maxW: w.maxW, maxH: w.maxH,
                });
            }
        }
        out[bp] = items;
    }
    return out;
}

// ─── Custom resize handle ────────────────────────────────────────────────

function ResizeHandle(_handleAxis: string, ref: React.Ref<HTMLDivElement>) {
    return (
        <div
            ref={ref as React.Ref<HTMLDivElement>}
            className="react-resizable-handle react-resizable-handle-se group/handle"
            style={{
                position: "absolute",
                width: 18,
                height: 18,
                right: 2,
                bottom: 2,
                cursor: "se-resize",
                zIndex: 10,
            }}
        >
            <svg viewBox="0 0 18 18" width="18" height="18"
                className="opacity-30 group-hover/handle:opacity-90 transition-opacity">
                <path d="M2 16 L16 2 M7 16 L16 7 M12 16 L16 12"
                    stroke="white" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
        </div>
    );
}

// ─── Component ───────────────────────────────────────────────────────────

export interface LiveWidgetGridProps<Id extends string> {
    storageKey: string;
    widgets: WidgetMeta<Id>[];
    /**
     * Render the actual widget body. The wrapper handles collapse/min sizes.
     * The widget root receives `collapsed` so it can render a header-only state.
     */
    renderWidget: (id: Id, opts: { collapsed: boolean; onToggleCollapse: () => void; dragHandleClass: string; locked: boolean; autoResize: boolean; requestAutoHeight: (pixels: number) => void }) => ReactNode;
    /** Optional toolbar slot rendered to the right of the built-in toolbar. */
    toolbarExtra?: ReactNode;
    className?: string;
}

export function LiveWidgetGrid<Id extends string>({
    storageKey, widgets, renderWidget, toolbarExtra, className,
}: LiveWidgetGridProps<Id>) {
    useRenderCount("LiveWidgetGrid");
    const defaultLayouts = useMemo(() => buildDefaultLayouts(widgets), [widgets]);
    const widgetIds = useMemo(() => widgets.map(w => w.id), [widgets]);

    const [layouts, setLayouts] = useState<Layouts>(defaultLayouts);
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [hidden, setHidden] = useState<Record<string, boolean>>({});
    const [expandedH, setExpandedH] = useState<Record<string, number>>({});
    const [locked, setLocked] = useState(false);
    const [currentBp, setCurrentBp] = useState<Breakpoint>("lg");
    const [hydrated, setHydrated] = useState(false);
    const [settled, setSettled] = useState(false);
    const [focusFlash, setFocusFlash] = useState<string | null>(null);

    // Hydrate from storage (after mount to avoid SSR mismatch)
    useEffect(() => {
        const load = () => {
            const p = loadPersisted(storageKey);
            if (!p) { setHydrated(true); return; }
            // Merge: for each breakpoint, keep stored item but ensure all current widgets appear
            const merged: Layouts = {};
            for (const bp of ALL_BPS) {
                const stored = p.layouts[bp] ?? [];
                const def = defaultLayouts[bp] ?? [];
                const byId = new Map(stored.map(l => [l.i, l]));
                merged[bp] = def.map(d => {
                    const s = byId.get(d.i);
                    if (!s) return d;
                    // Re-apply min/max from current meta in case constraints changed
                    return {
                        ...s,
                        minW: d.minW, minH: d.minH, maxW: d.maxW, maxH: d.maxH,
                        // Clamp w/h to current min so stale storage doesn't break layout
                        w: Math.max(s.w, d.minW ?? 1),
                        h: Math.max(s.h, d.minH ?? 1),
                    };
                });
            }
            setLayouts(merged);
            setCollapsed(p.collapsed);
            setExpandedH(p.expandedH);
            setLocked(p.locked);
            setHidden(p.hidden ?? {});
            setHydrated(true);
        };
        load();
        // After hydration paints, give the layout a brief settle window during
        // which (a) all CSS transitions are disabled and (b) auto-resize is
        // ignored. This prevents the visible jitter where widgets snap to
        // saved positions, then briefly resize to fit content, then settle.
        const settleTimer = window.setTimeout(() => setSettled(true), 350);
        // Cross-tab/cross-device sync via the native storage event (does not fire
        // for changes made in the same window, so no feedback loop with our own
        // savePersisted dispatches).
        const onStorage = (e: StorageEvent) => { if (e.key === storageKey) load(); };
        window.addEventListener("storage", onStorage);
        return () => {
            window.removeEventListener("storage", onStorage);
            window.clearTimeout(settleTimer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey]);

    // Persist on change (debounced 400ms). Coalesces bursts of layout updates
    // (e.g. during an auto-resize cascade) into a single localStorage write +
    // single `mmo-preference-changed` event — prevents downstream listeners
    // (preferences-sync → DB writes) from firing on every micro change.
    useEffect(() => {
        if (!hydrated) return;
        const t = setTimeout(() => {
            savePersisted(storageKey, { layouts, collapsed, locked, expandedH, hidden });
        }, 400);
        return () => clearTimeout(t);
    }, [layouts, collapsed, locked, expandedH, hidden, hydrated, storageKey]);

    // Apply collapsed state to rendered layouts (force h=COLLAPSED_H, lock h)
    const renderedLayouts = useMemo<Layouts>(() => {
        const out: Layouts = {};
        for (const bp of ALL_BPS) {
            out[bp] = (layouts[bp] ?? []).map(l => {
                if (collapsed[l.i]) {
                    return { ...l, h: COLLAPSED_H, minH: COLLAPSED_H, maxH: COLLAPSED_H, isResizable: false };
                }
                return l;
            });
        }
        return out;
    }, [layouts, collapsed]);

    const handleLayoutChange = useCallback((_current: Layout, all: ResponsiveLayouts) => {
        // RGL re-emits onLayoutChange whenever its `layouts` prop reference
        // changes (which we trigger via `renderedLayouts`). To avoid an infinite
        // loop we (a) only diff breakpoints RGL actually sent, (b) strip the
        // collapsed-only h overrides so they never persist, and (c) bail out
        // via referential return when nothing meaningfully changed.
        setLayouts(prev => {
            const next: Layouts = { ...prev };
            let changed = false;
            for (const bp of ALL_BPS) {
                const incoming = all[bp];
                if (!incoming) continue; // RGL didn't supply this bp — keep existing
                const prevBp = prev[bp] ?? [];
                const prevById = new Map(prevBp.map(l => [l.i, l]));
                const merged = incoming.map(l => {
                    if (collapsed[l.i]) {
                        const old = prevById.get(l.i);
                        return { ...l, h: old?.h ?? l.h, minH: old?.minH, maxH: old?.maxH };
                    }
                    return l;
                });
                let bpChanged = merged.length !== prevBp.length;
                if (!bpChanged) {
                    for (let i = 0; i < merged.length; i++) {
                        const a = merged[i];
                        const b = prevBp[i];
                        if (!b || a.i !== b.i || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h) {
                            bpChanged = true;
                            break;
                        }
                    }
                }
                if (bpChanged) {
                    next[bp] = merged;
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [collapsed]);

    const toggleCollapse = useCallback((id: string) => {
        setCollapsed(prev => {
            const isCollapsing = !prev[id];
            if (isCollapsing) {
                // Remember the current h in the active breakpoint
                const cur = layouts[currentBp]?.find(l => l.i === id);
                if (cur) setExpandedH(eh => ({ ...eh, [id]: cur.h }));
            }
            // Toggling collapse always re-arms auto-resize for this widget.
            manualResizeRef.current.delete(id);
            lastAutoHRef.current.delete(id);
            return { ...prev, [id]: !prev[id] };
        });
    }, [layouts, currentBp]);

    const collapseAll = useCallback(() => {
        const allOn: Record<string, boolean> = {};
        const heights: Record<string, number> = { ...expandedH };
        for (const id of widgetIds) {
            allOn[id] = true;
            const cur = layouts[currentBp]?.find(l => l.i === id);
            if (cur && !collapsed[id]) heights[id] = cur.h;
        }
        setExpandedH(heights);
        setCollapsed(allOn);
    }, [widgetIds, layouts, currentBp, collapsed, expandedH]);

    const expandAll = useCallback(() => {
        // Restore h for each item that was collapsed
        setLayouts(prev => {
            const next: Layouts = {};
            for (const bp of ALL_BPS) {
                next[bp] = (prev[bp] ?? []).map(l => {
                    if (collapsed[l.i]) {
                        const restored = expandedH[l.i];
                        if (restored && restored > COLLAPSED_H) return { ...l, h: restored };
                    }
                    return l;
                });
            }
            return next;
        });
        // Re-arm auto-resize for everything.
        manualResizeRef.current.clear();
        lastAutoHRef.current.clear();
        setCollapsed({});
    }, [collapsed, expandedH]);

    const resetLayout = useCallback(() => {
        setLayouts(defaultLayouts);
        setCollapsed({});
        setExpandedH({});
        setHidden({});
        manualResizeRef.current.clear();
        lastAutoHRef.current.clear();
        try {
            localStorage.removeItem(storageKey);
            window.dispatchEvent(new Event("mmo-preference-changed"));
        } catch { /* noop */ }
    }, [defaultLayouts, storageKey]);

    const toggleHidden = useCallback((id: string) => {
        setHidden(prev => ({ ...prev, [id]: !prev[id] }));
    }, []);
    const showAll = useCallback(() => setHidden({}), []);
    const hideAll = useCallback(() => {
        const all: Record<string, boolean> = {};
        for (const id of widgetIds) all[id] = true;
        setHidden(all);
    }, [widgetIds]);

    /**
     * Scroll a widget into view + briefly highlight it. Used by the manager's
     * "Focus" action so the user can find a widget on a busy page.
     */
    const focusWidget = useCallback((id: string) => {
        setHidden(prev => prev[id] ? { ...prev, [id]: false } : prev);
        requestAnimationFrame(() => {
            const el = document.querySelector<HTMLElement>(`[data-widget-id="${CSS.escape(id)}"]`);
            if (!el) return;
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            setFocusFlash(id);
            window.setTimeout(() => setFocusFlash(curr => curr === id ? null : curr), 1400);
        });
    }, []);

    // Filter widgets to only those currently visible. Hidden ones are not
    // mounted at all so their internal subscriptions / timers are released.
    // Their layout entries remain in `layouts` so re-showing them restores
    // the prior position.
    const visibleWidgets = useMemo(() => widgets.filter(w => !hidden[w.id]), [widgets, hidden]);

    // ── Auto-resize on content overflow (opt-in via WidgetMeta.autoResize) ──
    // Map widget id → meta for fast lookup.
    const metaById = useMemo(() => {
        const m = new Map<string, WidgetMeta<Id>>();
        for (const w of widgets) m.set(w.id, w);
        return m;
    }, [widgets]);

    /** pixel height of a cell with `h` rows (matches RGL's calcGridItemPosition). */
    const cellPixelHeight = useCallback((h: number) => {
        return h * ROW_HEIGHT + Math.max(0, h - 1) * MARGIN[1];
    }, []);

    // Track widgets the user has manually resized — those opt out of auto-shrink
    // until they collapse/expand or reset the layout.
    const manualResizeRef = useRef<Set<string>>(new Set());
    // The last h we set programmatically per widget — used to distinguish
    // user-driven resizes from auto-driven ones in onResizeStop.
    const lastAutoHRef = useRef<Map<string, number>>(new Map());

    const requestAutoHeight = useCallback((id: string, pixels: number) => {
        if (locked || collapsed[id]) return;
        // During the settle window the layout is still snapping into its saved
        // shape — ignore content measurements until widgets have stopped moving,
        // otherwise the very first paint triggers a height-jump animation that
        // looks like a flicker.
        if (!settled) return;
        const meta = metaById.get(id);
        if (!meta?.autoResize) return;
        if (manualResizeRef.current.has(id)) return; // user took control
        const maxRows = meta.maxH ?? 40;
        // Solve for smallest h with cellPixelHeight(h) >= pixels + a small slack.
        const slack = 4;
        let neededH = Math.max(
            meta.minH,
            Math.ceil((pixels + slack + MARGIN[1]) / (ROW_HEIGHT + MARGIN[1])),
        );
        neededH = Math.min(neededH, maxRows);
        setLayouts(prev => {
            const bpLayout = prev[currentBp] ?? [];
            const cur = bpLayout.find(l => l.i === id);
            if (!cur) return prev;
            // Hysteresis: grow on any ≥1-row delta, shrink only on ≥2-row delta.
            // This kills oscillation around the boundary while still letting
            // the widget genuinely shrink when content is removed.
            if (neededH === cur.h) return prev;
            if (neededH < cur.h && cur.h - neededH < 2) return prev;
            lastAutoHRef.current.set(id, neededH);
            return {
                ...prev,
                [currentBp]: bpLayout.map(l => l.i === id ? { ...l, h: neededH } : l),
            };
        });
        // Suppress unused warning for cellPixelHeight (kept for clarity / debug).
        void cellPixelHeight;
    }, [locked, collapsed, settled, metaById, currentBp, cellPixelHeight]);

    return (
        <div className={cn("flex flex-col h-full min-h-0", className)}>
            {/* Toolbar */}
            <div className="flex items-center gap-1 px-3 py-1 border-b border-white/[0.04] bg-black/20 shrink-0">
                <ToolButton
                    onClick={() => setLocked(v => !v)}
                    icon={locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                    label={locked ? "Locked" : "Edit"}
                    active={!locked}
                    title={locked ? "Layout locked — click to unlock" : "Layout unlocked — click to lock during performance"}
                />
                <ToolButton
                    onClick={collapseAll}
                    icon={<Minimize2 className="w-3 h-3" />}
                    label="Collapse"
                    title="Collapse all widgets"
                />
                <ToolButton
                    onClick={expandAll}
                    icon={<Maximize2 className="w-3 h-3" />}
                    label="Expand"
                    title="Expand all widgets"
                />
                <ToolButton
                    onClick={resetLayout}
                    icon={<RotateCcw className="w-3 h-3" />}
                    label="Reset"
                    title="Reset layout to defaults"
                />
                <WidgetsManagerButton
                    widgets={widgets}
                    layouts={layouts[currentBp] ?? []}
                    hidden={hidden}
                    collapsed={collapsed}
                    onToggleHidden={toggleHidden}
                    onToggleCollapsed={toggleCollapse}
                    onShowAll={showAll}
                    onHideAll={hideAll}
                    onFocus={focusWidget}
                />
                <div className="ml-auto flex items-center gap-2">
                    {toolbarExtra}
                    <span className="text-[9px] text-white/25 tabular-nums">{currentBp.toUpperCase()}</span>
                </div>
            </div>

            {/* Grid */}
            <div
                className={cn(
                    "flex-1 min-h-0 overflow-y-auto live-widget-grid-host",
                    !settled && "live-widget-grid-settling",
                )}
                // Hide until hydration is complete so users don't see a flash
                // of the default layout snapping to their saved layout. After
                // hydration we still keep transitions OFF for ~350ms (settle
                // window) and fade the grid in — so the user sees a smooth
                // appearance instead of items rearranging.
                style={hydrated ? { opacity: 1 } : { visibility: "hidden", opacity: 0 }}
            >
                <ResponsiveGridLayout
                    className="live-widget-grid"
                    layouts={(() => {
                        const out: Record<string, LayoutItem[]> = {};
                        for (const bp of ALL_BPS) out[bp] = (renderedLayouts[bp] ?? []).filter(l => !hidden[l.i]);
                        return out;
                    })()}
                    breakpoints={BREAKPOINTS}
                    cols={COLS}
                    rowHeight={ROW_HEIGHT}
                    margin={MARGIN}
                    containerPadding={PADDING}
                    onLayoutChange={handleLayoutChange}
                    onResizeStop={(_layout: Layout, _old: LayoutItem, item: LayoutItem) => {
                        // RGL only fires onResizeStop for user-driven resizes,
                        // so any call here means the user took manual control:
                        // freeze this widget out of further auto-height updates
                        // until it's collapsed/expanded or the layout is reset.
                        manualResizeRef.current.add(item.i);
                        lastAutoHRef.current.delete(item.i);
                    }}
                    onBreakpointChange={(bp: string) => setCurrentBp(bp as Breakpoint)}
                    isDraggable={!locked}
                    isResizable={!locked}
                    draggableHandle=".widget-drag-handle"
                    draggableCancel="[data-no-drag], button, input, select, textarea, a"
                    resizeHandle={ResizeHandle as never}
                    compactType="vertical"
                    preventCollision={false}
                    useCSSTransforms
                    transformScale={1}
                    measureBeforeMount={false}
                >
                    {visibleWidgets.map(w => (
                        <div
                            key={w.id}
                            className={cn(
                                "live-grid-item",
                                focusFlash === w.id && "live-widget-focus-flash",
                            )}
                            data-widget-id={w.id}
                        >
                            {renderWidget(w.id, {
                                collapsed: !!collapsed[w.id],
                                onToggleCollapse: () => toggleCollapse(w.id),
                                dragHandleClass: "widget-drag-handle",
                                locked,
                                autoResize: !!w.autoResize,
                                requestAutoHeight: (px: number) => requestAutoHeight(w.id, px),
                            })}
                        </div>
                    ))}
                </ResponsiveGridLayout>
            </div>

            {/* Inline styles override react-grid-layout defaults to match our dark theme */}
            <style dangerouslySetInnerHTML={{ __html: GRID_THEME_CSS }} />
        </div>
    );
}

const GRID_THEME_CSS = `
.live-widget-grid-host {
    transition: opacity 320ms cubic-bezier(0.2, 0, 0, 1);
}
.live-widget-grid .react-grid-item {
    transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1), width 220ms cubic-bezier(0.22, 1, 0.36, 1), height 220ms cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform;
}
/* During the settle window after hydration: snap items into place with no
   animation so the user never sees them slide / resize on first paint. */
.live-widget-grid-settling .react-grid-item,
.live-widget-grid-settling .react-grid-item.cssTransforms {
    transition: none !important;
}
.live-widget-grid .react-grid-item.react-grid-placeholder {
    background: rgba(244, 63, 94, 0.18);
    border: 1.5px dashed rgba(244, 63, 94, 0.55);
    border-radius: 16px;
    opacity: 1;
    transition-duration: 80ms;
    z-index: 1;
}
.live-widget-grid .react-grid-item.react-draggable-dragging {
    z-index: 50;
    transition: none;
    cursor: grabbing;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(244, 63, 94, 0.45);
}
.live-widget-grid .react-grid-item.resizing {
    z-index: 40;
    transition: none;
    box-shadow: 0 0 0 1px rgba(244, 63, 94, 0.45);
}
.live-widget-grid .react-grid-item > .live-grid-item {
    width: 100%;
    height: 100%;
}
/* Soft fade-in for widget bodies on first mount. The settling window keeps
   item POSITIONS stable; this animates only opacity, never layout. */
.live-widget-grid .react-grid-item > .live-grid-item {
    animation: liveWidgetItemIn 320ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes liveWidgetItemIn {
    from { opacity: 0; }
    to   { opacity: 1; }
}
.live-widget-grid .live-widget-focus-flash {
    animation: liveWidgetFocusFlash 1.4s ease-out;
}
@keyframes liveWidgetFocusFlash {
    0%   { box-shadow: 0 0 0 0 rgba(244,63,94,0); }
    20%  { box-shadow: 0 0 0 4px rgba(244,63,94,0.55), 0 0 28px rgba(244,63,94,0.45); }
    100% { box-shadow: 0 0 0 0 rgba(244,63,94,0); }
}
`;

function ToolButton({ onClick, icon, label, active, title }: {
    onClick: () => void; icon: ReactNode; label: string; active?: boolean; title?: string;
}) {
    return (
        <button
            onClick={onClick}
            title={title}
            className={cn(
                "flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium uppercase tracking-wider transition-colors cursor-pointer",
                active
                    ? "bg-white/[0.08] text-white/80 hover:bg-white/[0.12]"
                    : "bg-white/[0.03] text-white/40 hover:bg-white/[0.06] hover:text-white/60",
            )}
        >
            {icon}
            <span className="hidden sm:inline">{label}</span>
        </button>
    );
}

// ─── Widgets Manager ────────────────────────────────────────────────────────────────────

/**
 * Beautifully animated popover listing every registered widget. Lets the user
 * show / hide / collapse / focus each one. Inspired by the DAW Panel Manager
 * but tailored for the Live Performance grid (which uses dynamic visibility
 * rather than dockview slots).
 */
function WidgetsManagerButton<Id extends string>({
    widgets, layouts, hidden, collapsed,
    onToggleHidden, onToggleCollapsed, onShowAll, onHideAll, onFocus,
}: {
    widgets: WidgetMeta<Id>[];
    layouts: LayoutItem[];
    hidden: Record<string, boolean>;
    collapsed: Record<string, boolean>;
    onToggleHidden: (id: string) => void;
    onToggleCollapsed: (id: string) => void;
    onShowAll: () => void;
    onHideAll: () => void;
    onFocus: (id: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");

    const layoutById = useMemo(() => {
        const m = new Map<string, LayoutItem>();
        for (const l of layouts) m.set(l.i, l);
        return m;
    }, [layouts]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return widgets;
        return widgets.filter(w => w.title.toLowerCase().includes(q) || w.id.toLowerCase().includes(q));
    }, [widgets, query]);

    const visibleCount = widgets.filter(w => !hidden[w.id]).length;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    title="Widgets manager"
                    className={cn(
                        "flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium uppercase tracking-wider transition-all cursor-pointer relative",
                        open
                            ? "bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/40"
                            : "bg-white/[0.03] text-white/40 hover:bg-white/[0.06] hover:text-white/60",
                    )}
                >
                    <LayoutGrid className="w-3 h-3" />
                    <span className="hidden sm:inline">Widgets</span>
                    <span className="hidden sm:inline-block ml-0.5 text-[8.5px] tabular-nums opacity-60">
                        {visibleCount}/{widgets.length}
                    </span>
                </button>
            </PopoverTrigger>
            <PopoverContent
                side="bottom"
                align="start"
                sideOffset={6}
                className="w-[320px] p-0 bg-[#101014] border border-white/10 shadow-2xl text-white/80 ring-1 ring-rose-500/10"
            >
                {/* Header */}
                <div className="px-3 pt-2.5 pb-2 border-b border-white/[0.06] bg-gradient-to-b from-white/[0.03] to-transparent">
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-1.5">
                            <div className="w-5 h-5 rounded-md bg-rose-500/15 ring-1 ring-rose-500/30 flex items-center justify-center">
                                <LayoutGrid className="w-2.5 h-2.5 text-rose-300" />
                            </div>
                            <span className="text-[11px] font-bold uppercase tracking-wider text-white/85">Widgets</span>
                            <span className="text-[9px] tabular-nums text-white/35 ml-1">
                                {visibleCount} / {widgets.length}
                            </span>
                        </div>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={onShowAll}
                                className="text-[9px] uppercase tracking-wider text-white/40 hover:text-emerald-400 px-1.5 py-0.5 rounded hover:bg-white/[0.04] transition-colors cursor-pointer"
                                title="Show all widgets"
                            >Show all</button>
                            <button
                                onClick={onHideAll}
                                className="text-[9px] uppercase tracking-wider text-white/40 hover:text-rose-400 px-1.5 py-0.5 rounded hover:bg-white/[0.04] transition-colors cursor-pointer"
                                title="Hide all widgets"
                            >Hide all</button>
                        </div>
                    </div>
                    <div className="relative">
                        <input
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            placeholder="Search widgets…"
                            className="w-full h-7 px-2 text-[11px] bg-black/40 border border-white/[0.06] rounded-md text-white/75 placeholder:text-white/25 focus:outline-none focus:border-rose-500/40 transition-colors"
                        />
                    </div>
                </div>

                {/* List */}
                <div className="max-h-[55vh] overflow-y-auto py-1">
                    {filtered.length === 0 && (
                        <div className="px-3 py-6 text-center text-[10px] text-white/30">
                            No widgets match “{query}”
                        </div>
                    )}
                    {filtered.map((w, idx) => {
                        const isHidden = !!hidden[w.id];
                        const isCollapsed = !!collapsed[w.id];
                        const layout = layoutById.get(w.id);
                        const Icon = w.icon ?? Square;
                        const accent = w.accent ?? "#f43f5e";
                        return (
                            <div
                                key={w.id}
                                className={cn(
                                    "group flex items-center gap-2 px-2.5 py-1.5 mx-1 rounded-lg transition-all",
                                    isHidden
                                        ? "opacity-50 hover:opacity-90 hover:bg-white/[0.04]"
                                        : "hover:bg-white/[0.04]",
                                )}
                                style={{
                                    animation: open ? `liveWidgetMgrIn 220ms ${idx * 14}ms cubic-bezier(0.2,0,0,1) both` : undefined,
                                }}
                            >
                                {/* Accent icon tile */}
                                <div
                                    className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 transition-all"
                                    style={{
                                        background: isHidden ? "rgba(255,255,255,0.04)" : `${accent}1a`,
                                        boxShadow: isHidden ? undefined : `inset 0 0 0 1px ${accent}33`,
                                    }}
                                >
                                    <Icon
                                        className="w-3 h-3"
                                        style={{ color: isHidden ? "rgba(255,255,255,0.35)" : accent }}
                                    />
                                </div>

                                {/* Title + meta */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                        <span className={cn(
                                            "text-[11px] font-medium truncate",
                                            isHidden ? "text-white/45" : "text-white/85",
                                        )}>{w.title}</span>
                                        {/* Status pill */}
                                        {isHidden && (
                                            <span className="text-[7.5px] uppercase tracking-wider px-1 py-px rounded bg-white/[0.04] text-white/35">Hidden</span>
                                        )}
                                        {!isHidden && isCollapsed && (
                                            <span className="text-[7.5px] uppercase tracking-wider px-1 py-px rounded bg-amber-500/15 text-amber-400">Collapsed</span>
                                        )}
                                    </div>
                                    <div className="text-[8.5px] text-white/30 tabular-nums truncate">
                                        {w.description ?? (
                                            layout
                                                ? `${layout.w}×${layout.h} · (${layout.x},${layout.y})`
                                                : "—"
                                        )}
                                    </div>
                                </div>

                                {/* Actions */}
                                <div className="flex items-center gap-0.5 shrink-0 opacity-70 group-hover:opacity-100 transition-opacity">
                                    {!isHidden && (
                                        <IconBtn
                                            title={isCollapsed ? "Expand" : "Collapse"}
                                            onClick={() => onToggleCollapsed(w.id)}
                                        >
                                            {isCollapsed
                                                ? <ChevronRight className="w-3 h-3" />
                                                : <ChevronDown className="w-3 h-3" />}
                                        </IconBtn>
                                    )}
                                    {!isHidden && (
                                        <IconBtn title="Focus" onClick={() => { onFocus(w.id); setOpen(false); }}>
                                            <Crosshair className="w-3 h-3" />
                                        </IconBtn>
                                    )}
                                    <IconBtn
                                        title={isHidden ? "Show widget" : "Hide widget"}
                                        onClick={() => onToggleHidden(w.id)}
                                        accentClass={isHidden ? "hover:text-emerald-400" : "hover:text-rose-400"}
                                    >
                                        {isHidden
                                            ? <EyeOff className="w-3 h-3" />
                                            : <Eye className="w-3 h-3" />}
                                    </IconBtn>
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Footer */}
                <div className="px-3 py-1.5 border-t border-white/[0.06] flex items-center justify-between text-[8.5px] text-white/30 bg-black/20">
                    <span>Drag widget headers • Right corner to resize</span>
                    <span className="text-white/20">⏎ select · esc close</span>
                </div>

                <style dangerouslySetInnerHTML={{ __html: WIDGETS_MGR_CSS }} />
            </PopoverContent>
        </Popover>
    );
}

function IconBtn({ children, onClick, title, accentClass }: {
    children: ReactNode; onClick: () => void; title: string; accentClass?: string;
}) {
    return (
        <button
            onClick={onClick}
            title={title}
            className={cn(
                "w-6 h-6 flex items-center justify-center rounded text-white/35 hover:bg-white/[0.06] transition-colors cursor-pointer",
                accentClass ?? "hover:text-white/85",
            )}
        >
            {children}
        </button>
    );
}

const WIDGETS_MGR_CSS = `
@keyframes liveWidgetMgrIn {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
}
`;
