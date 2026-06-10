import { useCallback, useRef } from "react";

interface KnobProps {
    value: number;
    min: number;
    max: number;
    /** Value at the 12-o'clock detent (e.g. 0 for EQ, center for filter). */
    center?: number;
    label?: string;
    size?: number;
    color?: string;
    onChange: (v: number) => void;
    format?: (v: number) => string;
}

/**
 * Vertical-drag rotary knob. Drag up/down to change; double-click resets to
 * `center`. Renders an SVG arc indicator. Pointer-capture keeps it smooth.
 */
export function Knob({
    value,
    min,
    max,
    center,
    label,
    size = 54,
    color = "var(--accent)",
    onChange,
    format,
}: KnobProps) {
    const startY = useRef(0);
    const startVal = useRef(0);

    const onPointerDown = useCallback(
        (e: React.PointerEvent) => {
            (e.target as Element).setPointerCapture(e.pointerId);
            startY.current = e.clientY;
            startVal.current = value;
        },
        [value],
    );

    const onPointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (!(e.target as Element).hasPointerCapture?.(e.pointerId)) return;
            const dy = startY.current - e.clientY;
            const range = max - min;
            // Fine control with Shift.
            const sens = e.shiftKey ? 600 : 180;
            const next = clamp(startVal.current + (dy / sens) * range, min, max);
            onChange(next);
        },
        [min, max, onChange],
    );

    const onDoubleClick = useCallback(() => {
        if (center !== undefined) onChange(center);
    }, [center, onChange]);

    const pct = (value - min) / (max - min);
    // Arc spans 270deg from -135 to +135.
    const angle = -135 + pct * 270;
    const r = size / 2 - 4;
    const cx = size / 2;
    const cy = size / 2;
    const rad = (angle * Math.PI) / 180;
    const px = cx + r * Math.cos(rad - Math.PI / 2);
    const py = cy + r * Math.sin(rad - Math.PI / 2);

    return (
        <div style={{ display: "grid", justifyItems: "center", gap: 4 }}>
            <svg
                width={size}
                height={size}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onDoubleClick={onDoubleClick}
                style={{ cursor: "ns-resize", touchAction: "none" }}
            >
                <circle cx={cx} cy={cy} r={r} fill="var(--bg-elev-2)" stroke="var(--border)" />
                <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill="none"
                    stroke={color}
                    strokeWidth={2.5}
                    strokeDasharray={`${pct * 2 * Math.PI * r} ${2 * Math.PI * r}`}
                    transform={`rotate(135 ${cx} ${cy})`}
                    opacity={0.9}
                />
                <line x1={cx} y1={cy} x2={px} y2={py} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
            </svg>
            {label && (
                <span style={{ fontSize: 9, letterSpacing: "0.08em", color: "var(--fg-dim)", textTransform: "uppercase" }}>
                    {label}
                </span>
            )}
            {format && <span className="mono" style={{ fontSize: 10 }}>{format(value)}</span>}
        </div>
    );
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}
