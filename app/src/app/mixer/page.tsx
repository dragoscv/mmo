"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { usePersonalization, getMixerBackgroundStyle } from "@/hooks/use-personalization";
import { useMixerActions } from "@/components/mixer-context";
import { RemoteHostBridge } from "@/components/remote/remote-host-bridge";
import { MixerRemoteBridge } from "@/components/remote/mixer-remote-bridge";
import { cn } from "@/lib/utils";

const MixerView = dynamic(
    () => import("@/components/mixer-view").then(m => ({ default: m.MixerView })),
    { ssr: false, loading: () => <div className="flex-1 flex items-center justify-center text-white/30">Loading mixer...</div> }
);

// Cinematic background is heavy-ish (canvas2D + RAF loop). Lazy-load
// only when the user has it selected so the default-blur path stays
// zero-cost for everyone else.
const MixerCinematicBackground = dynamic(
    () => import("@/components/mixer-cinematic-background").then(m => ({ default: m.MixerCinematicBackground })),
    { ssr: false },
);

export default function MixerPage() {
    const personalization = usePersonalization();
    const actions = useMixerActions();
    const [mounted, setMounted] = useState(false);
    const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only mount detection for SSR safety
    useEffect(() => setMounted(true), []);
    // Pull the master analyser once mounted; safe to no-op if engine
    // isn't ready yet (the cinematic scene falls back to drift-only).
    useEffect(() => {
        if (!mounted) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- async engine ready; cannot derive
        setAnalyser(actions.getMasterAnalyser());
    }, [mounted, actions]);

    const isCinematic = personalization.mixerBackground === "cinematic";

    return (
        <RemoteHostBridge page="mixer">
            <MixerRemoteBridge />
            <div className="relative flex flex-col h-full">
                {/* Background — deferred to avoid SSR/client style mismatch */}
                <div
                    className={cn(
                        "absolute inset-0 transition-all duration-300",
                        isCinematic ? "bg-transparent" : "bg-black",
                    )}
                    style={mounted && !isCinematic ? getMixerBackgroundStyle(personalization) : undefined}
                />
                {mounted && isCinematic && (
                    <MixerCinematicBackground analyser={analyser} reactivity={0.6} />
                )}

                {/* Mixer */}
                <div
                    className="relative flex-1 min-h-0 flex flex-col"
                    style={{ fontSize: `${personalization.textScale * 100}%` }}
                >
                    <MixerView />
                </div>
            </div>
        </RemoteHostBridge>
    );
}
