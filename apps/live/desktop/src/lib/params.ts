/**
 * Effect parameter specs from `/api/fx` and the maths to drive controls from them. Mirrors
 * `live_dsp::param::ParamSpec` (clamp / to_normalized / from_normalized) so a knob position maps
 * to exactly the value the engine would compute.
 */

export type Unit =
    | "none"
    | "db"
    | "hz"
    | "ms"
    | "seconds"
    | "ratio"
    | "percent"
    | "semitones"
    | "cents"
    | "bpm"
    | "pan"
    | "toggle"
    | "choice";

export interface ParamSpec {
    id: string;
    min: number;
    max: number;
    default: number;
    unit: Unit;
    curve: "linear" | "log";
    choices: string[];
}

export interface FxSpec {
    id: string;
    params: ParamSpec[];
}

export type ControlKind = "toggle" | "choice" | "knob";

export function controlKind(spec: ParamSpec): ControlKind {
    if (spec.unit === "toggle") return "toggle";
    if (spec.unit === "choice" && spec.choices.length > 0) return "choice";
    return "knob";
}

export function clamp(spec: ParamSpec, v: number): number {
    if (!Number.isFinite(v)) return spec.default;
    const c = Math.min(spec.max, Math.max(spec.min, v));
    return spec.unit === "toggle" || spec.unit === "choice" ? Math.round(c) : c;
}

export function toNormalized(spec: ParamSpec, v: number): number {
    const c = clamp(spec, v);
    if (spec.max <= spec.min) return 0;
    if (spec.curve === "log" && spec.min > 0) return Math.log(c / spec.min) / Math.log(spec.max / spec.min);
    return (c - spec.min) / (spec.max - spec.min);
}

export function fromNormalized(spec: ParamSpec, n: number): number {
    const x = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
    const v = spec.curve === "log" && spec.min > 0 ? spec.min * Math.pow(spec.max / spec.min, x) : spec.min + (spec.max - spec.min) * x;
    return clamp(spec, v);
}

/** Integer-valued knobs (semitone intervals, MIDI notes) snap to whole steps. */
export function isInteger(spec: ParamSpec): boolean {
    return spec.unit === "semitones" || (spec.unit === "none" && Number.isInteger(spec.min) && Number.isInteger(spec.max) && spec.max - spec.min >= 12);
}

/** Value after nudging the control by `delta` normalised units (keyboard/wheel). */
export function nudge(spec: ParamSpec, v: number, delta: number): number {
    if (isInteger(spec)) return clamp(spec, Math.round(v) + Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) * 100)));
    return fromNormalized(spec, toNormalized(spec, v) + delta);
}

function fixed(v: number, max = 2): string {
    const a = Math.abs(v);
    const d = a >= 100 ? 0 : a >= 10 ? Math.min(1, max) : max;
    return v.toFixed(d).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** Human-readable value with unit (choice labels are resolved by the caller for i18n). */
export function formatValue(spec: ParamSpec, v: number): string {
    switch (spec.unit) {
        case "db":
            return `${v > 0 ? "+" : ""}${fixed(v, 1)} dB`;
        case "hz":
            return v >= 1000 ? `${fixed(v / 1000, 2)} kHz` : `${fixed(v, 0)} Hz`;
        case "ms":
            return v >= 1000 ? `${fixed(v / 1000, 2)} s` : `${fixed(v, v < 10 ? 1 : 0)} ms`;
        case "seconds":
            return `${fixed(v, 2)} s`;
        case "ratio":
            return `${fixed(v, 1)}:1`;
        case "percent":
            return `${Math.round(v * 100)}%`;
        case "semitones":
            return `${v > 0 ? "+" : ""}${Math.round(v)} st`;
        case "cents":
            return `${v > 0 ? "+" : ""}${Math.round(v)} ct`;
        case "bpm":
            return `${fixed(v, 1)} BPM`;
        case "pan": {
            const p = Math.round(v * 100);
            return p === 0 ? "C" : p < 0 ? `L${-p}` : `R${p}`;
        }
        case "toggle":
            return v >= 0.5 ? "on" : "off";
        case "choice":
            return spec.choices[Math.round(v)] ?? String(Math.round(v));
        default:
            return isInteger(spec) ? String(Math.round(v)) : fixed(v, 2);
    }
}

/** Map a harmonizer id like `v2_level` to `{ voice: 2, base: "level" }`. */
export function voiceParam(id: string): { voice: number; base: string } | null {
    const m = /^v(\d)_(\w+)$/.exec(id);
    return m ? { voice: Number(m[1]), base: m[2] as string } : null;
}

/** Normalise a raw `/api/fx` payload, dropping malformed entries. */
export function parseCatalogue(raw: unknown): FxSpec[] {
    if (!Array.isArray(raw)) return [];
    const out: FxSpec[] = [];
    for (const f of raw) {
        if (!f || typeof f.id !== "string" || !Array.isArray(f.params)) continue;
        const params: ParamSpec[] = [];
        for (const p of f.params) {
            if (!p || typeof p.id !== "string" || typeof p.min !== "number" || typeof p.max !== "number") continue;
            params.push({
                id: p.id,
                min: p.min,
                max: p.max,
                default: typeof p.default === "number" ? p.default : p.min,
                unit: (typeof p.unit === "string" ? p.unit : "none") as Unit,
                curve: p.curve === "log" ? "log" : "linear",
                choices: Array.isArray(p.choices) ? p.choices.map(String) : [],
            });
        }
        out.push({ id: f.id, params });
    }
    return out;
}
