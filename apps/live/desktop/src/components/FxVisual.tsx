/**
 * The hero visual of one effect, rendered from the pure geometry in `lib/fx-visual.ts` with the
 * design-token colours. Small in the chain card, larger in the insert panel.
 */
import { cn } from "@mmo/ui";
import { areaPath, shapeFor, TONE_VAR, type Tone } from "../lib/fx-visual";

/** A CSS variable as an inline style: presentation *attributes* do not resolve `var()`. */
const stroke = (tone: Tone) => ({ stroke: `var(${TONE_VAR[tone]})` });
const fill = (tone: Tone) => ({ fill: `var(${TONE_VAR[tone]})` });

export function FxVisual({
    fx,
    params,
    className,
}: {
    fx: string;
    /** The insert's parameter values; anything missing falls back to a sensible default. */
    params?: Map<string, number> | Record<string, number>;
    className?: string;
}) {
    const read = (id: string, fallback: number) =>
        params instanceof Map ? (params.get(id) ?? fallback) : (params?.[id] ?? fallback);
    const s = shapeFor(fx, read);
    return (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden className={cn("h-full w-full", className)}>
            {s.fills.map((f, i) => (
                <path key={`f${i}`} d={areaPath(f.points)} style={fill(f.tone)} opacity={0.18} />
            ))}
            {s.hlines.map((h, i) => (
                <line
                    key={`h${i}`}
                    x1={0}
                    x2={100}
                    y1={100 - h.y}
                    y2={100 - h.y}
                    style={stroke(h.tone)}
                    strokeWidth={1}
                    strokeDasharray={h.dashed ? "3 3" : undefined}
                    vectorEffect="non-scaling-stroke"
                />
            ))}
            {s.lines.map((l, i) => (
                <polyline
                    key={`l${i}`}
                    points={l.points.map(([x, y]) => `${x},${100 - y}`).join(" ")}
                    fill="none"
                    style={stroke(l.tone)}
                    strokeWidth={l.width ?? 2}
                    strokeDasharray={l.dashed ? "4 4" : undefined}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                />
            ))}
        </svg>
    );
}
