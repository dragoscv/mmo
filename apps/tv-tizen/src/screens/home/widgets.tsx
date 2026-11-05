/**
 * Shared UI bits for the WP16 media screens: hero text block (logo / title, chips, overview), QR block,
 * title-card renderers, and the poster FLIP ("shared element") between a card and the Title page.
 */
import { useEffect, useRef, type ReactNode } from "react";
import QRCode from "qrcode";
import type { TitleCard } from "../../lib/media-types";
import type { MediaClient } from "../../lib/media";
import { remPx } from "../../lib/image";
import { motionReduced } from "../../lib/prefs";
import { t } from "../../i18n/messages";
import { CARD_REM, PosterCard, type CardBadge } from "../../ui";
import { cardKey, yearOf } from "./media-ui";
import "./home.css";

export function HeroText({ logo, name, chips, overview, extra }: {
    logo: string | null; name: string; chips: string[]; overview?: string | null; extra?: ReactNode;
}) {
    return (
        <>
            {logo ? <img className="wh-logo" src={logo} alt={name} data-testid="hero-logo" /> : <h1 className="wh-name" data-testid="hero-name">{name}</h1>}
            {chips.length > 0 && (
                <div className="wh-chips">
                    {chips.map((c, i) => (
                        <span key={`${c}-${i}`} className={/^(4K|HD|DV|HDR)$/.test(c) ? "wh-chip wh-chip-tech" : i === 0 ? "" : "wh-chip"}>{c}</span>
                    ))}
                </div>
            )}
            {extra}
            {overview && <p className="wh-overview">{overview}</p>}
        </>
    );
}

/** QR of a URL (provider / trailer fallback when no app can open it). */
export function QrBlock({ url, caption }: { url: string; caption: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        if (ref.current) QRCode.toCanvas(ref.current, url, { width: Math.round(remPx(11)), margin: 1 }).catch(() => undefined);
    }, [url]);
    return (
        <div className="wt-section" data-testid="launch-qr">
            <div className="wt-qr"><canvas ref={ref} /></div>
            <div className="wh-status" style={{ textAlign: "center" }}>{caption}</div>
        </div>
    );
}

export function cardSubtitle(c: TitleCard): string {
    return [yearOf(c.releaseDate), c.voteAverage ? `★ ${c.voteAverage.toFixed(1)}` : null].filter(Boolean).join(" · ");
}

export function cardBadges(c: TitleCard): CardBadge[] | undefined {
    return c.inLibrary ? [{ label: t("wh.onServer"), icon: "server", tone: "neutral" }] : undefined;
}

/** Poster card for a TitleCard; remembers its rect for the FLIP before opening. */
export function TitlePoster({ c, media, prefix, onOpen, onFocus, titled }: {
    c: TitleCard; media: MediaClient; prefix: string; onOpen: (c: TitleCard) => void; onFocus?: () => void; titled?: boolean;
}) {
    const key = `${prefix}:${cardKey(c)}`;
    return (
        <PosterCard focusKey={key} title={c.title} subtitle={cardSubtitle(c)} badges={cardBadges(c)}
            image={media.imageFor(c.posterPath, remPx(CARD_REM.poster))} progress={c.progress ?? null}
            alwaysShowTitle={titled} placeholderIcon={c.kind === "tv" ? "tv" : "movie"} testId="media-card"
            onFocus={onFocus} onSelect={() => { rememberFlipSource(key, media.imageFor(c.posterPath, remPx(CARD_REM.poster))); onOpen(c); }} />
    );
}

// ─── FLIP ─────────────────────────────────────────────────────────────────

interface FlipSource { rect: DOMRect; url: string; at: number }
let flipSource: FlipSource | null = null;

/** Store the focused card's poster rect right before `nav.push({name:"title"})`. */
export function rememberFlipSource(focusKey: string, url: string | null): void {
    flipSource = null;
    if (!url) return;
    let el: HTMLElement | null = null;
    try { el = document.querySelector<HTMLElement>(`[data-focus-key="${focusKey.replace(/"/g, '\\"')}"] .mcard-frame`); } catch { el = null; }
    if (!el) return;
    flipSource = { rect: el.getBoundingClientRect(), url, at: Date.now() };
}

export const FLIP_MS = 280;

/**
 * Animates a fixed clone from the remembered card rect to `target` (the Title poster), hiding the target while it
 * runs. Uses `document.startViewTransition` when the engine has it, else a transform/opacity FLIP. No-op when
 * motion is reduced or no source is fresh (< 1.5 s).
 */
export function playFlip(target: HTMLElement | null, onDone?: () => void): void {
    const src = flipSource;
    flipSource = null;
    if (!target || !src || Date.now() - src.at > 1500 || motionReduced()) { onDone?.(); return; }
    const to = target.getBoundingClientRect();
    if (to.width <= 0 || src.rect.width <= 0) { onDone?.(); return; }
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (typeof doc.startViewTransition === "function") {
        // The DOM is already updated (keep-alive push) → a cross-fade/morph of the snapshot is all we can get.
        try { doc.startViewTransition(() => undefined); } catch { /* ignore */ }
    }
    const clone = document.createElement("div");
    clone.className = "wt-flip";
    clone.style.width = `${to.width}px`;
    clone.style.height = `${to.height}px`;
    const img = document.createElement("img");
    img.src = src.url;
    img.alt = "";
    clone.appendChild(img);
    const sx = src.rect.width / to.width;
    const sy = src.rect.height / to.height;
    clone.style.transform = `translate(${src.rect.left}px, ${src.rect.top}px) scale(${sx}, ${sy})`;
    clone.style.opacity = "1";
    document.body.appendChild(clone);
    target.classList.add("is-hidden");
    // Force style flush, then transition to the target position.
    void clone.offsetWidth;
    clone.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity ${FLIP_MS}ms ease-out`;
    clone.style.transform = `translate(${to.left}px, ${to.top}px) scale(1, 1)`;
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        target.classList.remove("is-hidden");
        clone.style.opacity = "0";
        setTimeout(() => clone.remove(), 120);
        onDone?.();
    };
    clone.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, FLIP_MS + 80);
}
