"use client";

/**
 * Media shell (WP16-37): sticky glass top bar with the section nav (Home, Search, Movies, TV shows,
 * Music, Live TV, My list), hub status + profile menu, and the profile gate in front of every page.
 * Keyboard: the nav is a roving-tabindex toolbar (←/→, Home/End); `/` focuses Search.
 */
import Link, { usePathname, useRouter } from "@/components/host/host-context";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { BarChart3, Clapperboard, Download, Film, Grid3x3, Heart, Home, Library, Music2, Radio, Search, Tv } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";
import { useMmo } from "./mmo-provider";
import { ProfileGate } from "./profile-gate";
import { ProfileMenu } from "./profile-menu";
import { MusicMiniPlayer } from "./music/mini-player";
import { useHost } from "@/components/host/host-context";

export const MEDIA_NAV = [
    { key: "home", href: "/media", icon: Home, exact: true },
    { key: "search", href: "/media/search", icon: Search },
    { key: "movies", href: "/media/browse/movie", icon: Film },
    { key: "shows", href: "/media/browse/tv", icon: Tv },
    { key: "music", href: "/media/music", icon: Music2 },
    { key: "live", href: "/media/live", icon: Radio },
    { key: "list", href: "/media/list", icon: Heart },
    { key: "collections", href: "/media/collections", icon: Library },
    { key: "stats", href: "/media/stats", icon: BarChart3 },
    { key: "downloads", href: "/media/downloads", icon: Download },
] as const;

export function isActive(pathname: string, href: string, exact = false): boolean {
    if (exact) return pathname === href;
    return pathname === href || pathname.startsWith(href + "/");
}

export function MediaShell({ children, loginHref = null }: { children: ReactNode; loginHref?: string | null }) {
    const t = useTranslations("mx.shell");
    const { server, clients, signedIn } = useMmo();
    const pathname = usePathname() ?? "/media";
    const router = useRouter();
    const navRef = useRef<HTMLElement>(null);
    const { kind, root } = useHost();
    // On product hosts the TV shell is the whole app: give it a way back to the suite launcher.
    const standalone = kind !== "legacy" && kind !== "studio";
    // The guest join page and the full-screen player have their own chrome.
    const bare = pathname.startsWith("/media/together") || pathname.startsWith("/media/play/") || pathname.startsWith("/media/live/play");

    useEffect(() => {
        const onKey = (e: globalThis.KeyboardEvent) => {
            if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
            const el = e.target as HTMLElement | null;
            if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
            e.preventDefault();
            router.push("/media/search");
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [router]);

    const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
        const links = Array.from(navRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-mx-nav]") ?? []);
        const i = links.indexOf(document.activeElement as HTMLAnchorElement);
        if (i < 0) return;
        let n = -1;
        if (e.key === "ArrowRight") n = (i + 1) % links.length;
        else if (e.key === "ArrowLeft") n = (i - 1 + links.length) % links.length;
        else if (e.key === "Home") n = 0;
        else if (e.key === "End") n = links.length - 1;
        if (n >= 0) { e.preventDefault(); links[n]?.focus(); }
    };

    if (!server || !clients) {
        if (pathname.startsWith("/media/together")) return <>{children}</>;
        return (
            <div className="mx-shell">
                <EmptyState
                    icon={<Clapperboard aria-hidden />}
                    title={signedIn ? t("noServer.title") : t("noServer.guestTitle")}
                    description={signedIn ? t("noServer.body") : t("noServer.guestBody")}
                    actions={
                        <div className="flex flex-wrap justify-center gap-2">
                            <Button render={<Link href="/connect" />} data-testid="noserver-connect">{t("noServer.connect")}</Button>
                            <Button variant="secondary" render={<Link href="/connect?demo=1" />}>{t("noServer.demo")}</Button>
                            {loginHref ? <Button variant="outline" render={<a href={loginHref} />}>{t("noServer.signIn")}</Button> : null}
                        </div>
                    }
                />
            </div>
        );
    }

    if (bare) return <ProfileGate>{children}</ProfileGate>;

    return (
        <div className="mx-shell">
            <header className="mx-topbar">
                <Link href="/media" className="mx-brand" aria-label={t("nav.label")}>
                    <Clapperboard aria-hidden className="size-5" />
                    <span>{t("nav.label")}</span>
                </Link>
                <nav ref={navRef} aria-label={t("nav.label")} className="mx-nav" onKeyDown={onNavKey}>
                    {MEDIA_NAV.map((n) => {
                        const active = isActive(pathname, n.href, "exact" in n ? n.exact : false);
                        const Icon = n.icon;
                        return (
                            <Link key={n.key} href={n.href} data-mx-nav aria-current={active ? "page" : undefined} className="mx-nav-link">
                                <Icon aria-hidden className="size-4" />
                                <span>{t(`nav.${n.key}`)}</span>
                            </Link>
                        );
                    })}
                </nav>
                <ProfileMenu />
                {standalone ? (
                    <a href={`https://${root}/`} className="mx-apps" aria-label={t("apps")} title={t("apps")}>
                        <Grid3x3 aria-hidden className="size-5" />
                    </a>
                ) : null}
            </header>
            <ProfileGate>
                <main className="mx-main">{children}</main>
            </ProfileGate>
            <MusicMiniPlayer />
        </div>
    );
}
