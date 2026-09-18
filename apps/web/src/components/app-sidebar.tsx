"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Menu, Search, ChevronRight, ArrowLeft, CircleHelp, Star, Pin } from "lucide-react";
import {
    Sidebar,
    SidebarHeader,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuButton,
    SidebarRail,
    Kbd,
} from "@mmo/ui";
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

type LabelFor = (key: string, fallback: string) => string;

// ─── Public mobile trigger (kept for compatibility) ──────────────────────
export function MobileSidebarTrigger() {
    const { openMobile } = useSidebar();
    const t = useTranslations("nav");
    return (
        <button
            type="button"
            onClick={openMobile}
            className="surface fixed top-3 left-3 z-(--z-sticky) flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground md:hidden"
            aria-label={t("openMenu")}
        >
            <Menu className="size-4.5" aria-hidden />
        </button>
    );
}

// ─── i18n helper: fall back to baked-in English when key is missing ──────
function useTranslatedLabel(): LabelFor {
    const t = useTranslations("nav");
    return useCallback((key: string, fallback: string) => (t.has(key) ? t(key) : fallback), [t]);
}

function leafByHref(href: string): NavLeaf | undefined {
    return allLeaves.find((l) => l.href === href);
}

const VIEW_EASE = [0.32, 0.72, 0, 1] as const;

// ─── Sidebar body (header + root/drilled views + footer) ─────────────────
function SidebarBody({ onOpenSearch, onOpenLegend }: { onOpenSearch: () => void; onOpenLegend: () => void }) {
    const pathname = usePathname();
    const router = useRouter();
    const savedHrefs = useRouteMemoryHrefs();
    const { collapsed: desktopCollapsed, isMobile, closeMobile } = useSidebar();
    // The mobile drawer always renders expanded even when the desktop rail is collapsed.
    const collapsed = desktopCollapsed && !isMobile;
    const labelFor = useTranslatedLabel();
    const t = useTranslations("nav");
    const { pinned, toggle: togglePin, isPinned } = usePinnedHrefs();
    const reduceMotion = useReducedMotion();

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

    const viewMotion = (dir: 1 | -1) =>
        reduceMotion
            ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
            : {
                initial: { opacity: 0, scale: 0.985, x: collapsed ? 0 : 6 * dir },
                animate: { opacity: 1, scale: 1, x: 0 },
                exit: { opacity: 0, scale: 0.985, x: collapsed ? 0 : 6 * dir },
            };
    const viewTransition = { duration: reduceMotion ? 0.1 : 0.18, ease: VIEW_EASE };

    return (
        <>
            <SidebarHeader className="h-16 gap-2.5 border-b border-sidebar-border px-4">
                <Image
                    src="/logo.svg"
                    alt="MixAI"
                    width={32}
                    height={32}
                    className="shrink-0 rounded-lg shadow-[0_0_12px_color-mix(in_oklch,var(--primary)_30%,transparent)]"
                />
                {!collapsed && (
                    <div className="flex min-w-0 flex-col leading-tight">
                        <span className="overflow-hidden font-heading text-[15px] font-bold tracking-tight whitespace-nowrap text-sidebar-foreground">
                            Mix<span className="text-gradient-accent">AI</span>
                        </span>
                        <span className="text-[10px] whitespace-nowrap text-sidebar-foreground/40">
                            v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
                        </span>
                    </div>
                )}
            </SidebarHeader>

            {/* Search */}
            <div className="px-2 pt-2">
                <button
                    type="button"
                    onClick={onOpenSearch}
                    className={cn(
                        "flex w-full cursor-pointer items-center rounded-lg border border-sidebar-border/50 bg-sidebar-accent/30 text-sidebar-foreground/50 transition-colors duration-(--dur-fast) hover:border-sidebar-border hover:bg-sidebar-accent hover:text-sidebar-foreground/80 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
                        collapsed ? "justify-center p-2" : "gap-2.5 px-3 py-2 text-sm"
                    )}
                    title={collapsed ? `${t("searchPlaceholder")} (⌘K)` : undefined}
                    aria-label={t("searchPlaceholder")}
                >
                    <Search className={cn(collapsed ? "size-4" : "size-3.5")} aria-hidden />
                    {!collapsed && (
                        <>
                            <span className="flex-1 truncate text-left">{t("searchPlaceholder")}</span>
                            <Kbd>⌘K</Kbd>
                        </>
                    )}
                </button>
            </div>

            {/* Animated nav region: cross-fade between root and drilled views */}
            <SidebarContent className="relative overflow-hidden p-0">
                <AnimatePresence mode="wait" initial={false}>
                    {activeParent ? (
                        <motion.div
                            key={`drill-${activeParent.key}`}
                            {...viewMotion(1)}
                            transition={viewTransition}
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
                            {...viewMotion(-1)}
                            transition={viewTransition}
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
            </SidebarContent>

            <SidebarFooter>
                {collapsed ? (
                    <div className="flex flex-col items-center gap-1">
                        <UserCard collapsed />
                        <DownloadHubButton collapsed />
                        <HelpButton onClick={onOpenLegend} label={t("help")} />
                    </div>
                ) : (
                    <>
                        <div className="flex items-center gap-1.5">
                            <div className="min-w-0 flex-1">
                                <DownloadHubButton />
                            </div>
                            <HelpButton onClick={onOpenLegend} label={t("help")} />
                        </div>
                        <UserCard />
                    </>
                )}
            </SidebarFooter>
        </>
    );
}

function HelpButton({ onClick, label }: { onClick: () => void; label: string }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
            title={label}
            aria-label={label}
        >
            <CircleHelp className="size-4" aria-hidden />
        </button>
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
    labelFor: LabelFor;
    hoverKey: string | null;
    setHoverKey: (k: string | null) => void;
    isPinned: (href: string) => boolean;
    togglePin: (href: string) => void;
}) {
    const {
        collapsed, pathname, savedHrefs, pinned, onParentEnter, onLeafClick,
        labelFor, hoverKey, setHoverKey, isPinned, togglePin,
    } = props;
    const t = useTranslations("nav");

    const pinnedLeaves = useMemo(
        () => pinned.map((h) => leafByHref(h)).filter((x): x is NavLeaf => !!x),
        [pinned]
    );

    const activeParentKey = findActiveParent(pathname)?.key;

    return (
        <nav className="flex h-full flex-col gap-2 overflow-y-auto overscroll-contain p-2" aria-label={t("primaryNavigation")}>
            {pinnedLeaves.length > 0 && (
                <SidebarGroup className="border-b border-sidebar-border/50 pb-2">
                    <SidebarGroupLabel className="gap-1.5 uppercase tracking-wider text-[.65rem]">
                        <Star className="size-3" aria-hidden /> {t("quickAccess")}
                    </SidebarGroupLabel>
                    <SidebarMenu>
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
                    </SidebarMenu>
                </SidebarGroup>
            )}

            <SidebarGroup>
                <SidebarMenu>
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
                </SidebarMenu>
            </SidebarGroup>
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
    labelFor: LabelFor;
    isPinned: (href: string) => boolean;
    togglePin: (href: string) => void;
}) {
    const { parent, collapsed, pathname, savedHrefs, onBack, onLeafClick, labelFor, isPinned, togglePin } = props;
    const t = useTranslations("nav");
    const parentLabel = labelFor(parent.key, parent.label);

    return (
        <div className="flex h-full flex-col">
            <div className={cn("flex items-center gap-2 px-2 pt-2 pb-1", collapsed && "justify-center")}>
                <button
                    type="button"
                    onClick={onBack}
                    className={cn(
                        "flex cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors duration-(--dur-fast) hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none",
                        collapsed ? "size-9" : "size-8"
                    )}
                    title={`${t("back")} (Esc)`}
                    aria-label={t("back")}
                >
                    <ArrowLeft className="size-4" aria-hidden />
                </button>
                {!collapsed && (
                    <div className="flex min-w-0 items-center gap-2">
                        <ParentChip parent={parent} size="md" />
                        <span className="truncate text-sm font-semibold tracking-tight text-sidebar-foreground">{parentLabel}</span>
                    </div>
                )}
            </div>

            {!collapsed && <div className="mx-3 my-1 h-px bg-sidebar-border/50" />}

            <nav className="flex-1 overflow-y-auto overscroll-contain p-2" aria-label={parentLabel}>
                <SidebarMenu>
                    {parent.children.map((leaf) => (
                        <LeafRow
                            key={leaf.key}
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
                </SidebarMenu>

                {parent.showProjects && !collapsed && (
                    <RecentProjects parentKey={parent.key} />
                )}
            </nav>
        </div>
    );
}

/** Parent icon chip: token gradient from nav-tree (`deck-*` / `chart-*`). */
function ParentChip({ parent, size, muted = false }: { parent: NavParent; size: "sm" | "md"; muted?: boolean }) {
    return (
        <span
            className={cn(
                "inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-(--dur-fast)",
                size === "md" ? "size-6" : "size-5",
                muted ? "bg-primary/10 text-primary" : cn("bg-gradient-to-br text-primary-foreground shadow-sm", parent.accent)
            )}
        >
            <parent.icon className={size === "md" ? "size-3.5" : "size-3"} aria-hidden />
        </span>
    );
}

/** 3px active indicator on the left edge. */
function ActiveBar() {
    return (
        <span
            aria-hidden="true"
            className="absolute top-1/2 left-0 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-gradient-accent motion-safe:animate-[slideUpFade_200ms_ease-out]"
        />
    );
}

// ─── Leaf row ────────────────────────────────────────────────────────────
function LeafRow(props: {
    leaf: NavLeaf;
    href: string;
    collapsed: boolean;
    isActive: boolean;
    onClick: () => void;
    labelFor: LabelFor;
    isPinned: boolean;
    onPinToggle: () => void;
}) {
    const { leaf, href, collapsed, isActive, onClick, labelFor, isPinned, onPinToggle } = props;
    const label = labelFor(leaf.key, leaf.label);
    const t = useTranslations("nav");
    return (
        <SidebarMenuItem className="group/leaf">
            <SidebarMenuButton
                render={<Link href={href} />}
                active={isActive}
                icon={<leaf.icon aria-hidden />}
                label={label}
                onClick={onClick}
                className={cn(
                    "relative font-medium text-sidebar-foreground/60",
                    "data-[active]:bg-sidebar-accent data-[active]:text-sidebar-primary data-[active]:[&_svg]:text-sidebar-primary"
                )}
            >
                {isActive && <ActiveBar />}
                {!collapsed && (
                    <button
                        type="button"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPinToggle(); }}
                        className={cn(
                            "rounded p-1 opacity-0 transition-opacity duration-(--dur-fast) group-hover/leaf:opacity-100 hover:bg-sidebar-accent/60 focus-visible:opacity-100",
                            isPinned && "text-deck-d opacity-100"
                        )}
                        title={isPinned ? t("unpin") : t("pin")}
                        aria-label={isPinned ? t("unpin") : t("pin")}
                        aria-pressed={isPinned}
                    >
                        <Pin className={cn("size-3", isPinned && "fill-current")} aria-hidden />
                    </button>
                )}
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}

// ─── Parent row (root view) ──────────────────────────────────────────────
function ParentRow(props: {
    parent: NavParent;
    collapsed: boolean;
    isActive: boolean;
    labelFor: LabelFor;
    onEnter: () => void;
    onHover: (open: boolean) => void;
    hovering: boolean;
    pathname: string;
    savedHrefs: Record<string, string>;
    onLeafClick: () => void;
}) {
    const { parent, collapsed, isActive, labelFor, onEnter, onHover, hovering, pathname, savedHrefs, onLeafClick } = props;
    const label = labelFor(parent.key, parent.label);
    const reduceMotion = useReducedMotion();
    return (
        <SidebarMenuItem
            onMouseEnter={() => collapsed && onHover(true)}
            onMouseLeave={() => collapsed && onHover(false)}
        >
            <SidebarMenuButton
                onClick={onEnter}
                aria-haspopup="menu"
                aria-expanded={isActive}
                active={isActive}
                icon={<ParentChip parent={parent} size="sm" muted={!isActive} />}
                label={label}
                className="relative font-medium text-sidebar-foreground/60 data-[active]:bg-sidebar-accent data-[active]:text-sidebar-primary"
            >
                {isActive && <ActiveBar />}
                {!collapsed && <ChevronRight className="size-3.5 opacity-50" aria-hidden />}
            </SidebarMenuButton>

            <AnimatePresence>
                {collapsed && hovering && (
                    <motion.div
                        initial={{ opacity: 0, x: reduceMotion ? 0 : -6 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: reduceMotion ? 0 : -6 }}
                        transition={{ duration: reduceMotion ? 0.08 : 0.14, ease: "easeOut" }}
                        role="menu"
                        aria-label={label}
                        className="surface absolute top-0 left-full z-(--z-popover) ml-2 w-56 rounded-xl bg-sidebar p-2 text-sidebar-foreground"
                    >
                        <div className="mb-1 flex items-center gap-2 border-b border-sidebar-border px-2 pb-2">
                            <ParentChip parent={parent} size="sm" />
                            <span className="truncate text-sm font-semibold text-sidebar-foreground">{label}</span>
                        </div>
                        {parent.children.map((leaf) => {
                            const active = isLeafActive(leaf, pathname);
                            const href = savedHrefs[leaf.href] || leaf.href;
                            return (
                                <Link
                                    key={leaf.key}
                                    href={href}
                                    onClick={onLeafClick}
                                    role="menuitem"
                                    aria-current={active ? "page" : undefined}
                                    className={cn(
                                        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors duration-(--dur-fast)",
                                        active
                                            ? "bg-sidebar-accent text-sidebar-primary"
                                            : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                                    )}
                                >
                                    <leaf.icon className="size-3.5 shrink-0" aria-hidden />
                                    <span className="truncate">{labelFor(leaf.key, leaf.label)}</span>
                                </Link>
                            );
                        })}
                    </motion.div>
                )}
            </AnimatePresence>
        </SidebarMenuItem>
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
    const t = useTranslations("nav");

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
        <SidebarGroup className="mt-4 border-t border-sidebar-border/50 pt-3">
            <SidebarGroupLabel className="uppercase tracking-wider text-[.65rem]">{t("recentProjects")}</SidebarGroupLabel>
            {items.length === 0 ? (
                <p className="px-3 py-2 text-xs text-sidebar-foreground/40 italic">{t("noRecentProjects")}</p>
            ) : (
                <SidebarMenu>
                    {items.map((p) => (
                        <SidebarMenuItem key={p.href}>
                            <SidebarMenuButton
                                render={<Link href={p.href} />}
                                icon={<span className="size-1.5 rounded-full bg-sidebar-foreground/40" aria-hidden />}
                                label={p.name}
                                className="h-8 text-sidebar-foreground/60"
                            />
                        </SidebarMenuItem>
                    ))}
                </SidebarMenu>
            )}
        </SidebarGroup>
    );
}

// ─── Main sidebar component ──────────────────────────────────────────────
export function AppSidebar() {
    const [legendOpen, setLegendOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const openSearch = useCallback(() => setSearchOpen(true), []);
    const openLegend = useCallback(() => setLegendOpen(true), []);

    return (
        <>
            {/* `Sidebar` renders the desktop rail (md+) and the mobile drawer (Base UI dialog,
                swipe-to-close) from the same children. Flyouts use `overflow-visible`. */}
            <Sidebar data-app-sidebar="" className="relative overflow-visible [body.daw-focus-mode_&]:hidden">
                <SidebarBody onOpenSearch={openSearch} onOpenLegend={openLegend} />
                <SidebarRail />
            </Sidebar>

            {/* Modals mounted once (the drawer duplicates the body). */}
            <LegendModal open={legendOpen} onOpenChange={setLegendOpen} />
            <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
        </>
    );
}
