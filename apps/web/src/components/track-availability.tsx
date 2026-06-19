"use client";

import { Monitor, CloudOff, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Track availability badge with three states:
 *  - connected    → a source device is online; streamable now (green)
 *  - offline      → pinned in the browser's IndexedDB cache; playable
 *                   without any device (blue)
 *  - disconnected → metadata only; no online device, not cached (grey)
 *
 * Pass `state` directly (preferred, from cloud-library) or the legacy
 * deviceId/isDeviceOnline props which are mapped to a state.
 */
export type AvailabilityUiState = "connected" | "offline" | "disconnected";

interface TrackAvailabilityProps {
    /** Explicit state from the cloud resolver. Takes precedence. */
    state?: "connected" | "disconnected" | null;
    /** Whether the track is pinned in the browser offline cache. */
    isOfflineAvailable?: boolean | null;
    className?: string;
    compact?: boolean;
    deviceName?: string | null;
    // ── Legacy props (still accepted for back-compat) ──
    deviceId?: string | null;
    isDeviceOnline?: boolean;
}

function resolveState(p: TrackAvailabilityProps): AvailabilityUiState {
    if (p.isOfflineAvailable) return "offline";
    if (p.state) return p.state === "connected" ? "connected" : "disconnected";
    if (p.deviceId && p.isDeviceOnline) return "connected";
    return "disconnected";
}

export function TrackAvailability(props: TrackAvailabilityProps) {
    const { className, compact = true, deviceName } = props;
    const state = resolveState(props);

    if (state === "connected") {
        const title = `Available via ${deviceName || "device"}`;
        return compact ? (
            <span className={cn("inline-flex items-center gap-1", className)} title={title}>
                <Monitor className="h-3 w-3 text-green-400" />
            </span>
        ) : (
            <span className={cn("inline-flex items-center gap-1 text-xs text-green-400", className)} title={title}>
                <Wifi className="h-3 w-3" />
                <span>{deviceName || "Online"}</span>
            </span>
        );
    }

    if (state === "offline") {
        return compact ? (
            <span className={cn("inline-flex items-center gap-1", className)} title="Available offline">
                <CloudOff className="h-3 w-3 text-blue-400" />
            </span>
        ) : (
            <span className={cn("inline-flex items-center gap-1 text-xs text-blue-400", className)} title="Available offline">
                <CloudOff className="h-3 w-3" />
                <span>Offline</span>
            </span>
        );
    }

    const title = "Disconnected — no device online and not cached offline";
    return compact ? (
        <span className={cn("inline-flex items-center gap-1", className)} title={title}>
            <WifiOff className="h-3 w-3 text-zinc-500" />
        </span>
    ) : (
        <span className={cn("inline-flex items-center gap-1 text-xs text-zinc-500", className)} title={title}>
            <WifiOff className="h-3 w-3" />
            <span>Disconnected</span>
        </span>
    );
}
