"use client";

/**
 * Devices page (client). Shows every companion the user has registered
 * with two configurable surfaces per device:
 *
 *   1. Library Folders — sourced from the companion (NOT the web DB).
 *      The user can pick folders via the OS-native dialog opened on the
 *      companion machine; no manual path entry, no copy/paste.
 *
 *   2. Audio Devices — physical input/output devices enumerated via
 *      RtAudio on the companion. The user toggles checkboxes to opt-in
 *      specific devices for use by the in-browser low-latency engine.
 *      Authorization is per-companion and persisted in electron-store.
 *
 * The audio surface is gated by a localhost detector — the engine only
 * runs when the web app itself is being served from 127.0.0.1, since
 * Web Audio (and ASIO/WASAPI bridging) cannot meet 3-5 ms latency over
 * a remote browser hop. We still let the user *configure* devices from
 * the cloud build (so the next localhost session is preset).
 */

import { useState, useTransition, useEffect, useCallback, useMemo, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { useRenderCount } from "@/lib/dev-debugger";
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
    Mic,
    Headphones,
    AlertTriangle,
    Globe,
    AudioLines,
    ChevronDown,
    Eye,
    EyeOff,
    FileMusic,
    Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import type { Device } from "@/db/schema";
import {
    removeDevice,
    renameDevice,
    pingDevice,
    getDeviceTrackCount,
    getDevices,
    getCompanionFolders,
    pickCompanionFolder,
    removeCompanionFolder,
    getCompanionAudioInventory,
    setCompanionAuthorizedAudioDevices,
    setCompanionFolderWatch,
    startCompanionScan,
    getCompanionScanJob,
    listCompanionScanJobs,
    ingestCompanionScanJob,
    pollCompanionWatchEvents,
} from "@/actions/devices";
import type {
    CompanionFolder,
    CompanionAudioInventory,
    AuthorizedAudioDevice,
    CompanionScanJob,
} from "@/lib/companion-control";

interface DevicesClientProps {
    initialDevices: Device[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isLocalhostHost(): boolean {
    if (typeof window === "undefined") return false;
    const h = window.location.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

function authKey(d: { name: string; direction: string; backend: string }) {
    return `${d.backend}::${d.direction}::${d.name}`;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function DevicesClient({ initialDevices }: DevicesClientProps) {
    useRenderCount("Page:/devices");
    const [devices, setDevices] = useState(initialDevices);
    const [isPending, startTransition] = useTransition();
    const [deviceStatuses, setDeviceStatuses] = useState<Record<string, boolean>>({});
    const [folders, setFolders] = useState<Record<string, CompanionFolder[]>>({});
    const [trackCounts, setTrackCounts] = useState<Record<string, number>>({});
    /** Per-folder scan progress, keyed by folder path. Lives across
     *  refreshes because we re-fetch from the companion on mount. */
    const [scanProgress, setScanProgress] = useState<Record<string, CompanionScanJob>>({});
    /** Per-device highest watcher event id we've ingested so far. */
    const watchHighWatermark = useRef<Record<string, number>>({});
    const [pickingFolder, setPickingFolder] = useState<string | null>(null);
    const [togglingWatch, setTogglingWatch] = useState<string | null>(null);
    const [editingName, setEditingName] = useState<string | null>(null);
    const [editNameValue, setEditNameValue] = useState("");
    const [openSection, setOpenSection] = useState<Record<string, "folders" | "audio" | null>>({});
    const [audioInv, setAudioInv] = useState<Record<string, CompanionAudioInventory | null>>({});
    const [audioLoading, setAudioLoading] = useState<Record<string, boolean>>({});
    const [isLocalhost, setIsLocalhost] = useState(false);

    useEffect(() => { setIsLocalhost(isLocalhostHost()); }, []);

    const refreshAll = useCallback(() => {
        for (const device of devices) {
            pingDevice(device.id).then((r) =>
                setDeviceStatuses((p) => ({ ...p, [device.id]: r.online })),
            );
            getDeviceTrackCount(device.id).then((c) =>
                setTrackCounts((p) => ({ ...p, [device.id]: c })),
            );
            getCompanionFolders(device.id).then((f) =>
                setFolders((p) => ({ ...p, [device.id]: f })),
            );
        }
    }, [devices]);

    useEffect(() => {
        refreshAll();
        const interval = setInterval(refreshAll, 30_000);
        return () => clearInterval(interval);
    }, [refreshAll]);

    // Auto-discover newly-registered companions
    useEffect(() => {
        const t = setInterval(async () => {
            const updated = await getDevices();
            setDevices(updated);
        }, 30_000);
        return () => clearInterval(t);
    }, []);

    // ─── Handlers ────────────────────────────────────────────────────────────

    function handleRemoveDevice(deviceId: string) {
        if (!confirm("Remove this device? Tracks scanned from it remain in your library.")) return;
        startTransition(async () => {
            await removeDevice(deviceId);
            setDevices((prev) => prev.filter((d) => d.id !== deviceId));
            toast.success("Device removed");
        });
    }

    function handleRenameDevice(deviceId: string) {
        if (!editNameValue.trim()) return;
        startTransition(async () => {
            await renameDevice(deviceId, editNameValue.trim());
            setDevices((prev) => prev.map((d) =>
                d.id === deviceId ? { ...d, name: editNameValue.trim() } : d,
            ));
            setEditingName(null);
            toast.success("Device renamed");
        });
    }

    async function handlePickFolder(deviceId: string) {
        setPickingFolder(deviceId);
        try {
            const r = await pickCompanionFolder(deviceId);
            if ("error" in r) { toast.error(r.error); return; }
            if (r.canceled) { toast.info("No folder picked"); return; }
            setFolders((p) => ({ ...p, [deviceId]: r.folders }));
            toast.success(`Added ${r.picked}`);
        } finally {
            setPickingFolder(null);
        }
    }

    function handleRemoveFolder(deviceId: string, folderPath: string) {
        startTransition(async () => {
            const updated = await removeCompanionFolder(deviceId, folderPath);
            setFolders((p) => ({ ...p, [deviceId]: updated }));
            toast.success("Folder removed");
        });
    }

    function handleScanFolder(deviceId: string, folderPath: string) {
        // Optimistic placeholder so the UI shows a bar immediately.
        setScanProgress((p) => ({
            ...p,
            [folderPath]: {
                id: "pending", folder: folderPath, status: "pending",
                discovered: 0, scanned: 0, errored: 0, currentFile: null,
                total: -1, startedAt: Date.now(), finishedAt: null, error: null,
                origin: "manual",
            },
        }));
        startTransition(async () => {
            const r = await startCompanionScan(deviceId, folderPath);
            if ("error" in r) {
                setScanProgress((p) => {
                    const next = { ...p }; delete next[folderPath]; return next;
                });
                toast.error(r.error);
                return;
            }
            setScanProgress((p) => ({ ...p, [folderPath]: { ...r.job, folder: folderPath } }));
        });
    }

    /** Poll any active scan jobs every ~750 ms until they complete. On
     *  completion, drain the tracks payload and ingest into the library.
     *  Survives refreshes because we hydrate from listCompanionScanJobs
     *  on mount (see effect below). */
    useEffect(() => {
        const active = Object.entries(scanProgress).filter(
            ([, job]) => job.status !== "complete" && job.status !== "error" && job.status !== "canceled",
        );
        if (active.length === 0) return;
        let stopped = false;
        const tick = async () => {
            for (const [folderPath, job] of active) {
                if (job.id === "pending") continue; // optimistic placeholder, wait for real id
                // Find which device owns this folder. (Folder paths are
                // companion-unique, but we still need the device for the IPC.)
                const owner = devices.find((d) => (folders[d.id] ?? []).some((f) => f.path === folderPath));
                if (!owner) continue;
                const r = await getCompanionScanJob(owner.id, job.id);
                if (stopped) return;
                if ("error" in r) continue;
                setScanProgress((p) => ({ ...p, [folderPath]: { ...r.job, folder: folderPath } }));
                if (r.job.status === "complete") {
                    // Pull tracks + ingest, then clear progress after a short
                    // celebratory pause so the user sees the “100% done” state.
                    const ingest = await ingestCompanionScanJob(owner.id, job.id);
                    if ("error" in ingest) {
                        toast.error(`Ingest failed: ${ingest.error}`);
                    } else {
                        toast.success(`Scan complete: ${ingest.inserted} new, ${ingest.skipped} skipped`);
                        // Refresh the device's track count.
                        const c = await getDeviceTrackCount(owner.id);
                        setTrackCounts((p) => ({ ...p, [owner.id]: c }));
                    }
                    setTimeout(() => {
                        setScanProgress((p) => {
                            const next = { ...p }; delete next[folderPath]; return next;
                        });
                    }, 2_500);
                } else if (r.job.status === "error") {
                    toast.error(`Scan failed: ${r.job.error ?? "unknown"}`);
                    setTimeout(() => {
                        setScanProgress((p) => {
                            const next = { ...p }; delete next[folderPath]; return next;
                        });
                    }, 5_000);
                }
            }
        };
        const handle = setInterval(tick, 750);
        return () => { stopped = true; clearInterval(handle); };
    }, [scanProgress, devices, folders]);

    /** On mount and whenever devices change, ask each companion for its
     *  in-flight scan jobs and drain queued watcher events. This is what
     *  makes scan progress survive a tab refresh. */
    useEffect(() => {
        let canceled = false;
        (async () => {
            for (const device of devices) {
                const jobs = await listCompanionScanJobs(device.id);
                if (canceled) return;
                for (const j of jobs) {
                    if (j.status === "pending" || j.status === "discovering" || j.status === "scanning") {
                        setScanProgress((p) => ({ ...p, [j.folder]: j }));
                    }
                }
            }
        })();
        return () => { canceled = true; };
    }, [devices]);

    /** Long-poll the watcher queue every 5 s. Whenever new files were
     *  dropped into a watched folder (even while the tab was closed) they
     *  get ingested here. */
    useEffect(() => {
        let canceled = false;
        const tick = async () => {
            for (const device of devices) {
                const since = watchHighWatermark.current[device.id] ?? 0;
                const r = await pollCompanionWatchEvents(device.id, since);
                if (canceled) return;
                if ("error" in r) continue;
                watchHighWatermark.current[device.id] = r.highWatermark;
                if (r.processed > 0) {
                    toast.success(`Watcher imported ${r.processed} new file${r.processed === 1 ? "" : "s"}`);
                    const c = await getDeviceTrackCount(device.id);
                    setTrackCounts((p) => ({ ...p, [device.id]: c }));
                }
            }
        };
        // Kick off immediately, then every 5 s.
        void tick();
        const handle = setInterval(tick, 5_000);
        return () => { canceled = true; clearInterval(handle); };
    }, [devices]);

    function handleToggleWatch(deviceId: string, folderPath: string, watch: boolean) {
        setTogglingWatch(folderPath);
        startTransition(async () => {
            const r = await setCompanionFolderWatch(deviceId, folderPath, watch);
            setTogglingWatch(null);
            if ("error" in r) { toast.error(r.error); return; }
            setFolders((p) => ({ ...p, [deviceId]: r.folders }));
            toast.success(watch ? "Auto-watch enabled" : "Auto-watch disabled");
        });
    }

    async function loadAudioInventory(deviceId: string) {
        setAudioLoading((p) => ({ ...p, [deviceId]: true }));
        try {
            const r = await getCompanionAudioInventory(deviceId);
            if ("error" in r) {
                toast.error(`Audio devices: ${r.error}`);
                setAudioInv((p) => ({ ...p, [deviceId]: null }));
            } else {
                setAudioInv((p) => ({ ...p, [deviceId]: r }));
            }
        } finally {
            setAudioLoading((p) => ({ ...p, [deviceId]: false }));
        }
    }

    function toggleSection(deviceId: string, section: "folders" | "audio") {
        // Compute the next state from the *current* snapshot, then schedule
        // the side effect (audio fetch) for AFTER the state commits. Doing
        // it inside the setState updater triggers React's "setState during
        // render" warning because the fetch ultimately calls a server action
        // which schedules a router transition.
        const wasOpen = openSection[deviceId] === section;
        setOpenSection((prev) => ({ ...prev, [deviceId]: wasOpen ? null : section }));
        if (!wasOpen && section === "audio" && !audioInv[deviceId]) {
            queueMicrotask(() => { void loadAudioInventory(deviceId); });
        }
    }

    async function toggleAudioAuthorization(
        deviceId: string,
        device: AuthorizedAudioDevice,
        currentlyAuthorized: boolean,
    ) {
        const inv = audioInv[deviceId];
        if (!inv) return;
        const key = authKey(device);
        const next = currentlyAuthorized
            ? inv.authorized.filter((a) => authKey(a) !== key)
            : [...inv.authorized, device];
        // Optimistic update
        setAudioInv((p) => ({ ...p, [deviceId]: { ...inv, authorized: next } }));
        const r = await setCompanionAuthorizedAudioDevices(deviceId, next);
        if ("error" in r) {
            toast.error(r.error);
            setAudioInv((p) => ({ ...p, [deviceId]: inv })); // rollback
        }
    }

    // ─── Render ──────────────────────────────────────────────────────────────

    return (
        <div className="max-w-4xl space-y-6">
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                    {devices.length} device{devices.length !== 1 ? "s" : ""} registered
                </p>
                <Button variant="outline" size="sm" onClick={refreshAll} disabled={isPending}>
                    <RefreshCw className={cn("mr-2 h-4 w-4", isPending && "animate-spin")} />
                    Refresh
                </Button>
            </div>

            {!isLocalhost && (
                <Card className="border-amber-500/30 bg-amber-500/5">
                    <CardContent className="flex items-start gap-3 py-3">
                        <Globe className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                        <div className="text-xs">
                            <p className="font-medium text-amber-300">You&apos;re viewing the cloud build</p>
                            <p className="mt-0.5 text-muted-foreground">
                                Audio device authorization is saved on the companion, but the in-browser
                                low-latency engine only runs when the web app is opened from <code className="rounded bg-background px-1">localhost:3000</code>.
                                For 3–5 ms live performance latency, run the web app locally.
                            </p>
                        </div>
                    </CardContent>
                </Card>
            )}

            {devices.length === 0 ? (
                <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                        <Server className="mb-4 h-12 w-12 text-muted-foreground/30" />
                        <h3 className="mb-1 font-semibold">No devices connected</h3>
                        <p className="max-w-md text-sm text-muted-foreground">
                            Install the MMO Companion app on your computers and sign in with your Google account.
                            Devices appear here automatically.
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-4">
                    {devices.map((device) => {
                        const isOnline = deviceStatuses[device.id] ?? false;
                        const dFolders = folders[device.id] ?? [];
                        const dCount = trackCounts[device.id] ?? 0;
                        const sectionOpen = openSection[device.id] ?? null;
                        const inv = audioInv[device.id];
                        return (
                            <DeviceCard
                                key={device.id}
                                device={device}
                                isOnline={isOnline}
                                trackCount={dCount}
                                folderCount={dFolders.length}
                                editingName={editingName === device.id}
                                editValue={editNameValue}
                                onEditStart={() => { setEditingName(device.id); setEditNameValue(device.name); }}
                                onEditChange={setEditNameValue}
                                onEditCancel={() => setEditingName(null)}
                                onEditSave={() => handleRenameDevice(device.id)}
                                onRemove={() => handleRemoveDevice(device.id)}
                                openSection={sectionOpen}
                                onToggleFolders={() => toggleSection(device.id, "folders")}
                                onToggleAudio={() => toggleSection(device.id, "audio")}
                            >
                                <AnimatePresence initial={false} mode="wait">
                                    {sectionOpen === "folders" && (
                                        <motion.div
                                            key="folders"
                                            initial={{ opacity: 0, height: 0 }}
                                            animate={{ opacity: 1, height: "auto" }}
                                            exit={{ opacity: 0, height: 0 }}
                                            transition={{ duration: 0.18 }}
                                            className="overflow-hidden"
                                        >
                                            <FolderSection
                                                folders={dFolders}
                                                isOnline={isOnline}
                                                isPicking={pickingFolder === device.id}
                                                scanProgress={scanProgress}
                                                togglingWatch={togglingWatch}
                                                onPick={() => handlePickFolder(device.id)}
                                                onScan={(p) => handleScanFolder(device.id, p)}
                                                onRemove={(p) => handleRemoveFolder(device.id, p)}
                                                onScanAll={() => {
                                                    for (const f of dFolders) handleScanFolder(device.id, f.path);
                                                }}
                                                onToggleWatch={(p, w) => handleToggleWatch(device.id, p, w)}
                                            />
                                        </motion.div>
                                    )}
                                    {sectionOpen === "audio" && (
                                        <motion.div
                                            key="audio"
                                            initial={{ opacity: 0, height: 0 }}
                                            animate={{ opacity: 1, height: "auto" }}
                                            exit={{ opacity: 0, height: 0 }}
                                            transition={{ duration: 0.18 }}
                                            className="overflow-hidden"
                                        >
                                            <AudioSection
                                                inventory={inv}
                                                loading={audioLoading[device.id] ?? false}
                                                isOnline={isOnline}
                                                isLocalhost={isLocalhost}
                                                onRefresh={() => loadAudioInventory(device.id)}
                                                onToggle={(d, was) => toggleAudioAuthorization(device.id, d, was)}
                                            />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </DeviceCard>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ─── Device card chrome ───────────────────────────────────────────────────────

interface DeviceCardProps {
    device: Device;
    isOnline: boolean;
    trackCount: number;
    folderCount: number;
    editingName: boolean;
    editValue: string;
    onEditStart: () => void;
    onEditChange: (v: string) => void;
    onEditCancel: () => void;
    onEditSave: () => void;
    onRemove: () => void;
    openSection: "folders" | "audio" | null;
    onToggleFolders: () => void;
    onToggleAudio: () => void;
    children: React.ReactNode;
}

function DeviceCard({
    device, isOnline, trackCount, folderCount, editingName, editValue,
    onEditStart, onEditChange, onEditCancel, onEditSave, onRemove,
    openSection, onToggleFolders, onToggleAudio, children,
}: DeviceCardProps) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
        >
            <Card className={cn(
                "transition-all duration-200",
                isOnline ? "border-green-500/20" : "border-border",
            )}>
                <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className={cn(
                                "flex h-10 w-10 items-center justify-center rounded-lg",
                                isOnline ? "bg-green-500/10" : "bg-muted",
                            )}>
                                <Monitor className={cn(
                                    "h-5 w-5",
                                    isOnline ? "text-green-400" : "text-muted-foreground",
                                )} />
                            </div>
                            <div>
                                {editingName ? (
                                    <div className="flex items-center gap-1">
                                        <Input
                                            value={editValue}
                                            onChange={(e) => onEditChange(e.target.value)}
                                            className="h-7 w-40 text-sm"
                                            onKeyDown={(e) => e.key === "Enter" && onEditSave()}
                                            autoFocus
                                        />
                                        <Button size="icon-xs" variant="ghost" onClick={onEditSave}>
                                            <Check className="h-3 w-3" />
                                        </Button>
                                        <Button size="icon-xs" variant="ghost" onClick={onEditCancel}>
                                            <X className="h-3 w-3" />
                                        </Button>
                                    </div>
                                ) : (
                                    <CardTitle className="flex items-center gap-2 text-base">
                                        {device.name}
                                        <button
                                            onClick={onEditStart}
                                            className="cursor-pointer text-muted-foreground hover:text-foreground"
                                        >
                                            <Pencil className="h-3 w-3" />
                                        </button>
                                    </CardTitle>
                                )}
                                <div className="mt-0.5 flex items-center gap-2">
                                    <Badge variant={isOnline ? "default" : "secondary"} className="h-5 text-[10px]">
                                        {isOnline ? <><Wifi className="mr-1 h-2.5 w-2.5" />Online</>
                                            : <><WifiOff className="mr-1 h-2.5 w-2.5" />Offline</>}
                                    </Badge>
                                    {device.os && (
                                        <span className="text-xs capitalize text-muted-foreground">
                                            {device.os === "win32" ? "Windows" : device.os === "darwin" ? "macOS" : device.os}
                                        </span>
                                    )}
                                    {device.hostname && (
                                        <span className="font-mono text-xs text-muted-foreground">{device.hostname}</span>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-1">
                            <SectionToggleButton
                                active={openSection === "folders"}
                                onClick={onToggleFolders}
                                icon={<HardDrive className="h-4 w-4" />}
                                label="Folders"
                                count={folderCount}
                            />
                            <SectionToggleButton
                                active={openSection === "audio"}
                                onClick={onToggleAudio}
                                icon={<AudioLines className="h-4 w-4" />}
                                label="Audio"
                            />
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-red-400 hover:text-red-300"
                                onClick={onRemove}
                            >
                                <Trash2 className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                </CardHeader>

                <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                            <HardDrive className="h-3 w-3" />
                            {folderCount} folder{folderCount !== 1 ? "s" : ""}
                        </span>
                        <span>{trackCount} tracks</span>
                        <span className="font-mono">{device.apiUrl}</span>
                        {device.lastSeenAt && (
                            <span>Last seen: {new Date(device.lastSeenAt).toLocaleString()}</span>
                        )}
                    </div>
                    {children}
                </CardContent>
            </Card>
        </motion.div>
    );
}

function SectionToggleButton({
    active, onClick, icon, label, count,
}: {
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
    count?: number;
}) {
    return (
        <Button
            variant={active ? "secondary" : "ghost"}
            size="sm"
            onClick={onClick}
            className="h-8 gap-1.5"
        >
            {icon}
            <span className="text-xs">{label}</span>
            {count !== undefined && count > 0 && (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">{count}</Badge>
            )}
            <ChevronDown className={cn("h-3 w-3 transition-transform", active && "rotate-180")} />
        </Button>
    );
}

// ─── Folder section ───────────────────────────────────────────────────────────

interface FolderSectionProps {
    folders: CompanionFolder[];
    isOnline: boolean;
    isPicking: boolean;
    scanProgress: Record<string, CompanionScanJob>;
    togglingWatch: string | null;
    onPick: () => void;
    onScan: (path: string) => void;
    onRemove: (path: string) => void;
    onScanAll: () => void;
    onToggleWatch: (path: string, watch: boolean) => void;
}

function FolderSection({
    folders, isOnline, isPicking, scanProgress, togglingWatch,
    onPick, onScan, onRemove, onScanAll, onToggleWatch,
}: FolderSectionProps) {
    const anyScanning = Object.values(scanProgress).some(
        (j) => j.status !== "complete" && j.status !== "error" && j.status !== "canceled",
    );
    return (
        <div className="space-y-3 border-t border-border pt-3">
            <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Library Folders</h4>
                <Button
                    variant="outline"
                    size="xs"
                    onClick={onPick}
                    disabled={!isOnline || isPicking}
                    title={isOnline ? "Open folder picker on the companion" : "Device offline"}
                >
                    {isPicking ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <FolderPlus className="mr-1 h-3 w-3" />}
                    Pick Folder…
                </Button>
            </div>

            {folders.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-6 text-center">
                    <FolderSearch className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
                    <p className="text-xs text-muted-foreground">
                        No folders configured. Click <span className="font-medium">Pick Folder…</span> to open the OS picker on the companion.
                    </p>
                </div>
            ) : (
                <ul className="space-y-2">
                    <AnimatePresence initial={false}>
                        {folders.map((folder) => (
                            <FolderRow
                                key={folder.path}
                                folder={folder}
                                isOnline={isOnline}
                                togglingWatch={togglingWatch === folder.path}
                                progress={scanProgress[folder.path]}
                                onScan={() => onScan(folder.path)}
                                onRemove={() => onRemove(folder.path)}
                                onToggleWatch={(w) => onToggleWatch(folder.path, w)}
                            />
                        ))}
                    </AnimatePresence>
                </ul>
            )}

            {folders.length > 0 && isOnline && (
                <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled={anyScanning}
                    onClick={onScanAll}
                >
                    {anyScanning
                        ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        : <ScanSearch className="mr-2 h-3.5 w-3.5" />}
                    {anyScanning ? "Scanning…" : "Scan All Folders"}
                </Button>
            )}
        </div>
    );
}

// ─── Per-folder row ──────────────────────────────────────────────────────────
//
// Lives outside FolderSection so its internal state survives parent re-renders.
// Also keeps the JSX of FolderSection tractable.

interface FolderRowProps {
    folder: CompanionFolder;
    isOnline: boolean;
    togglingWatch: boolean;
    progress: CompanionScanJob | undefined;
    onScan: () => void;
    onRemove: () => void;
    onToggleWatch: (watch: boolean) => void;
}

function FolderRow({
    folder, isOnline, togglingWatch, progress, onScan, onRemove, onToggleWatch,
}: FolderRowProps) {
    const isScanning = progress
        && progress.status !== "complete"
        && progress.status !== "error"
        && progress.status !== "canceled";
    const isComplete = progress?.status === "complete";
    const isError = progress?.status === "error";
    // Determinate percentage. -1 total = unknown (discovery phase) → barber-pole.
    const pct = progress && progress.total > 0
        ? Math.min(100, Math.round((progress.scanned / progress.total) * 100))
        : null;
    const isWatched = !!folder.watch;
    return (
        <motion.li
            layout
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={{ duration: 0.15 }}
            className={cn(
                "group rounded-lg border bg-background transition-colors",
                isScanning ? "border-purple-500/40 shadow-[0_0_0_1px_rgba(168,85,247,0.15)]"
                    : isComplete ? "border-green-500/40"
                        : isError ? "border-red-500/40"
                            : isWatched ? "border-blue-500/30"
                                : "border-border hover:border-ring",
            )}
        >
            <div className="flex items-center gap-2 px-3 py-2">
                <FolderSearch className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    folder.exists ? "text-muted-foreground" : "text-amber-400",
                )} />
                <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm">{folder.path}</p>
                    {!folder.exists && (
                        <p className="text-[11px] text-amber-400">Folder no longer exists on the companion</p>
                    )}
                </div>

                {/* Watch toggle */}
                <button
                    type="button"
                    role="switch"
                    aria-checked={isWatched}
                    aria-label={isWatched ? "Disable auto-watch" : "Enable auto-watch"}
                    disabled={togglingWatch || !isOnline || !folder.exists}
                    onClick={() => onToggleWatch(!isWatched)}
                    className={cn(
                        "relative flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        isWatched ? "bg-blue-500/80" : "bg-muted hover:bg-muted/80",
                    )}
                    title={isWatched ? "Auto-watch on — new files import automatically" : "Click to auto-watch this folder"}
                >
                    <motion.span
                        layout
                        transition={{ type: "spring", stiffness: 600, damping: 30 }}
                        className={cn(
                            "ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-white shadow",
                            isWatched && "translate-x-4",
                        )}
                    >
                        {togglingWatch
                            ? <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />
                            : isWatched
                                ? <Eye className="h-2.5 w-2.5 text-blue-600" />
                                : <EyeOff className="h-2.5 w-2.5 text-muted-foreground" />}
                    </motion.span>
                </button>

                <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={onScan}
                    disabled={!!isScanning || !isOnline || !folder.exists}
                    title={isOnline ? "Scan this folder" : "Device offline"}
                >
                    {isScanning
                        ? <Loader2 className="h-3 w-3 animate-spin" />
                        : isComplete
                            ? <Sparkles className="h-3 w-3 text-green-400" />
                            : <ScanSearch className="h-3 w-3" />}
                </Button>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-red-400 opacity-0 group-hover:opacity-100"
                    onClick={onRemove}
                    disabled={!!isScanning}
                >
                    <X className="h-3 w-3" />
                </Button>
            </div>

            {/* Progress / status bar */}
            <AnimatePresence initial={false}>
                {progress && (
                    <motion.div
                        key="progress"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden border-t border-border/60 bg-muted/30 px-3 py-2"
                    >
                        <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
                            <span className={cn(
                                "font-medium uppercase tracking-wider",
                                isComplete && "text-green-400",
                                isError && "text-red-400",
                                isScanning && "text-purple-400",
                            )}>
                                {progress.status === "discovering" && "Discovering files…"}
                                {progress.status === "scanning" && "Reading metadata"}
                                {progress.status === "complete" && "Done"}
                                {progress.status === "error" && "Failed"}
                                {progress.status === "pending" && "Starting…"}
                                {progress.status === "canceled" && "Canceled"}
                            </span>
                            <span className="font-mono tabular-nums text-muted-foreground">
                                {progress.status === "discovering"
                                    ? `${progress.discovered.toLocaleString()} found`
                                    : progress.total > 0
                                        ? `${progress.scanned.toLocaleString()} / ${progress.total.toLocaleString()}`
                                        : ""}
                                {pct !== null && <span className="ml-2 text-foreground">{pct}%</span>}
                            </span>
                        </div>
                        {/* Determinate bar when total is known, indeterminate barber-pole during discovery. */}
                        {pct !== null ? (
                            <Progress
                                value={pct}
                                className={cn(
                                    "h-1.5",
                                    isComplete && "[&>div]:bg-green-400",
                                    isError && "[&>div]:bg-red-400",
                                )}
                            />
                        ) : (
                            <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                                <motion.div
                                    className="absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-purple-500 to-transparent"
                                    animate={{ x: ["-100%", "300%"] }}
                                    transition={{ duration: 1.4, repeat: Infinity, ease: "linear" }}
                                />
                            </div>
                        )}
                        {/* Current file (truncated, monospace) */}
                        {progress.currentFile && isScanning && (
                            <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                                <FileMusic className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate font-mono">{progress.currentFile}</span>
                            </div>
                        )}
                        {progress.errored > 0 && (
                            <div className="mt-1 text-[10px] text-amber-400">
                                {progress.errored} file{progress.errored === 1 ? "" : "s"} could not be read
                            </div>
                        )}
                        {isError && progress.error && (
                            <div className="mt-1 text-[10px] text-red-400">{progress.error}</div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Watcher status footer (only when watching + no active scan) */}
            {isWatched && !progress && (
                <div className="flex items-center gap-1.5 border-t border-border/60 bg-blue-500/5 px-3 py-1.5 text-[10px] text-blue-300">
                    <Eye className="h-2.5 w-2.5" />
                    <span>Auto-importing new files</span>
                    {(folder.watchEvents ?? 0) > 0 && (
                        <span className="ml-auto font-mono">{folder.watchEvents} events</span>
                    )}
                    {folder.watchError && (
                        <span className="ml-auto text-amber-400">{folder.watchError}</span>
                    )}
                </div>
            )}
        </motion.li>
    );
}

// ─── Audio device section ─────────────────────────────────────────────────────

interface AudioSectionProps {
    inventory: CompanionAudioInventory | null | undefined;
    loading: boolean;
    isOnline: boolean;
    isLocalhost: boolean;
    onRefresh: () => void;
    onToggle: (device: AuthorizedAudioDevice, wasAuthorized: boolean) => void;
}

function AudioSection({
    inventory, loading, isOnline, isLocalhost, onRefresh, onToggle,
}: AudioSectionProps) {
    const authorizedKeys = useMemo(
        () => new Set((inventory?.authorized ?? []).map(authKey)),
        [inventory],
    );

    return (
        <div className="space-y-3 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
                <div>
                    <h4 className="text-sm font-medium">Authorized Audio Devices</h4>
                    <p className="text-[11px] text-muted-foreground">
                        Toggle which physical inputs/outputs the in-browser engine can access for low-latency live performance.
                    </p>
                </div>
                <Button variant="ghost" size="icon-sm" onClick={onRefresh} disabled={loading || !isOnline}>
                    <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
                </Button>
            </div>

            {!isLocalhost && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                        Authorizations are saved, but the engine only runs from <code className="rounded bg-background px-1">localhost:3000</code>.
                    </span>
                </div>
            )}

            {!isOnline && (
                <p className="rounded-md border border-dashed border-border py-4 text-center text-xs text-muted-foreground">
                    Companion offline — audio devices unavailable.
                </p>
            )}

            {loading && (
                <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
            )}

            {!loading && isOnline && inventory && (
                <div className="space-y-3">
                    {inventory.backends.length === 0 && (
                        <p className="text-center text-xs text-muted-foreground">No audio backends detected.</p>
                    )}
                    {inventory.backends.map((group) => (
                        <BackendGroup
                            key={group.backend}
                            group={group}
                            authorizedKeys={authorizedKeys}
                            onToggle={onToggle}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function BackendGroup({
    group, authorizedKeys, onToggle,
}: {
    group: NonNullable<CompanionAudioInventory["backends"][number]>;
    authorizedKeys: Set<string>;
    onToggle: (device: AuthorizedAudioDevice, wasAuthorized: boolean) => void;
}) {
    const inputs = group.devices.filter((d) => d.inputChannels > 0);
    const outputs = group.devices.filter((d) => d.outputChannels > 0);
    // Default: collapsed if backend unavailable or has no devices, else expanded.
    const [collapsed, setCollapsed] = useState(!group.available || group.devices.length === 0);
    const authorizedHere = useMemo(
        () => group.devices.filter((d) => {
            const inKey = `${group.backend}::input::${d.name}`;
            const outKey = `${group.backend}::output::${d.name}`;
            return authorizedKeys.has(inKey) || authorizedKeys.has(outKey);
        }).length,
        [group.devices, group.backend, authorizedKeys],
    );
    const headerId = `backend-${group.backend}-header`;
    const bodyId = `backend-${group.backend}-body`;
    return (
        <div className="overflow-hidden rounded-lg border border-border bg-background/50">
            <button
                type="button"
                id={headerId}
                aria-expanded={!collapsed}
                aria-controls={bodyId}
                onClick={() => setCollapsed((c) => !c)}
                className="flex w-full items-center justify-between border-b border-border px-3 py-2 text-left transition-colors hover:bg-muted/40"
            >
                <div className="flex items-center gap-2">
                    <motion.span
                        animate={{ rotate: collapsed ? -90 : 0 }}
                        transition={{ duration: 0.18 }}
                        className="text-muted-foreground"
                    >
                        <ChevronDown className="h-3.5 w-3.5" />
                    </motion.span>
                    <span className="text-xs font-semibold uppercase tracking-wider">{group.apiName}</span>
                    <Badge variant={group.available ? "default" : "secondary"} className="h-4 text-[9px]">
                        {group.available ? "Available" : "Unavailable"}
                    </Badge>
                    {authorizedHere > 0 && (
                        <Badge variant="outline" className="h-4 text-[9px]">
                            {authorizedHere} on
                        </Badge>
                    )}
                </div>
                <span className="text-[10px] text-muted-foreground">
                    {inputs.length} in · {outputs.length} out
                </span>
            </button>
            <AnimatePresence initial={false}>
                {!collapsed && (
                    <motion.div
                        id={bodyId}
                        role="region"
                        aria-labelledby={headerId}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: "easeInOut" }}
                        className="overflow-hidden"
                    >
                        {!group.available ? (
                            <p className="px-3 py-3 text-center text-[11px] text-muted-foreground">
                                Backend not available on this companion (driver missing or no devices).
                            </p>
                        ) : group.devices.length === 0 ? (
                            <p className="px-3 py-3 text-center text-[11px] text-muted-foreground">No devices.</p>
                        ) : (
                            <div className="grid gap-3 p-3 md:grid-cols-2">
                                <DirectionList
                                    title="Inputs"
                                    icon={<Mic className="h-3 w-3" />}
                                    devices={inputs}
                                    backend={group.backend}
                                    direction="input"
                                    authorizedKeys={authorizedKeys}
                                    onToggle={onToggle}
                                />
                                <DirectionList
                                    title="Outputs"
                                    icon={<Headphones className="h-3 w-3" />}
                                    devices={outputs}
                                    backend={group.backend}
                                    direction="output"
                                    authorizedKeys={authorizedKeys}
                                    onToggle={onToggle}
                                />
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

function DirectionList({
    title, icon, devices: devs, backend, direction, authorizedKeys, onToggle,
}: {
    title: string;
    icon: React.ReactNode;
    devices: CompanionAudioInventory["backends"][number]["devices"];
    backend: string;
    direction: "input" | "output";
    authorizedKeys: Set<string>;
    onToggle: (device: AuthorizedAudioDevice, wasAuthorized: boolean) => void;
}) {
    return (
        <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {icon}
                <span>{title}</span>
                <span className="ml-auto text-[10px] tracking-normal text-muted-foreground/60">
                    {devs.length}
                </span>
            </div>
            {devs.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/60">None</p>
            ) : (
                <ul className="space-y-1">
                    {devs.map((d) => {
                        const auth: AuthorizedAudioDevice = {
                            backend,
                            direction,
                            name: d.name,
                            preferredSampleRate: d.preferredSampleRate,
                        };
                        const isAuth = authorizedKeys.has(authKey(auth));
                        const isDefault = direction === "input" ? d.isDefaultInput : d.isDefaultOutput;
                        return (
                            <motion.li
                                key={`${d.id}-${d.name}`}
                                layout
                                whileHover={{ scale: 1.01 }}
                                className={cn(
                                    "flex cursor-pointer items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs transition-colors",
                                    isAuth ? "border-purple-500/40 bg-purple-500/5" : "hover:border-ring",
                                )}
                                onClick={() => onToggle(auth, isAuth)}
                            >
                                <Checkbox
                                    checked={isAuth}
                                    onChange={() => onToggle(auth, isAuth)}
                                    onClick={(e) => e.stopPropagation()}
                                />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate font-medium">{d.name}</p>
                                    <p className="text-[10px] text-muted-foreground">
                                        {direction === "input" ? `${d.inputChannels} ch in` : `${d.outputChannels} ch out`}
                                        {" · "}{d.preferredSampleRate} Hz
                                        {isDefault && " · default"}
                                    </p>
                                </div>
                            </motion.li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
