"use client";

import { useState, useTransition } from "react";
import { Upload, CheckCircle2, AlertTriangle } from "lucide-react";
import { importRekordboxXmlAction, type ImportResult } from "@/actions/rekordbox-import";
import { cn } from "@/lib/utils";

export function RekordboxImportCard() {
    const [pending, startTransition] = useTransition();
    const [file, setFile] = useState<File | null>(null);
    const [result, setResult] = useState<ImportResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const submit = () => {
        if (!file) return;
        setError(null);
        setResult(null);
        const fd = new FormData();
        fd.append("xml", file);
        startTransition(async () => {
            try {
                const r = await importRekordboxXmlAction(fd);
                setResult(r);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        });
    };

    return (
        <section className="rounded-xl border border-border bg-card p-5 space-y-4">
            <header>
                <h2 className="flex items-center gap-2 text-base font-semibold">
                    <Upload className="h-4 w-4 text-muted-foreground" />
                    Import rekordbox.xml
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                    Export your rekordbox library to XML (File → Export Collection in xml format), then upload it
                    here. Tracks are deduplicated by rekordbox ID; existing rows are never overwritten.
                </p>
            </header>

            <div className="flex items-center gap-3">
                <input
                    type="file"
                    accept=".xml,text/xml,application/xml"
                    onChange={(e) => {
                        setFile(e.target.files?.[0] ?? null);
                        setResult(null);
                        setError(null);
                    }}
                    className="block w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted/80"
                />
                <button
                    type="button"
                    onClick={submit}
                    disabled={!file || pending}
                    className={cn(
                        "shrink-0 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-muted",
                        (!file || pending) && "opacity-60 cursor-not-allowed",
                    )}
                >
                    {pending ? "Importing…" : "Import"}
                </button>
            </div>

            {result && (
                <div
                    className={cn(
                        "rounded-lg border p-3 text-sm space-y-1",
                        result.ok
                            ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200"
                            : "border-amber-500/30 bg-amber-500/5 text-amber-200",
                    )}
                >
                    <p className="flex items-center gap-2 font-medium">
                        {result.ok
                            ? <CheckCircle2 className="h-4 w-4" />
                            : <AlertTriangle className="h-4 w-4" />}
                        {result.tracksInserted} new track{result.tracksInserted === 1 ? "" : "s"} from {result.tracksParsed} parsed
                        {result.playlistsParsed > 0 && ` · ${result.playlistsParsed} playlists found`}
                    </p>
                    {result.errors.length > 0 && (
                        <details className="text-xs opacity-90">
                            <summary className="cursor-pointer">{result.errors.length} warning{result.errors.length === 1 ? "" : "s"}</summary>
                            <ul className="mt-2 ml-4 list-disc space-y-0.5">
                                {result.errors.slice(0, 10).map((err, i) => (
                                    <li key={i}>{err}</li>
                                ))}
                                {result.errors.length > 10 && <li>… and {result.errors.length - 10} more</li>}
                            </ul>
                        </details>
                    )}
                </div>
            )}
            {error && (
                <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-200">
                    {error}
                </p>
            )}
        </section>
    );
}
