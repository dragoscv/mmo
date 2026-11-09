/** Header: engine status chip, DSP load, dropouts, latency, pairing, setup, settings. */
import { motion } from "motion/react";
import { AudioLines, RotateCcw, Settings, SlidersHorizontal, Smartphone } from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from "@mmo/ui";
import { useT } from "../i18n";
import { useMeterSample } from "../lib/meter-bus";
import { useStore, type EngineStatus } from "../store";

const DOT: Record<EngineStatus, string> = {
    stopped: "bg-muted-foreground",
    starting: "bg-warning",
    connecting: "bg-warning",
    reconnecting: "bg-warning",
    running: "bg-success",
    error: "bg-destructive",
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "bad" }) {
    return (
        <div className="flex flex-col items-end leading-tight">
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
            <span className={cn("text-sm font-semibold tabular-nums", tone === "warn" && "text-warning", tone === "bad" && "text-destructive")}>{value}</span>
        </div>
    );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
    return (
        <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
        </Tooltip>
    );
}

export function Header() {
    const t = useT();
    const status = useStore((s) => s.status);
    const start = useStore((s) => s.start);
    const settings = useStore((s) => s.settings);
    const openPanel = useStore((s) => s.openPanel);
    const startEngine = useStore((s) => s.startEngine);
    const preset = useStore((s) => s.proto.state?.preset);
    const m = useMeterSample(4);
    const dsp = m ? Math.round(m.dsp_load * 100) : null;
    const latency = start?.info?.nominal_latency_ms;

    const restart = () => {
        const d = settings.device;
        if (d) void startEngine({ ...d, preset: preset ?? settings.lastPreset ?? d.preset, lan: settings.lan });
        else openPanel("setup");
    };

    return (
        <header className="flex items-center gap-4 px-1">
            <div className="flex items-center gap-2">
                <AudioLines className="size-6 text-primary" aria-hidden />
                <h1 className="font-heading text-xl font-semibold">{t("app.title")}</h1>
            </div>
            <motion.div
                layout
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm font-medium"
            >
                <span className="relative flex size-2.5">
                    {status === "running" ? <span className="absolute inline-flex size-full rounded-full bg-success opacity-60 motion-safe:animate-ping" /> : null}
                    <span className={cn("relative inline-flex size-2.5 rounded-full", DOT[status])} />
                </span>
                {t(`status.${status}`)}
            </motion.div>
            {start?.info ? (
                <span className="hidden truncate text-xs text-muted-foreground lg:inline">
                    {start.info.input} → {start.info.output} · {start.info.buffer_frames} @ {(start.info.sample_rate / 1000).toFixed(1)} kHz
                </span>
            ) : null}
            <div className="ms-auto flex items-center gap-5">
                <Stat label={t("header.dsp")} value={dsp == null ? "–" : `${dsp}%`} tone={dsp != null && dsp > 85 ? "bad" : dsp != null && dsp > 60 ? "warn" : undefined} />
                <Stat label={t("header.xruns")} value={m ? String(m.xruns) : "–"} tone={m && m.xruns > 0 ? "warn" : undefined} />
                <Stat label={t("header.latency")} value={latency ? `${latency.toFixed(1)} ms` : "–"} />
                <div className="flex items-center gap-1">
                    <Button variant={start?.lan ? "secondary" : "outline"} size="sm" onClick={() => openPanel("pair")}>
                        <Smartphone /> {t("header.pair")}
                    </Button>
                    {status === "error" || status === "stopped" ? (
                        <IconButton label={t("header.restart")} onClick={restart}>
                            <RotateCcw />
                        </IconButton>
                    ) : null}
                    <IconButton label={t("header.setup")} onClick={() => openPanel("setup")}>
                        <SlidersHorizontal />
                    </IconButton>
                    <IconButton label={t("header.settings")} onClick={() => openPanel("settings")}>
                        <Settings />
                    </IconButton>
                </div>
            </div>
        </header>
    );
}
