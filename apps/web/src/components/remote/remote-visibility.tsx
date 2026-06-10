"use client";

/**
 * Remote widget visibility manager.
 *
 * Wraps a remote widget tree. Each visually-distinct section registers itself
 * via <RemotePanel id="..." label="..."> and is shown/hidden via a floating
 * Layout button that opens a checklist.
 *
 * State persists in localStorage under `remote-visibility-{page}` and is
 * picked up by the existing preferences-sync (any change dispatches
 * `mmo-preference-changed`).
 */

import {
    createContext, useCallback, useContext, useEffect, useMemo, useState,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Layout, X, Check, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface RegistryEntry {
    id: string;
    label: string;
    defaultVisible: boolean;
}

interface VisibilityContextValue {
    register: (entry: RegistryEntry) => void;
    unregister: (id: string) => void;
    isVisible: (id: string) => boolean;
    toggle: (id: string) => void;
    setHidden: (id: string, hidden: boolean) => void;
    panels: RegistryEntry[];
    hidden: Set<string>;
}

const VisibilityContext = createContext<VisibilityContextValue | null>(null);

interface ProviderProps {
    page: string;
    children: React.ReactNode;
}

export function RemoteVisibilityProvider({ page, children }: ProviderProps) {
    const storageKey = `remote-visibility-${page}`;
    const [panels, setPanels] = useState<RegistryEntry[]>([]);
    const [hidden, setHiddenSet] = useState<Set<string>>(() => {
        if (typeof window === "undefined") return new Set();
        try {
            const raw = localStorage.getItem(storageKey);
            if (raw) return new Set(JSON.parse(raw) as string[]);
        } catch { /* ignore */ }
        return new Set();
    });

    // Persist + notify sync layer
    useEffect(() => {
        try {
            localStorage.setItem(storageKey, JSON.stringify([...hidden]));
            window.dispatchEvent(new Event("mmo-preference-changed"));
        } catch { /* ignore */ }
    }, [hidden, storageKey]);

    const register = useCallback((entry: RegistryEntry) => {
        setPanels(prev => {
            if (prev.some(p => p.id === entry.id)) return prev;
            return [...prev, entry];
        });
    }, []);

    const unregister = useCallback((id: string) => {
        setPanels(prev => prev.filter(p => p.id !== id));
    }, []);

    const isVisible = useCallback((id: string) => !hidden.has(id), [hidden]);

    const toggle = useCallback((id: string) => {
        setHiddenSet(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const setHidden = useCallback((id: string, h: boolean) => {
        setHiddenSet(prev => {
            const next = new Set(prev);
            if (h) next.add(id); else next.delete(id);
            return next;
        });
    }, []);

    const value = useMemo<VisibilityContextValue>(() => ({
        register, unregister, isVisible, toggle, setHidden, panels, hidden,
    }), [register, unregister, isVisible, toggle, setHidden, panels, hidden]);

    return (
        <VisibilityContext.Provider value={value}>
            {children}
            <RemoteVisibilityManagerButton />
        </VisibilityContext.Provider>
    );
}

interface PanelProps {
    id: string;
    label: string;
    defaultVisible?: boolean;
    children: React.ReactNode;
}

/**
 * Wrap a section to make it toggleable from the visibility manager.
 * Renders nothing when hidden.
 */
export function RemotePanel({ id, label, defaultVisible = true, children }: PanelProps) {
    const ctx = useContext(VisibilityContext);
    useEffect(() => {
        if (!ctx) return;
        ctx.register({ id, label, defaultVisible });
        return () => ctx.unregister(id);
    }, [ctx, id, label, defaultVisible]);

    if (!ctx) return <>{children}</>; // standalone fallback
    if (!ctx.isVisible(id)) return null;
    return <>{children}</>;
}

function RemoteVisibilityManagerButton() {
    const ctx = useContext(VisibilityContext);
    const [open, setOpen] = useState(false);
    if (!ctx) return null;

    const visibleCount = ctx.panels.filter(p => ctx.isVisible(p.id)).length;

    return (
        <>
            <button
                onClick={() => setOpen(true)}
                aria-label="Manage widgets"
                className="fixed bottom-4 right-4 z-40 h-11 w-11 rounded-full bg-violet-500/90 hover:bg-violet-400 text-white shadow-lg shadow-violet-500/30 flex items-center justify-center transition-all backdrop-blur cursor-pointer ring-1 ring-white/10"
                title={`Manage widgets (${visibleCount}/${ctx.panels.length} visible)`}
            >
                <Layout className="h-5 w-5" />
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
                        onClick={() => setOpen(false)}
                    >
                        <motion.div
                            initial={{ y: 40, opacity: 0, scale: 0.96 }}
                            animate={{ y: 0, opacity: 1, scale: 1 }}
                            exit={{ y: 40, opacity: 0, scale: 0.96 }}
                            transition={{ type: "spring", stiffness: 320, damping: 30 }}
                            onClick={e => e.stopPropagation()}
                            className="w-full max-w-md rounded-2xl border border-violet-400/30 bg-gradient-to-b from-card via-card to-violet-950/20 shadow-2xl overflow-hidden"
                        >
                            <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
                                <div className="flex items-center gap-2">
                                    <Layout className="h-4 w-4 text-violet-300" />
                                    <h3 className="text-sm font-semibold">Manage widgets</h3>
                                </div>
                                <button
                                    onClick={() => setOpen(false)}
                                    className="h-8 w-8 rounded-md hover:bg-muted/50 flex items-center justify-center text-muted-foreground hover:text-foreground"
                                    aria-label="Close"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </div>

                            <div className="px-4 py-2 border-b border-border/40 flex items-center justify-between text-xs text-muted-foreground">
                                <span>{visibleCount} of {ctx.panels.length} visible</span>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => ctx.panels.forEach(p => ctx.setHidden(p.id, false))}
                                        className="text-violet-300 hover:text-violet-200"
                                    >
                                        Show all
                                    </button>
                                    <span className="text-border">·</span>
                                    <button
                                        onClick={() => ctx.panels.forEach(p => ctx.setHidden(p.id, true))}
                                        className="text-muted-foreground hover:text-foreground"
                                    >
                                        Hide all
                                    </button>
                                </div>
                            </div>

                            <div className="max-h-[60vh] overflow-y-auto">
                                {ctx.panels.length === 0 ? (
                                    <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                                        No widgets registered yet.
                                    </div>
                                ) : (
                                    <ul className="divide-y divide-border/30">
                                        {ctx.panels.map(p => {
                                            const visible = ctx.isVisible(p.id);
                                            return (
                                                <li key={p.id}>
                                                    <button
                                                        onClick={() => ctx.toggle(p.id)}
                                                        className={cn(
                                                            "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
                                                            visible
                                                                ? "hover:bg-violet-500/5"
                                                                : "opacity-60 hover:bg-muted/30 hover:opacity-90"
                                                        )}
                                                    >
                                                        <div className={cn(
                                                            "h-7 w-7 rounded-md flex items-center justify-center transition-colors",
                                                            visible
                                                                ? "bg-violet-500/15 text-violet-300 ring-1 ring-violet-400/30"
                                                                : "bg-muted/30 text-muted-foreground"
                                                        )}>
                                                            {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                                                        </div>
                                                        <span className={cn(
                                                            "flex-1 text-sm font-medium",
                                                            visible ? "text-foreground" : "text-muted-foreground"
                                                        )}>
                                                            {p.label}
                                                        </span>
                                                        <div className={cn(
                                                            "h-5 w-5 rounded border flex items-center justify-center transition-all",
                                                            visible
                                                                ? "bg-violet-500 border-violet-400 text-white"
                                                                : "border-border/60"
                                                        )}>
                                                            {visible && <Check className="h-3 w-3" />}
                                                        </div>
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </div>

                            <div className="px-4 py-3 border-t border-border/40 text-[11px] text-muted-foreground">
                                Hidden widgets stop fetching/animating — saves CPU on the remote device.
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    );
}
