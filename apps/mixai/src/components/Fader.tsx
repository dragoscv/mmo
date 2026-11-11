import { useRef, type CSSProperties } from "react";
import { cn } from "@mmo/ui";

interface FaderProps {
    value: number;
    min?: number;
    max?: number;
    orientation?: "vertical" | "horizontal";
    /** CSS length along the vertical axis; default "100%" fills a sized grid / flex cell. */
    height?: number | string;
    width?: number | string;
    /** Colour of the level line (default: the deck colour in scope, else the ON accent). */
    color?: string;
    onChange: (v: number) => void;
    /** Accessible name. */
    ariaLabel?: string;
    /** Value in real units ("85%"); becomes `aria-valuetext`. */
    format?: (v: number) => string;
    /** Double-click / Enter target (default: `max`). */
    resetTo?: number;
    /** Value the pointer snaps to within 2 % of the travel (crossfader centre); Shift = no snap. */
    detent?: number;
    className?: string;
}

/** Length of the cap along the travel, CSS px (keep in sync with `.mx-fader-cap` in mixer.css). */
export const FADER_CAP = { vertical: 12, horizontal: 14 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Flat fader: a slot, a level line and a cap that always stays inside the box.
 * Pointer: press anywhere to jump there and drag; double-click resets to `resetTo`.
 * Keyboard (`role="slider"`): arrows 1 % (Shift 0.25 %), PageUp / PageDown 10 %, Home = min,
 * End = max, Enter / Backspace resets.
 */
export function Fader({ value, min = 0, max = 1, orientation = "vertical", height, width, color, onChange, ariaLabel, format, resetTo, detent, className }: FaderProps) {
    const ref = useRef<HTMLDivElement>(null);
    const vertical = orientation === "vertical";
    const range = max - min;
    const p = range > 0 ? clamp((value - min) / range, 0, 1) : 0;
    const reset = resetTo ?? max;

    const at = (e: React.PointerEvent) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const cap = FADER_CAP[orientation];
        const travel = (vertical ? r.height : r.width) - cap;
        if (travel <= 0) return;
        const along = vertical ? r.bottom - e.clientY : e.clientX - r.left;
        let next = min + clamp((along - cap / 2) / travel, 0, 1) * range;
        if (detent !== undefined && !e.shiftKey && Math.abs(next - detent) < range * 0.02) next = detent;
        onChange(next);
    };
    const onPointerDown = (e: React.PointerEvent) => {
        // Only the primary button (or a touch / pen contact) moves the fader: a right or middle click must not jump it.
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        at(e);
    };
    const onPointerMove = (e: React.PointerEvent) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e);
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        const step = e.shiftKey ? range / 400 : range / 100;
        const next =
            e.key === "ArrowUp" || e.key === "ArrowRight" ? value + step
            : e.key === "ArrowDown" || e.key === "ArrowLeft" ? value - step
            : e.key === "PageUp" ? value + range / 10
            : e.key === "PageDown" ? value - range / 10
            : e.key === "Home" ? min
            : e.key === "End" ? max
            : e.key === "Enter" || e.key === "Backspace" ? reset
            : null;
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        onChange(clamp(next, min, max));
    };

    const style = { "--p": p, ...(color ? { "--fader-color": color } : {}), ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) } as CSSProperties;

    return (
        <div
            ref={ref}
            role="slider"
            tabIndex={0}
            aria-label={ariaLabel}
            aria-orientation={orientation}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={Number(value.toFixed(3))}
            aria-valuetext={format ? format(value) : undefined}
            data-orient={orientation}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onDoubleClick={() => onChange(reset)}
            className={cn("mx-fader", className)}
            style={style}
        >
            <span className="mx-fader-slot" aria-hidden />
            <span className="mx-fader-fill" aria-hidden />
            <span className="mx-fader-cap" aria-hidden />
        </div>
    );
}
