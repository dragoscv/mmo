"use client";

import { Monitor, CloudOff, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface TrackAvailabilityProps {
    deviceId: string | null | undefined;
    isDeviceOnline: boolean;
    isOfflineAvailable?: boolean | null;
    className?: string;
    compact?: boolean;
    deviceName?: string | null;
}

export function TrackAvailability({
    deviceId,
    isDeviceOnline,
    isOfflineAvailable,
    className,
    compact = true,
    deviceName,
}: TrackAvailabilityProps) {
    // Local tracks - no indicator needed
    if (!deviceId) return null;

    // Remote track available (device online or offline-cached)
    if (isDeviceOnline) {
        if (compact) {
            return (
                <span
                    className={cn("inline-flex items-center gap-1", className)}
                    title={`Available via ${deviceName || "device"}`}
                >
                    <Monitor className="h-3 w-3 text-green-400" />
                </span>
            );
        }
        return (
            <span
                className={cn("inline-flex items-center gap-1 text-xs text-green-400", className)}
                title={`Available via ${deviceName || "device"}`}
            >
                <Wifi className="h-3 w-3" />
                <span>{deviceName || "Online"}</span>
            </span>
        );
    }

    // Offline cached
    if (isOfflineAvailable) {
        if (compact) {
            return (
                <span
                    className={cn("inline-flex items-center gap-1", className)}
                    title="Available offline"
                >
                    <CloudOff className="h-3 w-3 text-blue-400" />
                </span>
            );
        }
        return (
            <span
                className={cn("inline-flex items-center gap-1 text-xs text-blue-400", className)}
                title="Available offline"
            >
                <CloudOff className="h-3 w-3" />
                <span>Offline</span>
            </span>
        );
    }

    // Unavailable
    if (compact) {
        return (
            <span
                className={cn("inline-flex items-center gap-1", className)}
                title={`Unavailable - ${deviceName || "device"} is offline`}
            >
                <WifiOff className="h-3 w-3 text-red-400/60" />
            </span>
        );
    }
    return (
        <span
            className={cn("inline-flex items-center gap-1 text-xs text-red-400/60", className)}
            title={`Unavailable - ${deviceName || "device"} is offline`}
        >
            <WifiOff className="h-3 w-3" />
            <span>Unavailable</span>
        </span>
    );
}
