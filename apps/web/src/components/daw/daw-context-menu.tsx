"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface MenuItem {
    label: string;
    icon?: ReactNode;
    shortcut?: string;
    disabled?: boolean;
    destructive?: boolean;
    checked?: boolean;
    onClick?: () => void;
}

export interface MenuSeparator {
    type: "separator";
}

export interface MenuLabel {
    type: "label";
    label: string;
}

export interface MenuSub {
    type: "sub";
    label: string;
    icon?: ReactNode;
    items: MenuEntry[];
}

export type MenuEntry = MenuItem | MenuSeparator | MenuLabel | MenuSub;

interface MenuState {
    x: number;
    y: number;
    items: MenuEntry[];
}

interface ContextMenuContextType {
    show: (x: number, y: number, items: MenuEntry[]) => void;
    hide: () => void;
}

const ContextMenuContext = createContext<ContextMenuContextType | null>(null);

// ═══════════════════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════════════════

export function useContextMenu() {
    const ctx = useContext(ContextMenuContext);
    if (!ctx) throw new Error("useContextMenu must be used within DAWContextMenuProvider");
    return ctx;
}

/**
 * Touch-friendly long-press → contextmenu trigger.
 *
 * Returns props to spread on any element. On touch devices, holding the
 * element for `ms` (default 500 ms) without significant movement fires the
 * provided contextmenu builder. On mouse, this is a no-op (right-click
 * already works via the standard `onContextMenu` handler).
 *
 * Usage:
 *   const longPress = useLongPress((x, y) => ctx.show(x, y, items));
 *   <div {...longPress} onContextMenu={...}>...
 */
export function useLongPress(
    onLongPress: (clientX: number, clientY: number) => void,
    opts: { ms?: number; moveTolerance?: number } = {},
) {
    const { ms = 500, moveTolerance = 8 } = opts;
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startRef = useRef<{ x: number; y: number } | null>(null);
    const firedRef = useRef(false);
    const cbRef = useRef(onLongPress);
    useEffect(() => { cbRef.current = onLongPress; });

    const cancel = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        startRef.current = null;
    }, []);

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
        firedRef.current = false;
        startRef.current = { x: e.clientX, y: e.clientY };
        const x = e.clientX;
        const y = e.clientY;
        timerRef.current = setTimeout(() => {
            firedRef.current = true;
            cbRef.current(x, y);
        }, ms);
    }, [ms]);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        if (!startRef.current) return;
        const dx = Math.abs(e.clientX - startRef.current.x);
        const dy = Math.abs(e.clientY - startRef.current.y);
        if (dx > moveTolerance || dy > moveTolerance) cancel();
    }, [cancel, moveTolerance]);

    const onPointerUp = useCallback(() => cancel(), [cancel]);
    const onPointerCancel = useCallback(() => cancel(), [cancel]);

    return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════════════════

export function DAWContextMenuProvider({ children }: { children: ReactNode }) {
    const [menu, setMenu] = useState<MenuState | null>(null);
    const [sub, setSub] = useState<{ parentIdx: number; x: number; y: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const subRef = useRef<HTMLDivElement>(null);

    const show = useCallback((x: number, y: number, items: MenuEntry[]) => {
        setSub(null);
        setMenu({ x, y, items });
    }, []);

    const hide = useCallback(() => {
        setMenu(null);
        setSub(null);
    }, []);

    // Close on outside click or Escape
    useEffect(() => {
        if (!menu) return;

        const handleClick = (e: PointerEvent) => {
            if (menuRef.current?.contains(e.target as Node)) return;
            if (subRef.current?.contains(e.target as Node)) return;
            hide();
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") hide();
        };
        const handleScroll = () => hide();

        document.addEventListener("pointerdown", handleClick, true);
        document.addEventListener("keydown", handleKey);
        window.addEventListener("scroll", handleScroll, true);
        return () => {
            document.removeEventListener("pointerdown", handleClick, true);
            document.removeEventListener("keydown", handleKey);
            window.removeEventListener("scroll", handleScroll, true);
        };
    }, [menu, hide]);

    // Adjust position to fit viewport
    useEffect(() => {
        if (!menu || !menuRef.current) return;
        const rect = menuRef.current.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let { x, y } = menu;
        if (x + rect.width > vw - 8) x = vw - rect.width - 8;
        if (y + rect.height > vh - 8) y = vh - rect.height - 8;
        if (x < 8) x = 8;
        if (y < 8) y = 8;
        if (x !== menu.x || y !== menu.y) {
            setMenu({ ...menu, x, y });
        }
    }, [menu]);

    const handleItemClick = useCallback((item: MenuItem) => {
        if (item.disabled) return;
        item.onClick?.();
        hide();
    }, [hide]);

    const handleSubHover = useCallback((idx: number, e: React.MouseEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setSub({ parentIdx: idx, x: rect.right - 2, y: rect.top });
    }, []);

    return (
        <ContextMenuContext.Provider value={{ show, hide }}>
            {children}
            {menu && typeof document !== "undefined" && createPortal(
                <>
                    <div
                        ref={menuRef}
                        className="daw-context-menu"
                        style={{ left: menu.x, top: menu.y }}
                        onContextMenu={e => e.preventDefault()}
                    >
                        {menu.items.map((entry, i) => (
                            <MenuEntryItem
                                key={i}
                                entry={entry}
                                index={i}
                                onItemClick={handleItemClick}
                                onSubHover={handleSubHover}
                                isSubOpen={sub?.parentIdx === i}
                            />
                        ))}
                    </div>
                    {sub && (menu.items[sub.parentIdx] as MenuSub)?.items && (
                        <div
                            ref={subRef}
                            className="daw-context-menu"
                            style={{ left: sub.x, top: sub.y }}
                            onContextMenu={e => e.preventDefault()}
                        >
                            {((menu.items[sub.parentIdx] as MenuSub).items).map((entry, i) => (
                                <MenuEntryItem
                                    key={i}
                                    entry={entry}
                                    index={i}
                                    onItemClick={handleItemClick}
                                    onSubHover={() => { }}
                                    isSubOpen={false}
                                />
                            ))}
                        </div>
                    )}
                </>,
                document.body
            )}
        </ContextMenuContext.Provider>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Menu Entry Renderer
// ═══════════════════════════════════════════════════════════════════════════

function MenuEntryItem({ entry, index, onItemClick, onSubHover, isSubOpen }: {
    entry: MenuEntry;
    index: number;
    onItemClick: (item: MenuItem) => void;
    onSubHover: (idx: number, e: React.MouseEvent) => void;
    isSubOpen: boolean;
}) {
    if ("type" in entry) {
        if (entry.type === "separator") {
            return <div className="daw-context-menu-separator" />;
        }
        if (entry.type === "label") {
            return <div className="daw-context-menu-label">{entry.label}</div>;
        }
        if (entry.type === "sub") {
            return (
                <div
                    className={cn("daw-context-menu-item", isSubOpen && "daw-context-menu-item-active")}
                    onMouseEnter={e => onSubHover(index, e)}
                >
                    {entry.icon && <span className="daw-context-menu-icon">{entry.icon}</span>}
                    <span className="flex-1">{entry.label}</span>
                    <span className="text-[10px] opacity-40 ml-3">▶</span>
                </div>
            );
        }
    }

    const item = entry as MenuItem;
    return (
        <div
            className={cn(
                "daw-context-menu-item",
                item.disabled && "opacity-35 pointer-events-none",
                item.destructive && "daw-context-menu-item-destructive",
            )}
            onClick={() => onItemClick(item)}
        >
            {item.icon && <span className="daw-context-menu-icon">{item.icon}</span>}
            {item.checked !== undefined && (
                <span className="daw-context-menu-check">{item.checked ? "✓" : ""}</span>
            )}
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
                <span className="daw-context-menu-shortcut">{item.shortcut}</span>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Color Picker Submenu Items
// ═══════════════════════════════════════════════════════════════════════════

export const DAW_COLORS = [
    "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
    "#3b82f6", "#8b5cf6", "#ec4899", "#f43f5e", "#14b8a6",
];

export function colorMenuItems(current: string, onSelect: (color: string) => void): MenuEntry[] {
    return DAW_COLORS.map(color => ({
        label: color === current ? `● ${color}` : `○ ${color}`,
        icon: (
            <span
                className="w-3 h-3 rounded-full inline-block ring-1 ring-white/10"
                style={{ background: color }}
            />
        ),
        checked: color === current,
        onClick: () => onSelect(color),
    }));
}
