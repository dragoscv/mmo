"use client";

/**
 * EditorPluginsPanel — VST3 / AU / LV2 chain editor for the Sound Editor.
 *
 * The editor works with in-memory AudioBuffers loaded via the File API,
 * which means we don't have a server-side filesystem path the companion
 * can hand to pedalboard. So this panel is chain-edit-only for v0.8.0:
 * the user builds their plugin chain, then triggers a render from a
 * destination that *does* have a path (a saved track in the library,
 * a recording on disk).
 *
 * The chain itself persists in component state so toggling the FX
 * sidebar doesn't lose work.
 */

import { useState } from "react";
import { PluginRack, type PluginChainSlot } from "@/components/plugins/plugin-rack";

export function EditorPluginsPanel() {
    const [chain, setChain] = useState<PluginChainSlot[]>([]);
    return (
        <PluginRack
            mode="compact"
            role="selection"
            title="Plugin chain"
            chain={chain}
            onChange={setChain}
        />
    );
}
