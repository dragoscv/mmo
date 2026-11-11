import { useRef, type CSSProperties } from "react";
import { cn } from "@mmo/ui";
import { arcPath, arcRange, dragPos, isBipolar, keyValue, knobSteps, posToAngle, posToValue, valueToPos } from "./mixer/knob-math";

interface KnobProps {
    value: number;
    min: number;
    max: number;
    /** Detent value: 12 o'clock when it lies inside the range (EQ 0 dB, filter off); double-click / Enter resets to it. */
    center?: number;
    /** Force a one-sided knob although `center` is inside the range (wet/dry, levels). */
    bipolar?: boolean;
    label?: string;
    size?: number;
    /** Colour of the value arc (default: the ON accent). */
    color?: string;
    onChange: (v: number) => void;
    /** Value in real units ("+3.0 dB"); also `aria-valuetext`. */
    format?: (v: number) => string;
    /** Accessible name (defaults to `label`). */
    ariaLabel?: string;
    disabled?: boolean;
    /** Render the formatted value line under the knob (aria-valuetext is kept either way). */
    showValue?: boolean;
    /** Keyboard step in value units (default: 1 % of the range), e.g. 0.5 for a dB knob. */
    step?: number;
    /** Keyboard step with Shift (default: a quarter of `step`). */
    fineStep?: number;
    className?: string;
}

/**
 * Flat rotary knob: a disc with a pointer and a value arc on a 270° ring (from the detent when
 * bipolar, else from the minimum). Geometry and input maths live in `mixer/knob-math.ts`.
 * Pointer: drag up / down (Shift = fine), double-click resets to `center`.
 * Keyboard (`role="slider"`): arrows one `step` (Shift = `fineStep`), PageUp / PageDown about
 * 10 % of the range, Home / End the ends, Enter / Backspace resets to `center`. Steps are equal
 * in value on both sides of the detent.
 */
export function Knob({ value, min, max, center, bipolar, label, size = 28, color, onChange, format, ariaLabel, disabled = false, showValue = true, step, fineStep, className }: KnobProps) {
    const drag = useRef<{ y: number; pos: number } | null>(null);
    const scale = { min, max, center, bipolar };
    const two = isBipolar(scale);
    const pos = valueToPos(value, scale);

    const onPointerDown = (e: React.PointerEvent) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, pos };
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const d = drag.current;
        if (!d || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
        onChange(posToValue(dragPos(d.pos, d.y - e.clientY, e.shiftKey, two), scale));
    };
    const onPointerUp = () => {
        drag.current = null;
    };
    const reset = () => {
        if (center !== undefined && !disabled) onChange(center);
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (disabled) return;
        let next: number | null = null;
        if (e.key === "Enter" || e.key === "Backspace") {
            if (center === undefined) return;
            next = center;
        } else {
            next = keyValue(value, e.key, e.shiftKey, scale, knobSteps(scale, step, fineStep));
            if (next === null) return;
        }
        // Keep deck shortcuts (bound to bare keys) from firing while the knob has focus.
        e.preventDefault();
        e.stopPropagation();
        onChange(next);
    };

    const c = size / 2;
    const ringR = c - 1.5;
    const bodyR = Math.max(4, c - 4.5);
    const [from, to] = arcRange(pos, two);
    const a = (posToAngle(pos) * Math.PI) / 180;
    const px = (r: number) => c + r * Math.sin(a);
    const py = (r: number) => c - r * Math.cos(a);
    const text = format ? format(value) : undefined;

    return (
        <div
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={ariaLabel ?? label}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={Number(value.toFixed(3))}
            aria-valuetext={text}
            aria-disabled={disabled || undefined}
            title={text}
            onKeyDown={onKeyDown}
            className={cn("mx-knob", className)}
            style={color ? ({ "--knob-color": color } as CSSProperties) : undefined}
        >
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onDoubleClick={reset}>
                <path className="mx-knob-track" d={arcPath(c, c, ringR, -135, 135)} />
                {to - from > 0.004 && <path className="mx-knob-arc" d={arcPath(c, c, ringR, posToAngle(from), posToAngle(to))} />}
                <circle className="mx-knob-body" cx={c} cy={c} r={bodyR} />
                <line className="mx-knob-ptr" x1={px(bodyR * 0.25)} y1={py(bodyR * 0.25)} x2={px(bodyR - 0.5)} y2={py(bodyR - 0.5)} />
            </svg>
            {label && <span className="dk-label mx-knob-label">{label}</span>}
            {text !== undefined && showValue && <span className="dk-num mx-knob-value">{text}</span>}
        </div>
    );
}
