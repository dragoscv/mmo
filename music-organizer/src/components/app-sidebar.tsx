"use client";

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
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/library", label: "Library", icon: Library },
    { href: "/playlists", label: "Playlists", icon: ListMusic },
    { href: "/scanner", label: "Scanner", icon: ScanSearch },
    { href: "/drives", label: "Drives", icon: HardDrive },
    { href: "/settings", label: "Settings", icon: Settings },
];

export function AppSidebar() {
    const pathname = usePathname();

    return (
        <aside className="flex h-screen w-56 flex-col border-r border-[var(--border)] bg-[var(--card)]">
            <div className="flex items-center gap-2 border-b border-[var(--border)] p-4">
                <Music className="h-6 w-6 text-[var(--primary)]" />
                <span className="text-lg font-bold">Music Organizer</span>
            </div>

            <nav className="flex-1 space-y-1 p-2">
                {navItems.map((item) => {
                    const isActive =
                        pathname === item.href ||
                        (item.href !== "/" && pathname.startsWith(item.href));
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                                isActive
                                    ? "bg-[var(--primary)]/15 text-[var(--primary)]"
                                    : "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                            )}
                        >
                            <item.icon className="h-4 w-4" />
                            {item.label}
                        </Link>
                    );
                })}
            </nav>

            <div className="border-t border-[var(--border)] p-4">
                <p className="text-xs text-[var(--muted-foreground)]">
                    Music Organizer v0.1
                </p>
                <p className="text-xs text-[var(--muted-foreground)]">by mwrty</p>
            </div>
        </aside>
    );
}
