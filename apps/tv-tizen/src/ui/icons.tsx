/**
 * Inline SVG icon set (24×24, stroke = currentColor; paths after lucide, ISC). No emoji as UI icons.
 * `<IconSprite/>` is mounted once by the App (a hidden <svg> of <symbol>s); `<Icon name="play"/>` references it
 * with <use>, so each icon costs one tiny node. Size via CSS `font-size` (icons are 1em) or `size` prop.
 */
import type { CSSProperties } from "react";

const PATHS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    movie: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    tv: '<rect x="2" y="5" width="20" height="13" rx="2"/><path d="m8 2 4 3 4-3M8 21h8"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    livetv: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="m17 2-5 5-5-5"/><circle cx="12" cy="14" r="2.5" fill="currentColor"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>',
    back10: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif" font-weight="700">10</text>',
    fwd10: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/><text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif" font-weight="700">10</text>',
    subtitles: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 13h4M14 13h4M6 16h8M16 16h2"/>',
    audio: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
    speed: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
    aspect: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9v-.5h3M18 15v.5h-3"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-5M12 8h.01"/>',
    next: '<path d="M5 4l10 8-10 8z" fill="currentColor"/><path d="M19 5v14"/>',
    prev: '<path d="M19 20 9 12l10-8z" fill="currentColor"/><path d="M5 19V5"/>',
    shuffle: '<path d="M2 18h1.4a4 4 0 0 0 3.3-1.8l6.6-9.4A4 4 0 0 1 16.6 5H22"/><path d="m18 2 4 3-4 3"/><path d="M2 6h1.9a4 4 0 0 1 3.2 1.6"/><path d="M22 18h-5.5a4 4 0 0 1-3.2-1.6"/><path d="m18 14 4 4-4 4"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    repeatOne: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    kids: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
    group: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5" fill="currentColor"/>',
    guide: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M7 13h4M7 17h7M14 13h3"/>',
    queue: '<path d="M3 6h13M3 12h13M3 18h8"/><path d="m16 15 5 3-5 3z" fill="currentColor"/>',
    lyrics: '<path d="M4 6h16M4 10h10M4 14h16M4 18h7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    star: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z" fill="currentColor"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>',
    backspace: '<path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><path d="m18 9-6 6M12 9l6 6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** Hidden sprite with one <symbol id="i-<name>"> per icon. Mount once near the root. */
export function IconSprite() {
    const html = ICON_NAMES.map((n) => `<symbol id="i-${n}" viewBox="0 0 24 24">${PATHS[n]}</symbol>`).join("");
    return (
        <svg width="0" height="0" aria-hidden="true" focusable="false"
            style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
            dangerouslySetInnerHTML={{ __html: html }} />
    );
}

export interface IconProps {
    name: IconName;
    /** CSS size (default `1em`). */
    size?: string | number;
    className?: string;
    /** Accessible label; omit for decorative icons (default aria-hidden). */
    label?: string;
    style?: CSSProperties;
}

export function Icon({ name, size, className, label, style }: IconProps) {
    const s = size === undefined ? "1em" : typeof size === "number" ? `${size}px` : size;
    return (
        <svg className={className ? `icon ${className}` : "icon"} width={s} height={s} viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
            role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false" style={style}>
            <use href={`#i-${name}`} />
        </svg>
    );
}
