import { useCallback, useRef } from "react";

interface FaderProps {
    value: number;
    min?: number;
    max?: number;
    height?: number;
    color?: string;
    onChange: (v: number) => void;
}

/** Vertical channel fader. Drag the cap; double-click resets to max. */
export function Fader({
    value,
    min = 0,
    max = 1,
    height = 160,
    color = "var(--accent)",
    onChange,
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

    return (
        <div
            ref={trackRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onDoubleClick={() => onChange(max)}
            style={{
                position: "relative",
                width: 36,
                height,
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
