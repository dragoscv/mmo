"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
    validateLoraCorpusByPath,
    validateLoraCorpusFromFormData,
    type ValidateCorpusReport,
} from "@/actions/lora-validate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, DataTable, type DataTableColumnDef } from "@mmo/ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Upload, FolderOpen, CheckCircle2, AlertCircle } from "lucide-react";

type ClipRow = ValidateCorpusReport["clips"][number];

const VERDICT_VARIANT: Record<ValidateCorpusReport["verdict"], "success" | "warning" | "destructive"> = {
    "ready-to-train": "success",
    "minimal-corpus": "warning",
    "insufficient": "destructive",
    "error": "destructive",
};

export function LoraValidateClient() {
    const [pending, startTransition] = useTransition();
    const [report, setReport] = useState<ValidateCorpusReport | null>(null);
    const [dirPath, setDirPath] = useState("");
    const [dragOver, setDragOver] = useState(false);

    const handleByPath = () => {
        if (!dirPath.trim()) {
            toast.error("Enter an absolute path");
            return;
        }
        startTransition(async () => {
            const r = await validateLoraCorpusByPath(dirPath.trim());
            setReport(r);
            toast(r.ok ? `OK — ${r.clipCount} clips` : `Issues: ${r.summary}`);
        });
    };

    const handleFiles = (files: FileList | File[]) => {
        const list = Array.from(files);
        if (list.length === 0) return;
        const fd = new FormData();
        for (const f of list) fd.append("file", f);
        startTransition(async () => {
            const r = await validateLoraCorpusFromFormData(fd);
            setReport(r);
            toast(r.ok ? `OK — ${r.clipCount} clips` : r.summary);
        });
    };

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <FolderOpen className="h-4 w-4" /> Validate by server path
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <Label htmlFor="dirPath">Absolute path on the server</Label>
                    <Input
                        id="dirPath"
                        placeholder="e.g. C:\Users\me\Music\my-lora-corpus"
                        value={dirPath}
                        onChange={(e) => setDirPath(e.target.value)}
                        disabled={pending}
                    />
                    <Button onClick={handleByPath} disabled={pending}>
                        {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Validate folder
                    </Button>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Upload className="h-4 w-4" /> Upload &amp; validate
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <label
                        className={`flex h-40 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition ${dragOver ? "border-primary bg-primary/10" : "border-muted-foreground/30 hover:border-muted-foreground/60"}`}
                        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={(e) => {
                            e.preventDefault();
                            setDragOver(false);
                            handleFiles(e.dataTransfer.files);
                        }}
                    >
                        <Upload className="h-6 w-6 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                            Drop audio files here, or click to select
                        </p>
                        <input
                            type="file"
                            multiple
                            accept=".wav,.flac,.mp3,.ogg,.opus,.m4a,.txt"
                            className="absolute inset-0 cursor-pointer opacity-0"
                            onChange={(e) => e.target.files && handleFiles(e.target.files)}
                            disabled={pending}
                        />
                    </label>
                </CardContent>
            </Card>

            {report ? <ReportCard report={report} /> : null}
        </div>
    );
}

function ReportCard({ report }: { report: ValidateCorpusReport }) {
    const t = useTranslations("tables.loraValidate");

    const columns = useMemo<Array<DataTableColumnDef<ClipRow, any>>>(
        () => [
            {
                accessorKey: "file",
                header: t("file"),
                cell: ({ row }) => (
                    <span className={row.original.ok ? "font-mono" : "font-mono text-destructive"} title={row.original.file}>
                        {row.original.file}
                    </span>
                ),
                meta: { priority: 1 },
            },
            {
                accessorKey: "durationSec",
                header: t("duration"),
                cell: ({ getValue }) => {
                    const v = getValue<number | undefined>();
                    return <span className="tabular-nums">{v != null ? `${v.toFixed(1)}s` : "—"}</span>;
                },
                meta: { priority: 1, align: "right" },
            },
            {
                accessorKey: "sampleRate",
                header: t("sampleRate"),
                cell: ({ getValue }) => <span className="tabular-nums">{getValue<number | undefined>() ?? "—"}</span>,
                meta: { priority: 2, align: "right" },
            },
            {
                accessorKey: "channels",
                header: t("channels"),
                cell: ({ getValue }) => <span className="tabular-nums">{getValue<number | undefined>() ?? "—"}</span>,
                meta: { priority: 3, align: "right" },
            },
            {
                accessorKey: "hasLyrics",
                header: t("lyrics"),
                cell: ({ getValue }) => (getValue<boolean | undefined>() ? <CheckCircle2 className="inline size-4 text-success" aria-label={t("ok")} /> : "—"),
                meta: { priority: 2, align: "center" },
            },
            {
                id: "issues",
                accessorFn: (c) => c.issues.length,
                header: t("issues"),
                cell: ({ row }) =>
                    row.original.issues.length ? (
                        <span className="flex flex-wrap gap-1">
                            {row.original.issues.map((i) => (
                                <Badge key={i} variant="destructive">
                                    {i}
                                </Badge>
                            ))}
                        </span>
                    ) : (
                        <Badge variant="success">{t("ok")}</Badge>
                    ),
                meta: { priority: 1 },
            },
        ],
        [t],
    );

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {report.ok ? (
                        <CheckCircle2 className="h-5 w-5 text-success" />
                    ) : (
                        <AlertCircle className="h-5 w-5 text-destructive" />
                    )}
                    Verdict
                    <Badge variant={VERDICT_VARIANT[report.verdict]}>{t(`verdict.${report.verdict}`)}</Badge>
                    <span className="ml-auto text-xs font-normal text-muted-foreground">
                        {report.clipCount} clips · {Math.round(report.totalDurationSec)}s total
                    </span>
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                <p className="text-sm">{report.summary}</p>
                {report.error ? (
                    <p className="text-xs text-destructive">Error: {report.error}</p>
                ) : null}
                {report.clips.length > 0 ? (
                    <DataTable
                        columns={columns}
                        data={report.clips}
                        getRowId={(c) => c.file}
                        pageSize={25}
                        pagination={report.clips.length > 25}
                        tableClassName="text-xs"
                        mobileCard={(c) => (
                            <div className="flex flex-col gap-1 text-xs">
                                <div className="flex items-start justify-between gap-2">
                                    <span className="min-w-0 truncate font-mono" title={c.file}>{c.file}</span>
                                    {c.ok ? <Badge variant="success">{t("ok")}</Badge> : <Badge variant="destructive">{c.issues.length}</Badge>}
                                </div>
                                <div className="text-muted-foreground tabular-nums">
                                    {c.durationSec != null ? `${c.durationSec.toFixed(1)}s` : "—"} · {c.sampleRate ?? "—"} Hz · {c.channels ?? "—"} ch
                                    {c.hasLyrics ? ` · ${t("lyrics")}` : ""}
                                </div>
                                {c.issues.length ? <div className="text-destructive">{c.issues.join(", ")}</div> : null}
                            </div>
                        )}
                    />
                ) : null}
            </CardContent>
        </Card>
    );
}
