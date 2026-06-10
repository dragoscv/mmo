"use client";

/**
 * Training control plane (client component).
 *
 * Four tabs: Jobs / Datasets / LoRAs / Feedback. When a job is selected
 * we attach an EventSource to /api/training/events/[jobId] and stream
 * live step / loss / sample / controlPatch events. The whole page is a
 * single client island; server actions handle every mutation.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";

import {
    cancelTrainingJob,
    listTrainingJobs,
    patchControlSignal,
    submitTrainingJob,
    type TrainingJobDto,
    type TrainingJobKind,
} from "@/actions/training";
import {
    archiveDataset,
    buildDatasetFromThumbsUp,
    listDatasets,
    materializeDataset,
    type DatasetDto,
} from "@/actions/training-datasets";
import { listLoras, type LoraDto } from "@/actions/loras";
import { reconcileTrainingJobsForCurrentUser } from "@/actions/training-reconcile";
import type { FeedbackSummary } from "@/actions/generation-feedback";

interface Props {
    initialJobs: TrainingJobDto[];
    initialDatasets: DatasetDto[];
    initialLoras: LoraDto[];
    initialFeedback: FeedbackSummary;
}

export function TrainingClient({ initialJobs, initialDatasets, initialLoras, initialFeedback }: Props) {
    const [jobs, setJobs] = useState(initialJobs);
    const [datasets, setDatasets] = useState(initialDatasets);
    const [loras, setLoras] = useState(initialLoras);
    const [feedback] = useState(initialFeedback);
    const [selectedJobId, setSelectedJobId] = useState<string | null>(jobs[0]?.id ?? null);

    const selectedJob = useMemo(
        () => jobs.find((j) => j.id === selectedJobId) ?? null,
        [jobs, selectedJobId],
    );

    // Realtime polling — reconcile lists with the server so completed
    // Vertex jobs / freshly materialised datasets / newly registered
    // LoRAs appear without a manual refresh. The per-job SSE already
    // handles step-level updates; this is for status & list churn.
    //
    // Keep the cadence gentle: in dev each server action serialises
    // through Drizzle/Neon and costs ~hundreds of ms. Hammering all
    // three lists every 5s wedges the whole page (and any other server
    // action running on the side — including Maestro session restore).
    const hasRunning = useMemo(
        () => jobs.some((j) => j.status === "pending" || j.status === "submitted" || j.status === "running" || j.status === "paused"),
        [jobs],
    );
    const refreshJobs = useCallback(async () => {
        try { setJobs(await listTrainingJobs()); } catch { /* ignore */ }
    }, []);
    const refreshDatasets = useCallback(async () => {
        try { setDatasets(await listDatasets()); } catch { /* ignore */ }
    }, []);
    const refreshLoras = useCallback(async () => {
        try { setLoras(await listLoras()); } catch { /* ignore */ }
    }, []);
    // Jobs poll more often because that's where progress shows up.
    useEffect(() => {
        const ms = hasRunning ? 10_000 : 30_000;
        const id = setInterval(refreshJobs, ms);
        return () => clearInterval(id);
    }, [hasRunning, refreshJobs]);
    // Datasets/LoRAs change rarely — every minute is plenty.
    useEffect(() => {
        const id = setInterval(() => {
            refreshDatasets();
            refreshLoras();
        }, 60_000);
        return () => clearInterval(id);
    }, [refreshDatasets, refreshLoras]);
    // Refresh once on focus so the page is fresh after the user switches back.
    useEffect(() => {
        const onVis = () => {
            if (document.visibilityState !== "visible") return;
            refreshJobs();
            refreshDatasets();
            refreshLoras();
        };
        document.addEventListener("visibilitychange", onVis);
        return () => document.removeEventListener("visibilitychange", onVis);
    }, [refreshJobs, refreshDatasets, refreshLoras]);

    // Self-healing reconcile: when a job's been "submitted/running" with
    // no update for > 5 min, the real trainer webhook is probably lost
    // (Vertex preemption, crashed before first event, no Pub/Sub cron in
    // dev). Ask the server to query Vertex directly and synthesize the
    // terminal event. Throttle to once per minute regardless of how many
    // jobs look stale, since the action itself sweeps all stale jobs.
    const lastReconcileRef = useRef(0);
    useEffect(() => {
        const STALE_MS = 5 * 60_000;
        const THROTTLE_MS = 60_000;
        const now = Date.now();
        const stale = jobs.some((j) => {
            if (j.status !== "submitted" && j.status !== "running" && j.status !== "paused") return false;
            const t = Date.parse(j.updatedAt);
            return Number.isFinite(t) && now - t > STALE_MS;
        });
        if (!stale) return;
        if (now - lastReconcileRef.current < THROTTLE_MS) return;
        lastReconcileRef.current = now;
        void (async () => {
            try {
                const res = await reconcileTrainingJobsForCurrentUser();
                if (res.reconciled > 0) await refreshJobs();
            } catch {
                /* ignore — reconcile is best-effort */
            }
        })();
    }, [jobs, refreshJobs]);

    return (
        <div className="container mx-auto max-w-7xl p-6 space-y-6">
            <header className="flex items-baseline justify-between">
                <div>
                    <h1 className="text-3xl font-bold">Training</h1>
                    <p className="text-sm text-muted-foreground">
                        Background trainer agent. Maestro can submit, monitor, and steer LoRA jobs live.
                    </p>
                </div>
                <BudgetWidget jobs={jobs} />
            </header>

            <Tabs defaultValue="jobs" className="w-full">
                <TabsList>
                    <TabsTrigger value="jobs">Jobs ({jobs.length})</TabsTrigger>
                    <TabsTrigger value="datasets">Datasets ({datasets.length})</TabsTrigger>
                    <TabsTrigger value="loras">LoRAs ({loras.length})</TabsTrigger>
                    <TabsTrigger value="feedback">Feedback ({feedback.total})</TabsTrigger>
                </TabsList>

                <TabsContent value="jobs" className="space-y-4">
                    <div className="grid grid-cols-12 gap-4">
                        <div className="col-span-4 space-y-2">
                            <JobsList
                                jobs={jobs}
                                selectedId={selectedJobId}
                                onSelect={setSelectedJobId}
                            />
                            <SubmitForm
                                datasets={datasets}
                                onSubmitted={(j) => {
                                    setJobs((prev) => [j, ...prev]);
                                    setSelectedJobId(j.id);
                                }}
                            />
                        </div>
                        <div className="col-span-8">
                            {selectedJob ? (
                                <JobDetail
                                    job={selectedJob}
                                    onUpdate={(patch) => {
                                        setJobs((prev) =>
                                            prev.map((j) => (j.id === patch.id ? { ...j, ...patch } : j)),
                                        );
                                    }}
                                />
                            ) : (
                                <Card>
                                    <CardContent className="py-12 text-center text-muted-foreground">
                                        Select a job to see live progress.
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="datasets">
                    <DatasetsTab
                        datasets={datasets}
                        onChange={setDatasets}
                    />
                </TabsContent>

                <TabsContent value="loras">
                    <LorasTab loras={loras} />
                </TabsContent>

                <TabsContent value="feedback">
                    <FeedbackTab feedback={feedback} />
                </TabsContent>
            </Tabs>
        </div>
    );
}

// ─── Budget ─────────────────────────────────────────────────────────────

function BudgetWidget({ jobs }: { jobs: TrainingJobDto[] }) {
    const monthly = useMemo(() => {
        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        let acc = 0;
        for (const j of jobs) {
            const created = j.createdAt ? new Date(j.createdAt) : null;
            if (!created || Number.isNaN(created.getTime()) || created < monthStart) continue;
            const v = j.estimatedCostUsd;
            if (typeof v === "number" && Number.isFinite(v)) acc += v;
        }
        return acc;
    }, [jobs]);
    const cap = 500;
    const safeMonthly = Number.isFinite(monthly) ? monthly : 0;
    const pct = Math.min(100, Math.round((safeMonthly / cap) * 100));
    return (
        <div className="text-right">
            <div className="text-xs text-muted-foreground">Monthly spend (est.)</div>
            <div className="text-2xl font-mono">${safeMonthly.toFixed(2)} <span className="text-sm text-muted-foreground">/ ${cap}</span></div>
            <div className="w-48 h-1 bg-muted rounded mt-1 ml-auto overflow-hidden">
                <div
                    className={`h-full ${pct > 80 ? "bg-red-500" : pct > 60 ? "bg-yellow-500" : "bg-green-500"}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}

// ─── Jobs list ──────────────────────────────────────────────────────────

function JobsList({
    jobs,
    selectedId,
    onSelect,
}: {
    jobs: TrainingJobDto[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}) {
    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">Jobs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 max-h-96 overflow-y-auto p-2">
                {jobs.length === 0 && <div className="text-sm text-muted-foreground p-4">No jobs yet.</div>}
                {jobs.map((j) => (
                    <button
                        key={j.id}
                        onClick={() => onSelect(j.id)}
                        className={`w-full text-left p-2 rounded text-sm hover:bg-muted ${selectedId === j.id ? "bg-muted" : ""}`}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <div className="truncate">{j.name}</div>
                            <StatusBadge status={j.status} />
                        </div>
                        <div className="text-xs text-muted-foreground">
                            {j.kind} · {j.currentStep}/{j.config.maxSteps} ·{" "}
                            {j.lastLoss != null ? `loss ${j.lastLoss.toFixed(3)}` : "warming up"}
                        </div>
                    </button>
                ))}
            </CardContent>
        </Card>
    );
}

function StatusBadge({ status }: { status: TrainingJobDto["status"] }) {
    const variant = {
        pending: "secondary",
        submitted: "secondary",
        running: "default",
        paused: "outline",
        succeeded: "default",
        failed: "destructive",
        cancelled: "outline",
    }[status] as "default" | "secondary" | "destructive" | "outline";
    return (
        <Badge variant={variant} className="text-[10px]">
            {status}
        </Badge>
    );
}

// ─── Submit form ────────────────────────────────────────────────────────

function SubmitForm({
    datasets,
    onSubmitted,
}: {
    datasets: DatasetDto[];
    onSubmitted: (j: TrainingJobDto) => void;
}) {
    const [name, setName] = useState("");
    const [kind, setKind] = useState<TrainingJobKind>("user-lora");
    const [datasetId, setDatasetId] = useState<string>(datasets[0]?.id ?? "");
    const [outputUri, setOutputUri] = useState("");
    const [pending, startTransition] = useTransition();

    const ready = datasets.filter((d) => d.status === "ready");

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">Submit new job</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <div>
                    <Label>Name</Label>
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My melodic-techno LoRA" />
                </div>
                <div>
                    <Label>Kind</Label>
                    <Select value={kind} onValueChange={(v) => setKind(v as TrainingJobKind)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="user-lora">user-lora (~$0.45, L4)</SelectItem>
                            <SelectItem value="style-lora">style-lora (~$3.30, A100)</SelectItem>
                            <SelectItem value="acestep-dpo">acestep-dpo (~$2, A100)</SelectItem>
                            <SelectItem value="stem-aware">stem-aware (~$3, A100)</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <Label>Dataset</Label>
                    <Select value={datasetId} onValueChange={setDatasetId}>
                        <SelectTrigger><SelectValue placeholder="Pick a materialized dataset" /></SelectTrigger>
                        <SelectContent>
                            {ready.map((d) => (
                                <SelectItem key={d.id} value={d.id}>
                                    {d.name} ({d.itemCount} items)
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {ready.length === 0 && (
                        <div className="text-xs text-muted-foreground mt-1">
                            No materialized datasets yet. Go to the Datasets tab.
                        </div>
                    )}
                </div>
                <div>
                    <Label>Output URI (gs://)</Label>
                    <Input
                        value={outputUri}
                        onChange={(e) => setOutputUri(e.target.value)}
                        placeholder="gs://mmo-training-prod/<jobid>/output/"
                    />
                </div>
                <Button
                    disabled={pending || !name || !datasetId || !outputUri}
                    onClick={() =>
                        startTransition(async () => {
                            const res = await submitTrainingJob({
                                kind,
                                name,
                                datasetId,
                                outputUri,
                            });
                            if (res.ok) {
                                toast.success(`Submitted: ${res.job.externalJobName ?? res.job.id}`);
                                onSubmitted(res.job);
                                setName("");
                            } else {
                                toast.error(`Submit failed: ${res.error}`);
                            }
                        })
                    }
                >
                    {pending ? "Submitting…" : "Submit"}
                </Button>
            </CardContent>
        </Card>
    );
}

// ─── Job detail with live SSE ───────────────────────────────────────────

function JobDetail({
    job,
    onUpdate,
}: {
    job: TrainingJobDto;
    onUpdate: (patch: Partial<TrainingJobDto> & { id: string }) => void;
}) {
    const [events, setEvents] = useState<Array<{ id: string; kind: string; step: number | null; message: string | null; createdAt: string }>>([]);
    const [live, setLive] = useState(job);
    const eventsRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        setLive(job);
        setEvents([]);
    }, [job.id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") return;
        const es = new EventSource(`/api/training/events/${job.id}`);
        let closedByDone = false;
        es.addEventListener("job", (e) => {
            try {
                const patch = JSON.parse((e as MessageEvent).data) as Partial<TrainingJobDto>;
                setLive((prev) => ({ ...prev, ...patch }));
                onUpdate({ id: job.id, ...patch });
            } catch { /* ignore */ }
        });
        // Server emits `done` on terminal status; close locally so the
        // browser doesn't auto-reconnect (which is what produced the
        // ERR_ABORTED loop on finished jobs).
        es.addEventListener("done", () => {
            closedByDone = true;
            es.close();
        });
        const onAny = (e: MessageEvent) => {
            try {
                const data = JSON.parse(e.data) as { id?: string; kind?: string; step?: number; message?: string; createdAt?: string };
                if (!data.id) return;
                setEvents((prev) => {
                    if (prev.some((p) => p.id === data.id)) return prev;
                    return [...prev, {
                        id: data.id!,
                        kind: data.kind ?? "?",
                        step: data.step ?? null,
                        message: data.message ?? null,
                        createdAt: data.createdAt ?? new Date().toISOString(),
                    }].slice(-200);
                });
            } catch { /* ignore */ }
        };
        for (const k of ["submitted", "started", "step", "sample", "checkpoint", "controlPatch", "warning", "error", "finished", "cancelled"]) {
            es.addEventListener(k, onAny as EventListener);
        }
        es.onerror = () => {
            // EventSource auto-reconnects on transient network errors; we
            // only want to suppress the noisy log + close once the server
            // intentionally closed (handled above by `done`). When the
            // connection is in CLOSED state nothing else can happen.
            if (closedByDone) es.close();
        };
        return () => { closedByDone = true; es.close(); };
    }, [job.id, job.status, onUpdate]);

    useEffect(() => {
        eventsRef.current?.scrollTo({ top: eventsRef.current.scrollHeight });
    }, [events]);

    return (
        <Card>
            <CardHeader>
                <div className="flex items-baseline justify-between">
                    <CardTitle>{live.name}</CardTitle>
                    <div className="flex items-center gap-2">
                        <StatusBadge status={live.status} />
                        {live.consoleUrl && (
                            <a href={live.consoleUrl} target="_blank" rel="noreferrer" className="text-xs underline">Vertex →</a>
                        )}
                    </div>
                </div>
                <div className="text-xs text-muted-foreground space-y-1">
                    <div>{live.kind} · rank {live.config.rank} · {live.config.acceleratorType} {live.config.spot ? "(spot)" : ""}</div>
                    <div>Est. ${live.estimatedCostUsd?.toFixed(2) ?? "?"} · Created by {live.createdBy}</div>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                <ProgressBar current={live.currentStep} max={live.config.maxSteps} loss={live.lastLoss} />
                <ControlPanel job={live} />
                {live.latestSampleUri && (
                    <div>
                        <Label>Latest eval sample</Label>
                        <audio
                            src={live.latestSampleUri.replace(/^gs:\/\//, "https://storage.googleapis.com/")}
                            controls
                            className="w-full mt-1"
                        />
                    </div>
                )}
                <div>
                    <Label>Events</Label>
                    <div
                        ref={eventsRef}
                        className="mt-1 h-64 overflow-y-auto rounded border bg-muted/30 p-2 font-mono text-xs space-y-1"
                    >
                        {events.length === 0 && <div className="text-muted-foreground">Waiting for events…</div>}
                        {events.map((e) => (
                            <div key={e.id} className="flex gap-2">
                                <span className="text-muted-foreground shrink-0">
                                    {new Date(e.createdAt).toLocaleTimeString()}
                                </span>
                                <Badge variant="outline" className="text-[10px] shrink-0">{e.kind}</Badge>
                                {e.step != null && <span className="text-muted-foreground shrink-0">@{e.step}</span>}
                                <span className="truncate">{e.message ?? ""}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

function ProgressBar({ current, max, loss }: { current: number; max: number; loss: number | null }) {
    const pct = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
    return (
        <div>
            <div className="flex items-baseline justify-between text-xs mb-1">
                <span>
                    Step <span className="font-mono">{current}</span> / {max} ({pct}%)
                </span>
                {loss != null && <span className="font-mono">loss {loss.toFixed(4)}</span>}
            </div>
            <div className="h-2 bg-muted rounded overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

function ControlPanel({ job }: { job: TrainingJobDto }) {
    const [lr, setLr] = useState<number>(job.config.learningRate);
    const [pending, startTransition] = useTransition();
    const finalized = job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
    if (finalized) return null;

    const apply = (patch: Parameters<typeof patchControlSignal>[1]) =>
        startTransition(async () => {
            const res = await patchControlSignal(job.id, patch);
            if (res.ok) toast.success("Control patch sent. Trainer will apply on next poll.");
            else toast.error(`Patch failed: ${res.error}`);
        });

    const cancel = () =>
        startTransition(async () => {
            const res = await cancelTrainingJob(job.id);
            if (res.ok) toast.success("Cancellation requested.");
            else toast.error(`Cancel failed: ${res.error}`);
        });

    return (
        <div className="space-y-3 rounded border p-3 bg-muted/30">
            <Label className="text-xs">Control signal</Label>
            <div className="flex items-center gap-2">
                <Label className="text-xs w-32">Learning rate</Label>
                <Slider
                    value={[Math.log10(Math.max(lr, 1e-7))]}
                    min={-7}
                    max={-2}
                    step={0.1}
                    onValueChange={(v) => setLr(10 ** v[0])}
                    className="flex-1"
                />
                <span className="font-mono text-xs w-24 text-right">{lr.toExponential(2)}</span>
                <Button size="sm" onClick={() => apply({ learningRate: lr })} disabled={pending}>Set</Button>
            </div>
            <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => apply({ evalNow: true })} disabled={pending}>
                    Eval now
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => apply({ pause: job.status !== "paused" })}
                    disabled={pending}
                >
                    {job.status === "paused" ? "Resume" : "Pause"}
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={() => apply({ earlyStop: true })}
                    disabled={pending}
                >
                    Early stop
                </Button>
                <Button size="sm" variant="destructive" onClick={cancel} disabled={pending}>
                    Cancel
                </Button>
            </div>
            {job.controlSignal.updatedAt && (
                <div className="text-xs text-muted-foreground" suppressHydrationWarning>
                    Last patch by {job.controlSignal.updatedBy ?? "?"} at{" "}
                    {new Date(job.controlSignal.updatedAt).toLocaleString()}
                </div>
            )}
        </div>
    );
}

// ─── Datasets tab ───────────────────────────────────────────────────────

function DatasetsTab({
    datasets,
    onChange,
}: {
    datasets: DatasetDto[];
    onChange: (next: DatasetDto[]) => void;
}) {
    const [pending, startTransition] = useTransition();
    const [name, setName] = useState("My taste");

    const onBuildThumbs = () =>
        startTransition(async () => {
            const res = await buildDatasetFromThumbsUp({ name, minScore: 1 });
            if (!res.ok) { toast.error(`Build failed: ${res.error}`); return; }
            toast.success(`Built '${name}' with ${res.included} items.`);
            onChange([res.dataset, ...datasets]);
        });

    const onMaterialize = (id: string) =>
        startTransition(async () => {
            const res = await materializeDataset(id);
            if (!res.ok) { toast.error(`Materialize failed: ${res.error}`); return; }
            toast.success(`Uploaded to ${res.gcsUri}`);
            onChange(datasets.map((d) => (d.id === id ? { ...d, status: "ready" as const, gcsUri: res.gcsUri } : d)));
        });

    const onArchive = (id: string) =>
        startTransition(async () => {
            const res = await archiveDataset(id);
            if (!res.ok) { toast.error(`Archive failed: ${res.error}`); return; }
            onChange(datasets.map((d) => (d.id === id ? { ...d, status: "archived" as const } : d)));
        });

    return (
        <div className="grid grid-cols-12 gap-4">
            <div className="col-span-4 space-y-3">
                <Card>
                    <CardHeader>
                        <CardTitle className="text-sm">Build from thumbs-up</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <Input value={name} onChange={(e) => setName(e.target.value)} />
                        <Button onClick={onBuildThumbs} disabled={pending} className="w-full">
                            {pending ? "Building…" : "Build dataset"}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                            Bundles every generation you've thumbed up into a training dataset.
                        </p>
                    </CardContent>
                </Card>
            </div>
            <div className="col-span-8 space-y-2">
                {datasets.map((d) => (
                    <Card key={d.id}>
                        <CardContent className="py-3 flex items-center justify-between gap-4">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium truncate">{d.name}</span>
                                    <Badge variant="outline" className="text-[10px]">{d.sourceKind}</Badge>
                                    <Badge
                                        variant={d.status === "ready" ? "default" : "secondary"}
                                        className="text-[10px]"
                                    >
                                        {d.status}
                                    </Badge>
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    {d.itemCount} items · {(d.totalDurationSec / 60).toFixed(1)} min
                                </div>
                                {d.gcsUri && <div className="text-[10px] font-mono text-muted-foreground truncate">{d.gcsUri}</div>}
                            </div>
                            <div className="flex gap-2 shrink-0">
                                {d.status === "draft" && (
                                    <Button size="sm" variant="outline" onClick={() => onMaterialize(d.id)} disabled={pending}>
                                        Upload
                                    </Button>
                                )}
                                {d.status !== "archived" && (
                                    <Button size="sm" variant="ghost" onClick={() => onArchive(d.id)} disabled={pending}>
                                        Archive
                                    </Button>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                ))}
                {datasets.length === 0 && (
                    <Card><CardContent className="py-12 text-center text-muted-foreground">No datasets yet.</CardContent></Card>
                )}
            </div>
        </div>
    );
}

// ─── LoRAs tab ──────────────────────────────────────────────────────────

function LorasTab({ loras }: { loras: LoraDto[] }) {
    return (
        <div className="space-y-2">
            {loras.length === 0 && (
                <Card><CardContent className="py-12 text-center text-muted-foreground">No LoRAs yet. Finish a training job to register one.</CardContent></Card>
            )}
            {loras.map((l) => (
                <Card key={l.id}>
                    <CardContent className="py-3 flex items-center justify-between gap-4">
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className="font-medium">{l.name}</span>
                                <Badge variant="outline" className="text-[10px]">{l.kind}</Badge>
                                <Badge variant="outline" className="text-[10px]">rank {l.rank}</Badge>
                                {l.triggerToken && <code className="text-xs">{l.triggerToken}</code>}
                                {l.thumbsUpRate != null && (
                                    <Badge variant="secondary" className="text-[10px]">
                                        👍 {Math.round(l.thumbsUpRate * 100)}%
                                    </Badge>
                                )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                                {l.scope} · {l.usageCount} uses ·{" "}
                                {l.evalLoss != null ? `eval loss ${l.evalLoss.toFixed(3)}` : "no eval"}
                            </div>
                        </div>
                        {l.previewUri && (
                            <audio
                                src={l.previewUri.replace(/^gs:\/\//, "https://storage.googleapis.com/")}
                                controls
                                className="w-64"
                            />
                        )}
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}

// ─── Feedback tab ───────────────────────────────────────────────────────

function FeedbackTab({ feedback }: { feedback: FeedbackSummary }) {
    return (
        <div className="grid grid-cols-12 gap-4">
            <Card className="col-span-4">
                <CardHeader><CardTitle className="text-sm">Last 30 days</CardTitle></CardHeader>
                <CardContent>
                    <div className="grid grid-cols-3 gap-4 text-center">
                        <div>
                            <div className="text-2xl font-mono">{feedback.up}</div>
                            <div className="text-xs text-muted-foreground">👍 up</div>
                        </div>
                        <div>
                            <div className="text-2xl font-mono">{feedback.down}</div>
                            <div className="text-xs text-muted-foreground">👎 down</div>
                        </div>
                        <div>
                            <div className="text-2xl font-mono">{feedback.flagged}</div>
                            <div className="text-xs text-muted-foreground">🚩 flag</div>
                        </div>
                    </div>
                </CardContent>
            </Card>
            <Card className="col-span-4">
                <CardHeader><CardTitle className="text-sm">Top complaint reasons</CardTitle></CardHeader>
                <CardContent>
                    {feedback.topReasons.length === 0 && <div className="text-sm text-muted-foreground">Nothing yet.</div>}
                    <ul className="space-y-1 text-sm">
                        {feedback.topReasons.map((r) => (
                            <li key={r.reason} className="flex justify-between">
                                <span>{r.reason}</span>
                                <span className="font-mono text-muted-foreground">{r.count}</span>
                            </li>
                        ))}
                    </ul>
                </CardContent>
            </Card>
            <Card className="col-span-4">
                <CardHeader><CardTitle className="text-sm">Recent notes</CardTitle></CardHeader>
                <CardContent className="space-y-1 text-xs">
                    {feedback.recentNotes.length === 0 && <div className="text-muted-foreground">No free-form notes.</div>}
                    {feedback.recentNotes.map((n, i) => (
                        <div key={i} className="border-l-2 pl-2">
                            <span className="text-muted-foreground">{n.verdict === "up" ? "👍" : n.verdict === "down" ? "👎" : "🚩"} </span>
                            {n.note}
                        </div>
                    ))}
                </CardContent>
            </Card>
        </div>
    );
}
