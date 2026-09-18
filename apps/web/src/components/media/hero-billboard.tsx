"use client";

/**
 * HeroBillboard (WP11-03): rotates through the top hero candidates every
 * 12 s with a cross-fade (motion v13; reduced motion → instant swap, no
 * auto-rotate). Backdrop `w1280`, TMDB logo treatment when the server
 * returned one, else the title as text. Artwork accent: when the theme
 * accent is `artwork`, the backdrop's dominant hue drives `--accent-h`.
 */
import Image from "next/image";
import Link from "next/link";
import { Info, ListPlus, Play, Tv } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, dominantHueFromImage, usePrefersReducedMotion, useThemePrefs } from "@mmo/ui";
import { fade, slow } from "@mmo/ui/motion";
import { tmdbImg } from "@/lib/media/normalize";
import type { MergedTitle } from "@/lib/media/types";
import { titleHref } from "./media-card";

const ROTATE_MS = 12_000;

function useArtworkAccent(src: string | null) {
    const { prefs, setArtworkHue } = useThemePrefs();
    const active = prefs.accent === "artwork";
    useEffect(() => {
        if (!active) return;
        if (!src) { setArtworkHue(null); return; }
        let cancelled = false;
        const timer = window.setTimeout(() => {
            void dominantHueFromImage(src).then((hue) => { if (!cancelled && hue !== null) setArtworkHue(hue); });
        }, 150);
        return () => { cancelled = true; window.clearTimeout(timer); };
    }, [active, src, setArtworkHue]);
}

export interface HeroBillboardProps {
    items: MergedTitle[];
    /** Genre id → name (from the server's `/media/home`, when available). */
    genreNames?: Record<number, string>;
}

export function HeroBillboard({ items, genreNames = {} }: HeroBillboardProps) {
    const t = useTranslations("home.hero");
    const reduced = usePrefersReducedMotion();
    const [index, setIndex] = useState(0);
    const count = items.length;

    useEffect(() => {
        if (reduced || count < 2) return;
        const id = window.setInterval(() => setIndex((i) => (i + 1) % count), ROTATE_MS);
        return () => window.clearInterval(id);
    }, [reduced, count]);

    const item = items[Math.min(index, Math.max(0, count - 1))];
    const backdrop = tmdbImg(item?.backdrop, "w1280");
    useArtworkAccent(backdrop);
    if (!item) return null;

    const logo = tmdbImg(item.logo, "w500");
    const href = titleHref(item);
    const primaryServer = item.sources[0]?.serverName;
    const genres = (item.genreIds ?? []).map((g) => genreNames[g]).filter(Boolean).slice(0, 3);
    const meta = [item.year, item.rating ? `★ ${item.rating.toFixed(1)}` : null, ...genres].filter(Boolean);

    return (
        <section className="media-hero" data-slot="hero-billboard" aria-roledescription="carousel" aria-label={t("label")}>
            <AnimatePresence mode="sync" initial={false}>
                <motion.div
                    key={`${item.kind}:${item.tmdbId}`}
                    className="absolute inset-0"
                    variants={fade}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    transition={reduced ? { duration: 0 } : slow()}
                >
                    {backdrop ? (
                        <Image src={backdrop} alt="" fill priority sizes="(max-width: 1600px) 100vw, 1600px" className="media-hero-bg" />
                    ) : null}
                    <div className="media-hero-scrim" aria-hidden />
                </motion.div>
            </AnimatePresence>

            <div className="media-hero-content">
                {logo ? (
                    // Title treatment: intrinsic aspect ratio, so plain <img> is fine.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo} alt={item.title} className="media-hero-logo" />
                ) : (
                    <h1 className="media-hero-title">{item.title}</h1>
                )}
                {logo ? <h1 className="sr-only">{item.title}</h1> : null}
                {meta.length ? (
                    <div className="media-hero-meta">
                        {meta.map((m, i) => <span key={i}>{i > 0 ? "· " : ""}{m}</span>)}
                    </div>
                ) : null}
                {item.overview ? <p className="media-hero-overview">{item.overview}</p> : null}
                <div className="media-hero-actions">
                    {item.sources.length > 0 ? (
                        <Button size="lg" render={<Link href={href} />}>
                            <Play aria-hidden fill="currentColor" /> {t("playOn", { server: primaryServer ?? "" })}
                        </Button>
                    ) : (
                        <Button size="lg" render={<Link href={href} />}>
                            <Tv aria-hidden /> {t("whereToWatch")}
                        </Button>
                    )}
                    <Button size="lg" variant="secondary" render={<Link href={`${href}#actions`} />}>
                        <ListPlus aria-hidden /> {t("watchlist")}
                    </Button>
                    <Button size="lg" variant="ghost" render={<Link href={href} />}>
                        <Info aria-hidden /> {t("details")}
                    </Button>
                </div>
            </div>

            {count > 1 ? (
                <div className="media-hero-dots" role="tablist" aria-label={t("pick")}>
                    {items.map((it, i) => (
                        <button
                            key={`${it.kind}:${it.tmdbId}`}
                            type="button"
                            role="tab"
                            className="media-hero-dot"
                            aria-current={i === index}
                            aria-selected={i === index}
                            aria-label={it.title}
                            onClick={() => setIndex(i)}
                        />
                    ))}
                </div>
            ) : null}
        </section>
    );
}
