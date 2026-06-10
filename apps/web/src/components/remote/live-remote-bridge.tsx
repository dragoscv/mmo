"use client";

/**
 * LiveRemoteBridge — Drop this inside the Live page (within LiveProvider)
 * to start broadcasting state and handling remote commands.
 * Renders nothing.
 */

import { useRemoteLiveHost } from "./use-remote-live-host";

export function LiveRemoteBridge() {
    useRemoteLiveHost();
    return null;
}
