"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    LayoutDashboard,
    Library,
    ScanSearch,
    HardDrive,
    Settings,
    Music,
    ListMusic,
    AudioWaveform,
    HelpCircle,
    Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";
import { LegendModal } from "./legend-modal";
import { GlobalSearch } from "./global-search";

const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/library", label: "Library", icon: Library },
    { href: "/playlists", label: "Playlists", icon: ListMusic },
    { href: "/visualizations", label: "Visualizations", icon: AudioWaveform },
    { href: "/scanner", label: "Scanner", icon: ScanSearch },
    { href: "/drives", label: "Drives", icon: HardDrive },
    { href: "/settings", label: "Settings", icon: Settings },
];

export function AppSidebar() {
    const pathname = usePathname();
    const [legendOpen, setLegendOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);

    return (
        <aside className="flex h-full w-56 flex-col border-r border-sidebar-border bg-sidebar">
            {/* Logo */}
            <div className="flex items-center gap-2.5 border-b border-sidebar-border px-4 py-4">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500 to-fuchsia-600 shadow-[0_0_12px_rgba(139,92,246,0.25)]">
                    <Music className="h-4 w-4 text-white" />
                </div>
                <span className="text-[15px] font-bold tracking-tight text-sidebar-foreground">
                    Music Organizer
                </span>
            </div>

            {/* Search button */}
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

            <nav className="flex-1 space-y-0.5 p-2">
                {navItems.map((item) => {
                    const isActive =
                        pathname === item.href ||
                        (item.href !== "/" && pathname.startsWith(item.href));
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                                "relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
                                isActive
                                    ? "bg-sidebar-primary/10 text-sidebar-primary shadow-[inset_0_0_0_1px_rgba(139,92,246,0.15)]"
                                    : "text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-foreground/70"
                            )}
                        >
                            {/* Active indicator bar */}
                            {isActive && (
                                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-gradient-to-b from-purple-400 to-fuchsia-500 animate-[slideUpFade_200ms_ease-out]" />
                            )}
                            <item.icon className={cn(
                                "h-4 w-4 transition-colors duration-200",
                                isActive && "text-sidebar-primary"
                            )} />
                            {item.label}
                        </Link>
                    );
                })}
            </nav>

            <div className="border-t border-sidebar-border px-4 py-3 space-y-3">
                <div className="flex items-center justify-between">
                    <ThemeToggle />
                    <button
                        onClick={() => setLegendOpen(true)}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                        title="Legend & Help"
                    >
                        <HelpCircle className="h-4 w-4" />
                    </button>
                </div>
                <div>
                    <p className="text-[11px] text-sidebar-foreground/20">
                        Music Organizer v0.1
                    </p>
                    <p className="text-[11px] text-sidebar-foreground/15">by mwrty</p>
                </div>
            </div>
            <LegendModal open={legendOpen} onOpenChange={setLegendOpen} />
            <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
        </aside>
    );
}
