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
    /** Accessible name (defaults to `label`). */
    ariaLabel?: string;
    disabled?: boolean;
}

/**
 * Vertical-drag rotary knob. Drag up/down to change; double-click resets to
 * `center`. Renders an SVG arc indicator. Pointer-capture keeps it smooth.
 * Keyboard: focusable `role="slider"`; arrows step 1 %, Shift+arrows 0.25 %,
 * PageUp/PageDown 10 %, Home/End to the ends, Enter/Backspace resets to `center`.
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
    ariaLabel,
    disabled = false,
}: KnobProps) {
    const startY = useRef(0);
    const startVal = useRef(0);

    const onPointerDown = useCallback(
        (e: React.PointerEvent) => {
            if (disabled) return;
            (e.target as Element).setPointerCapture(e.pointerId);
            startY.current = e.clientY;
            startVal.current = value;
        },
        [value, disabled],
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
        if (center !== undefined && !disabled) onChange(center);
    }, [center, onChange, disabled]);

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (disabled) return;
            const range = max - min;
            const step = e.shiftKey ? range / 400 : range / 100;
            let next: number | null = null;
            switch (e.key) {
                case "ArrowUp":
                case "ArrowRight":
                    next = value + step;
                    break;
                case "ArrowDown":
                case "ArrowLeft":
                    next = value - step;
                    break;
                case "PageUp":
                    next = value + range / 10;
                    break;
                case "PageDown":
                    next = value - range / 10;
                    break;
                case "Home":
                    next = min;
                    break;
                case "End":
                    next = max;
                    break;
                case "Enter":
                case "Backspace":
                    if (center !== undefined) next = center;
                    break;
                default:
                    return;
            }
            if (next === null) return;
            // Keep deck shortcuts (bound to bare keys) from firing while the knob has focus.
            e.preventDefault();
            e.stopPropagation();
            onChange(clamp(next, min, max));
        },
        [value, min, max, center, onChange, disabled],
    );

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
        <div
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={ariaLabel ?? label}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={Number(value.toFixed(3))}
            aria-valuetext={format ? format(value) : undefined}
            aria-disabled={disabled || undefined}
            onKeyDown={onKeyDown}
            style={{ display: "grid", justifyItems: "center", gap: 4, borderRadius: 8, opacity: disabled ? 0.4 : 1 }}
        >
            <svg
                width={size}
                height={size}
                aria-hidden
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
