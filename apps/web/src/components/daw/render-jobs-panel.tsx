"use client";

import { useCallback, useEffect, useState } from "react";
import { isTauri, tauriInvoke } from "@/lib/tauri-bridge";

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

export function RenderJobsPanel() {
    const [jobs, setJobs] = useState<RenderJob[] | null>(null);
    const [native, setNative] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
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
        if (!confirm("Clear all finished render jobs?")) return;
        await tauriInvoke("clear_render_jobs");
        void load();
    }, [load]);

    if (!native) {
        return (
            <div className="text-xs text-muted-foreground p-3 rounded-md border border-dashed">
                Render-job history is only persisted in the native desktop shell. Open this app inside the Tauri
                desktop client to see queued and completed renders.
            </div>
        );
    }

    if (jobs == null) return <div className="text-xs text-muted-foreground p-3">Loading render jobs…</div>;

    const hasFinished = jobs.some((j) => j.stage === "done" || j.stage === "error");

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {jobs.length} job{jobs.length === 1 ? "" : "s"}
                </span>
                <button
                    onClick={() => void clearAll()}
                    disabled={!hasFinished}
                    className="text-[10px] px-2 py-0.5 rounded border hover:bg-muted disabled:opacity-40"
                >Clear finished</button>
            </div>
            {jobs.length === 0 ? (
                <div className="text-xs text-muted-foreground p-3">No render jobs yet.</div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead className="text-left text-muted-foreground">
                            <tr>
                                <th className="py-1.5 pr-3">Created</th>
                                <th className="py-1.5 pr-3">Project</th>
                                <th className="py-1.5 pr-3">Format</th>
                                <th className="py-1.5 pr-3">Mode</th>
                                <th className="py-1.5 pr-3">Stage</th>
                                <th className="py-1.5 pr-3">Size</th>
                                <th className="py-1.5 pr-3"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {jobs.map((j) => (
                                <tr key={j.id} className="border-t border-border/40">
                                    <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(j.created_at).toLocaleString()}</td>
                                    <td className="py-1.5 pr-3 font-mono">{j.project_external_id.slice(0, 8)}…</td>
                                    <td className="py-1.5 pr-3">{j.format}</td>
                                    <td className="py-1.5 pr-3">{j.mode}</td>
                                    <td className="py-1.5 pr-3">
                                        <span className={
                                            j.stage === "done" ? "text-green-500"
                                            : j.stage === "error" ? "text-destructive"
                                            : "text-muted-foreground"
                                        }>{j.stage}</span>
                                        {j.error ? <span className="ml-2 text-destructive">{j.error}</span> : null}
                                    </td>
                                    <td className="py-1.5 pr-3 tabular-nums">
                                        {j.bytes > 0 ? `${(j.bytes / 1024 / 1024).toFixed(2)} MB` : "—"}
                                    </td>
                                    <td className="py-1.5 pr-3 space-x-1 whitespace-nowrap">
                                        {j.output_path ? (
                                            <button
                                                onClick={() => void openFolder(j.id)}
                                                className="text-[10px] px-1.5 py-0.5 rounded border hover:bg-muted"
                                            >Open</button>
                                        ) : null}
                                        {j.stage === "error" ? (
                                            <button
                                                onClick={() => void retry(j.id)}
                                                disabled={busy === j.id}
                                                className="text-[10px] px-1.5 py-0.5 rounded border hover:bg-muted disabled:opacity-50"
                                            >Retry</button>
                                        ) : null}
                                        <button
                                            onClick={() => void remove(j.id)}
                                            className="text-[10px] px-1.5 py-0.5 rounded border hover:bg-muted"
                                        >Remove</button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
