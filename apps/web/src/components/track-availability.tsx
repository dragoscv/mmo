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
    /** Number of distinct devices that hold this track's file. When >1 a
     *  small count is shown next to the badge. */
    sourceCount?: number | null;
    /** Names of the source devices (online first), shown in the tooltip. */
    sourceDeviceNames?: string[] | null;
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

/** Build the human tooltip describing where a track lives. */
export function sourcesSummary(names: string[] | null | undefined, count: number): string | null {
    const list = (names ?? []).filter(Boolean);
    if (list.length === 0) return null;
    if (count <= 1) return list[0];
    const shown = list.slice(0, 4).join(", ");
    const extra = count - Math.min(list.length, 4);
    return `On ${count} devices: ${shown}${extra > 0 ? `, +${extra} more` : ""}`;
}

export function TrackAvailability(props: TrackAvailabilityProps) {
    const { className, compact = true, deviceName, sourceCount, sourceDeviceNames } = props;
    const state = resolveState(props);
    const count = sourceCount ?? 0;
    const multi = count > 1;
    const summary = sourcesSummary(sourceDeviceNames, count);

    if (state === "connected") {
        const title = summary
            ? `Available · ${summary}`
            : `Available via ${deviceName || "device"}`;
        return compact ? (
            <span className={cn("inline-flex items-center gap-1", className)} title={title}>
                <Monitor className="h-3 w-3 text-green-400" />
                {multi && <span className="text-[10px] leading-none text-green-400">{count}</span>}
            </span>
        ) : (
            <span className={cn("inline-flex items-center gap-1 text-xs text-green-400", className)} title={title}>
                <Wifi className="h-3 w-3" />
                <span>{multi ? `${count} devices` : deviceName || "Online"}</span>
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

    const title = summary
        ? `Disconnected — last seen on ${summary}`
        : "Disconnected — no device online and not cached offline";
    return compact ? (
        <span className={cn("inline-flex items-center gap-1", className)} title={title}>
            <WifiOff className="h-3 w-3 text-zinc-500" />
            {multi && <span className="text-[10px] leading-none text-zinc-500">{count}</span>}
        </span>
    ) : (
        <span className={cn("inline-flex items-center gap-1 text-xs text-zinc-500", className)} title={title}>
            <WifiOff className="h-3 w-3" />
            <span>Disconnected</span>
        </span>
    );
}
