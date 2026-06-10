"use client";

import { useState, useTransition } from "react";
import { Cloud, HardDrive, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { setProcessingModeAction } from "@/actions/processing-mode";
import type { ProcessingMode } from "@/lib/processing-mode";

const OPTIONS: { value: ProcessingMode; label: string; desc: string; Icon: typeof Cloud }[] = [
    { value: "auto", label: "Auto", desc: "Try the companion first, fall back to cloud if offline.", Icon: Sparkles },
    { value: "companion", label: "Companion only", desc: "Always use the local companion. Never call the cloud.", Icon: HardDrive },
    { value: "cloud", label: "Cloud only", desc: "Always use Cloud Run GPUs. Companion is bypassed.", Icon: Cloud },
];

export function ProcessingModeSwitch({ initial }: { initial: ProcessingMode }) {
    const [mode, setMode] = useState<ProcessingMode>(initial);
    const [pending, startTransition] = useTransition();

    function update(next: ProcessingMode) {
        if (next === mode) return;
        const prev = mode;
        setMode(next);
        startTransition(async () => {
            const r = await setProcessingModeAction(next);
            if (!r.ok) {
                setMode(prev);
                toast.error(`Could not update processing mode: ${r.error}`);
            } else {
                toast.success(`Processing mode → ${next}`);
            }
        });
    }

    return (
        <div className="rounded-lg border bg-card p-4">
            <h2 className="text-base font-semibold mb-1">Processing mode</h2>
            <p className="text-sm text-muted-foreground mb-4">
                Where heavy work (song generation, stem split, voice TTS) runs.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
                {OPTIONS.map(({ value, label, desc, Icon }) => {
                    const active = mode === value;
                    return (
                        <button
                            key={value}
                            type="button"
                            disabled={pending}
                            onClick={() => update(value)}
                            className={[
                                "flex flex-col items-start gap-1 rounded-md border p-3 text-left transition",
                                active
                                    ? "border-primary bg-primary/10 ring-2 ring-primary/40"
                                    : "border-border hover:border-primary/50 hover:bg-accent",
                                pending ? "opacity-60 cursor-wait" : "",
                            ].join(" ")}
                        >
                            <div className="flex items-center gap-2">
                                <Icon className="h-4 w-4" />
                                <span className="font-medium">{label}</span>
                            </div>
                            <span className="text-xs text-muted-foreground">{desc}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
