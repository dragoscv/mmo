"use client";

import { useState, useTransition, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { beginScan, getScanProgress } from "@/actions/scan-orchestrator";
import { ingestCompanionScanJob } from "@/actions/devices";
import { reconcileCloudWithCompanions } from "@/actions/reconcile";
import type { ScannerCompanion, FolderKind } from "@/lib/companion-types";
import {
    ScanSearch,
    FolderOpen,
    CheckCircle,
    Loader2,
    Monitor,
    Wifi,
    WifiOff,
    Music,
    Sparkles,
    Trash2,
} from "lucide-react";
import { toast } from "sonner";

interface ScannerClientProps {
    companions: ScannerCompanion[];
}

interface ActiveScan {
    deviceId: string;
    folder: string;
    jobId: string;
    status: string;
    discovered: number;
    scanned: number;
}

function relativeSeen(iso: string | null): string {
    if (!iso) return "never";
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function ScannerClient({ companions }: ScannerClientProps) {
    const [customPath, setCustomPath] = useState("");
    const [customDevice, setCustomDevice] = useState(
        companions.find((c) => c.online)?.deviceId ?? companions[0]?.deviceId ?? "",
    );
    const [active, setActive] = useState<ActiveScan | null>(null);
    const [isPending, startTransition] = useTransition();
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const runScan = useCallback((deviceId: string, folder: string, kind?: FolderKind) => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        startTransition(async () => {
            const begun = await beginScan(deviceId, folder, kind);
            if ("error" in begun) { toast.error(`Scan failed: ${begun.error}`); return; }
            const jobId = begun.jobId;
            setActive({ deviceId, folder, jobId, status: "discovering", discovered: 0, scanned: 0 });
            pollRef.current = setInterval(async () => {
                const p = await getScanProgress(deviceId, jobId);
                if ("error" in p) return;
                setActive({ deviceId, folder, jobId, status: p.status, discovered: p.discovered, scanned: p.scanned });
                if (p.status === "complete") {
                    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
                    const ing = await ingestCompanionScanJob(deviceId, jobId);
                    if ("error" in ing) { toast.error(`Ingest failed: ${ing.error}`); setActive(null); return; }
                    toast.success(`Scan complete: ${ing.inserted} new, ${ing.skipped} existing`, { description: folder });
                    setActive(null);
                } else if (p.status === "error") {
                    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
                    toast.error("Scan failed on companion");
                    setActive(null);
                }
            }, 1500);
        });
    }, []);

    const busy = isPending || active !== null;

    const [reconciling, setReconciling] = useState(false);
    const runReconcile = useCallback(() => {
        setReconciling(true);
        startTransition(async () => {
            try {
                const r = await reconcileCloudWithCompanions();
                if (r.error) { toast.error(r.error); return; }
                const skipped = r.results.filter((x) => x.skipped);
                toast.success(`Reconcile: pruned ${r.totalPruned}, deduped ${r.deduped}, linked ${r.backfilled}`, {
                    description: r.results
                        .map((x) => x.skipped ? `${x.name}: ${x.skipped}` : `${x.name}: ${x.companionTrackCount} on device`)
                        .join(" · "),
                });
                if (skipped.length === r.results.length && r.totalPruned === 0) {
                    toast.message("Nothing pruned", { description: "All online companions were skipped or already in sync." });
                }
            } finally {
                setReconciling(false);
            }
        });
    }, []);

    return (
        <div className="space-y-6">
            {companions.map((c) => (
                <Card key={c.deviceId}>
                    <CardHeader>
                        <CardTitle className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-2 min-w-0">
                                <Monitor className="h-5 w-5 shrink-0" />
                                <span className="truncate">{c.name}</span>
                                {c.online ? (
                                    <span className="flex items-center gap-1 text-xs text-green-500"><Wifi className="h-3.5 w-3.5" /> online</span>
                                ) : (
                                    <span className="flex items-center gap-1 text-xs text-[var(--muted-foreground)]"><WifiOff className="h-3.5 w-3.5" /> offline · {relativeSeen(c.lastSeenAt)}</span>
                                )}
                            </span>
                            <span className="flex items-center gap-3 text-xs text-[var(--muted-foreground)] shrink-0">
                                <span className="flex items-center gap-1"><Music className="h-3.5 w-3.5" /> {c.trackCount.toLocaleString()}</span>
                                <span className="flex items-center gap-1"><Sparkles className="h-3.5 w-3.5" /> {c.analyzedCount.toLocaleString()} analyzed</span>
                            </span>
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {c.error && (
                            <p className="text-sm text-amber-500">Could not reach companion: {c.error} (showing cached folders)</p>
                        )}
                        {c.folders.length > 0 ? (
                            c.folders.map((f) => {
                                const isActive = active?.deviceId === c.deviceId && active?.folder === f.path;
                                return (
                                    <div key={f.path} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] px-4 py-3">
                                        <div className="min-w-0 flex-1">
                                            <span className="text-sm font-mono truncate block">{f.path}</span>
                                            {isActive && (
                                                <span className="text-xs text-[var(--muted-foreground)]">
                                                    {active!.status} · {active!.discovered} found · {active!.scanned} scanned
                                                </span>
                                            )}
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={() => runScan(c.deviceId, f.path, f.kind)}
                                            disabled={busy || !c.online}
                                            title={!c.online ? "Companion offline" : undefined}
                                        >
                                            {isActive ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}
                                            {isActive ? "Scanning…" : "Scan"}
                                        </Button>
                                    </div>
                                );
                            })
                        ) : (
                            <p className="text-sm text-[var(--muted-foreground)]">
                                No folders configured on this companion. Add one from the Devices page.
                            </p>
                        )}
                    </CardContent>
                </Card>
            ))}

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <FolderOpen className="h-5 w-5" /> Custom folder
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <select
                            value={customDevice}
                            onChange={(e) => setCustomDevice(e.target.value)}
                            className="h-9 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 text-sm"
                        >
                            {companions.map((c) => (
                                <option key={c.deviceId} value={c.deviceId} disabled={!c.online}>
                                    {c.name}{c.online ? "" : " (offline)"}
                                </option>
                            ))}
                        </select>
                        <Input
                            placeholder="C:\\Users\\you\\Music"
                            value={customPath}
                            onChange={(e) => setCustomPath(e.target.value)}
                            className="flex-1"
                        />
                        <Button
                            onClick={() => { if (customPath.trim() && customDevice) runScan(customDevice, customPath.trim()); }}
                            disabled={busy || !customPath.trim() || !customDevice}
                        >
                            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}
                            Scan
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Trash2 className="h-5 w-5" /> Library maintenance
                    </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-[var(--muted-foreground)]">
                        Prune cloud tracks whose files no longer exist on an online
                        companion. Offline companions and empty libraries are never pruned.
                    </p>
                    <Button variant="outline" onClick={runReconcile} disabled={reconciling || busy}>
                        {reconciling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                        {reconciling ? "Reconciling…" : "Reconcile library"}
                    </Button>
                </CardContent>
            </Card>

            {!active && !isPending && (
                <p className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                    <CheckCircle className="h-3.5 w-3.5" /> Scans run on the companion machine; files are read locally and ingested into your library.
                </p>
            )}
        </div>
    );
}
