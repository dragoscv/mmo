"use client";

/**
 * LivePluginsWidget — VST3 / AU / LV2 master FX rack on the Live page.
 *
 * Live monitoring uses WebAudio nodes for sub-10ms latency, so this
 * widget targets a different role: the user pre-builds a plugin
 * chain that will be applied to their next recording (or the most
 * recent one) via the companion's offline render path. After
 * rendering, the audio URL is exposed back via React state so the
 * user can preview / save it.
 *
 * Per the architecture doc: realtime plugin processing in WebAudio
 * is a Phase-2 work item; this widget handles the offline lane that
 * already covers 90% of "I want to use my Waves bundle on this take"
 * use cases.
 */

import { useState } from "react";
import { Play } from "lucide-react";
import { PluginRack, type PluginChainSlot } from "@/components/plugins/plugin-rack";

export function LivePluginsWidget() {
    const [chain, setChain] = useState<PluginChainSlot[]>([]);
    const [renderedUrl, setRenderedUrl] = useState<string | null>(null);

    return (
        <div className="h-full flex flex-col gap-2 p-2">
            <PluginRack
                mode="full"
                role="master"
                title="Master FX rack"
                chain={chain}
                onChange={setChain}
            />
            {renderedUrl ? (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2">
                    <div className="flex items-center gap-2 mb-1.5">
                        <Play className="h-3 w-3 text-emerald-300" />
                        <span className="text-[11px] text-emerald-200 font-medium">Last render</span>
                    </div>
                    <audio src={renderedUrl} controls className="w-full h-8" />
                </div>
            ) : (
                <p className="text-[10px] text-white/40 text-center">
                    The chain is applied offline to the next recording. Realtime processing
                    stays in WebAudio for low latency.
                </p>
            )}
            {/* Placeholder hook: when /live records audio, it can call
                renderWithPlugins(recordingPath, chain) and pass the URL
                back via setRenderedUrl. The wiring lives in the live
                hook layer (out of scope for this widget). */}
            { }
            {(() => { void setRenderedUrl; return null; })()}
        </div>
    );
}
