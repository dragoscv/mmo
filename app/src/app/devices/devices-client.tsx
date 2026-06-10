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
import { Select } from "@/components/ui/select";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
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
    ChevronRight,
    Eye,
    EyeOff,
    FileMusic,
    Sparkles,
    Folder,
    Home,
    ArrowUp,
    Terminal,
    Trash,
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
    removeCompanionFolder,
    getCompanionAudioInventory,
    setCompanionAuthorizedAudioDevices,
    setCompanionFolderWatch,
    startCompanionScan,
    getCompanionScanJob,
    listCompanionScanJobs,
    ingestCompanionScanJob,
    ingestCompanionVideoScanJob,
    pollCompanionWatchEvents,
    listCompanionDrives,
    listCompanionDirectory,
    addCompanionFolder,
    getDeviceDirectAccess,
} from "@/actions/devices";
import { directFetch } from "@/lib/companion-direct";
import { connectDeviceWs, type DeviceWsClient, type DeviceLogEntry } from "@/lib/device-ws";
import {
    FOLDER_KINDS,
    type CompanionFolder,
    type CompanionAudioInventory,
    type AuthorizedAudioDevice,
    type CompanionScanJob,
    type FolderKind,
    type CompanionDrive,
    type CompanionDirectoryEntry,
    type CompanionDirectoryListing,
} from "@/lib/companion-types";

/** Human-readable labels for folder kinds shown in the picker + badge. */
const FOLDER_KIND_LABELS: Record<FolderKind, string> = {
    music: "Music",
    movies: "Movies",
    "tv-shows": "TV Shows",
    samples: "Samples",
    recordings: "Recordings",
    other: "Other",
};

interface DevicesClientProps {
    initialDevices: Device[];
    /** Cached library folders (per device id) hydrated from the DB on the
     *  server. Lets the first paint show folders even when the companion
     *  is offline; the client refreshes from the live companion on mount. */
    initialFolders?: Record<string, CompanionFolder[]>;
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

export function DevicesClient({ initialDevices, initialFolders }: DevicesClientProps) {
    useRenderCount("Page:/devices");
    const [devices, setDevices] = useState(initialDevices);
    const [isPending, startTransition] = useTransition();
    const [deviceStatuses, setDeviceStatuses] = useState<Record<string, boolean>>({});
    const [folders, setFolders] = useState<Record<string, CompanionFolder[]>>(initialFolders ?? {});
    const [trackCounts, setTrackCounts] = useState<Record<string, number>>({});
    /** Per-folder scan progress, keyed by folder path. Lives across
     *  refreshes because we re-fetch from the companion on mount. */
    const [scanProgress, setScanProgress] = useState<Record<string, CompanionScanJob>>({});
    /** Last ingest result per folder path — persistent feedback that
     *  survives the ephemeral toast so the user always sees what landed
     *  in the cloud DB after a scan. */
    const [ingestSummary, setIngestSummary] = useState<Record<string, {
        ok: boolean;
        text: string;
        at: number;
    }>>({});
    /** Job IDs we've already kicked an ingest for. Prevents a double
     *  ingest when both the WS "complete" frame and the 750 ms poll
     *  observe the same transition. */
    const ingestedJobIds = useRef<Set<string>>(new Set());

    /** Pull a completed scan job's payload into the cloud DB and surface
     *  the result on the folder card + as a toast. Idempotent per jobId. */
    const runIngest = useCallback(async (
        deviceId: string,
        folderPath: string,
        job: CompanionScanJob,
    ) => {
        if (ingestedJobIds.current.has(job.id)) return;
        ingestedJobIds.current.add(job.id);
        if (job.kind === "video") {
            const ingest = await ingestCompanionVideoScanJob(deviceId, job.id);
            if ("error" in ingest) {
                toast.error(`Ingest failed: ${ingest.error}`, { duration: 12_000 });
                setIngestSummary((p) => ({ ...p, [folderPath]: { ok: false, text: `Ingest failed: ${ingest.error}`, at: Date.now() } }));
            } else {
                const parts: string[] = [];
                if (ingest.movies) parts.push(`${ingest.movies} movies`);
                if (ingest.shows) parts.push(`${ingest.shows} shows`);
                if (ingest.episodes) parts.push(`${ingest.episodes} episodes`);
                parts.push(`${ingest.files} files`);
                if (ingest.skipped) parts.push(`${ingest.skipped} skipped`);
                const text = parts.join(", ");
                toast.success(`Scan complete: ${text}`, { duration: 8_000 });
                setIngestSummary((p) => ({ ...p, [folderPath]: { ok: true, text, at: Date.now() } }));
            }
        } else {
            const ingest = await ingestCompanionScanJob(deviceId, job.id);
            if ("error" in ingest) {
                toast.error(`Ingest failed: ${ingest.error}`, { duration: 12_000 });
                setIngestSummary((p) => ({ ...p, [folderPath]: { ok: false, text: `Ingest failed: ${ingest.error}`, at: Date.now() } }));
            } else {
                const text = `${ingest.inserted} new, ${ingest.skipped} skipped (of ${ingest.total})`;
                toast.success(`Scan complete: ${text}`, { duration: 8_000 });
                setIngestSummary((p) => ({ ...p, [folderPath]: { ok: true, text, at: Date.now() } }));
                const c = await getDeviceTrackCount(deviceId);
                setTrackCounts((p) => ({ ...p, [deviceId]: c }));
            }
        }
        // Clear the progress bar a moment later so the user sees "100% done"
        // before the row collapses back to its idle state.
        setTimeout(() => {
            setScanProgress((p) => { const next = { ...p }; delete next[folderPath]; return next; });
        }, 2_500);
    }, []);

    /** Reactive ingest trigger. Runs every time scanProgress changes —
     *  whether the new state came from the 750 ms poll OR from the WS
     *  push frame. The `ingestedJobIds` ref dedupes so each job runs
     *  ingest exactly once across the two channels. */
    useEffect(() => {
        for (const [folderPath, job] of Object.entries(scanProgress)) {
            if (job.status !== "complete" || job.id === "pending") continue;
            if (ingestedJobIds.current.has(job.id)) continue;
            const owner = devices.find((d) => (folders[d.id] ?? []).some((f) => f.path === folderPath));
            if (!owner) continue;
            void runIngest(owner.id, folderPath, job);
        }
    }, [scanProgress, devices, folders, runIngest]);
    /** Per-device highest watcher event id we've ingested so far. */
    const watchHighWatermark = useRef<Record<string, number>>({});
    const [togglingWatch, setTogglingWatch] = useState<string | null>(null);
    /** Device whose Pick-Folder modal is open. Null = closed. */
    const [pickerDialogDevice, setPickerDialogDevice] = useState<string | null>(null);
    /** Pending kind selected inside the modal. */
    const [pendingPickKind, setPendingPickKind] = useState<FolderKind>("music");
    /** Drives + current listing for the in-modal folder browser. */
    const [browserDrives, setBrowserDrives] = useState<CompanionDrive[]>([]);
    const [browserCwd, setBrowserCwd] = useState<string | null>(null);
    const [browserEntries, setBrowserEntries] = useState<CompanionDirectoryEntry[]>([]);
    const [browserParent, setBrowserParent] = useState<string | null>(null);
    const [browserLoading, setBrowserLoading] = useState(false);
    const [browserError, setBrowserError] = useState<string | null>(null);
    const [browserAdding, setBrowserAdding] = useState(false);
    /** SWR-style caches so reopening the modal or back-clicking renders
     *  instantly and the network call only updates if data has shifted. */
    const drivesCacheRef = useRef<Map<string, CompanionDrive[]>>(new Map());
    const dirCacheRef = useRef<Map<string, CompanionDirectoryListing>>(new Map());
    /** In-flight prefetches we should not re-issue. Cleared on resolution. */
    const inflightRef = useRef<Set<string>>(new Set());
    /** Per-device {hostname, bearer} for the Cloudflare-Tunnel fast path.
     *  Fetched lazily on first need; falsy entry means "tried, none
     *  available" so we don't re-ask the server every call. */
    const directAccessRef = useRef<Map<string, { tunnelHostname: string; bearer: string } | null>>(new Map());
    /** Devices whose drives we've already prefetched this mount. */
    const drivesPrefetchedRef = useRef<Set<string>>(new Set());
    /** Surfaced in the picker modal so the user can see whether the
     *  request went over the fast tunnel path or the slow queue, and how
     *  long the round-trip took. Helps diagnose multi-second freezes
     *  caused by an unhealthy tunnel or a frozen companion event loop. */
    const [pickerDebug, setPickerDebug] = useState<{ op: string; via: "tunnel" | "queue"; reason?: "no-tunnel" | "tunnel-fail"; ms: number; n?: number; err?: string } | null>(null);
    const [editingName, setEditingName] = useState<string | null>(null);
    const [editNameValue, setEditNameValue] = useState("");
    const [openSection, setOpenSection] = useState<Record<string, "folders" | "audio" | "console" | null>>({});
    /** Per-device live log ring streamed from the companion over WS.
     *  Bounded so a chatty subsystem can't unbounded-grow client memory. */
    const [deviceLogs, setDeviceLogs] = useState<Record<string, DeviceLogEntry[]>>({});
    /** Per-device WS connection indicator so the console header can show
     *  “streaming” / “disconnected” without re-rendering the whole card. */
    const [deviceWsLive, setDeviceWsLive] = useState<Record<string, boolean>>({});
    const [audioInv, setAudioInv] = useState<Record<string, CompanionAudioInventory | null>>({});
    const [audioLoading, setAudioLoading] = useState<Record<string, boolean>>({});
    const [isLocalhost, setIsLocalhost] = useState(false);

    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only browser API hydration
    useEffect(() => { setIsLocalhost(isLocalhostHost()); }, []);

    // ─── Direct-tunnel fast path ────────────────────────────────────────────
    // We resolve { hostname, bearer } once per device per session and cache
    // it. Each call below tries the tunnel first and silently falls back
    // to the queue-based server action on any failure (network, 4xx, CF
    // outage, env not configured). The fallback path is what existed
    // before — no behavior regression possible, only speedup when the
    // tunnel is healthy.

    async function getDirectAccess(deviceId: string) {
        if (directAccessRef.current.has(deviceId)) return directAccessRef.current.get(deviceId);
        const access = await getDeviceDirectAccess(deviceId).catch(() => null);
        directAccessRef.current.set(deviceId, access);
        return access;
    }

    /** Hydrate the drives cache from localStorage on first render so the
     *  picker can paint the moment it opens — even before the first
     *  server round-trip completes. Stale entries (>24h) are dropped. */
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only browser API hydration
    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const raw = window.localStorage.getItem("mmo:picker:drives");
            if (!raw) return;
            const parsed = JSON.parse(raw) as Record<string, { at: number; drives: CompanionDrive[] }>;
            const now = Date.now();
            for (const [deviceId, entry] of Object.entries(parsed)) {
                if (entry && Array.isArray(entry.drives) && now - entry.at < 24 * 3_600_000) {
                    drivesCacheRef.current.set(deviceId, entry.drives);
                }
            }
        } catch { /* ignore corrupted cache */ }
    }, []);

    /** Write-through the in-memory drives cache to localStorage. */
    const persistDrivesCache = useCallback((deviceId: string, drives: CompanionDrive[]) => {
        drivesCacheRef.current.set(deviceId, drives);
        if (typeof window === "undefined") return;
        try {
            const raw = window.localStorage.getItem("mmo:picker:drives");
            const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, { at: number; drives: CompanionDrive[] }>;
            parsed[deviceId] = { at: Date.now(), drives };
            window.localStorage.setItem("mmo:picker:drives", JSON.stringify(parsed));
        } catch { /* quota / private mode — silently ignore */ }
    }, []);

    async function fastListDrives(deviceId: string): Promise<
        { drives: CompanionDrive[] } | { error: string }
    > {
        const t0 = performance.now();
        const target = await getDirectAccess(deviceId);
        if (target) {
            const r = await directFetch<{ drives: CompanionDrive[] }>(target, "/fs/drives");
            if (r) {
                const ms = Math.round(performance.now() - t0);
                console.log(`[picker] drives via tunnel in ${ms}ms (n=${r.drives.length})`);
                setPickerDebug({ op: "drives", via: "tunnel", ms, n: r.drives.length });
                return r;
            }
        }
        const reason: "no-tunnel" | "tunnel-fail" = target ? "tunnel-fail" : "no-tunnel";
        const r = await listCompanionDrives(deviceId);
        const ms = Math.round(performance.now() - t0);
        const tag = "error" in r ? `error=${r.error}` : `n=${r.drives.length}`;
        console.log(`[picker] drives via queue (${reason}) in ${ms}ms (${tag})`);
        setPickerDebug({
            op: "drives", via: "queue", reason, ms,
            n: "error" in r ? undefined : r.drives.length,
            err: "error" in r ? r.error : undefined,
        });
        return r;
    }

    async function fastListDirectory(deviceId: string, path: string): Promise<
        CompanionDirectoryListing | { error: string }
    > {
        const t0 = performance.now();
        const target = await getDirectAccess(deviceId);
        if (target) {
            const r = await directFetch<CompanionDirectoryListing>(
                target, `/fs/list?path=${encodeURIComponent(path)}`,
            );
            if (r) {
                const ms = Math.round(performance.now() - t0);
                console.log(`[picker] list "${path}" via tunnel in ${ms}ms (n=${r.entries.length})`);
                setPickerDebug({ op: "list", via: "tunnel", ms, n: r.entries.length });
                return r;
            }
        }
        const reason: "no-tunnel" | "tunnel-fail" = target ? "tunnel-fail" : "no-tunnel";
        const r = await listCompanionDirectory(deviceId, path);
        const ms = Math.round(performance.now() - t0);
        const tag = "error" in r ? `error=${r.error}` : `n=${r.entries.length}`;
        console.log(`[picker] list "${path}" via queue (${reason}) in ${ms}ms (${tag})`);
        setPickerDebug({
            op: "list", via: "queue", reason, ms,
            n: "error" in r ? undefined : r.entries.length,
            err: "error" in r ? r.error : undefined,
        });
        return r;
    }

    async function fastAddFolder(deviceId: string, path: string, kind: FolderKind): Promise<
        { added: boolean; picked: string; folders: CompanionFolder[] } | { error: string }
    > {
        const t0 = performance.now();
        const target = await getDirectAccess(deviceId);
        if (target) {
            const r = await directFetch<{ added: boolean; picked: string; folders: CompanionFolder[] }>(
                target, "/fs/add", { method: "POST", body: JSON.stringify({ path, kind }) },
            );
            if (r) {
                console.log(`[picker] add "${path}" via tunnel in ${Math.round(performance.now() - t0)}ms`);
                return r;
            }
        }
        const r = await addCompanionFolder(deviceId, path, kind);
        console.log(`[picker] add "${path}" via queue in ${Math.round(performance.now() - t0)}ms`);
        return r;
    }

    /** Fast folder removal via tunnel; falls back to the queue path. */
    async function fastRemoveFolder(deviceId: string, path: string): Promise<CompanionFolder[]> {
        const t0 = performance.now();
        const target = await getDirectAccess(deviceId);
        if (target) {
            const r = await directFetch<{ success: boolean; folders: CompanionFolder[] }>(
                target, "/folders/remove", { method: "POST", body: JSON.stringify({ path }) },
            );
            if (r) {
                console.log(`[folders] remove "${path}" via tunnel in ${Math.round(performance.now() - t0)}ms`);
                return r.folders ?? [];
            }
        }
        const folders = await removeCompanionFolder(deviceId, path);
        console.log(`[folders] remove "${path}" via queue in ${Math.round(performance.now() - t0)}ms`);
        return folders;
    }

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

    // Eager prefetch: warm the direct-access + drives caches for every
    // device on mount and whenever a new device appears. By the time the
    // user clicks "Add a folder" the modal can paint from cache in <1ms
    // instead of waiting for two cold round-trips (server action for the
    // tunnel bearer + CF tunnel cold-start + companion drive enumeration).
    useEffect(() => {
        for (const device of devices) {
            if (drivesPrefetchedRef.current.has(device.id)) continue;
            drivesPrefetchedRef.current.add(device.id);
            void (async () => {
                // Warm the tunnel bearer first (fills directAccessRef);
                // fastListDrives will then take the fast path and write
                // through to localStorage via refreshDrives.
                await getDirectAccess(device.id);
                void refreshDrives(device.id);
            })();
        }
    }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: refreshDrives/getDirectAccess are stable closures over refs

    // Auto-discover newly-registered companions. 5s instead of 30s so
    // a fresh pairing (opened in a separate browser tab by the companion)
    // shows up almost immediately on this tab without a manual refresh.
    useEffect(() => {
        const t = setInterval(async () => {
            const updated = await getDevices();
            setDevices(updated);
        }, 5_000);
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

    async function navigateBrowser(deviceId: string, path: string | null) {
        setBrowserError(null);
        if (path === null) {
            // Root: show drives. Paint cache instantly, refresh in background.
            const cached = drivesCacheRef.current.get(deviceId);
            if (cached) {
                setBrowserDrives(cached);
                setBrowserCwd(null);
                setBrowserEntries([]);
                setBrowserParent(null);
                setBrowserLoading(false);
                void refreshDrives(deviceId);
                return;
            }
            setBrowserLoading(true);
            try {
                const r = await fastListDrives(deviceId);
                if ("error" in r) { setBrowserError(r.error); return; }
                persistDrivesCache(deviceId, r.drives);
                setBrowserDrives(r.drives);
                setBrowserCwd(null);
                setBrowserEntries([]);
                setBrowserParent(null);
            } finally {
                setBrowserLoading(false);
            }
        } else {
            const cacheKey = `${deviceId}::${path}`;
            const cached = dirCacheRef.current.get(cacheKey);
            if (cached) {
                setBrowserCwd(cached.path);
                setBrowserEntries(cached.entries);
                setBrowserParent(cached.parent);
                setBrowserLoading(false);
                void refreshDirectory(deviceId, path);
                return;
            }
            setBrowserLoading(true);
            try {
                const r = await fastListDirectory(deviceId, path);
                if ("error" in r) { setBrowserError(r.error); return; }
                dirCacheRef.current.set(cacheKey, r);
                setBrowserCwd(r.path);
                setBrowserEntries(r.entries);
                setBrowserParent(r.parent);
            } finally {
                setBrowserLoading(false);
            }
        }
    }

    async function refreshDrives(deviceId: string) {
        const key = `drives::${deviceId}`;
        if (inflightRef.current.has(key)) return;
        inflightRef.current.add(key);
        try {
            const r = await fastListDrives(deviceId);
            if ("error" in r) return;
            persistDrivesCache(deviceId, r.drives);
            // Only update visible state if we're still on the drives view.
            setBrowserCwd((cwd) => { if (cwd === null) setBrowserDrives(r.drives); return cwd; });
        } finally {
            inflightRef.current.delete(key);
        }
    }

    async function refreshDirectory(deviceId: string, path: string) {
        const cacheKey = `${deviceId}::${path}`;
        if (inflightRef.current.has(cacheKey)) return;
        inflightRef.current.add(cacheKey);
        try {
            const r = await fastListDirectory(deviceId, path);
            if ("error" in r) return;
            dirCacheRef.current.set(cacheKey, r);
            // Only update visible state if user hasn't navigated away.
            setBrowserCwd((cwd) => {
                if (cwd === r.path) {
                    setBrowserEntries(r.entries);
                    setBrowserParent(r.parent);
                }
                return cwd;
            });
        } finally {
            inflightRef.current.delete(cacheKey);
        }
    }

    /** Hover-prefetch: warm the cache without touching visible state. */
    function prefetchDirectory(deviceId: string, path: string) {
        const cacheKey = `${deviceId}::${path}`;
        if (dirCacheRef.current.has(cacheKey) || inflightRef.current.has(cacheKey)) return;
        inflightRef.current.add(cacheKey);
        void (async () => {
            try {
                const r = await fastListDirectory(deviceId, path);
                if (!("error" in r)) dirCacheRef.current.set(cacheKey, r);
            } finally {
                inflightRef.current.delete(cacheKey);
            }
        })();
    }

    function openPickerDialog(deviceId: string) {
        setPendingPickKind("music");
        // Hydrate from cache synchronously so the modal paints instantly.
        // If the cache is cold we still kick off the network call below;
        // navigateBrowser handles both paths transparently.
        const cachedDrives = drivesCacheRef.current.get(deviceId) ?? [];
        setBrowserDrives(cachedDrives);
        setBrowserCwd(null);
        setBrowserEntries([]);
        setBrowserParent(null);
        setBrowserError(null);
        setPickerDebug(null);
        setPickerDialogDevice(deviceId);
        void navigateBrowser(deviceId, null);
    }

    async function handleAddBrowsedFolder(deviceId: string) {
        if (!browserCwd) return;
        setBrowserAdding(true);
        try {
            const r = await fastAddFolder(deviceId, browserCwd, pendingPickKind);
            if ("error" in r) { toast.error(r.error); return; }
            setFolders((p) => ({ ...p, [deviceId]: r.folders }));
            // Drop the parent listing so a follow-up open doesn't show stale
            // "not in library yet" affordances. The companion already invalidates
            // its own cache for the same reason.
            const parts = browserCwd.split(/[\\/]/).filter(Boolean);
            if (parts.length > 1) {
                const parent = browserCwd.replace(/[\\/][^\\/]+[\\/]?$/, "");
                if (parent) dirCacheRef.current.delete(`${deviceId}::${parent}`);
            }
            toast.success(
                r.added
                    ? `Added ${r.picked} (${FOLDER_KIND_LABELS[pendingPickKind]})`
                    : `${r.picked} was already in the library`,
            );
            setPickerDialogDevice(null);
            // Fire an initial scan so the new folder's existing content
            // shows up in /library or /watch. Watch only catches NEW
            // files \u2014 the user expects current content too.
            if (r.added) handleScanFolder(deviceId, r.picked, pendingPickKind);
        } finally {
            setBrowserAdding(false);
        }
    }

    function handleRemoveFolder(deviceId: string, folderPath: string) {
        // Optimistic removal so the UI feels instant; if the request fails
        // we restore the previous list below.
        let previous: CompanionFolder[] | undefined;
        setFolders((p) => {
            previous = p[deviceId];
            return {
                ...p,
                [deviceId]: (p[deviceId] ?? []).filter((f) => f.path !== folderPath),
            };
        });
        startTransition(async () => {
            try {
                const updated = await fastRemoveFolder(deviceId, folderPath);
                setFolders((p) => ({ ...p, [deviceId]: updated }));
                toast.success("Folder removed");
            } catch (err) {
                if (previous) setFolders((p) => ({ ...p, [deviceId]: previous! }));
                toast.error(err instanceof Error ? err.message : "Failed to remove folder");
            }
        });
    }

    function handleScanFolder(deviceId: string, folderPath: string, kind?: FolderKind) {
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
            const r = await startCompanionScan(deviceId, folderPath, kind);
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

    /** Poll any active scan jobs every ~750 ms until they complete.
     *  Ingest is handled by a separate effect that reacts to any
     *  transition into the "complete" state — whether the update came
     *  from this poll or from the WS push frame. */
    useEffect(() => {
        const active = Object.entries(scanProgress).filter(
            ([, job]) => job.status !== "complete" && job.status !== "error" && job.status !== "canceled",
        );
        if (active.length === 0) return;
        let stopped = false;
        const tick = async () => {
            for (const [folderPath, job] of active) {
                if (job.id === "pending") continue; // optimistic placeholder, wait for real id
                const owner = devices.find((d) => (folders[d.id] ?? []).some((f) => f.path === folderPath));
                if (!owner) continue;
                const r = await getCompanionScanJob(owner.id, job.id);
                if (stopped) return;
                if ("error" in r) continue;
                setScanProgress((p) => ({ ...p, [folderPath]: { ...r.job, folder: folderPath } }));
                if (r.job.status === "error") {
                    toast.error(`Scan failed: ${r.job.error ?? "unknown"}`);
                    setTimeout(() => {
                        setScanProgress((p) => { const next = { ...p }; delete next[folderPath]; return next; });
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
        // Kick off immediately, then every 30 s as a fallback. Live
        // updates arrive over the WS `watch:event` frame; this poll is
        // only here to drain events that fired while the WS was down
        // (CF reconnect, brief offline window) and to recover after a
        // tab restore.
        void tick();
        const handle = setInterval(tick, 30_000);
        return () => { canceled = true; clearInterval(handle); };
    }, [devices]);

    /** Open one WebSocket per device with a tunnel hostname and merge
     *  push-delivered scan:progress frames into the same scanProgress
     *  state the 750 ms poll loop fills. WS arrives before the next
     *  poll tick (typically <100 ms vs ~750 ms), so the UI updates
     *  smoothly; the poll loop becomes the fallback when the WS is
     *  unreachable (CF outage, companion behind NAT, etc.).
     *
     *  Also drives the per-device "Console" section by appending
     *  `log:line` frames and seeding from the `log:snapshot` frame the
     *  companion sends on connect. Kept here so the WS stays open even
     *  when the console panel is collapsed — the user can open it any
     *  time and immediately see what happened since they loaded the page. */
    useEffect(() => {
        const clients: { id: string; client: DeviceWsClient }[] = [];
        for (const device of devices) {
            const host = (device as { tunnelHostname?: string | null }).tunnelHostname;
            if (!host) continue;
            const c = connectDeviceWs(host);
            clients.push({ id: device.id, client: c });
            c.onScanProgress((msg) => {
                const job = msg.job as CompanionScanJob | undefined;
                if (!job?.folder) return;
                setScanProgress((p) => ({ ...p, [job.folder]: job }));
            });
            // Live watcher feedback (no more waiting for the 5 s poll).
            c.onWatchEvent(() => {
                void getDeviceTrackCount(device.id).then((n) => {
                    setTrackCounts((p) => ({ ...p, [device.id]: n }));
                });
            });
            c.onConnection((connected) => {
                setDeviceWsLive((p) => ({ ...p, [device.id]: connected }));
            });
            c.onLog((entries, kind) => {
                setDeviceLogs((p) => {
                    const prev = p[device.id] ?? [];
                    // Snapshot replaces (it's the authoritative ring at
                    // connect time); live frames append.
                    const merged = kind === "snapshot" ? entries : [...prev, ...entries];
                    // Bound to last 500 lines — same cap as the server ring.
                    const capped = merged.length > 500 ? merged.slice(merged.length - 500) : merged;
                    return { ...p, [device.id]: capped };
                });
            });
        }
        return () => { for (const { client } of clients) client.close(); };
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

    function toggleSection(deviceId: string, section: "folders" | "audio" | "console") {
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
                                low-latency engine only runs when the web app is opened from <code className="rounded bg-background px-1">localhost:13789</code>.
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
                                onToggleConsole={() => toggleSection(device.id, "console")}
                                consoleLineCount={(deviceLogs[device.id] ?? []).length}
                                consoleLive={deviceWsLive[device.id] ?? false}
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
                                                isPicking={false}
                                                scanProgress={scanProgress}
                                                ingestSummary={ingestSummary}
                                                togglingWatch={togglingWatch}
                                                onPick={() => openPickerDialog(device.id)}
                                                onScan={(p) => {
                                                    const f = (folders[device.id] ?? []).find((x) => x.path === p);
                                                    handleScanFolder(device.id, p, f?.kind);
                                                }}
                                                onRemove={(p) => handleRemoveFolder(device.id, p)}
                                                onScanAll={() => {
                                                    for (const f of dFolders) handleScanFolder(device.id, f.path, f.kind);
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
                                    {sectionOpen === "console" && (
                                        <motion.div
                                            key="console"
                                            initial={{ opacity: 0, height: 0 }}
                                            animate={{ opacity: 1, height: "auto" }}
                                            exit={{ opacity: 0, height: 0 }}
                                            transition={{ duration: 0.18 }}
                                            className="overflow-hidden"
                                        >
                                            <ConsoleSection
                                                entries={deviceLogs[device.id] ?? []}
                                                live={deviceWsLive[device.id] ?? false}
                                                hasTunnel={Boolean((device as { tunnelHostname?: string | null }).tunnelHostname)}
                                                onClear={() => setDeviceLogs((p) => ({ ...p, [device.id]: [] }))}
                                            />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </DeviceCard>
                        );
                    })}
                </div>
            )}

            {/* Pick-Folder modal: choose kind, then browse the companion's
                filesystem in-place. Everything stays in the web app — the
                companion only answers list_drives / list_directory queries
                routed through the announce-loop command queue. */}
            <Dialog
                open={pickerDialogDevice !== null}
                onOpenChange={(open) => { if (!open) setPickerDialogDevice(null); }}
            >
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Add a library folder</DialogTitle>
                        <DialogDescription>
                            Choose what kind of content lives in this folder, then browse the
                            companion&apos;s drives to pick one. Nothing opens on the desktop.
                        </DialogDescription>
                    </DialogHeader>

                    {/* Kind chips */}
                    <div className="flex flex-wrap gap-1.5 pb-1">
                        {FOLDER_KINDS.map((k) => (
                            <button
                                key={k}
                                type="button"
                                onClick={() => setPendingPickKind(k)}
                                className={cn(
                                    "rounded-full border px-3 py-1 text-xs transition-colors",
                                    pendingPickKind === k
                                        ? "border-blue-500/60 bg-blue-500/10 text-foreground"
                                        : "border-border text-muted-foreground hover:border-ring hover:bg-muted/40",
                                )}
                            >
                                {FOLDER_KIND_LABELS[k]}
                            </button>
                        ))}
                    </div>

                    {/* Browser: breadcrumbs + entries list */}
                    <div className="rounded-lg border bg-card/40">
                        {/* Header / breadcrumbs */}
                        <div className="flex items-center gap-1 border-b px-2 py-1.5 text-xs">
                            <button
                                type="button"
                                title="Drives"
                                disabled={browserLoading}
                                onClick={() => pickerDialogDevice && navigateBrowser(pickerDialogDevice, null)}
                                className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted/60 disabled:opacity-50"
                            >
                                <Home className="h-3.5 w-3.5" />
                            </button>
                            <button
                                type="button"
                                title="Parent"
                                disabled={browserLoading || !browserParent}
                                onClick={() => pickerDialogDevice && browserParent && navigateBrowser(pickerDialogDevice, browserParent)}
                                className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted/60 disabled:opacity-30"
                            >
                                <ArrowUp className="h-3.5 w-3.5" />
                            </button>
                            <div className="ml-1 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                                {browserCwd ?? "Drives"}
                            </div>
                            {browserLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                        </div>

                        {/* Debug strip — last call's transport + latency */}
                        {pickerDebug && (
                            <div className={cn(
                                "flex items-center gap-2 border-b px-2 py-1 font-mono text-[10px]",
                                pickerDebug.err
                                    ? "bg-destructive/10 text-destructive"
                                    : pickerDebug.via === "tunnel"
                                        ? "bg-emerald-500/5 text-emerald-400/80"
                                        : "bg-amber-500/5 text-amber-400/80",
                            )}>
                                <span>{pickerDebug.op}</span>
                                <span>·</span>
                                <span>{pickerDebug.via}</span>
                                {pickerDebug.reason && (<><span>·</span><span>{pickerDebug.reason}</span></>)}
                                <span>·</span>
                                <span>{pickerDebug.ms}ms</span>
                                {pickerDebug.n !== undefined && (<><span>·</span><span>n={pickerDebug.n}</span></>)}
                                {pickerDebug.err && (<><span>·</span><span className="truncate">{pickerDebug.err}</span></>)}
                            </div>
                        )}

                        {/* Body */}
                        <div className="h-72 overflow-y-auto px-1 py-1">
                            {browserError && (
                                <div className="m-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                                    {browserError}
                                </div>
                            )}
                            {browserCwd === null ? (
                                browserDrives.length === 0 ? (
                                    !browserLoading && !browserError && (
                                        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                                            No drives reported.
                                        </p>
                                    )
                                ) : (
                                    browserDrives.map((d) => (
                                        <button
                                            key={d.path}
                                            type="button"
                                            disabled={browserLoading}
                                            onClick={() => pickerDialogDevice && navigateBrowser(pickerDialogDevice, d.path)}
                                            onMouseEnter={() => pickerDialogDevice && prefetchDirectory(pickerDialogDevice, d.path)}
                                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/60 disabled:opacity-50"
                                        >
                                            <HardDrive className={cn(
                                                "h-4 w-4 shrink-0",
                                                d.type === "removable" ? "text-amber-400" :
                                                    d.type === "network" ? "text-blue-400" :
                                                        d.type === "home" ? "text-green-400" :
                                                            "text-muted-foreground",
                                            )} />
                                            <span className="flex-1 truncate">{d.label}</span>
                                            {typeof d.free === "number" && typeof d.total === "number" && d.total > 0 && (
                                                <span className="shrink-0 text-[10px] text-muted-foreground/70">
                                                    {formatGB(d.free)} free / {formatGB(d.total)}
                                                </span>
                                            )}
                                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                                        </button>
                                    ))
                                )
                            ) : browserEntries.length === 0 ? (
                                !browserLoading && !browserError && (
                                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                                        This folder has no subfolders. You can still add it.
                                    </p>
                                )
                            ) : (
                                browserEntries.map((e) => (
                                    <button
                                        key={e.path}
                                        type="button"
                                        disabled={browserLoading}
                                        onClick={() => pickerDialogDevice && navigateBrowser(pickerDialogDevice, e.path)}
                                        onMouseEnter={() => pickerDialogDevice && e.hasChildren !== false && prefetchDirectory(pickerDialogDevice, e.path)}
                                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/60 disabled:opacity-50"
                                    >
                                        <Folder className="h-4 w-4 shrink-0 text-blue-400/80" />
                                        <span className="flex-1 truncate">{e.name}</span>
                                        {e.hasChildren && (
                                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                                        )}
                                    </button>
                                ))
                            )}
                        </div>
                    </div>

                    <DialogFooter className="flex items-center justify-between gap-2 sm:flex-row">
                        <p className="mr-auto truncate text-[11px] text-muted-foreground">
                            {browserCwd
                                ? <>Will add <span className="font-mono text-foreground/80">{browserCwd}</span></>
                                : "Pick a drive to start browsing"}
                        </p>
                        <Button variant="ghost" onClick={() => setPickerDialogDevice(null)}>
                            Cancel
                        </Button>
                        <Button
                            onClick={() => { if (pickerDialogDevice) void handleAddBrowsedFolder(pickerDialogDevice); }}
                            disabled={!pickerDialogDevice || !browserCwd || browserAdding || browserLoading}
                        >
                            {browserAdding ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            Add this folder
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function formatGB(bytes: number): string {
    const gb = bytes / (1024 ** 3);
    if (gb >= 100) return `${gb.toFixed(0)} GB`;
    if (gb >= 10) return `${gb.toFixed(1)} GB`;
    return `${gb.toFixed(2)} GB`;
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
    openSection: "folders" | "audio" | "console" | null;
    onToggleFolders: () => void;
    onToggleAudio: () => void;
    onToggleConsole: () => void;
    consoleLineCount?: number;
    consoleLive?: boolean;
    children: React.ReactNode;
}

function DeviceCard({
    device, isOnline, trackCount, folderCount, editingName, editValue,
    onEditStart, onEditChange, onEditCancel, onEditSave, onRemove,
    openSection, onToggleFolders, onToggleAudio, onToggleConsole,
    consoleLineCount, consoleLive, children,
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
                            <SectionToggleButton
                                active={openSection === "console"}
                                onClick={onToggleConsole}
                                icon={<Terminal className="h-4 w-4" />}
                                label="Console"
                                count={consoleLineCount}
                                indicator={consoleLive ? "live" : undefined}
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
    active, onClick, icon, label, count, indicator,
}: {
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
    count?: number;
    indicator?: "live";
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
            {indicator === "live" && (
                <span className="relative inline-flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
            )}
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
    ingestSummary: Record<string, { ok: boolean; text: string; at: number }>;
    togglingWatch: string | null;
    onPick: () => void;
    onScan: (path: string) => void;
    onRemove: (path: string) => void;
    onScanAll: () => void;
    onToggleWatch: (path: string, watch: boolean) => void;
}

function FolderSection({
    folders, isOnline, isPicking, scanProgress, ingestSummary, togglingWatch,
    onPick, onScan, onRemove, onScanAll, onToggleWatch,
}: FolderSectionProps) {
    const anyScanning = Object.values(scanProgress).some(
        (j) => j.status !== "complete" && j.status !== "error" && j.status !== "canceled",
    );
    return (
        <div className="space-y-3 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-medium">Library Folders</h4>
                <Button
                    variant="outline"
                    size="xs"
                    onClick={onPick}
                    disabled={!isOnline || isPicking}
                    title={isOnline ? "Choose a folder purpose, then open the picker on the companion" : "Device offline"}
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
                                ingest={ingestSummary[folder.path]}
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
    ingest?: { ok: boolean; text: string; at: number };
    onScan: () => void;
    onRemove: () => void;
    onToggleWatch: (watch: boolean) => void;
}

function FolderRow({
    folder, isOnline, togglingWatch, progress, ingest, onScan, onRemove, onToggleWatch,
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

                {/* Folder purpose label — chosen at pick time, fixed thereafter.
                    To change the purpose, remove the folder and re-add it. */}
                <span
                    className="shrink-0 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                    title="Folder purpose (set at pick time)"
                >
                    {FOLDER_KIND_LABELS[folder.kind ?? "music"]}
                </span>

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

            {/* Last ingest result \u2014 persistent so the user always sees what
                actually landed in the cloud DB after a scan finishes. */}
            {ingest && !isScanning && (
                <div className={cn(
                    "flex items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-[10px]",
                    ingest.ok ? "bg-green-500/5 text-green-300" : "bg-red-500/5 text-red-300",
                )}>
                    {ingest.ok ? <Sparkles className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
                    <span className="truncate">{ingest.text}</span>
                    <span className="ml-auto font-mono text-muted-foreground">
                        {new Date(ingest.at).toLocaleTimeString()}
                    </span>
                </div>
            )}
        </motion.li>
    );
}

// ─── Live server log console ──────────────────────────────────────────────────

interface ConsoleSectionProps {
    entries: DeviceLogEntry[];
    live: boolean;
    hasTunnel: boolean;
    onClear: () => void;
}

function ConsoleSection({ entries, live, hasTunnel, onClear }: ConsoleSectionProps) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [autoScroll, setAutoScroll] = useState(true);
    const [levelFilter, setLevelFilter] = useState<"all" | "info" | "warn" | "error">("all");

    // Auto-scroll to bottom on new lines unless the user has scrolled up.
    useEffect(() => {
        if (!autoScroll) return;
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [entries, autoScroll]);

    const filtered = useMemo(() => {
        if (levelFilter === "all") return entries;
        return entries.filter((e) => e.level === levelFilter);
    }, [entries, levelFilter]);

    const counts = useMemo(() => {
        let info = 0, warn = 0, error = 0;
        for (const e of entries) {
            if (e.level === "error") error++;
            else if (e.level === "warn") warn++;
            else info++;
        }
        return { info, warn, error };
    }, [entries]);

    function copyToClipboard() {
        try {
            const text = filtered.map((e) => e.line).join("\n");
            void navigator.clipboard.writeText(text);
            toast.success(`Copied ${filtered.length} line${filtered.length === 1 ? "" : "s"}`);
        } catch {
            toast.error("Copy failed");
        }
    }

    return (
        <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold">Server console</h4>
                    {live ? (
                        <Badge variant="default" className="h-5 gap-1 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20">
                            <span className="relative inline-flex h-1.5 w-1.5">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            </span>
                            <span className="text-[10px]">streaming</span>
                        </Badge>
                    ) : (
                        <Badge variant="secondary" className="h-5 text-[10px]">
                            {hasTunnel ? "disconnected" : "no tunnel"}
                        </Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                        {counts.info} info · <span className="text-amber-400">{counts.warn} warn</span> ·{" "}
                        <span className="text-red-400">{counts.error} err</span>
                    </span>
                </div>
                <div className="flex items-center gap-1">
                    {(["all", "info", "warn", "error"] as const).map((l) => (
                        <Button
                            key={l}
                            size="sm"
                            variant={levelFilter === l ? "secondary" : "ghost"}
                            className="h-6 px-2 text-[10px] uppercase"
                            onClick={() => setLevelFilter(l)}
                        >
                            {l}
                        </Button>
                    ))}
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={copyToClipboard}>
                        Copy
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={onClear}>
                        <Trash className="h-3 w-3" />
                    </Button>
                </div>
            </div>

            <div
                ref={scrollRef}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
                    setAutoScroll(atBottom);
                }}
                className="h-72 overflow-y-auto rounded-md border bg-black/40 p-2 font-mono text-[11px] leading-relaxed"
            >
                {filtered.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                        {live
                            ? "Waiting for activity…"
                            : hasTunnel
                                ? "Connecting to companion…"
                                : "This device has no tunnel — open the companion to enable remote streaming."}
                    </div>
                ) : (
                    filtered.map((e, i) => (
                        <div
                            key={`${e.ts}-${i}`}
                            className={cn(
                                "whitespace-pre-wrap break-all",
                                e.level === "error" && "text-red-300",
                                e.level === "warn" && "text-amber-300",
                                e.level === "info" && "text-zinc-300",
                            )}
                        >
                            {e.line}
                        </div>
                    ))
                )}
            </div>
            {!autoScroll && (
                <button
                    onClick={() => setAutoScroll(true)}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                    Auto-scroll paused — click to resume
                </button>
            )}
        </div>
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
                        Authorizations are saved, but the engine only runs from <code className="rounded bg-background px-1">localhost:13789</code>.
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
