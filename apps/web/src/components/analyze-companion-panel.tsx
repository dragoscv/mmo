"use client";

/**
 * Companion DSP / Source-Separation panel.
 *
 * Surfaces the new analyzer pipeline (Essentia BPM/key/loudness +
 * BS-Roformer source separation) to the user. Lives inside the
 * Reanalyze modal, separate from the textual-metadata batch flow
 * because:
 *  - DSP/stems run on the *companion* (Python sidecar), not in the
 *    web app, so the lifecycle is independent of the modal.
 *  - The work is heavy (minutes per track for stems on CPU); users
 *    typically kick it off and walk away.
 *
 * Polls `getAnalyzerStatus` every 2 s while jobs are in flight.
 */

import { useCallback, useEffect, useState } from "react";
import {
    getAnalyzerHealth,
    startBulkDspAnalysis,
    getAnalyzerStatus,
    cancelAnalyzerJob,
} from "@/actions/analyze";
import type { AnalyzerHealth, AnalyzerStatus } from "@/lib/companion-library";

export function CompanionAnalyzerPanel() {
    const [health, setHealth] = useState<AnalyzerHealth | null>(null);
    const [status, setStatus] = useState<AnalyzerStatus | null>(null);
    const [opts, setOpts] = useState({ dsp: true, stems: false, fingerprint: false });
    const [filter, setFilter] = useState<"all" | "missing-dsp" | "missing-stems">("missing-dsp");
    const [busy, setBusy] = useState(false);
    const [lastResult, setLastResult] = useState<string | null>(null);

    // Initial health probe.
    useEffect(() => {
        getAnalyzerHealth().then(setHealth);
    }, []);

    // Poll status whenever there's anything in flight.
    useEffect(() => {
        let cancelled = false;
        const tick = async () => {
            const s = await getAnalyzerStatus();
            if (cancelled) return;
            if ("error" in s) { setStatus(null); return; }
            setStatus(s);
        };
        tick();
        const id = setInterval(tick, 2000);
        return () => { cancelled = true; clearInterval(id); };
    }, []);

    const start = useCallback(async () => {
        setBusy(true);
        setLastResult(null);
        try {
            const r = await startBulkDspAnalysis(opts, filter);
            setLastResult(r.error ? `Error: ${r.error}` : `Enqueued ${r.enqueued} job(s).`);
        } finally {
            setBusy(false);
        }
    }, [opts, filter]);

    const cancelCurrent = useCallback(async () => {
        if (!status?.current) return;
        await cancelAnalyzerJob(status.current.id);
    }, [status]);

    // ── Render ──────────────────────────────────────────────────────
    const queueLen = status?.queue.length ?? 0;
    const inflight = status?.current;
    const recent = status?.completed.slice(-5).reverse() ?? [];

    return (
        <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">
                    Companion DSP / Stems analyzer
                </h3>
                <HealthDot health={health} />
            </div>

            {!health?.ok && (
                <div className="text-xs text-amber-300/90">
                    {health?.reason || "Probing companion…"}
                    {health && !health.ok && (
                        <div className="mt-1 text-white/60">
                            Install with: <code className="text-amber-200">pip install audio-separator[cpu] librosa pyloudnorm pyacoustid soundfile numpy</code>
                        </div>
                    )}
                </div>
            )}

            <div className="grid grid-cols-3 gap-2 text-xs">
                <Toggle label="DSP (BPM/key/loudness)" value={opts.dsp}
                    onChange={(v) => setOpts((o) => ({ ...o, dsp: v }))}
                    disabled={!health?.available?.librosa} />
                <Toggle label="Stems (BS-Roformer)" value={opts.stems}
                    onChange={(v) => setOpts((o) => ({ ...o, stems: v }))}
                    disabled={!health?.available?.audio_separator} />
                <Toggle label="Fingerprint (AcoustID)" value={opts.fingerprint}
                    onChange={(v) => setOpts((o) => ({ ...o, fingerprint: v }))}
                    disabled={!health?.available?.pyacoustid} />
            </div>

            <div className="flex items-center gap-2 text-xs">
                <label className="text-white/70">Scope:</label>
                <select value={filter}
                    onChange={(e) => setFilter(e.target.value as typeof filter)}
                    className="rounded bg-white/10 px-2 py-1 text-white">
                    <option value="missing-dsp">Tracks without DSP analysis</option>
                    <option value="missing-stems">Tracks without stems</option>
                    <option value="all">Entire library</option>
                </select>
            </div>

            <div className="flex items-center gap-2">
                <button
                    onClick={start}
                    disabled={busy || !health?.ok || (!opts.dsp && !opts.stems && !opts.fingerprint)}
                    className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {busy ? "Enqueuing…" : "Start analysis"}
                </button>
                {inflight && (
                    <button
                        onClick={cancelCurrent}
                        className="rounded bg-red-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500"
                    >
                        Cancel current
                    </button>
                )}
                {lastResult && (
                    <span className="text-xs text-white/70">{lastResult}</span>
                )}
            </div>

            {(inflight || queueLen > 0) && (
                <div className="space-y-1 rounded border border-white/10 bg-black/30 p-2">
                    {inflight && (
                        <div className="text-xs">
                            <div className="flex items-center justify-between">
                                <span className="text-white/80">
                                    Track {inflight.trackId} — {inflight.stage}
                                </span>
                                <span className="text-white/50">
                                    {Math.round((inflight.progress ?? 0) * 100)}%
                                </span>
                            </div>
                            <div className="mt-1 h-1.5 w-full rounded bg-white/10">
                                <div
                                    className="h-full rounded bg-blue-500 transition-all"
                                    style={{ width: `${Math.round((inflight.progress ?? 0) * 100)}%` }}
                                />
                            </div>
                            {inflight.message && (
                                <div className="mt-0.5 truncate text-white/50">{inflight.message}</div>
                            )}
                        </div>
                    )}
                    {queueLen > 0 && (
                        <div className="text-xs text-white/60">
                            {queueLen} job{queueLen === 1 ? "" : "s"} queued
                        </div>
                    )}
                </div>
            )}

            {recent.length > 0 && (
                <details className="text-xs">
                    <summary className="cursor-pointer text-white/60">Recent completions ({recent.length})</summary>
                    <ul className="mt-1 space-y-0.5">
                        {recent.map((j) => (
                            <li key={j.id} className="flex justify-between gap-2 truncate">
                                <span className="truncate text-white/70">Track {j.trackId}</span>
                                <span className={j.error ? "text-red-400" : "text-emerald-400"}>
                                    {j.error ? "error" : "done"}
                                </span>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}

function HealthDot({ health }: { health: AnalyzerHealth | null }) {
    if (!health) return <span className="h-2 w-2 rounded-full bg-white/30" />;
    if (health.ok) return <span title="Companion ready" className="h-2 w-2 rounded-full bg-emerald-500" />;
    return <span title={health.reason} className="h-2 w-2 rounded-full bg-amber-500" />;
}

function Toggle({ label, value, onChange, disabled }: {
    label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
    return (
        <label className={`flex items-center gap-1.5 ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}>
            <input
                type="checkbox" checked={value && !disabled} disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
                className="h-3.5 w-3.5 accent-blue-500"
            />
            <span className="text-white/80">{label}</span>
        </label>
    );
}
