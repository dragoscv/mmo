"use client";

/**
 * MixerRemoteBridge — Drop this inside the Mixer page (within MixerProvider)
 * to start broadcasting state and handling remote commands.
 * Renders nothing.
 */

import { useRemoteMixerHost } from "./use-remote-mixer-host";

export function MixerRemoteBridge() {
    useRemoteMixerHost();
    return null;
}
