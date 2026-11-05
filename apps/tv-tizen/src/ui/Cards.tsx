/**
 * Media cards (focus: scale 1.06 + ring + glow from tokens; title appears under on focus).
 *   <PosterCard>    2:3 portrait (movies, shows, albums with `square`)
 *   <LandscapeCard> 16:9 (continue watching, episodes, channels)
 * Width comes from CSS vars `--poster-w` / `--landscape-w` (rem; see ui.css) so `Row` can virtualise by a known
 * card width. Image URL: pass `image` (already sized) or `imagePath` + `media` to pick the TMDB size by width.
 */
import { memo, type ReactNode } from "react";
import { isLoaded, markLoaded } from "../lib/image";
import { Icon, type IconName } from "./icons";

export interface CardBadge {
    label: string;
    icon?: IconName;
    tone?: "primary" | "neutral" | "warning" | "destructive" | "success";
}

export interface BaseCardProps {
    /** Stable key for focus restoration (`data-focus-key`). Required. */
    focusKey: string;
    title: string;
    subtitle?: string;
    /** Final image URL (already sized). */
    image?: string | null;
    /** 0..1 progress bar. */
    progress?: number | null;
    badges?: CardBadge[];
    /** Placeholder icon when there is no image. */
    placeholderIcon?: IconName;
    onSelect?: () => void;
    /** Fires when the card receives focus (backdrop / preload). */
    onFocus?: () => void;
    /** Always show the title under the card (default: only on focus). */
    alwaysShowTitle?: boolean;
    /** Extra content over the art (top-right corner). */
    overlay?: ReactNode;
    className?: string;
    testId?: string;
}

function Art({ image, placeholderIcon, alt }: { image?: string | null; placeholderIcon: IconName; alt: string }) {
    if (!image) return <div className="card-art card-art-ph"><Icon name={placeholderIcon} size="2.2rem" /></div>;
    const warm = isLoaded(image);
    return (
        <img className={`card-art${warm ? " loaded" : ""}`} src={image} alt={alt} loading="lazy" decoding="async"
            onLoad={(e) => { markLoaded(image); e.currentTarget.classList.add("loaded"); }} />
    );
}

function CardBody(p: BaseCardProps & { shape: "poster" | "landscape" | "square" }) {
    return (
        <button
            type="button"
            className={`mcard mcard-${p.shape}${p.alwaysShowTitle ? " mcard-titled" : ""}${p.className ? ` ${p.className}` : ""}`}
            data-focusable=""
            data-focus-key={p.focusKey}
            data-testid={p.testId}
            aria-label={p.subtitle ? `${p.title}, ${p.subtitle}` : p.title}
            onClick={p.onSelect}
            onFocus={p.onFocus}
        >
            <span className="mcard-frame">
                <Art image={p.image} placeholderIcon={p.placeholderIcon ?? (p.shape === "landscape" ? "tv" : "movie")} alt="" />
                {p.badges && p.badges.length > 0 && (
                    <span className="mcard-badges">
                        {p.badges.map((b, i) => (
                            <span key={i} className={`badge badge-${b.tone ?? "primary"}`}>
                                {b.icon && <Icon name={b.icon} />}{b.label}
                            </span>
                        ))}
                    </span>
                )}
                {p.overlay && <span className="mcard-overlay">{p.overlay}</span>}
                {p.progress != null && p.progress > 0 && (
                    <span className="mcard-progress"><span style={{ transform: `scaleX(${Math.min(1, Math.max(0, p.progress))})` }} /></span>
                )}
            </span>
            <span className="mcard-meta">
                <span className="mcard-title">{p.title}</span>
                {p.subtitle && <span className="mcard-sub">{p.subtitle}</span>}
            </span>
        </button>
    );
}

export const PosterCard = memo(function PosterCard(p: BaseCardProps & { square?: boolean }) {
    return <CardBody {...p} shape={p.square ? "square" : "poster"} />;
});

export const LandscapeCard = memo(function LandscapeCard(p: BaseCardProps) {
    return <CardBody {...p} shape="landscape" />;
});

/** Card widths in rem (must match ui.css `--poster-w` etc.). Used by Row/Grid virtualisation + image sizing. */
export const CARD_REM = { poster: 9.5, square: 9.5, landscape: 15, gap: 1 } as const;
