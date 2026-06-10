"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
    validateLoraCorpusByPath,
    validateLoraCorpusFromFormData,
    type ValidateCorpusReport,
} from "@/actions/lora-validate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Upload, FolderOpen, CheckCircle2, AlertCircle } from "lucide-react";

const VERDICT_COLOR: Record<ValidateCorpusReport["verdict"], string> = {
    "ready-to-train": "bg-emerald-500 text-white",
    "minimal-corpus": "bg-amber-500 text-white",
    "insufficient": "bg-destructive text-white",
    "error": "bg-destructive text-white",
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
    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {report.ok ? (
                        <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    ) : (
                        <AlertCircle className="h-5 w-5 text-destructive" />
                    )}
                    Verdict
                    <Badge className={VERDICT_COLOR[report.verdict]}>{report.verdict}</Badge>
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
                    <div className="overflow-hidden rounded border">
                        <table className="w-full text-xs">
                            <thead className="bg-muted/50 text-muted-foreground">
                                <tr>
                                    <th className="p-2 text-left">File</th>
                                    <th className="p-2 text-right">Dur</th>
                                    <th className="p-2 text-right">SR</th>
                                    <th className="p-2 text-right">Ch</th>
                                    <th className="p-2 text-center">Lyrics</th>
                                    <th className="p-2 text-left">Issues</th>
                                </tr>
                            </thead>
                            <tbody>
                                {report.clips.map((c) => (
                                    <tr key={c.file} className={c.ok ? "" : "bg-destructive/5"}>
                                        <td className="p-2 font-mono">{c.file}</td>
                                        <td className="p-2 text-right">{c.durationSec?.toFixed(1) ?? "—"}s</td>
                                        <td className="p-2 text-right">{c.sampleRate ?? "—"}</td>
                                        <td className="p-2 text-right">{c.channels ?? "—"}</td>
                                        <td className="p-2 text-center">{c.hasLyrics ? "✓" : "—"}</td>
                                        <td className="p-2 text-muted-foreground">
                                            {c.issues.length ? c.issues.join(", ") : "—"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : null}
            </CardContent>
        </Card>
    );
}
