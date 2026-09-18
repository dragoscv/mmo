import { useEffect, useState } from "react";
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from "@mmo/ui";
import { Square } from "lucide-react";
import { useT } from "../i18n";
import { mmo, type NativeEngineSnapshot } from "../lib/ipc";

const POLL_MS = 250; // 4 Hz — meters are EMA-smoothed in main; higher rates froze the renderer under IPC load.

function classify(ms: number | null | undefined): "" | "warn" | "bad" {
    if (ms == null) return "";
    if (ms <= 8) return "";
    if (ms <= 20) return "warn";
    return "bad";
}

const valueTone = { "": "text-foreground", warn: "text-warning", bad: "text-destructive" } as const;
const barTone = {
    "": "bg-gradient-to-r from-success to-primary",
    warn: "bg-gradient-to-r from-warning to-warning/70",
    bad: "bg-gradient-to-r from-warning to-destructive",
} as const;

const toDb = (v: number) => (v > 0 ? `${(20 * Math.log10(v)).toFixed(1)} dB` : "-∞");
const clamp01 = (v: number | undefined) => Math.max(0, Math.min(1, v ?? 0));

/**
 * Live engine metrics. Polls `get-audio-native-metrics` at 4 Hz while the
 * window is visible (pauses on `visibilitychange` to save battery — same as
 * the legacy widget). The engine is started/stopped from the web app; we only
 * reflect state, plus the hard kill switch.
 */
export function LatencyWidget() {
    const t = useT();
    const [snap, setSnap] = useState<NativeEngineSnapshot>({ running: false });
    const [killState, setKillState] = useState<"idle" | "stopping" | "stopped" | "wasIdle" | "failed">("idle");

    useEffect(() => {
        const bridge = mmo;
        if (!bridge) return;
        let timer: number | null = null;
        const tick = async () => {
            try {
                setSnap(await bridge.getAudioNativeMetrics());
            } catch {
                setSnap({ running: false });
            }
        };
        const start = () => {
            if (timer !== null) return;
            void tick();
            timer = window.setInterval(() => void tick(), POLL_MS);
        };
        const stop = () => {
            if (timer !== null) window.clearInterval(timer);
            timer = null;
        };
        const onVis = () => (document.hidden ? stop() : start());
        start();
        document.addEventListener("visibilitychange", onVis);
        return () => {
            stop();
            document.removeEventListener("visibilitychange", onVis);
        };
    }, []);

    async function kill() {
        if (!mmo) return;
        setKillState("stopping");
        try {
            const r = await mmo.killAudioEngine();
            if (r?.success) setKillState(r.wasRunning ? "stopped" : "wasIdle");
            else {
                setKillState("failed");
                console.warn("kill-audio-engine:", r);
            }
        } catch (err) {
            setKillState("failed");
            console.warn("kill-audio-engine threw:", err);
        } finally {
            window.setTimeout(() => setKillState("idle"), 1500);
        }
    }

    const killLabel = {
        idle: t("engine.stop"),
        stopping: t("engine.stopping"),
        stopped: `✓ ${t("engine.stopped")}`,
        wasIdle: `• ${t("engine.wasIdle")}`,
        failed: `✗ ${t("engine.stopFailed")}`,
    }[killState];

    const running = snap.running && !!snap.metrics;
    const m = snap.metrics ?? {};
    const streamMs = m.streamLatencyMs ?? 0;
    const bufMs = m.outputBufferDepthMs ?? 0;
    const dspAvg = m.dspBlockAvgMs ?? 0;
    const dspMax = m.dspBlockMaxMs ?? 0;
    const underruns = m.underruns ?? 0;
    const flushes = m.bufferFlushes ?? 0;
    const callbacks = m.callbackCount ?? 0;
    const sr =
        snap.status?.sampleRate ??
        (m.streamLatencyFrames && streamMs > 0 ? Math.round((m.streamLatencyFrames * 1000) / streamMs) : null);
    const cls = classify(streamMs);
    const pct = Math.min(100, Math.max(2, (streamMs / 30) * 100));

    const stats: Array<{ label: string; value: string; unit?: string; tone: "" | "warn" | "bad" }> = [
        { label: t("engine.streamLatency"), value: streamMs.toFixed(2), unit: "ms", tone: cls },
        { label: t("engine.bufferDepth"), value: bufMs.toFixed(1), unit: "ms", tone: classify(bufMs) },
        { label: t("engine.dspAvg"), value: dspAvg.toFixed(2), unit: "ms", tone: classify(dspAvg) },
        { label: t("engine.dspPeak"), value: dspMax.toFixed(2), unit: "ms", tone: classify(dspMax) },
        { label: t("engine.underruns"), value: String(underruns), tone: underruns > 0 ? "bad" : "" },
        { label: t("engine.flushes"), value: String(flushes), tone: flushes > 0 ? "warn" : "" },
    ];

    return (
        <div
            className={cn(
                "rounded-lg border p-3 text-[11px]",
                running ? "border-primary/25 bg-gradient-to-br from-primary/10 to-success/5" : "bg-muted/30 text-muted-foreground",
            )}
        >
            <div className="flex items-center gap-2">
                <span
                    className={cn(
                        "size-2 rounded-full",
                        running ? "bg-success shadow-[0_0_6px_var(--success)] motion-full:animate-pulse" : "bg-muted-foreground/40",
                    )}
                    aria-hidden
                />
                <span className="flex-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {running ? (sr ? t("engine.runningAt", { rate: sr }) : t("engine.running")) : t("engine.idle")}
                </span>
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button variant="destructive" size="xs" onClick={kill} disabled={killState === "stopping"}>
                                <Square className="size-3 fill-current" aria-hidden />
                                {killLabel}
                            </Button>
                        }
                    />
                    <TooltipContent side="left" className="max-w-56">
                        {t("engine.stopHint")}
                    </TooltipContent>
                </Tooltip>
            </div>

            {!running ? (
                <p className="mt-2">{t("engine.idleHint")}</p>
            ) : (
                <div className="mt-2">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 tabular-nums">
                        {stats.map((s) => (
                            <div key={s.label} className="flex flex-col gap-0.5">
                                <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{s.label}</span>
                                <span className={cn("text-sm font-semibold", valueTone[s.tone])}>
                                    {s.value}
                                    {s.unit && <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{s.unit}</span>}
                                </span>
                            </div>
                        ))}
                    </div>
                    <div className="mt-2 h-1 overflow-hidden rounded bg-foreground/10">
                        <div className={cn("h-full transition-[width] duration-300", barTone[cls])} style={{ width: `${pct.toFixed(1)}%` }} />
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-3">
                        <Meter label={t("engine.input")} peak={clamp01(m.inPeak)} rms={clamp01(m.inRms)} />
                        <Meter label={t("engine.output")} peak={clamp01(m.outPeak)} rms={clamp01(m.outRms)} />
                    </div>
                    <div className="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
                        <span>{t("engine.callbacks", { count: callbacks.toLocaleString() })}</span>
                        <span>{t("engine.target")}</span>
                    </div>
                </div>
            )}
        </div>
    );
}

function Meter({ label, peak, rms }: { label: string; peak: number; rms: number }) {
    return (
        <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between text-[9px] uppercase tracking-wide text-muted-foreground">
                <span>{label}</span>
                <span className="tabular-nums text-foreground">{toDb(peak)}</span>
            </div>
            <div className="relative h-2 overflow-hidden rounded bg-foreground/5" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={peak} aria-label={label}>
                <div
                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-success via-warning via-70% to-destructive transition-[width] duration-75 ease-linear"
                    style={{ width: `${(rms * 100).toFixed(1)}%` }}
                />
                <div className="absolute inset-y-0 w-0.5 bg-foreground/85 transition-[left] duration-75 ease-linear" style={{ left: `${(peak * 100).toFixed(1)}%` }} />
            </div>
        </div>
    );
}
