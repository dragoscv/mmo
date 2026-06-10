"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Zap, Loader2, Check, X, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
    triggerPreRemux,
    getPreRemuxStatus,
    cancelPreRemuxAction,
    type PreRemuxJobView,
} from "@/actions/pre-remux";

interface Props {
    fileId: number;
    className?: string;
}

type UiState =
    | { kind: "idle" }
    | { kind: "ready" }                       // sidecar already present
    | { kind: "queued" | "running"; job: PreRemuxJobView }
    | { kind: "done"; job: PreRemuxJobView }
    | { kind: "failed"; job: PreRemuxJobView };

/** Button + live status indicator for the per-file background pre-remux
 *  job. Polls the companion every 2s while a job is active. Idempotent
 *  on the server: clicking again while running is a no-op. */
export function PreRemuxButton({ fileId, className }: Props) {
    const [state, setState] = useState<UiState>({ kind: "idle" });
    const [pending, start] = useTransition();
    const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

    const stopPolling = () => {
        if (pollTimer.current) {
            clearInterval(pollTimer.current);
            pollTimer.current = null;
        }
    };

    const refresh = async () => {
        const r = await getPreRemuxStatus(fileId);
        if (!r) { setState({ kind: "idle" }); return; }
        if (r.job) {
            if (r.job.status === "queued" || r.job.status === "running") {
                setState({ kind: r.job.status, job: r.job });
            } else if (r.job.status === "done" || r.job.status === "skipped") {
                setState({ kind: "done", job: r.job });
                stopPolling();
            } else {
                setState({ kind: "failed", job: r.job });
                stopPolling();
            }
        } else {
            setState(r.hasSidecar ? { kind: "ready" } : { kind: "idle" });
            stopPolling();
        }
    };

    // Initial probe so the badge reflects sidecar state immediately.
    useEffect(() => {
        void refresh();
        return () => stopPolling();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fileId]);

    const ensurePolling = () => {
        if (pollTimer.current) return;
        pollTimer.current = setInterval(() => { void refresh(); }, 2000);
    };

    const onTrigger = () => {
        start(async () => {
            const r = await triggerPreRemux(fileId);
            if (!r) {
                toast.error("Could not start pre-remux. Is the companion online?");
                return;
            }
            if (r.job.status === "skipped") {
                toast.success("Already pre-remuxed — sidecar exists.");
                setState({ kind: "ready" });
                return;
            }
            setState({ kind: r.job.status === "running" ? "running" : "queued", job: r.job });
            ensurePolling();
            toast.success("Pre-remux queued.");
        });
    };

    const onCancel = () => {
        start(async () => {
            await cancelPreRemuxAction(fileId);
            setState({ kind: "idle" });
            stopPolling();
            toast("Pre-remux cancelled.");
        });
    };

    const base = className ?? "inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm border transition-colors";

    if (state.kind === "ready" || state.kind === "done") {
        return (
            <span
                className={`${base} bg-emerald-500/10 text-emerald-300 border-emerald-500/30 cursor-default`}
                title="A pre-remuxed sidecar exists — playback uses near-zero CPU."
            >
                <Check className="h-4 w-4" /> Pre-remuxed
            </span>
        );
    }

    if (state.kind === "queued") {
        return (
            <span className={`${base} bg-amber-500/10 text-amber-200 border-amber-500/30`}>
                <Loader2 className="h-4 w-4 animate-spin" /> Queued
                <button type="button" onClick={onCancel} className="ml-1 hover:text-amber-100" title="Cancel">
                    <Trash2 className="h-3.5 w-3.5" />
                </button>
            </span>
        );
    }

    if (state.kind === "running") {
        const pct = Math.round((state.job.progress ?? 0) * 100);
        return (
            <span className={`${base} bg-amber-500/10 text-amber-200 border-amber-500/30`}>
                <Loader2 className="h-4 w-4 animate-spin" /> Remuxing {pct}%
                <button type="button" onClick={onCancel} className="ml-1 hover:text-amber-100" title="Cancel">
                    <Trash2 className="h-3.5 w-3.5" />
                </button>
            </span>
        );
    }

    if (state.kind === "failed") {
        return (
            <button
                type="button"
                onClick={onTrigger}
                disabled={pending}
                title={state.job.error ?? "Failed — click to retry"}
                className={`${base} bg-rose-500/10 hover:bg-rose-500/20 text-rose-200 border-rose-500/30 cursor-pointer disabled:opacity-50`}
            >
                <X className="h-4 w-4" /> Pre-remux failed — retry
            </button>
        );
    }

    return (
        <button
            type="button"
            onClick={onTrigger}
            disabled={pending}
            title="Convert to a sidecar MP4 once so future playback uses near-zero CPU."
            className={`${base} bg-sky-500/10 hover:bg-sky-500/20 text-sky-200 border-sky-500/30 cursor-pointer disabled:opacity-50`}
        >
            <Zap className="h-4 w-4" /> Pre-remux for fast playback
        </button>
    );
}
