"use client";

/**
 * Scrub bar: role="slider" with pointer drag, hover preview (time + scrubber sprite tile when the server has
 * built it) and keyboard (←/→ ±10 s, Home/End, PageUp/PageDown ±60 s). Values are ABSOLUTE media seconds.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslations } from "next-intl";
import { formatTime, spriteGrid, spriteTile, tilePosition } from "./model";

export interface ScrubBarProps {
    time: number;
    duration: number;
    buffered: number;
    /** Sprite URL once loaded, else null (preview shows the time only). */
    spriteSrc: string | null;
    /** First hover/drag asks the parent to load the sprite. */
    onWantSprite(): void;
    onSeek(sec: number): void;
    /** Chapter-ish marks (intro end, credits) as absolute seconds. */
    marks?: number[];
    disabled?: boolean;
}

export function ScrubBar({ time, duration, buffered, spriteSrc, onWantSprite, onSeek, marks = [], disabled }: ScrubBarProps) {
    const t = useTranslations("mx.player.osd");
    const ref = useRef<HTMLDivElement>(null);
    const [hover, setHover] = useState<{ x: number; sec: number } | null>(null);
    const [drag, setDrag] = useState<number | null>(null);
    const total = duration > 0 ? duration : 0;
    const shown = drag ?? time;
    const pct = (s: number) => (total > 0 ? Math.max(0, Math.min(100, (s / total) * 100)) : 0);
    const grid = spriteGrid(total);

    const secAt = (clientX: number): { x: number; sec: number } | null => {
        const r = ref.current?.getBoundingClientRect();
        if (!r || r.width <= 0 || total <= 0) return null;
        const x = Math.max(0, Math.min(r.width, clientX - r.left));
        return { x, sec: (x / r.width) * total };
    };

    const onMove = (e: PointerEvent<HTMLDivElement>) => {
        const h = secAt(e.clientX);
        if (!h) return;
        setHover(h);
        onWantSprite();
        if (drag !== null) setDrag(h.sec);
    };
    const onDown = (e: PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        const h = secAt(e.clientX);
        if (!h) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(h.sec);
        setHover(h);
        onWantSprite();
    };
    const onUp = (e: PointerEvent<HTMLDivElement>) => {
        if (drag === null) return;
        const h = secAt(e.clientX);
        const target = h?.sec ?? drag;
        setDrag(null);
        if (e.pointerType !== "mouse") setHover(null);
        onSeek(target);
    };
    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled || total <= 0) return;
        const step = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -10 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 10
            : e.key === "PageDown" ? -60 : e.key === "PageUp" ? 60 : 0;
        if (step !== 0) { e.preventDefault(); e.stopPropagation(); onSeek(Math.max(0, Math.min(total - 1, time + step))); return; }
        if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); onSeek(0); }
        if (e.key === "End") { e.preventDefault(); e.stopPropagation(); onSeek(Math.max(0, total - 5)); }
    };

    const preview = hover ?? (drag !== null ? { x: 0, sec: drag } : null);
    const tile = preview && grid && spriteSrc ? spriteTile(grid, preview.sec) : null;

    return (
        <div className="mxp-scrub-wrap">
            <div
                ref={ref}
                className="mxp-scrub"
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-label={t("seek")}
                aria-valuemin={0}
                aria-valuemax={Math.round(total)}
                aria-valuenow={Math.round(shown)}
                aria-valuetext={t("timeOf", { current: formatTime(shown), total: formatTime(total) })}
                aria-disabled={disabled || undefined}
                data-dragging={drag !== null || undefined}
                onPointerMove={onMove}
                onPointerDown={onDown}
                onPointerUp={onUp}
                onPointerCancel={() => { setDrag(null); setHover(null); }}
                onPointerLeave={() => { if (drag === null) setHover(null); }}
                onKeyDown={onKey}
            >
                <div className="mxp-scrub-track">
                    <div className="mxp-scrub-buffered" style={{ width: `${pct(buffered)}%` }} />
                    <div className="mxp-scrub-played" style={{ width: `${pct(shown)}%` }} />
                    {marks.filter((m) => m > 0 && m < total).map((m) => (
                        <span key={m} className="mxp-scrub-mark" style={{ left: `${pct(m)}%` }} aria-hidden />
                    ))}
                </div>
                <div className="mxp-scrub-thumb" style={{ left: `${pct(shown)}%` }} aria-hidden />
                {preview && total > 0 && (
                    <div className="mxp-scrub-preview" style={{ left: `clamp(5rem, ${pct(preview.sec)}%, calc(100% - 5rem))` }} aria-hidden>
                        {tile !== null && spriteSrc && (
                            <div className="mxp-scrub-tile" style={{ backgroundImage: `url("${spriteSrc}")`, backgroundPosition: tilePosition(tile) }} />
                        )}
                        <span className="mxp-scrub-time">{formatTime(preview.sec)}</span>
                    </div>
                )}
            </div>
        </div>
    );
}
