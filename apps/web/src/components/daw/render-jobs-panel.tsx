"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge, Button, DataTable, EmptyState, Progress, type DataTableColumnDef } from "@mmo/ui";
import { FolderOpenIcon, RotateCcwIcon, Trash2Icon, FilmIcon } from "lucide-react";
import { isTauri, tauriInvoke } from "@/lib/tauri-bridge";
import { formatBytes } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/relative-time";

interface RenderJob {
    id: string;
    project_external_id: string;
    format: string;
    mode: string;
    stage: string;
    bytes: number;
    output_path: string | null;
    error: string | null;
    created_at: number;
    finished_at: number | null;
}

const TERMINAL_STAGES = new Set(["done", "ready", "error"]);
const STAGE_PROGRESS: Record<string, number> = { queued: 5, uploading: 60, ready: 100, done: 100, error: 100 };
/** Rough wall-clock budget used to estimate the remaining time for in-flight jobs. */
const EXPECTED_JOB_MS = 90_000;

function stageVariant(stage: string): "success" | "destructive" | "info" | "secondary" {
    if (stage === "done" || stage === "ready") return "success";
    if (stage === "error") return "destructive";
    if (stage === "uploading") return "info";
    return "secondary";
}

export function RenderJobsPanel() {
    const t = useTranslations("tables.renderJobs");
    const locale = useLocale();
    const [jobs, setJobs] = useState<RenderJob[] | null>(null);
    const [native, setNative] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());

    const load = useCallback(async () => {
        setNow(Date.now());
        if (isTauri()) {
            setNative(true);
            const list = await tauriInvoke<RenderJob[]>("list_render_jobs");
            setJobs(list ?? []);
        } else {
            setNative(false);
            setJobs([]);
        }
    }, []);

    useEffect(() => {
        void load();
        const t = setInterval(() => { void load(); }, 2000);
        return () => clearInterval(t);
    }, [load]);

    const remove = useCallback(async (id: string) => {
        if (!isTauri()) return;
        await tauriInvoke("remove_render_job", { id });
        void load();
    }, [load]);

    const retry = useCallback(async (id: string) => {
        if (!isTauri()) return;
        setBusy(id);
        try { await tauriInvoke("retry_render_job", { id }); }
        finally { setBusy(null); void load(); }
    }, [load]);

    const openFolder = useCallback(async (id: string) => {
        if (!isTauri()) return;
        try { await tauriInvoke("open_render_output", { id }); }
        catch (e) { console.warn("open_render_output failed", e); }
    }, []);

    const clearAll = useCallback(async () => {
        if (!isTauri()) return;
        if (!confirm(t("clearConfirm"))) return;
        await tauriInvoke("clear_render_jobs");
        void load();
    }, [load, t]);

    const stageLabel = useCallback(
        (stage: string) => {
            const known = ["queued", "uploading", "ready", "done", "error"] as const;
            return (known as readonly string[]).includes(stage) ? t(`stage.${stage as (typeof known)[number]}`) : stage;
        },
        [t],
    );

    const etaLabel = useCallback(
        (j: RenderJob) => {
            if (TERMINAL_STAGES.has(j.stage)) return t("etaDone");
            const remaining = EXPECTED_JOB_MS - (now - j.created_at);
            if (remaining <= 0) return t("etaUnknown");
            const s = Math.ceil(remaining / 1000);
            return s < 60 ? t("etaSeconds", { seconds: s }) : t("etaMinutes", { minutes: Math.ceil(s / 60) });
        },
        [now, t],
    );

    const columns = useMemo<Array<DataTableColumnDef<RenderJob, any>>>(
        () => [
            {
                accessorKey: "created_at",
                header: t("created"),
                cell: ({ getValue }) => {
                    const ts = getValue<number>();
                    return <span className="whitespace-nowrap" title={new Date(ts).toLocaleString(locale)}>{formatRelativeTime(new Date(ts), locale, now) ?? "—"}</span>;
                },
                meta: { priority: 2 },
            },
            {
                accessorKey: "project_external_id",
                header: t("project"),
                cell: ({ getValue }) => <span className="font-mono text-xs">{getValue<string>().slice(0, 8)}…</span>,
                meta: { priority: 3, hideBelow: "lg" },
            },
            { accessorKey: "format", header: t("format"), meta: { priority: 2 } },
            { accessorKey: "mode", header: t("mode"), meta: { priority: 3 } },
            {
                id: "progress",
                accessorFn: (j) => STAGE_PROGRESS[j.stage] ?? 0,
                header: t("progress"),
                cell: ({ row }) => {
                    const j = row.original;
                    const inFlight = !TERMINAL_STAGES.has(j.stage);
                    return (
                        <Progress
                            value={STAGE_PROGRESS[j.stage] ?? 0}
                            indeterminate={inFlight && j.stage === "uploading"}
                            showValue={!inFlight}
                            aria-label={t("progress")}
                            className="min-w-24"
                            indicatorClassName={j.stage === "error" ? "bg-destructive" : undefined}
                        />
                    );
                },
                meta: { priority: 1, className: "w-40" },
            },
            {
                accessorKey: "stage",
                header: t("status"),
                cell: ({ row }) => (
                    <span className="inline-flex items-center gap-2">
                        <Badge variant={stageVariant(row.original.stage)}>{stageLabel(row.original.stage)}</Badge>
                        {row.original.error ? <span className="max-w-48 truncate text-destructive" title={row.original.error}>{row.original.error}</span> : null}
                    </span>
                ),
                meta: { priority: 1 },
            },
            { id: "eta", accessorFn: (j) => etaLabel(j), header: t("eta"), enableSorting: false, meta: { priority: 2 } },
            {
                accessorKey: "bytes",
                header: t("size"),
                cell: ({ getValue }) => <span className="tabular-nums">{getValue<number>() > 0 ? formatBytes(getValue<number>()) : "—"}</span>,
                meta: { priority: 3, align: "right" },
            },
            {
                id: "actions",
                header: "",
                enableSorting: false,
                enableHiding: false,
                cell: ({ row }) => <JobActions job={row.original} busy={busy} onOpen={openFolder} onRetry={retry} onRemove={remove} />,
                meta: { priority: 1, align: "right", className: "w-28" },
            },
        ],
        [t, locale, now, busy, stageLabel, etaLabel, openFolder, retry, remove],
    );

    if (!native) {
        return (
            <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">{t("nativeOnly")}</div>
        );
    }

    const hasFinished = (jobs ?? []).some((j) => j.stage === "done" || j.stage === "error");

    return (
        <DataTable
            columns={columns}
            data={jobs ?? []}
            isLoading={jobs == null}
            getRowId={(j) => j.id}
            pageSize={10}
            pagination={(jobs?.length ?? 0) > 10}
            tableClassName="text-xs"
            emptyState={<EmptyState variant="inline" icon={<FilmIcon aria-hidden />} title={t("empty")} />}
            toolbar={
                <div className="flex w-full items-center justify-between gap-2">
                    <span className="text-[10px] tracking-wider text-muted-foreground uppercase">{t("count", { count: jobs?.length ?? 0 })}</span>
                    <Button variant="outline" size="xs" disabled={!hasFinished} onClick={() => void clearAll()}>
                        <Trash2Icon />
                        {t("clearFinished")}
                    </Button>
                </div>
            }
            mobileCard={(j) => (
                <div className="flex flex-col gap-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <div className="font-medium">
                                {j.format} · {j.mode}
                            </div>
                            <div className="text-muted-foreground">{formatRelativeTime(new Date(j.created_at), locale, now)}</div>
                        </div>
                        <Badge variant={stageVariant(j.stage)}>{stageLabel(j.stage)}</Badge>
                    </div>
                    <Progress value={STAGE_PROGRESS[j.stage] ?? 0} indeterminate={j.stage === "uploading"} aria-label={t("progress")} indicatorClassName={j.stage === "error" ? "bg-destructive" : undefined} />
                    <div className="flex items-center justify-between gap-2 text-muted-foreground">
                        <span>
                            {etaLabel(j)}
                            {j.bytes > 0 ? ` · ${formatBytes(j.bytes)}` : ""}
                        </span>
                        <JobActions job={j} busy={busy} onOpen={openFolder} onRetry={retry} onRemove={remove} />
                    </div>
                    {j.error ? <p className="text-destructive">{j.error}</p> : null}
                </div>
            )}
        />
    );
}

function JobActions({
    job,
    busy,
    onOpen,
    onRetry,
    onRemove,
}: {
    job: RenderJob;
    busy: string | null;
    onOpen: (id: string) => Promise<void>;
    onRetry: (id: string) => Promise<void>;
    onRemove: (id: string) => Promise<void>;
}) {
    const tc = useTranslations("tables.common");
    return (
        <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
            {job.output_path ? (
                <Button variant="ghost" size="icon-xs" aria-label={tc("open")} title={tc("open")} onClick={() => void onOpen(job.id)}>
                    <FolderOpenIcon />
                </Button>
            ) : null}
            {job.stage === "error" ? (
                <Button variant="ghost" size="icon-xs" aria-label={tc("retry")} title={tc("retry")} loading={busy === job.id} onClick={() => void onRetry(job.id)}>
                    <RotateCcwIcon />
                </Button>
            ) : null}
            <Button variant="ghost" size="icon-xs" aria-label={tc("remove")} title={tc("remove")} onClick={() => void onRemove(job.id)}>
                <Trash2Icon />
            </Button>
        </div>
    );
}
