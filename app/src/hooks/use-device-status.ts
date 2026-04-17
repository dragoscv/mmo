"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Device } from "@/db/schema";

interface DeviceStatusMap {
    [deviceId: string]: {
        online: boolean;
        name: string;
        lastChecked: number;
    };
}

const DEVICE_STATUS_KEY = "mmo-device-status";
const CHECK_INTERVAL = 30_000; // 30s

export function useDeviceStatus(devices: Device[] = []) {
    const [statuses, setStatuses] = useState<DeviceStatusMap>(() => {
        if (typeof window === "undefined") return {};
        try {
            return JSON.parse(localStorage.getItem(DEVICE_STATUS_KEY) || "{}");
        } catch {
            return {};
        }
    });
    const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

    const checkDevices = useCallback(async () => {
        const newStatuses: DeviceStatusMap = {};

        for (const device of devices) {
            try {
                const resp = await fetch(`${device.apiUrl}/health`, {
                    signal: AbortSignal.timeout(5_000),
                });
                newStatuses[device.id] = {
                    online: resp.ok,
                    name: device.name,
                    lastChecked: Date.now(),
                };
            } catch {
                newStatuses[device.id] = {
                    online: false,
                    name: device.name,
                    lastChecked: Date.now(),
                };
            }
        }

        setStatuses(newStatuses);
        localStorage.setItem(DEVICE_STATUS_KEY, JSON.stringify(newStatuses));
    }, [devices]);

    useEffect(() => {
        if (devices.length === 0) return;
        checkDevices();
        intervalRef.current = setInterval(checkDevices, CHECK_INTERVAL);
        return () => clearInterval(intervalRef.current);
    }, [devices, checkDevices]);

    const isDeviceOnline = useCallback(
        (deviceId: string | null | undefined): boolean => {
            if (!deviceId) return true; // Local tracks are always available
            return statuses[deviceId]?.online ?? false;
        },
        [statuses]
    );

    const getDeviceName = useCallback(
        (deviceId: string | null | undefined): string | null => {
            if (!deviceId) return null;
            return statuses[deviceId]?.name ?? null;
        },
        [statuses]
    );

    return { statuses, isDeviceOnline, getDeviceName, refresh: checkDevices };
}
