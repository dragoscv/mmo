"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { usePersonalization, getMixerBackgroundStyle } from "@/hooks/use-personalization";
import { MidiProvider } from "@/hooks/use-midi";
import { RemoteHostBridge } from "@/components/remote/remote-host-bridge";
import { MixerRemoteBridge } from "@/components/remote/mixer-remote-bridge";
import { cn } from "@/lib/utils";

const MixerView = dynamic(
    () => import("@/components/mixer-view").then(m => ({ default: m.MixerView })),
    { ssr: false, loading: () => <div className="flex-1 flex items-center justify-center text-white/30">Loading mixer...</div> }
);

export default function MixerPage() {
    const personalization = usePersonalization();
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    return (
        <RemoteHostBridge page="mixer">
            <MidiProvider>
                <MixerRemoteBridge />
                <div className="relative flex flex-col h-full">
                    {/* Background — deferred to avoid SSR/client style mismatch */}
                    <div
                        className="absolute inset-0 bg-black transition-all duration-300"
                        style={mounted ? getMixerBackgroundStyle(personalization) : undefined}
                    />

                    {/* Mixer */}
                    <div
                        className="relative flex-1 min-h-0 flex flex-col"
                        style={{ fontSize: `${personalization.textScale * 100}%` }}
                    >
                        <MixerView />
                    </div>
                </div>
            </MidiProvider>
        </RemoteHostBridge>
    );
}
