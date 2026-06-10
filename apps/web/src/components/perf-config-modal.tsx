"use client";

import { memo } from "react";
import { useTranslations } from "next-intl";
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { usePersonalization, type PerfPanelConfig, DEFAULT_PERF_CONFIG } from "@/hooks/use-personalization";
import { useSystemStats, type GpuInfo } from "@/hooks/use-system-stats";
import { cn } from "@/lib/utils";
import {
    Settings2,
    Cpu,
    MemoryStick,
    Monitor,
    Thermometer,
    Gauge,
    Box,
    MonitorSpeaker,
    RotateCcw,
} from "lucide-react";

// ─── Toggle row ──────────────────────────────────────────────────────────

function ToggleRow({
    icon: Icon,
    label,
    description,
    checked,
    onChange,
}: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    description?: string;
    checked: boolean;
    onChange: (v: boolean) => void;
}) {
    return (
        <label className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-white/[0.03] cursor-pointer transition-colors group">
            <Icon className="h-3.5 w-3.5 shrink-0 text-white/25 group-hover:text-white/40 transition-colors" />
            <div className="flex-1 min-w-0">
                <div className="text-[11px] text-white/70">{label}</div>
                {description && <div className="text-[9px] text-white/25">{description}</div>}
            </div>
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                onClick={() => onChange(!checked)}
                className={cn(
                    "relative w-7 h-4 rounded-full transition-colors shrink-0 cursor-pointer",
                    checked ? "bg-purple-500" : "bg-white/10"
                )}
            >
                <div
                    className={cn(
                        "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform",
                        checked ? "translate-x-3.5" : "translate-x-0.5"
                    )}
                />
            </button>
        </label>
    );
}

// ─── GPU selector ────────────────────────────────────────────────────────

function GpuSelector({
    gpus,
    selectedIndex,
    onChange,
}: {
    gpus: GpuInfo[];
    selectedIndex: number;
    onChange: (index: number) => void;
}) {
    const t = useTranslations("perfConfig");
    if (gpus.length <= 1) return null;

    return (
        <div className="px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-white/25 mb-1.5">{t("selectGpu")}</div>
            <div className="flex flex-col gap-1">
                {gpus.map((gpu) => (
                    <button
                        key={gpu.index}
                        onClick={() => onChange(gpu.index)}
                        className={cn(
                            "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-all cursor-pointer border",
                            gpu.index === selectedIndex
                                ? "bg-purple-500/15 border-purple-500/30 text-purple-300"
                                : "bg-white/[0.02] border-white/[0.06] text-white/40 hover:bg-white/[0.05] hover:text-white/60"
                        )}
                    >
                        <Monitor className="h-3 w-3 shrink-0" />
                        <div className="flex-1 min-w-0">
                            <div className="text-[10px] font-medium truncate">{gpu.model}</div>
                            {gpu.vramTotal > 0 && (
                                <div className="text-[8px] text-white/20">{gpu.vramTotal > 1024 ? `${(gpu.vramTotal / 1024).toFixed(1)} GB` : `${gpu.vramTotal} MB`} VRAM</div>
                            )}
                        </div>
                        {gpu.index === selectedIndex && (
                            <div className="h-1.5 w-1.5 rounded-full bg-purple-400 shrink-0" />
                        )}
                    </button>
                ))}
            </div>
        </div>
    );
}

// ─── Poll interval selector ──────────────────────────────────────────────

function PollIntervalSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    const t = useTranslations("perfConfig");
    const options = [1, 2, 3, 5, 10];
    return (
        <div className="px-2 py-1.5">
            <div className="text-[9px] uppercase tracking-wider text-white/25 mb-1.5">{t("updateInterval")}</div>
            <div className="flex items-center gap-0.5">
                {options.map((s) => (
                    <button
                        key={s}
                        onClick={() => onChange(s)}
                        className={cn(
                            "flex-1 py-1 rounded text-[9px] font-medium transition-colors cursor-pointer",
                            value === s
                                ? "bg-purple-500/25 text-purple-300"
                                : "bg-white/[0.03] text-white/25 hover:text-white/50"
                        )}
                    >
                        {s}s
                    </button>
                ))}
            </div>
        </div>
    );
}

// ─── Main Modal ──────────────────────────────────────────────────────────

export const PerfConfigModal = memo(function PerfConfigModal({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("perfConfig");
    const personalization = usePersonalization();
    const system = useSystemStats(
        personalization.perfConfig.gpuIndex,
        personalization.perfConfig.pollInterval,
    );
    const config = personalization.perfConfig;

    const update = (patch: Partial<PerfPanelConfig>) => {
        personalization.update({
            perfConfig: { ...config, ...patch },
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="sm:max-w-[400px] max-h-[85vh] p-0 overflow-hidden bg-zinc-950 border-white/10 z-[80]"
                overlayClassName="z-[79]"
            >
                <div className="p-3 pb-2 border-b border-white/[0.06]">
                    <DialogTitle className="flex items-center justify-between text-sm font-semibold text-white/90">
                        <div className="flex items-center gap-2">
                            <Settings2 className="h-4 w-4" />
                            {t("title")}
                        </div>
                        <button
                            onClick={() => update({ ...DEFAULT_PERF_CONFIG })}
                            className="flex items-center gap-1 text-[9px] text-white/25 hover:text-white/50 cursor-pointer transition-colors"
                            title={t("resetTooltip")}
                        >
                            <RotateCcw className="h-3 w-3" />
                            {t("reset")}
                        </button>
                    </DialogTitle>
                </div>

                <div className="overflow-y-auto max-h-[70vh] divide-y divide-white/[0.04]">
                    {/* System Stats */}
                    <div className="py-2">
                        <div className="px-2 mb-1">
                            <span className="text-[10px] uppercase tracking-wider text-white/30 font-medium">{t("sectionSystem")}</span>
                            {!system.connected && (
                                <span className="ml-2 text-[8px] text-amber-400/60">{t("connecting")}</span>
                            )}
                        </div>
                        <ToggleRow
                            icon={Cpu}
                            label={t("cpuUsage")}
                            description={system.cpuModel || t("cpuUsageDesc")}
                            checked={config.showCpu}
                            onChange={(v) => update({ showCpu: v })}
                        />
                        <ToggleRow
                            icon={Thermometer}
                            label={t("cpuTemp")}
                            description={t("sensorRequired")}
                            checked={config.showCpuTemp}
                            onChange={(v) => update({ showCpuTemp: v })}
                        />
                        <ToggleRow
                            icon={MemoryStick}
                            label={t("ramUsage")}
                            description={system.ramTotal > 0 ? t("ramTotal", { gb: (system.ramTotal / 1024).toFixed(0) }) : t("ramDesc")}
                            checked={config.showRam}
                            onChange={(v) => update({ showRam: v })}
                        />
                        <ToggleRow
                            icon={Monitor}
                            label={t("gpuUsage")}
                            description={system.gpuModel || t("gpuUsageDesc")}
                            checked={config.showGpu}
                            onChange={(v) => update({ showGpu: v })}
                        />
                        <ToggleRow
                            icon={Thermometer}
                            label={t("gpuTemp")}
                            description={t("sensorRequired")}
                            checked={config.showGpuTemp}
                            onChange={(v) => update({ showGpuTemp: v })}
                        />
                        <ToggleRow
                            icon={Box}
                            label={t("vram")}
                            description={t("vramDesc")}
                            checked={config.showVram}
                            onChange={(v) => update({ showVram: v })}
                        />
                    </div>

                    {/* GPU Selection */}
                    {system.availableGpus.length > 1 && (
                        <div className="py-2">
                            <GpuSelector
                                gpus={system.availableGpus}
                                selectedIndex={config.gpuIndex}
                                onChange={(i) => update({ gpuIndex: i })}
                            />
                        </div>
                    )}

                    {/* Browser Stats */}
                    <div className="py-2">
                        <div className="px-2 mb-1">
                            <span className="text-[10px] uppercase tracking-wider text-white/30 font-medium">{t("sectionBrowser")}</span>
                        </div>
                        <ToggleRow
                            icon={Gauge}
                            label={t("fps")}
                            description={t("fpsDesc")}
                            checked={config.showFps}
                            onChange={(v) => update({ showFps: v })}
                        />
                        <ToggleRow
                            icon={MemoryStick}
                            label={t("tabMemory")}
                            description={t("tabMemoryDesc")}
                            checked={config.showTabMemory}
                            onChange={(v) => update({ showTabMemory: v })}
                        />
                        <ToggleRow
                            icon={Box}
                            label={t("jsHeap")}
                            description={t("jsHeapDesc")}
                            checked={config.showJsHeap}
                            onChange={(v) => update({ showJsHeap: v })}
                        />
                        <ToggleRow
                            icon={MonitorSpeaker}
                            label={t("domNodes")}
                            description={t("domNodesDesc")}
                            checked={config.showDomNodes}
                            onChange={(v) => update({ showDomNodes: v })}
                        />
                        <ToggleRow
                            icon={Gauge}
                            label={t("audioLatency")}
                            description={t("audioLatencyDesc")}
                            checked={config.showAudioLatency}
                            onChange={(v) => update({ showAudioLatency: v })}
                        />
                    </div>

                    {/* Display Options */}
                    <div className="py-2">
                        <div className="px-2 mb-1">
                            <span className="text-[10px] uppercase tracking-wider text-white/30 font-medium">{t("sectionDisplay")}</span>
                        </div>
                        <ToggleRow
                            icon={Cpu}
                            label={t("hardwareInfo")}
                            description={t("hardwareInfoDesc")}
                            checked={config.showModelInfo}
                            onChange={(v) => update({ showModelInfo: v })}
                        />
                        <PollIntervalSelector
                            value={config.pollInterval}
                            onChange={(v) => update({ pollInterval: v })}
                        />
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
});
