"use client";

import { useState } from "react";
import { Search, Menu } from "lucide-react";
import { useSidebar } from "./sidebar-context";
import { GlobalSearch } from "./global-search";
import { cn } from "@/lib/utils";

export function MobileHeader() {
    const { openMobile } = useSidebar();
    const [searchOpen, setSearchOpen] = useState(false);

    return (
        <>
            <header className="sticky top-0 z-40 flex items-center gap-3 px-3 py-2.5 bg-background/95 backdrop-blur-sm border-b border-border md:hidden">
                <button
                    onClick={openMobile}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer shrink-0"
                    aria-label="Open menu"
                >
                    <Menu className="h-4.5 w-4.5" />
                </button>

                {/* Search bar */}
                <button
                    onClick={() => setSearchOpen(true)}
                    className="flex-1 flex items-center gap-2 h-8 px-3 rounded-lg bg-muted/50 border border-border text-sm text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
                >
                    <Search className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Search tracks, artists...</span>
                </button>
            </header>
            <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
        </>
    );
}
