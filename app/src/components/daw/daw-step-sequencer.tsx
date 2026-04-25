"use client";

import { useCallback } from "react";
import { useDAW } from "./daw-context";
import { cn } from "@/lib/utils";
import { Volume2, Play, RotateCcw, Plus, Minus } from "lucide-react";
import { useContextMenu, useLongPress, type MenuEntry } from "./daw-context-menu";
import { useScrollAdjust } from "./daw-ui-utils";
import { useRenderCount } from "@/lib/dev-debugger";

export function DAWStepSequencer() {
    useRenderCount("DAWStepSequencer");
    const daw = useDAW();
    const ctxMenu = useContextMenu();
    const pattern = daw.stepPattern;

    const swingRef = useScrollAdjust({
        value: pattern?.swing ?? 0,
        min: 0,
        max: 100,
        step: 5,
        fineStep: 1,
        onChange: v => daw.setPatternSwing(Math.round(v)),
    });

    if (!pattern) {
        return (
            <div className="h-full flex items-center justify-center text-white/20 text-sm">
                No step pattern loaded
            </div>
        );
    }

    const beatsPerStep = 1 / (pattern.steps / (daw.project.timeSignature.numerator * 4));
    const currentStep = Math.floor((daw.currentBeat * pattern.steps) / (daw.project.timeSignature.numerator * 4)) % pattern.steps;

    return (
        <div className="h-full flex flex-col bg-[var(--daw-bg)] overflow-hidden">
            {/* Header */}
            <div className="h-7 flex items-center gap-3 px-3 border-b border-[var(--daw-border)] bg-[var(--daw-surface)] flex-shrink-0">
                <span className="text-xs text-white/60 font-medium">Step Sequencer</span>

                {/* Steps control */}
                <div className="flex items-center gap-1 ml-auto">
                    <span className="text-[10px] text-white/30">Steps</span>
                    <button
                        onClick={() => daw.setPatternSteps(Math.max(8, pattern.steps - 8))}
                        className="w-5 h-5 rounded bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/40"
                    >
                        <Minus className="h-2.5 w-2.5" />
                    </button>
                    <span className="text-xs text-white/60 w-6 text-center font-mono">{pattern.steps}</span>
                    <button
                        onClick={() => daw.setPatternSteps(Math.min(64, pattern.steps + 8))}
                        className="w-5 h-5 rounded bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/40"
                    >
                        <Plus className="h-2.5 w-2.5" />
                    </button>
                </div>

                {/* Swing */}
                <div className="flex items-center gap-1">
                    <span className="text-[10px] text-white/30">Swing</span>
                    <input
                        ref={swingRef}
                        type="range"
                        min={0}
                        max={100}
                        value={pattern.swing}
                        onChange={e => daw.setPatternSwing(Number(e.target.value))}
                        className="w-16 h-1 accent-orange-500"
                    />
                    <span className="text-[10px] text-white/40 w-6 text-right font-mono">{pattern.swing}%</span>
                </div>

                {/* Clear */}
                <button
                    onClick={() => daw.clearPattern()}
                    className="flex items-center gap-1 px-2 h-5 rounded bg-white/5 hover:bg-white/10 text-[10px] text-white/40 hover:text-white/60"
                >
                    <RotateCcw className="h-2.5 w-2.5" /> Clear
                </button>
            </div>

            {/* Step number row */}
            <div className="flex flex-shrink-0">
                <div className="w-[120px] flex-shrink-0" />
                <div className="flex-1 flex overflow-x-auto">
                    {Array.from({ length: pattern.steps }).map((_, step) => {
                        const isDownbeat = step % (pattern.steps / daw.project.timeSignature.numerator) === 0;
                        return (
                            <div
                                key={step}
                                className={cn(
                                    "flex-shrink-0 h-4 flex items-center justify-center text-[8px] font-mono border-r border-white/5",
                                    isDownbeat ? "text-white/30" : "text-white/10",
                                    daw.isPlaying && step === currentStep && "text-green-400"
                                )}
                                style={{ width: `${100 / pattern.steps}%`, minWidth: 20 }}
                            >
                                {step + 1}
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Pattern grid */}
            <div className="flex-1 overflow-y-auto">
                {pattern.tracks.map((drumTrack, trackIdx) => (
                    <div key={drumTrack.id} className="flex items-stretch border-b border-white/5 h-8">
                        {/* Drum track label */}
                        <div className="w-[120px] flex-shrink-0 flex items-center gap-1.5 px-2 bg-[var(--daw-surface)] border-r border-[var(--daw-border)]">
                            <div className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                            <span className="text-[10px] text-white/60 truncate flex-1">{drumTrack.name}</span>
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.01}
                                defaultValue={1}
                                className="w-10 h-0.5 accent-purple-500"
                            />
                        </div>

                        {/* Steps */}
                        <div className="flex-1 flex">
                            {drumTrack.steps.map((stepData, step) => {
                                const isDownbeat = step % (pattern.steps / daw.project.timeSignature.numerator) === 0;
                                const isCurrent = daw.isPlaying && step === currentStep;

                                const showMenu = (clientX: number, clientY: number) => {
                                    const items: MenuEntry[] = [
                                        { type: "label", label: `Step ${step + 1}` },
                                        { type: "separator" },
                                        { label: stepData.active ? "Deactivate Step" : "Activate Step", onClick: () => daw.toggleStep(trackIdx, step) },
                                        { type: "separator" },
                                        {
                                            type: "sub",
                                            label: `Velocity: ${stepData.velocity}`,
                                            items: [
                                                { label: "Soft (50)", onClick: () => daw.setStepVelocity(trackIdx, step, 50) },
                                                { label: "Medium (80)", onClick: () => daw.setStepVelocity(trackIdx, step, 80) },
                                                { label: "Hard (100)", onClick: () => daw.setStepVelocity(trackIdx, step, 100) },
                                                { label: "Max (127)", onClick: () => daw.setStepVelocity(trackIdx, step, 127) },
                                            ],
                                        },
                                    ];
                                    ctxMenu.show(clientX, clientY, items);
                                };

                                return (
                                    <StepButton
                                        key={step}
                                        active={stepData.active}
                                        velocity={stepData.velocity}
                                        isDownbeat={isDownbeat}
                                        isCurrent={isCurrent}
                                        widthPct={100 / pattern.steps}
                                        onToggle={() => daw.toggleStep(trackIdx, step)}
                                        onMenu={showMenu}
                                    />
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// Per-step button so we can attach a long-press hook (touch context menu).
function StepButton({
    active, velocity, isDownbeat, isCurrent, widthPct, onToggle, onMenu,
}: {
    active: boolean;
    velocity: number;
    isDownbeat: boolean;
    isCurrent: boolean;
    widthPct: number;
    onToggle: () => void;
    onMenu: (clientX: number, clientY: number) => void;
}) {
    const longPress = useLongPress((x, y) => onMenu(x, y));
    return (
        <button
            onClick={onToggle}
            onContextMenu={e => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
            {...longPress}
            className={cn(
                "flex-shrink-0 border-r border-white/5 transition-all relative",
                isDownbeat && "border-l border-l-white/10",
                active
                    ? "bg-purple-500/40 hover:bg-purple-500/50"
                    : "bg-transparent hover:bg-white/5",
                isCurrent && active && "bg-green-500/40",
                isCurrent && !active && "bg-green-500/10"
            )}
            style={{ width: `${widthPct}%`, minWidth: 20, touchAction: "manipulation" }}
        >
            {active && (
                <div
                    className="absolute inset-1 rounded-sm"
                    style={{
                        background: `rgba(168, 85, 247, ${velocity / 127 * 0.8 + 0.2})`,
                    }}
                />
            )}
        </button>
    );
}
