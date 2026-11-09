import { useCallback, useRef } from "react";

interface FaderProps {
    value: number;
    min?: number;
    max?: number;
    /** CSS length; "100%" lets the fader fill a sized grid/flex cell. */
    height?: number | string;
    width?: number | string;
    color?: string;
    onChange: (v: number) => void;
    /** Accessible name. */
    ariaLabel?: string;
}

/** Vertical channel fader. Drag the cap; double-click resets to max.
 *  Keyboard: arrows 1 % (Shift 0.25 %), PageUp/PageDown 10 %, Home/End. */
export function Fader({
    value,
    min = 0,
    max = 1,
    height = 160,
    width = 36,
    color = "var(--accent)",
    onChange,
    ariaLabel,
}: FaderProps) {
    const trackRef = useRef<HTMLDivElement>(null);

    const update = useCallback(
        (clientY: number) => {
            const el = trackRef.current;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const pct = 1 - clamp((clientY - rect.top) / rect.height, 0, 1);
            onChange(min + pct * (max - min));
        },
        [min, max, onChange],
    );

    const onPointerDown = useCallback(
        (e: React.PointerEvent) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            update(e.clientY);
        },
        [update],
    );

    const onPointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (!(e.target as Element).hasPointerCapture?.(e.pointerId)) return;
            update(e.clientY);
        },
        [update],
    );

    const pct = (value - min) / (max - min);

    const onKeyDown = (e: React.KeyboardEvent) => {
        const range = max - min;
        const step = e.shiftKey ? range / 400 : range / 100;
        const next =
            e.key === "ArrowUp" || e.key === "ArrowRight" ? value + step
            : e.key === "ArrowDown" || e.key === "ArrowLeft" ? value - step
            : e.key === "PageUp" ? value + range / 10
            : e.key === "PageDown" ? value - range / 10
            : e.key === "Home" ? min
            : e.key === "End" ? max
            : null;
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        onChange(clamp(next, min, max));
    };

    return (
        <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label={ariaLabel}
            aria-orientation="vertical"
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={Number(value.toFixed(3))}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onDoubleClick={() => onChange(max)}
            style={{
                position: "relative",
                width,
                height,
                minHeight: 48,
                minWidth: 18,
                background: "var(--bg-elev-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                cursor: "ns-resize",
                touchAction: "none",
            }}
        >
            {/* Fill */}
            <div
                style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: `${pct * 100}%`,
                    background: `linear-gradient(180deg, ${color}, transparent)`,
                    opacity: 0.35,
                    borderRadius: 8,
                }}
            />
            {/* Cap */}
            <div
                style={{
                    position: "absolute",
                    left: -3,
                    right: -3,
                    height: 18,
                    bottom: `calc(${pct * 100}% - 9px)`,
                    background: color,
                    borderRadius: 5,
                    boxShadow: "var(--glow) " + color,
                }}
            />
        </div>
    );
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}
