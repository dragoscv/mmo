"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
    LayoutDashboard,
    Library,
    ScanSearch,
    HardDrive,
    Settings,
    ListMusic,
    AudioWaveform,
    HelpCircle,
    Search,
    ChevronsLeft,
    ChevronsRight,
    Menu,
    X,
    Download,
    Piano,
    Waves,
    Disc3,
    Mic,
    Monitor,
    Smartphone,
    CircleDot,
    Activity,
    Plug,
    BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";
import { LegendModal } from "./legend-modal";
import { GlobalSearch } from "./global-search";
import { useRouteMemoryHrefs } from "@/hooks/use-route-memory";
import { useSidebar } from "./sidebar-context";
import { UserCard } from "./user-card";
import { CompanionDownloadButton } from "./sidebar/companion-download-button";

const navItems = [
    { href: "/", label: "Dashboard", key: "dashboard", icon: LayoutDashboard },
    { href: "/library", label: "Library", key: "library", icon: Library },
    { href: "/analysis", label: "Analysis", key: "analysis", icon: Activity },
    { href: "/playlists", label: "Playlists", key: "playlists", icon: ListMusic },
    { href: "/mixer", label: "Mixer", key: "mixer", icon: Disc3 },
    { href: "/daw", label: "DAW", key: "daw", icon: Piano },
    { href: "/editor", label: "Sound Editor", key: "editor", icon: Waves },
    { href: "/plugins", label: "Plugins", key: "plugins", icon: Plug },
    { href: "/live", label: "Live", key: "live", icon: Mic },
    { href: "/recordings", label: "Recordings", key: "recordings", icon: CircleDot },
    { href: "/download", label: "Download", key: "download", icon: Download },
    { href: "/visualizations", label: "Visualizations", key: "visualizations", icon: AudioWaveform },
    { href: "/scanner", label: "Scanner", key: "scanner", icon: ScanSearch },
    { href: "/drives", label: "Drives", key: "drives", icon: HardDrive },
    { href: "/devices", label: "Devices", key: "devices", icon: Monitor },
    { href: "/remote", label: "Remote", key: "remote", icon: Smartphone },
    { href: "/learn", label: "Learn", key: "learn", icon: BookOpen },
    { href: "/settings", label: "Settings", key: "settings", icon: Settings },
] as const;

// ─── Mobile trigger button (rendered outside sidebar) ────────────────────
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

// ─── Sidebar content (shared between desktop & mobile) ───────────────────
function SidebarContent({ collapsed }: { collapsed: boolean }) {
    const pathname = usePathname();
    const [legendOpen, setLegendOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const savedHrefs = useRouteMemoryHrefs();
    const { toggle, closeMobile } = useSidebar();
    // Falls back to the English label baked into navItems when a key is
    // missing in the active locale’s message bundle (next-intl logs a warning
    // in dev rather than throwing).
    const t = useTranslations("nav");
    const labelFor = (item: typeof navItems[number]) => {
        try { return t(item.key); } catch { return item.label; }
    };

    return (
        <>
            {/* Logo */}
            <div className="flex items-center gap-2.5 border-b border-sidebar-border px-4 py-4">
                <Image
                    src="/logo.svg"
                    alt="MMO"
                    width={32}
                    height={32}
                    className="shrink-0 rounded-lg shadow-[0_0_12px_rgba(139,92,246,0.25)]"
                />
                {!collapsed && (
                    <span className="text-[15px] font-bold tracking-tight text-sidebar-foreground whitespace-nowrap overflow-hidden">
                        MMO
                    </span>
                )}
            </div>

            {/* Search button */}
            {!collapsed ? (
                <div className="px-2 pt-2">
                    <button
                        onClick={() => setSearchOpen(true)}
                        className="flex w-full items-center gap-2.5 rounded-xl border border-sidebar-border/50 bg-sidebar-accent/30 px-3 py-2 text-sm text-sidebar-foreground/40 transition-all duration-200 hover:bg-sidebar-accent hover:text-sidebar-foreground/70 hover:border-sidebar-border cursor-pointer"
                    >
                        <Search className="h-3.5 w-3.5" />
                        <span className="flex-1 text-left">Search...</span>
                        <kbd className="inline-flex h-5 items-center rounded border border-sidebar-border/60 bg-sidebar-accent/50 px-1.5 font-mono text-[10px] font-medium text-sidebar-foreground/25">
                            ⌘K
                        </kbd>
                    </button>
                </div>
            ) : (
                <div className="px-2 pt-2">
                    <button
                        onClick={() => setSearchOpen(true)}
                        className="flex w-full items-center justify-center rounded-xl border border-sidebar-border/50 bg-sidebar-accent/30 p-2 text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-foreground/70 transition-all duration-200 cursor-pointer"
                        title="Search (⌘K)"
                    >
                        <Search className="h-4 w-4" />
                    </button>
                </div>
            )}

            <nav className="flex-1 min-h-0 overflow-y-auto space-y-0.5 p-2" aria-label="Primary">
                {navItems.map((item) => {
                    const isActive =
                        pathname === item.href ||
                        (item.href !== "/" && pathname.startsWith(item.href));
                    const href = savedHrefs[item.href] || item.href;
                    return (
                        <Link
                            key={item.href}
                            href={href}
                            onClick={closeMobile}
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                                "relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
                                collapsed && "justify-center px-2",
                                isActive
                                    ? "bg-sidebar-primary/10 text-sidebar-primary shadow-[inset_0_0_0_1px_rgba(139,92,246,0.15)]"
                                    : "text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-foreground/70"
                            )}
                            title={collapsed ? labelFor(item) : undefined}
                        >
                            {/* Active indicator bar */}
                            {isActive && (
                                <div
                                    aria-hidden="true"
                                    className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-gradient-to-b from-purple-400 to-fuchsia-500 animate-[slideUpFade_200ms_ease-out]"
                                />
                            )}
                            <item.icon
                                aria-hidden="true"
                                className={cn(
                                    "h-4 w-4 shrink-0 transition-colors duration-200",
                                    isActive && "text-sidebar-primary"
                                )}
                            />
                            {!collapsed && labelFor(item)}
                        </Link>
                    );
                })}
            </nav>

            <div className="border-t border-sidebar-border px-2 py-3 space-y-2">
                {collapsed ? (
                    <div className="flex flex-col items-center gap-1">
                        <UserCard collapsed />
                        <CompanionDownloadButton collapsed />
                        <ThemeToggle collapsed />
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
                        <UserCard />
                        <CompanionDownloadButton />
                        <div className="flex items-center justify-between px-2">
                            <ThemeToggle />
                            <button
                                onClick={() => setLegendOpen(true)}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                                title="Legend & Help"
                            >
                                <HelpCircle className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="px-2">
                            <p className="text-[11px] text-sidebar-foreground/20">
                                MMO v0.1
                            </p>
                            <p className="text-[11px] text-sidebar-foreground/15">by mwrty</p>
                        </div>
                    </>
                )}
            </div>
            <LegendModal open={legendOpen} onOpenChange={setLegendOpen} />
            <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
        </>
    );
}

// ─── Main sidebar component ──────────────────────────────────────────────
export function AppSidebar() {
    const { collapsed, toggle, mobileOpen, closeMobile } = useSidebar();

    return (
        <>
            {/* Desktop sidebar */}
            <div className="hidden md:flex relative shrink-0 h-full">
                <aside
                    className={cn(
                        "flex h-full flex-col bg-sidebar transition-[width] duration-300 ease-in-out overflow-hidden",
                        collapsed ? "w-[60px]" : "w-56"
                    )}
                >
                    <SidebarContent collapsed={collapsed} />
                </aside>

                {/* Right border collapse handle */}
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

            {/* Mobile overlay */}
            <div
                className={cn(
                    "fixed inset-0 z-[55] md:hidden transition-all duration-300",
                    mobileOpen ? "pointer-events-auto" : "pointer-events-none"
                )}
            >
                {/* Backdrop */}
                <div
                    className={cn(
                        "absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300",
                        mobileOpen ? "opacity-100" : "opacity-0"
                    )}
                    onClick={closeMobile}
                />
                {/* Drawer */}
                <aside
                    className={cn(
                        "absolute left-0 top-0 bottom-0 w-64 bg-sidebar border-r border-sidebar-border flex flex-col transition-transform duration-300 ease-out",
                        mobileOpen ? "translate-x-0" : "-translate-x-full"
                    )}
                >
                    {/* Close button */}
                    <button
                        onClick={closeMobile}
                        className="absolute top-3 right-3 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors cursor-pointer z-10"
                    >
                        <X className="h-4 w-4" />
                    </button>
                    <SidebarContent collapsed={false} />
                </aside>
            </div>
        </>
    );
}
