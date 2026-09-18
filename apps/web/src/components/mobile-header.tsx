"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search, Menu } from "lucide-react";
import { useSidebar } from "./sidebar-context";
import { GlobalSearch } from "./global-search";
import { PwaInstallButton } from "./pwa-install-button";
import { currentNavLabel } from "./shell/nav-items";

export function MobileHeader() {
    const { openMobile } = useSidebar();
    const [searchOpen, setSearchOpen] = useState(false);
    const pathname = usePathname();
    const t = useTranslations("nav");
    const current = currentNavLabel(pathname);
    const title = current ? (t.has(current.key) ? t(current.key) : current.label) : "MixAI";

    return (
        <>
            <header
                data-slot="mobile-header"
                className="surface sticky top-0 z-(--z-sticky) flex h-14 items-center gap-2 rounded-none border-x-0 border-t-0 px-2 pt-[var(--safe-top)] md:hidden"
            >
                <button
                    type="button"
                    onClick={openMobile}
                    className="flex size-control-sm shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
                    aria-label={t("openMenu")}
                >
                    <Menu className="size-5" aria-hidden />
                </button>

                <h1 className="min-w-0 flex-1 truncate font-heading text-base font-semibold tracking-tight">{title}</h1>

                <button
                    type="button"
                    onClick={() => setSearchOpen(true)}
                    className="flex size-control-sm shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--dur-fast) hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
                    aria-label={t("searchPlaceholder")}
                    title={t("searchPlaceholder")}
                >
                    <Search className="size-4.5" aria-hidden />
                </button>

                <PwaInstallButton />
            </header>
            <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
        </>
    );
}
