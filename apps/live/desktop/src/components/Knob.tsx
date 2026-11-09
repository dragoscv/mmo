/**
 * Rotary control for a ParamSpec. Vertical drag (Shift = fine), wheel, arrow keys / PageUp/Down /
 * Home/End, double-click resets to default. role="slider" with value text for assistive tech.
 */
import { useRef, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { cn } from "@mmo/ui";
import { clamp, fromNormalized, isInteger, nudge, toNormalized, type ParamSpec } from "../lib/params";

const START = -135;
const SWEEP = 270;

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
    const p = (a: number) => {
        const rad = ((a - 90) * Math.PI) / 180;
        return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)] as const;
    };
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${a1 > a0 ? 1 : 0} ${x1} ${y1}`;
}

export interface KnobProps {
    spec: ParamSpec;
    value: number;
    label: string;
    valueText: string;
    onChange: (v: number) => void;
    size?: number;
    disabled?: boolean;
}

export function Knob({ spec, value, label, valueText, onChange, size = 56, disabled }: KnobProps) {
    const drag = useRef<{ y: number; n: number } | null>(null);
    const n = toNormalized(spec, value);
    const bipolar = spec.min < 0 && spec.max > 0;
    const zero = bipolar ? toNormalized(spec, 0) : 0;
    const angle = START + n * SWEEP;
    const from = START + zero * SWEEP;
    const r = size / 2 - 5;
    const c = size / 2;

    const set = (v: number) => {
        const next = isInteger(spec) ? clamp(spec, Math.round(v)) : clamp(spec, v);
        if (next !== value) onChange(next);
    };

    const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, n };
    };
    const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d) return;
        const scale = e.shiftKey ? 800 : 200;
        set(fromNormalized(spec, d.n + (d.y - e.clientY) / scale));
    };
    const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent<HTMLDivElement>) => {
        if (disabled) return;
        set(nudge(spec, value, (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.02)));
    };
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        const step = e.shiftKey ? 0.002 : 0.01;
        const map: Record<string, () => number> = {
            ArrowUp: () => nudge(spec, value, step),
            ArrowRight: () => nudge(spec, value, step),
            ArrowDown: () => nudge(spec, value, -step),
            ArrowLeft: () => nudge(spec, value, -step),
            PageUp: () => nudge(spec, value, 0.1),
            PageDown: () => nudge(spec, value, -0.1),
            Home: () => spec.min,
            End: () => spec.max,
        };
        const f = map[e.key];
        if (f) {
            e.preventDefault();
            e.stopPropagation();
            set(f());
        }
    };

    return (
        <div className={cn("flex w-20 flex-col items-center gap-1", disabled && "opacity-50")}>
            <div
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-label={label}
                aria-valuemin={spec.min}
                aria-valuemax={spec.max}
                aria-valuenow={Number(value.toFixed(3))}
                aria-valuetext={valueText}
                aria-disabled={disabled || undefined}
                className="knob cursor-ns-resize touch-none text-primary"
                style={{ width: size, height: size }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onWheel={onWheel}
                onKeyDown={onKeyDown}
                onDoubleClick={() => !disabled && set(spec.default)}
            >
                <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
                    <path d={arc(c, c, r, START, START + SWEEP)} fill="none" className="stroke-muted" strokeWidth={4} strokeLinecap="round" />
                    {Math.abs(angle - from) > 0.5 ? (
                        <path d={arc(c, c, r, Math.min(from, angle), Math.max(from, angle))} fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" />
                    ) : null}
                    <circle cx={c} cy={c} r={r - 7} className="fill-card stroke-border" strokeWidth={1} />
                    <line
                        x1={c}
                        y1={c}
                        x2={c}
                        y2={c - (r - 10)}
                        stroke="currentColor"
                        strokeWidth={2.5}
                        strokeLinecap="round"
                        transform={`rotate(${angle} ${c} ${c})`}
                    />
                </svg>
            </div>
            <span className="max-w-full truncate text-center text-[11px] leading-tight text-muted-foreground">{label}</span>
            <span className="text-xs font-medium tabular-nums">{valueText}</span>
        </div>
    );
}
