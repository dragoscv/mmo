"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion } from "framer-motion";
import {
    Menu,
    Search,
    ChevronsLeft,
    ChevronsRight,
    ChevronRight,
    ArrowLeft,
    HelpCircle,
    Star,
    Pin,
    X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { UserCard } from "./user-card";
import { LegendModal } from "./legend-modal";
import { GlobalSearch } from "./global-search";
import { DownloadHubButton } from "./sidebar/download-hub-button";
import { useRouteMemoryHrefs } from "@/hooks/use-route-memory";
import { useSidebar } from "./sidebar-context";
import {
    navTree,
    isLeafActive,
    findActiveParent,
    allLeaves,
    type NavLeaf,
    type NavParent,
} from "./sidebar/nav-tree";
import { usePinnedHrefs } from "./sidebar/use-pinned";

// ─── Public mobile trigger (kept for compatibility) ──────────────────────
export function MobileSidebarTrigger() {
    const { openMobile } = useSidebar();
    return (
        <button
            onClick={openMobile}
            className="fixed top-3 left-3 z-50 flex h-9 w-9 items-center justify-center rounded-lg bg-card/80 backdrop-blur border border-border text-muted-foreground hover:text-foreground transition-colors md:hidden cursor-pointer"
            aria-label="Open menu"
        >
            <Menu className="h-4.5 w-4.5" />
        </button>
    );
}

// ─── i18n helper: fall back to baked-in English when key is missing ──────
function useTranslatedLabel() {
    const t = useTranslations("nav");
    return (key: string, fallback: string) => {
        // next-intl 3+ surfaces missing keys via `.has()`; it doesn't throw.
        const has = (t as unknown as { has?: (k: string) => boolean }).has;
        if (typeof has === "function" && !has.call(t, key)) return fallback;
        try {
            const out = t(key);
            return out === key ? fallback : out;
        } catch {
            return fallback;
        }
    };
}

function leafByHref(href: string): NavLeaf | undefined {
    return allLeaves.find((l) => l.href === href);
}

// ─── Sidebar content (root view + drilled view) ──────────────────────────
function SidebarContent({ collapsed }: { collapsed: boolean }) {
    const pathname = usePathname();
    const router = useRouter();
    const [legendOpen, setLegendOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const savedHrefs = useRouteMemoryHrefs();
    const { closeMobile } = useSidebar();
    const labelFor = useTranslatedLabel();
    const tCommon = useTranslations("common");
    const { pinned, toggle: togglePin, isPinned } = usePinnedHrefs();

    // Drilled view state. `null` = root view; otherwise the parent's key.
    const [view, setView] = useState<string | null>(() => findActiveParent(pathname)?.key ?? null);
    const lastPathRef = useRef<string>(pathname);

    // Re-derive view only when the route actually changes, so an explicit
    // "Back" stays sticky until the next navigation.
    useEffect(() => {
        if (lastPathRef.current === pathname) return;
        lastPathRef.current = pathname;
        const p = findActiveParent(pathname);
        setView(p?.key ?? null);
    }, [pathname]);

    const activeParent: NavParent | null = useMemo(
        () => (view ? ((navTree.find((n) => n.kind === "parent" && n.key === view) as NavParent | undefined) ?? null) : null),
        [view]
    );

    const [hoverKey, setHoverKey] = useState<string | null>(null);

    // Esc inside drilled view returns to root (unless typing).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || !view) return;
            const tgt = e.target as HTMLElement | null;
            if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
            setView(null);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [view]);

    const enterParent = (parent: NavParent) => {
        setView(parent.key);
        const inside = parent.children.some((c) => isLeafActive(c, pathname));
        if (!inside) {
            const first = parent.children[0];
            router.push(savedHrefs[first.href] || first.href);
        }
        closeMobile();
    };

    return (
        <>
            {/* Logo */}
            <div className="flex items-center gap-2.5 border-b border-sidebar-border px-4 py-4">
                <Image
                    src="/logo.svg"
                    alt="MuzicAI"
                    width={32}
                    height={32}
                    className="shrink-0 rounded-lg shadow-[0_0_12px_rgba(124,92,255,0.30)]"
                />
                {!collapsed && (
                    <div className="flex flex-col min-w-0 leading-tight">
                        <span className="font-heading text-[15px] font-bold tracking-tight text-sidebar-foreground whitespace-nowrap overflow-hidden">
                            Muzic<span className="text-brand-accent">AI</span>
                        </span>
                        <span className="text-[10px] text-sidebar-foreground/30 whitespace-nowrap">
                            v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
                        </span>
                    </div>
                )}
            </div>

            {/* Search */}
            <div className="px-2 pt-2">
                <button
                    onClick={() => setSearchOpen(true)}
                    className={cn(
                        "flex w-full items-center rounded-xl border border-sidebar-border/50 bg-sidebar-accent/30 text-sidebar-foreground/40 transition-all duration-200 hover:bg-sidebar-accent hover:text-sidebar-foreground/70 hover:border-sidebar-border cursor-pointer",
                        collapsed ? "justify-center p-2" : "gap-2.5 px-3 py-2 text-sm"
                    )}
                    title={collapsed ? "Search (⌘K)" : undefined}
                >
                    <Search className={cn(collapsed ? "h-4 w-4" : "h-3.5 w-3.5")} />
                    {!collapsed && (
                        <>
                            <span className="flex-1 text-left">{tCommon("searchPlaceholder")}</span>
                            <kbd className="inline-flex h-5 items-center rounded border border-sidebar-border/60 bg-sidebar-accent/50 px-1.5 font-mono text-[10px] font-medium text-sidebar-foreground/25">
                                ⌘K
                            </kbd>
                        </>
                    )}
                </button>
            </div>

            {/* Animated nav region: cross-fade between root and drilled views */}
            <div className="flex-1 min-h-0 relative">
                <AnimatePresence mode="wait" initial={false}>
                    {activeParent ? (
                        <motion.div
                            key={`drill-${activeParent.key}`}
                            initial={{ opacity: 0, scale: 0.985, x: collapsed ? 0 : 6 }}
                            animate={{ opacity: 1, scale: 1, x: 0 }}
                            exit={{ opacity: 0, scale: 0.985, x: collapsed ? 0 : 6 }}
                            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
                            className="absolute inset-0 flex flex-col"
                        >
                            <DrilledView
                                parent={activeParent}
                                collapsed={collapsed}
                                pathname={pathname}
                                savedHrefs={savedHrefs}
                                onBack={() => setView(null)}
                                onLeafClick={closeMobile}
                                labelFor={labelFor}
                                isPinned={isPinned}
                                togglePin={togglePin}
                            />
                        </motion.div>
                    ) : (
                        <motion.div
                            key="root"
                            initial={{ opacity: 0, scale: 0.985, x: collapsed ? 0 : -6 }}
                            animate={{ opacity: 1, scale: 1, x: 0 }}
                            exit={{ opacity: 0, scale: 0.985, x: collapsed ? 0 : -6 }}
                            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
                            className="absolute inset-0 flex flex-col"
                        >
                            <RootView
                                collapsed={collapsed}
                                pathname={pathname}
                                savedHrefs={savedHrefs}
                                pinned={pinned}
                                onParentEnter={enterParent}
                                onLeafClick={closeMobile}
                                labelFor={labelFor}
                                hoverKey={hoverKey}
                                setHoverKey={setHoverKey}
                                isPinned={isPinned}
                                togglePin={togglePin}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Footer */}
            <div className="border-t border-sidebar-border px-2 py-3 space-y-2">
                {collapsed ? (
                    <div className="flex flex-col items-center gap-1">
                        <UserCard collapsed />
                        <DownloadHubButton collapsed />
                        <button
                            onClick={() => setLegendOpen(true)}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                            title="Legend & Help"
                        >
                            <HelpCircle className="h-4 w-4" />
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="flex items-center gap-1.5">
                            <div className="flex-1 min-w-0">
                                <DownloadHubButton />
                            </div>
                            <button
                                onClick={() => setLegendOpen(true)}
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                                title="Legend & Help"
                            >
                                <HelpCircle className="h-4 w-4" />
                            </button>
                        </div>
                        <UserCard />
                    </>
                )}
            </div>

            <LegendModal open={legendOpen} onOpenChange={setLegendOpen} />
            <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
        </>
    );
}

// ─── Root (top-level) view ───────────────────────────────────────────────
function RootView(props: {
    collapsed: boolean;
    pathname: string;
    savedHrefs: Record<string, string>;
    pinned: string[];
    onParentEnter: (p: NavParent) => void;
    onLeafClick: () => void;
    labelFor: (key: string, fallback: string) => string;
    hoverKey: string | null;
    setHoverKey: (k: string | null) => void;
    isPinned: (href: string) => boolean;
    togglePin: (href: string) => void;
}) {
    const {
        collapsed, pathname, savedHrefs, pinned, onParentEnter, onLeafClick,
        labelFor, hoverKey, setHoverKey, isPinned, togglePin,
    } = props;

    const pinnedLeaves = useMemo(
        () => pinned.map((h) => leafByHref(h)).filter((x): x is NavLeaf => !!x),
        [pinned]
    );

    const activeParentKey = findActiveParent(pathname)?.key;

    return (
        <nav className="h-full overflow-y-auto space-y-0.5 p-2" aria-label="Primary">
            {pinnedLeaves.length > 0 && (
                <>
                    {!collapsed && (
                        <div className="px-3 pt-2 pb-1 text-[.65rem] uppercase tracking-wider text-sidebar-foreground/30 flex items-center gap-1.5">
                            <Star className="h-3 w-3" /> Quick access
                        </div>
                    )}
                    {pinnedLeaves.map((leaf) => (
                        <LeafRow
                            key={`pin-${leaf.key}`}
                            leaf={leaf}
                            href={savedHrefs[leaf.href] || leaf.href}
                            collapsed={collapsed}
                            isActive={isLeafActive(leaf, pathname)}
                            onClick={onLeafClick}
                            labelFor={labelFor}
                            isPinned={isPinned(leaf.href)}
                            onPinToggle={() => togglePin(leaf.href)}
                        />
                    ))}
                    {!collapsed && <div className="my-2 mx-3 h-px bg-sidebar-border/50" />}
                </>
            )}

            {navTree.map((node) =>
                node.kind === "leaf" ? (
                    <LeafRow
                        key={node.key}
                        leaf={node}
                        href={savedHrefs[node.href] || node.href}
                        collapsed={collapsed}
                        isActive={isLeafActive(node, pathname)}
                        onClick={onLeafClick}
                        labelFor={labelFor}
                        isPinned={isPinned(node.href)}
                        onPinToggle={() => togglePin(node.href)}
                    />
                ) : (
                    <ParentRow
                        key={node.key}
                        parent={node}
                        collapsed={collapsed}
                        isActive={activeParentKey === node.key}
                        labelFor={labelFor}
                        onEnter={() => onParentEnter(node)}
                        onHover={(open) => setHoverKey(open ? node.key : null)}
                        hovering={hoverKey === node.key}
                        pathname={pathname}
                        savedHrefs={savedHrefs}
                        onLeafClick={onLeafClick}
                    />
                )
            )}
        </nav>
    );
}

// ─── Drilled (child) view ────────────────────────────────────────────────
function DrilledView(props: {
    parent: NavParent;
    collapsed: boolean;
    pathname: string;
    savedHrefs: Record<string, string>;
    onBack: () => void;
    onLeafClick: () => void;
    labelFor: (key: string, fallback: string) => string;
    isPinned: (href: string) => boolean;
    togglePin: (href: string) => void;
}) {
    const { parent, collapsed, pathname, savedHrefs, onBack, onLeafClick, labelFor, isPinned, togglePin } = props;

    return (
        <div className="flex flex-col h-full">
            <div className={cn("flex items-center gap-2 px-2 pt-2 pb-1", collapsed && "justify-center")}>
                <button
                    onClick={onBack}
                    className={cn(
                        "flex items-center justify-center rounded-lg text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors cursor-pointer",
                        collapsed ? "h-9 w-9" : "h-8 w-8"
                    )}
                    title="Back (Esc)"
                    aria-label="Back"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                {!collapsed && (
                    <div className="flex items-center gap-2 min-w-0">
                        <span className={cn(
                            "inline-flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br text-white shadow-sm",
                            parent.accent
                        )}>
                            <parent.icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="text-sm font-semibold tracking-tight text-sidebar-foreground truncate">
                            {labelFor(parent.key, parent.label)}
                        </span>
                    </div>
                )}
            </div>

            {!collapsed && <div className="my-1 mx-3 h-px bg-sidebar-border/50" />}

            <nav className="flex-1 overflow-y-auto p-2 space-y-0.5" aria-label={`${parent.label} navigation`}>
                {parent.children.map((leaf) => (
                    <LeafRow
                        key={leaf.key}
                        leaf={leaf}
                        href={savedHrefs[leaf.href] || leaf.href}
                        collapsed={collapsed}
                        isActive={isLeafActive(leaf, pathname)}
                        accent={parent.accent}
                        onClick={onLeafClick}
                        labelFor={labelFor}
                        isPinned={isPinned(leaf.href)}
                        onPinToggle={() => togglePin(leaf.href)}
                    />
                ))}

                {parent.showProjects && !collapsed && (
                    <RecentProjects parentKey={parent.key} />
                )}
            </nav>
        </div>
    );
}

// ─── Leaf row ────────────────────────────────────────────────────────────
function LeafRow(props: {
    leaf: NavLeaf;
    href: string;
    collapsed: boolean;
    isActive: boolean;
    accent?: string;
    onClick: () => void;
    labelFor: (key: string, fallback: string) => string;
    isPinned: boolean;
    onPinToggle: () => void;
}) {
    const { leaf, href, collapsed, isActive, accent, onClick, labelFor, isPinned, onPinToggle } = props;
    const label = labelFor(leaf.key, leaf.label);
    return (
        <Link
            href={href}
            onClick={onClick}
            aria-current={isActive ? "page" : undefined}
            className={cn(
                "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
                collapsed && "justify-center px-2",
                isActive
                    ? "bg-sidebar-primary/10 text-sidebar-primary shadow-[inset_0_0_0_1px_rgba(139,92,246,0.15)]"
                    : "text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-foreground/70"
            )}
            title={collapsed ? label : undefined}
        >
            {isActive && (
                <span
                    aria-hidden="true"
                    className={cn(
                        "absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-gradient-to-b animate-[slideUpFade_200ms_ease-out]",
                        accent ?? "from-purple-400 to-fuchsia-500"
                    )}
                />
            )}
            <leaf.icon
                aria-hidden="true"
                className={cn(
                    "h-4 w-4 shrink-0 transition-colors duration-200",
                    isActive && "text-sidebar-primary"
                )}
            />
            {!collapsed && (
                <>
                    <span className="flex-1 truncate">{label}</span>
                    <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPinToggle(); }}
                        className={cn(
                            "opacity-0 group-hover:opacity-100 transition-opacity rounded p-1 hover:bg-sidebar-accent/60",
                            isPinned && "opacity-100 text-amber-400"
                        )}
                        title={isPinned ? "Unpin from Quick access" : "Pin to Quick access"}
                        aria-label={isPinned ? "Unpin" : "Pin"}
                    >
                        <Pin className={cn("h-3 w-3", isPinned && "fill-amber-400")} />
                    </button>
                </>
            )}
        </Link>
    );
}

// ─── Parent row (root view) ──────────────────────────────────────────────
function ParentRow(props: {
    parent: NavParent;
    collapsed: boolean;
    isActive: boolean;
    labelFor: (key: string, fallback: string) => string;
    onEnter: () => void;
    onHover: (open: boolean) => void;
    hovering: boolean;
    pathname: string;
    savedHrefs: Record<string, string>;
    onLeafClick: () => void;
}) {
    const { parent, collapsed, isActive, labelFor, onEnter, onHover, hovering, pathname, savedHrefs, onLeafClick } = props;
    const label = labelFor(parent.key, parent.label);
    return (
        <div
            className="relative"
            onMouseEnter={() => collapsed && onHover(true)}
            onMouseLeave={() => collapsed && onHover(false)}
        >
            <button
                type="button"
                onClick={onEnter}
                aria-haspopup="menu"
                aria-expanded={isActive}
                className={cn(
                    "relative w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 cursor-pointer",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
                    collapsed && "justify-center px-2",
                    isActive
                        ? "bg-sidebar-accent/60 text-sidebar-foreground"
                        : "text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-foreground/70"
                )}
                title={collapsed ? label : undefined}
            >
                {isActive && (
                    <span
                        aria-hidden="true"
                        className={cn(
                            "absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-gradient-to-b",
                            parent.accent
                        )}
                    />
                )}
                <span className={cn(
                    "inline-flex shrink-0 items-center justify-center rounded-md transition-all duration-200",
                    isActive
                        ? cn("h-5 w-5 bg-gradient-to-br text-white shadow-sm", parent.accent)
                        : "h-4 w-4 text-current"
                )}>
                    <parent.icon className={cn(isActive ? "h-3 w-3" : "h-4 w-4")} />
                </span>
                {!collapsed && (
                    <>
                        <span className="flex-1 truncate text-left">{label}</span>
                        <ChevronRight className="h-3.5 w-3.5 opacity-50" />
                    </>
                )}
            </button>

            <AnimatePresence>
                {collapsed && hovering && (
                    <motion.div
                        initial={{ opacity: 0, x: -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -6 }}
                        transition={{ duration: 0.14, ease: "easeOut" }}
                        className="absolute left-full top-0 ml-2 z-50 w-56 rounded-xl border border-sidebar-border bg-sidebar shadow-xl p-2"
                    >
                        <div className="flex items-center gap-2 px-2 pb-2 mb-1 border-b border-sidebar-border">
                            <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br text-white", parent.accent)}>
                                <parent.icon className="h-3 w-3" />
                            </span>
                            <span className="text-sm font-semibold text-sidebar-foreground truncate">{label}</span>
                        </div>
                        {parent.children.map((leaf) => {
                            const active = isLeafActive(leaf, pathname);
                            const href = savedHrefs[leaf.href] || leaf.href;
                            return (
                                <Link
                                    key={leaf.key}
                                    href={href}
                                    onClick={onLeafClick}
                                    className={cn(
                                        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors",
                                        active
                                            ? "bg-sidebar-primary/10 text-sidebar-primary"
                                            : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                                    )}
                                >
                                    <leaf.icon className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{leaf.label}</span>
                                </Link>
                            );
                        })}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

// ─── Recent projects (cloud-backed when signed in, localStorage fallback) ─
//
// Parent → project kind mapping. Apps whose `parentKey` matches one of
// these query the cloud via the `listProjects` server action; others
// fall back to the localStorage `recent-projects:<key>` cache.
const PARENT_TO_PROJECT_KIND: Record<string, "daw" | "editor" | "live" | "mixer" | "visualization"> = {
    music: "daw",
    tools: "visualization",
};

function RecentProjects({ parentKey }: { parentKey: string }) {
    const [items, setItems] = useState<{ name: string; href: string }[]>([]);

    useEffect(() => {
        let cancelled = false;
        const kind = PARENT_TO_PROJECT_KIND[parentKey];

        async function load() {
            if (kind) {
                try {
                    const mod = await import("@/actions/projects");
                    const rows = await mod.listProjects(kind);
                    if (cancelled) return;
                    const hrefBase = kind === "daw" ? "/daw" : kind === "editor" ? "/editor" : `/${kind}`;
                    setItems(rows.slice(0, 6).map((r) => ({
                        name: r.name,
                        href: `${hrefBase}?project=${encodeURIComponent(r.externalId)}`,
                    })));
                    return;
                } catch { /* fall through to localStorage */ }
            }
            try {
                const raw = localStorage.getItem(`recent-projects:${parentKey}`);
                if (!raw) return;
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && !cancelled) setItems(parsed.slice(0, 6));
            } catch { /* ignore */ }
        }
        void load();
        return () => { cancelled = true; };
    }, [parentKey]);

    return (
        <div className="mt-4 pt-3 border-t border-sidebar-border/50">
            <div className="px-3 pb-1 text-[.65rem] uppercase tracking-wider text-sidebar-foreground/30">
                Recent projects
            </div>
            {items.length === 0 ? (
                <p className="px-3 py-2 text-xs text-sidebar-foreground/30 italic">
                    No recent projects yet.
                </p>
            ) : (
                items.map((p) => (
                    <Link
                        key={p.href}
                        href={p.href}
                        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors truncate"
                    >
                        <span className="h-1.5 w-1.5 rounded-full bg-sidebar-foreground/30" />
                        <span className="truncate">{p.name}</span>
                    </Link>
                ))
            )}
        </div>
    );
}

// ─── Main sidebar component ──────────────────────────────────────────────
export function AppSidebar() {
    const { collapsed, toggle, mobileOpen, closeMobile } = useSidebar();

    return (
        <>
            {/* Desktop */}
            <div className="hidden md:flex relative shrink-0 h-full">
                <aside
                    className={cn(
                        "flex h-full flex-col bg-sidebar transition-[width] duration-300 ease-in-out overflow-hidden",
                        collapsed ? "w-[60px]" : "w-60"
                    )}
                >
                    <SidebarContent collapsed={collapsed} />
                </aside>

                <button
                    onClick={toggle}
                    className="group absolute top-0 right-0 w-[1px] h-full bg-sidebar-border hover:w-[3px] hover:bg-purple-500/50 transition-all duration-200 cursor-col-resize z-10"
                    title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                >
                    <div className="absolute top-1/2 -translate-y-1/2 -right-3 flex h-6 w-6 items-center justify-center rounded-full bg-sidebar border border-sidebar-border shadow-md opacity-50 group-hover:opacity-100 transition-opacity duration-200">
                        {collapsed ? (
                            <ChevronsRight className="h-3 w-3 text-sidebar-foreground/60" />
                        ) : (
                            <ChevronsLeft className="h-3 w-3 text-sidebar-foreground/60" />
                        )}
                    </div>
                </button>
            </div>

            {/* Mobile drawer */}
            <div
                className={cn(
                    "fixed inset-0 z-[55] md:hidden transition-all duration-300",
                    mobileOpen ? "pointer-events-auto" : "pointer-events-none"
                )}
            >
                <div
                    className={cn(
                        "absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300",
                        mobileOpen ? "opacity-100" : "opacity-0"
                    )}
                    onClick={closeMobile}
                    aria-hidden="true"
                />
                <aside
                    className={cn(
                        "absolute left-0 top-0 bottom-0 w-64 bg-sidebar border-r border-sidebar-border flex flex-col transition-transform duration-300 ease-out",
                        mobileOpen ? "translate-x-0" : "-translate-x-full"
                    )}
                >
                    <button
                        onClick={closeMobile}
                        className="absolute top-3 right-3 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors cursor-pointer z-10"
                        aria-label="Close menu"
                    >
                        <X className="h-4 w-4" />
                    </button>
                    <SidebarContent collapsed={false} />
                </aside>
            </div>
        </>
    );
}
