"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
    Monitor,
    Trash2,
    RefreshCw,
    Loader2,
    Wifi,
    WifiOff,
    FolderPlus,
    FolderSearch,
    ScanSearch,
    Check,
    X,
    Pencil,
    Server,
    HardDrive,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Device, DeviceFolder } from "@/db/schema";
import {
    removeDevice,
    renameDevice,
    pingDevice,
    getDeviceFolders,
    addDeviceFolder,
    removeDeviceFolder,
    scanDeviceFolder,
    getDeviceTrackCount,
    getDevices,
} from "@/actions/devices";

interface DevicesClientProps {
    initialDevices: Device[];
}

export function DevicesClient({ initialDevices }: DevicesClientProps) {
    const [devices, setDevices] = useState(initialDevices);
    const [isPending, startTransition] = useTransition();
    const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
    const [deviceStatuses, setDeviceStatuses] = useState<Record<string, boolean>>({});
    const [deviceFolders, setDeviceFolders] = useState<Record<string, DeviceFolder[]>>({});
    const [deviceTrackCounts, setDeviceTrackCounts] = useState<Record<string, number>>({});
    const [scanningFolder, setScanningFolder] = useState<string | null>(null);
    const [editingName, setEditingName] = useState<string | null>(null);
    const [editNameValue, setEditNameValue] = useState("");
    const [newFolderPath, setNewFolderPath] = useState("");
    const [addFolderDeviceId, setAddFolderDeviceId] = useState<string | null>(null);

    // Ping all devices on mount
    const checkAllDevices = useCallback(() => {
        for (const device of devices) {
            pingDevice(device.id).then(result => {
                setDeviceStatuses(prev => ({ ...prev, [device.id]: result.online }));
            });
            getDeviceTrackCount(device.id).then(count => {
                setDeviceTrackCounts(prev => ({ ...prev, [device.id]: count }));
            });
            getDeviceFolders(device.id).then(folders => {
                setDeviceFolders(prev => ({ ...prev, [device.id]: folders }));
            });
        }
    }, [devices]);

    useEffect(() => {
        checkAllDevices();
        // Refresh every 30s
        const interval = setInterval(checkAllDevices, 30_000);
        return () => clearInterval(interval);
    }, [checkAllDevices]);

    function handleRemoveDevice(deviceId: string) {
        if (!confirm("Remove this device? Tracks from this device will remain in your library.")) return;

        startTransition(async () => {
            await removeDevice(deviceId);
            setDevices(prev => prev.filter(d => d.id !== deviceId));
            toast.success("Device removed");
        });
    }

    function handleRenameDevice(deviceId: string) {
        if (!editNameValue.trim()) return;

        startTransition(async () => {
            await renameDevice(deviceId, editNameValue.trim());
            setDevices(prev => prev.map(d =>
                d.id === deviceId ? { ...d, name: editNameValue.trim() } : d
            ));
            setEditingName(null);
            toast.success("Device renamed");
        });
    }

    function handleAddFolder(deviceId: string) {
        if (!newFolderPath.trim()) return;

        startTransition(async () => {
            await addDeviceFolder(deviceId, newFolderPath.trim());
            const folders = await getDeviceFolders(deviceId);
            setDeviceFolders(prev => ({ ...prev, [deviceId]: folders }));
            setNewFolderPath("");
            setAddFolderDeviceId(null);
            toast.success("Folder added");
        });
    }

    function handleRemoveFolder(folderId: number, deviceId: string) {
        startTransition(async () => {
            await removeDeviceFolder(folderId);
            const folders = await getDeviceFolders(deviceId);
            setDeviceFolders(prev => ({ ...prev, [deviceId]: folders }));
            toast.success("Folder removed");
        });
    }

    function handleScanFolder(deviceId: string, folderPath: string) {
        setScanningFolder(folderPath);

        startTransition(async () => {
            const result = await scanDeviceFolder(deviceId, folderPath);
            setScanningFolder(null);

            if ("error" in result) {
                toast.error(result.error);
                return;
            }

            toast.success(
                `Scan complete: ${result.inserted} new tracks, ${result.skipped} skipped`
            );

            // Refresh folders and track counts
            const folders = await getDeviceFolders(deviceId);
            setDeviceFolders(prev => ({ ...prev, [deviceId]: folders }));
            const count = await getDeviceTrackCount(deviceId);
            setDeviceTrackCounts(prev => ({ ...prev, [deviceId]: count }));
        });
    }

    // Auto-refresh device list periodically (companion auto-registers)
    useEffect(() => {
        const refreshDevices = async () => {
            const updated = await getDevices();
            setDevices(updated);
        };
        const interval = setInterval(refreshDevices, 30_000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="max-w-4xl space-y-6">
            {/* Header Actions */}
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                    {devices.length} device{devices.length !== 1 ? "s" : ""} registered
                </p>
                <Button variant="outline" size="sm" onClick={checkAllDevices} disabled={isPending}>
                    <RefreshCw className={cn("mr-2 h-4 w-4", isPending && "animate-spin")} />
                    Refresh
                </Button>
            </div>

            {/* Devices List */}
            {devices.length === 0 ? (
                <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                        <Server className="h-12 w-12 text-muted-foreground/30 mb-4" />
                        <h3 className="font-semibold mb-1">No devices connected</h3>
                        <p className="text-sm text-muted-foreground max-w-md">
                            Install the MMO Companion app on your computers and sign in with your Google account.
                            Devices will appear here automatically.
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-4">
                    {devices.map((device) => {
                        const isOnline = deviceStatuses[device.id] ?? false;
                        const folders = deviceFolders[device.id] || [];
                        const trackCount = deviceTrackCounts[device.id] || 0;
                        const isExpanded = selectedDevice === device.id;

                        return (
                            <Card key={device.id} className={cn(
                                "transition-all duration-200",
                                isOnline ? "border-green-500/20" : "border-border"
                            )}>
                                <CardHeader className="pb-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className={cn(
                                                "flex h-10 w-10 items-center justify-center rounded-lg",
                                                isOnline ? "bg-green-500/10" : "bg-muted"
                                            )}>
                                                <Monitor className={cn(
                                                    "h-5 w-5",
                                                    isOnline ? "text-green-400" : "text-muted-foreground"
                                                )} />
                                            </div>
                                            <div>
                                                {editingName === device.id ? (
                                                    <div className="flex items-center gap-1">
                                                        <Input
                                                            value={editNameValue}
                                                            onChange={(e) => setEditNameValue(e.target.value)}
                                                            className="h-7 w-40 text-sm"
                                                            onKeyDown={(e) => e.key === "Enter" && handleRenameDevice(device.id)}
                                                            autoFocus
                                                        />
                                                        <Button size="icon-xs" variant="ghost" onClick={() => handleRenameDevice(device.id)}>
                                                            <Check className="h-3 w-3" />
                                                        </Button>
                                                        <Button size="icon-xs" variant="ghost" onClick={() => setEditingName(null)}>
                                                            <X className="h-3 w-3" />
                                                        </Button>
                                                    </div>
                                                ) : (
                                                    <CardTitle className="flex items-center gap-2 text-base">
                                                        {device.name}
                                                        <button
                                                            onClick={() => {
                                                                setEditingName(device.id);
                                                                setEditNameValue(device.name);
                                                            }}
                                                            className="text-muted-foreground hover:text-foreground cursor-pointer"
                                                        >
                                                            <Pencil className="h-3 w-3" />
                                                        </button>
                                                    </CardTitle>
                                                )}
                                                <div className="flex items-center gap-2 mt-0.5">
                                                    <Badge variant={isOnline ? "default" : "secondary"} className="text-[10px] h-5">
                                                        {isOnline ? (
                                                            <><Wifi className="h-2.5 w-2.5 mr-1" />Online</>
                                                        ) : (
                                                            <><WifiOff className="h-2.5 w-2.5 mr-1" />Offline</>
                                                        )}
                                                    </Badge>
                                                    {device.os && (
                                                        <span className="text-xs text-muted-foreground capitalize">
                                                            {device.os === "win32" ? "Windows" : device.os === "darwin" ? "macOS" : device.os}
                                                        </span>
                                                    )}
                                                    {device.hostname && (
                                                        <span className="text-xs text-muted-foreground font-mono">
                                                            {device.hostname}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-1">
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                onClick={() => setSelectedDevice(isExpanded ? null : device.id)}
                                            >
                                                <FolderSearch className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                className="text-red-400 hover:text-red-300"
                                                onClick={() => handleRemoveDevice(device.id)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                </CardHeader>

                                <CardContent className="space-y-3">
                                    {/* Stats Row */}
                                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                        <span className="flex items-center gap-1">
                                            <HardDrive className="h-3 w-3" />
                                            {folders.length} folder{folders.length !== 1 ? "s" : ""}
                                        </span>
                                        <span>{trackCount} tracks</span>
                                        <span className="font-mono">{device.apiUrl}</span>
                                        {device.lastSeenAt && (
                                            <span>Last seen: {new Date(device.lastSeenAt).toLocaleString()}</span>
                                        )}
                                    </div>

                                    {/* Expanded: Folders */}
                                    {isExpanded && (
                                        <div className="space-y-3 pt-2 border-t border-border animate-[fadeIn_150ms_ease-out]">
                                            <div className="flex items-center justify-between">
                                                <h4 className="text-sm font-medium">Library Folders</h4>
                                                <Button
                                                    variant="outline"
                                                    size="xs"
                                                    onClick={() => setAddFolderDeviceId(device.id)}
                                                >
                                                    <FolderPlus className="mr-1 h-3 w-3" />
                                                    Add Folder
                                                </Button>
                                            </div>

                                            {/* Add folder input */}
                                            {addFolderDeviceId === device.id && (
                                                <div className="flex gap-2">
                                                    <Input
                                                        value={newFolderPath}
                                                        onChange={(e) => setNewFolderPath(e.target.value)}
                                                        placeholder="Enter folder path (e.g. H:\Music)"
                                                        className="flex-1 font-mono text-xs"
                                                        onKeyDown={(e) => e.key === "Enter" && handleAddFolder(device.id)}
                                                        autoFocus
                                                    />
                                                    <Button size="sm" onClick={() => handleAddFolder(device.id)} disabled={isPending}>
                                                        Add
                                                    </Button>
                                                    <Button size="sm" variant="ghost" onClick={() => setAddFolderDeviceId(null)}>
                                                        <X className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            )}

                                            {/* Folder list */}
                                            {folders.length === 0 ? (
                                                <p className="text-xs text-muted-foreground py-4 text-center">
                                                    No folders configured. Add a folder to start scanning.
                                                </p>
                                            ) : (
                                                <div className="space-y-1.5">
                                                    {folders.map((folder) => (
                                                        <div
                                                            key={folder.id}
                                                            className="flex items-center gap-2 rounded-lg bg-background border border-border px-3 py-2 group hover:border-ring transition-colors"
                                                        >
                                                            <FolderSearch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-sm font-mono truncate">{folder.path}</p>
                                                                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                                                                    {folder.trackCount !== null && <span>{folder.trackCount} tracks</span>}
                                                                    {folder.lastScannedAt && (
                                                                        <span>Scanned: {new Date(folder.lastScannedAt).toLocaleString()}</span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon-xs"
                                                                onClick={() => handleScanFolder(device.id, folder.path)}
                                                                disabled={scanningFolder === folder.path || !isOnline}
                                                                title={isOnline ? "Scan folder" : "Device offline"}
                                                            >
                                                                {scanningFolder === folder.path ? (
                                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                                ) : (
                                                                    <ScanSearch className="h-3 w-3" />
                                                                )}
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                size="icon-xs"
                                                                className="opacity-0 group-hover:opacity-100 text-red-400"
                                                                onClick={() => handleRemoveFolder(folder.id, device.id)}
                                                            >
                                                                <X className="h-3 w-3" />
                                                            </Button>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}

                                            {/* Scan all button */}
                                            {folders.length > 0 && isOnline && (
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="w-full"
                                                    disabled={isPending || !!scanningFolder}
                                                    onClick={() => {
                                                        for (const folder of folders) {
                                                            handleScanFolder(device.id, folder.path);
                                                        }
                                                    }}
                                                >
                                                    <ScanSearch className="mr-2 h-3.5 w-3.5" />
                                                    Scan All Folders
                                                </Button>
                                            )}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}

        </div>
    );
}
