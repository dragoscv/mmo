"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { signOutAndPurge } from "@/lib/auth-client";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { LoginModal } from "@/components/login-modal";
import { LogIn, LogOut, User, ChevronUp } from "lucide-react";

interface UserCardProps {
    collapsed?: boolean;
}

export function UserCard({ collapsed }: UserCardProps) {
    const { data: session, status } = useSession();
    const [loginOpen, setLoginOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);

    // Loading state
    if (status === "loading") {
        return (
            <div className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-2",
                collapsed && "justify-center"
            )}>
                <div className="h-7 w-7 shrink-0 rounded-full bg-muted animate-pulse" />
                {!collapsed && <div className="h-3 w-20 rounded bg-muted animate-pulse" />}
            </div>
        );
    }

    // Not authenticated - show sign in button
    if (!session?.user) {
        return (
            <>
                <button
                    onClick={() => setLoginOpen(true)}
                    className={cn(
                        "flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-sidebar-foreground/40 hover:bg-sidebar-accent hover:text-sidebar-foreground/70 transition-all duration-200 w-full cursor-pointer",
                        collapsed && "justify-center px-2"
                    )}
                    title={collapsed ? "Sign In" : undefined}
                >
                    <LogIn className="h-4 w-4 shrink-0" />
                    {!collapsed && "Sign In"}
                </button>
                <LoginModal open={loginOpen} onOpenChange={setLoginOpen} />
            </>
        );
    }

    // Authenticated user
    const initials = session.user.name
        ?.split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2) || "U";

    return (
        <div className="relative">
            <button
                onClick={() => setMenuOpen(!menuOpen)}
                className={cn(
                    "flex items-center gap-2.5 rounded-xl px-2 py-2 w-full hover:bg-sidebar-accent transition-all duration-200 cursor-pointer",
                    collapsed && "justify-center"
                )}
                title={collapsed ? session.user.name || "Profile" : undefined}
            >
                {session.user.image ? (
                    // eslint-disable-next-line @next/next/no-img-element -- dynamic blob/data/remote artwork; next/image cannot optimise unknown remotes
                    <img
                        src={session.user.image}
                        alt={session.user.name || "User"}
                        className="h-7 w-7 shrink-0 rounded-full ring-1 ring-sidebar-border"
                        referrerPolicy="no-referrer"
                    />
                ) : (
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-purple-500/20 text-[11px] font-semibold text-purple-300 ring-1 ring-sidebar-border">
                        {initials}
                    </div>
                )}
                {!collapsed && (
                    <>
                        <div className="flex-1 min-w-0 text-left">
                            <p className="text-[13px] font-medium text-sidebar-foreground/80 truncate leading-tight">
                                {session.user.name}
                            </p>
                            <p className="text-[11px] text-sidebar-foreground/30 truncate leading-tight">
                                {session.user.email}
                            </p>
                        </div>
                        <ChevronUp className={cn(
                            "h-3.5 w-3.5 shrink-0 text-sidebar-foreground/30 transition-transform duration-200",
                            menuOpen && "rotate-180"
                        )} />
                    </>
                )}
            </button>

            {/* Dropdown menu */}
            {menuOpen && (
                <>
                    {/* Backdrop */}
                    <div
                        className="fixed inset-0 z-40"
                        onClick={() => setMenuOpen(false)}
                    />
                    <div className={cn(
                        "absolute z-50 rounded-xl border border-sidebar-border bg-sidebar shadow-xl py-1 min-w-[180px]",
                        collapsed
                            ? "bottom-0 left-full ml-2"
                            : "bottom-full left-0 right-0 mb-1"
                    )}>
                        <Link
                            href="/profile"
                            onClick={() => setMenuOpen(false)}
                            className="flex items-center gap-2.5 px-3 py-2 text-sm text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
                        >
                            <User className="h-3.5 w-3.5" />
                            Profile
                        </Link>
                        <div className="h-px bg-sidebar-border mx-2 my-1" />
                        <button
                            onClick={() => {
                                setMenuOpen(false);
                                signOutAndPurge({ callbackUrl: "/" });
                            }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-red-400/70 hover:bg-red-500/10 hover:text-red-400 transition-colors cursor-pointer"
                        >
                            <LogOut className="h-3.5 w-3.5" />
                            Sign Out
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
