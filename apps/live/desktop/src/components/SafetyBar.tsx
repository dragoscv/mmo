/**
 * The safety bar: the states that must never be missed, in one strip that stays on screen — bypass,
 * mute and a latched panic, the safety limiter's gain reduction, a clip, the dropouts and the
 * latency figure. It only reads (the engine's meters and the session state); nothing here changes
 * the audio by itself. Part of the "Stage Console" direction (WP21-20).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, cn } from "@mmo/ui";
import { useT } from "../i18n";
import { useMeterSample } from "../lib/meter-bus";
import { useStore } from "../store";

/** The limiter bar spans this much gain reduction; anything deeper just pins it. */
const GR_MAX_DB = 12;

function Chip({ tone, children }: { tone: "ok" | "warn" | "bad"; children: ReactNode }) {
    return (
        <span
            className={cn(
                "rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase",
                tone === "ok" && "border-success/40 bg-card text-success",
                tone === "warn" && "border-warning/50 bg-warning/10 text-warning",
                tone === "bad" && "border-destructive bg-destructive text-destructive-foreground",
            )}
        >
            {children}
        </span>
    );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "warn" | "bad" }) {
    return (
        <div className="flex flex-col leading-tight">
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
            <span
                className={cn(
                    "text-sm font-semibold tabular-nums",
                    tone === "warn" && "text-warning",
                    tone === "bad" && "text-destructive",
                )}
            >
                {value}
            </span>
        </div>
    );
}

export function SafetyBar() {
    const t = useT();
    const status = useStore((s) => s.status);
    const mix = useStore((s) => s.proto.state?.mix);
    const declared = useStore((s) => s.start?.info?.nominal_latency_ms ?? null);
    const measured = useStore((s) => s.measuredRoundTripMs);
    const stage = useStore((s) => s.stage);
    const toggleStage = useStore((s) => s.toggleStage);
    const m = useMeterSample(15);

    const live = status === "running";
    // The deepest of the two buses (main, ears): what the safety stage had to pull down.
    const gr = Math.max(m?.safety_gr?.[0] ?? 0, m?.safety_gr?.[1] ?? 0);
    const clipped = !!m?.clipped;
    // The engine's flag is "since the last snapshot", so it can clear before anyone looks up: hold it.
    const [clipHold, setClipHold] = useState(false);
    const clipTimer = useRef<number | undefined>(undefined);
    useEffect(() => {
        if (!clipped) return;
        setClipHold(true);
        window.clearTimeout(clipTimer.current);
        clipTimer.current = window.setTimeout(() => setClipHold(false), 2000);
    }, [clipped]);
    useEffect(() => () => window.clearTimeout(clipTimer.current), []);
    const xruns = m?.xruns ?? 0;
    const lat = measured != null ? `${measured.toFixed(1)} ms` : declared != null ? `${declared.toFixed(1)} ms` : "–";

    return (
        <div
            className="flex min-w-0 flex-1 items-center gap-4 rounded-xl border bg-card px-3 py-2"
            role="group"
            aria-label={t("safety.title")}
        >
            <div className="flex items-center gap-2" role="status" aria-live="polite">
                <ShieldCheck className={cn("size-5", mix?.panic ? "text-destructive" : "text-success")} aria-hidden />
                {mix?.panic ? (
                    <Chip tone="bad">{t("mix.panic")}</Chip>
                ) : (
                    <>
                        {mix?.mute ? <Chip tone="warn">{t("mix.mute")}</Chip> : null}
                        {mix?.bypass ? <Chip tone="warn">{t("mix.bypass")}</Chip> : null}
                        {!mix?.mute && !mix?.bypass ? <Chip tone="ok">{t("safety.clean")}</Chip> : null}
                    </>
                )}
                {!live ? <Chip tone="warn">{t(`status.${status}`)}</Chip> : null}
            </div>

            <div className="flex min-w-0 items-center gap-2">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {t("safety.limiter")}
                </span>
                <div
                    role="meter"
                    aria-label={t("safety.limiter")}
                    aria-valuemin={0}
                    aria-valuemax={GR_MAX_DB}
                    aria-valuenow={Math.round(gr * 10) / 10}
                    className="h-2.5 w-28 overflow-hidden rounded-full bg-muted"
                >
                    <div
                        className={cn("h-full rounded-full", gr > 0 ? "bg-warning" : "bg-success")}
                        style={{ width: `${Math.min(100, (gr / GR_MAX_DB) * 100)}%` }}
                    />
                </div>
                <span className={cn("text-base font-semibold tabular-nums", gr > 0 && "text-warning")}>
                    {gr > 0 ? `−${gr.toFixed(1)} dB` : "0 dB"}
                </span>
                {clipHold ? <Chip tone="bad">{t("meters.clip")}</Chip> : null}
            </div>

            <div className="ms-auto flex items-center gap-4">
                <Figure label={t("safety.dropouts")} value={String(xruns)} tone={xruns > 0 ? "warn" : undefined} />
                <Figure
                    label={t("safety.latency")}
                    value={lat}
                    tone={measured != null && declared != null && measured > declared * 1.5 ? "warn" : undefined}
                />
                <Button
                    variant={stage ? "secondary" : "outline"}
                    size="sm"
                    onClick={() => toggleStage()}
                    aria-pressed={stage}
                    title={`F11 — ${t("keys.f11")}`}
                    className="transition-transform duration-(--dur-fast) active:scale-[0.97]"
                >
                    {stage ? t("safety.exitStage") : t("safety.stage")}
                </Button>
            </div>
        </div>
    );
}
