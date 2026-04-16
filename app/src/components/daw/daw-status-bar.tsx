"use client";

import { useDAW } from "./daw-context";
import { usePerformanceStats } from "@/hooks/use-performance-stats";
import { cn } from "@/lib/utils";
import {
    Cpu, HardDrive, Music, Layers, Clock, Activity, Zap,
} from "lucide-react";

function StatusItem({ icon: Icon, label, value, color }: {
    icon?: React.ComponentType<{ className?: string }>;
    label: string;
    value: string;
    color?: string;
}) {
    return (
        <div className="flex items-center gap-1">
            {Icon && <Icon className="h-2.5 w-2.5 text-[var(--daw-text-dim)] opacity-50" />}
            {label && <span className="text-[9px] text-[var(--daw-text-dim)]">{label}</span>}
            <span className={cn("text-[9px] tabular-nums font-mono", color || "text-[var(--daw-text-muted)]")}>{value}</span>
        </div>
    );
}

function PerfDot({ pct }: { pct: number }) {
    return (
        <div
            className={cn(
                "h-1.5 w-1.5 rounded-full shrink-0 transition-colors",
                pct >= 90 ? "bg-[var(--daw-red)]" : pct >= 70 ? "bg-[var(--daw-amber)]" : "bg-[var(--daw-green)]"
            )}
        />
    );
}

export function DAWStatusBar() {
    const daw = useDAW();
    const stats = usePerformanceStats();
    const project = daw.project;

    const clipCount = project.tracks.reduce((sum, t) => sum + t.clips.length, 0);
    const noteCount = project.tracks.reduce((sum, t) =>
        sum + t.clips.reduce((clipSum, c) => clipSum + (c.midi?.notes.length || 0), 0), 0);

    const fpsPct = (stats.fps / 60) * 100;
    const heapPct = stats.jsHeapLimit > 0 ? (stats.jsHeapUsed / stats.jsHeapLimit) * 100 : 0;

    const saveText = daw.isDirty ? "Unsaved" : "Saved";
    const saveColor = daw.isDirty ? "text-[var(--daw-amber)]" : "text-[var(--daw-green)] opacity-60";

    const durationSec = project.duration || (project.tracks.reduce((max, t) =>
        Math.max(max, ...t.clips.map(c => c.position + c.length)), 0));
    const durationTime = ((durationSec / project.tempo) * 60);
    const mins = Math.floor(durationTime / 60);
    const secs = Math.floor(durationTime % 60);

    return (
        <div className="h-6 bg-[var(--daw-surface)] border-t border-[var(--daw-border)] flex items-center px-3 gap-3 flex-shrink-0">
            {/* Performance */}
            <div className="flex items-center gap-2.5">
                <div className="flex items-center gap-1">
                    <PerfDot pct={100 - fpsPct} />
                    <span className="text-[9px] font-mono tabular-nums text-[var(--daw-text-dim)]">{stats.fps} FPS</span>
                </div>
                <div className="flex items-center gap-1">
                    <Cpu className="h-2.5 w-2.5 text-[var(--daw-text-dim)] opacity-40" />
                    <span className={cn(
                        "text-[9px] font-mono tabular-nums",
                        heapPct >= 90 ? "text-[var(--daw-red)]" : heapPct >= 70 ? "text-[var(--daw-amber)]" : "text-[var(--daw-text-dim)]"
                    )}>
                        {stats.jsHeapUsed.toFixed(0)}MB
                    </span>
                </div>
                {stats.audioLatency > 0 && (
                    <div className="flex items-center gap-1">
                        <Zap className="h-2.5 w-2.5 text-[var(--daw-text-dim)] opacity-40" />
                        <span className={cn(
                            "text-[9px] font-mono tabular-nums",
                            stats.audioLatency > 20 ? "text-[var(--daw-amber)]" : "text-[var(--daw-text-dim)]"
                        )}>
                            {stats.audioLatency.toFixed(1)}ms
                        </span>
                    </div>
                )}
            </div>

            <div className="w-px h-3 bg-[var(--daw-border)]" />

            {/* Project info */}
            <div className="flex items-center gap-3 flex-1">
                <StatusItem icon={Music} label="Tracks" value={String(project.tracks.length)} />
                <StatusItem icon={Layers} label="Clips" value={String(clipCount)} />
                {noteCount > 0 && <StatusItem label="Notes" value={String(noteCount)} />}
                <StatusItem icon={Clock} label="" value={`${mins}:${secs.toString().padStart(2, "0")}`} />
                <StatusItem icon={Activity} label="" value={`${project.tempo} BPM`} />
                <StatusItem label="" value={`${project.timeSignature.numerator}/${project.timeSignature.denominator}`} />
            </div>

            {/* Right: Status */}
            <div className="flex items-center gap-3">
                <StatusItem icon={HardDrive} label="" value={saveText} color={saveColor} />
                <div className="flex items-center gap-1">
                    <span className="text-[9px] text-[var(--daw-text-dim)]">History</span>
                    <span className="text-[9px] font-mono tabular-nums text-[var(--daw-text-dim)]">{daw.history.currentIndex}/{daw.history.entries.length - 1}</span>
                </div>
                {daw.isRecording && (
                    <div className="flex items-center gap-1">
                        <div className="h-1.5 w-1.5 rounded-full bg-[var(--daw-red)] animate-pulse" />
                        <span className="text-[9px] text-[var(--daw-red)]">REC</span>
                    </div>
                )}
                <span className="text-[9px] text-[var(--daw-text-dim)] opacity-60 font-mono">
                    {daw.snap === "none" ? "Free" : `Snap ${daw.snap}`}
                </span>
            </div>
        </div>
    );
}
