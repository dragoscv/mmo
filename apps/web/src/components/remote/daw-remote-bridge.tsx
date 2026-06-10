"use client";

/**
 * DAWRemoteBridge — Drop this inside the DAW page (within DAWProvider)
 * to start broadcasting state and handling remote commands.
 * Renders nothing.
 */

import { useRemoteDAWHost } from "./use-remote-daw-host";

export function DAWRemoteBridge() {
    useRemoteDAWHost();
    return null;
}
