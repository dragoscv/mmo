"use client";

import { useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { BottomTabBar, type BottomTabItem } from "@mmo/ui";
import { useSidebar } from "@/components/sidebar-context";
import { useFocusMode } from "@/components/focus-mode-context";
import { useRouteMemoryHrefs } from "@/hooks/use-route-memory";
import { shellTabs, isTabActive, currentNavLabel } from "./nav-items";

/**
 * Mobile bottom tab bar (hidden on `md+` by BottomTabBar itself). The "More"
 * slot opens the mobile sidebar drawer instead of the built-in sheet.
 */
export function BottomNav() {
    const pathname = usePathname();
    const t = useTranslations("nav");
    const { openMobile } = useSidebar();
    const { isFocusMode } = useFocusMode();
    const savedHrefs = useRouteMemoryHrefs();

    const items = useMemo<BottomTabItem[]>(() => {
        const anyActive = shellTabs.some((tab) => isTabActive(tab, pathname));
        const inNav = currentNavLabel(pathname) !== null;
        return shellTabs.map((tab) => {
            const label = t.has(tab.key) ? t(tab.key) : tab.label;
            if (tab.more) {
                return {
                    id: tab.id,
                    label,
                    icon: <tab.icon aria-hidden />,
                    // Highlight "More" when the route lives in the nav tree but not on a tab (e.g. /settings).
                    active: !anyActive && inNav,
                    onSelect: openMobile,
                };
            }
            const href = savedHrefs[tab.href!] || tab.href!;
            return {
                id: tab.id,
                label,
                href,
                icon: <tab.icon aria-hidden />,
                active: isTabActive(tab, pathname),
                render: <Link href={href} />,
            };
        });
    }, [pathname, t, openMobile, savedHrefs]);

    if (isFocusMode) return null;

    return <BottomTabBar items={items} layoutId="app-bottom-nav" className="[body.daw-focus-mode_&]:hidden" />;
}
