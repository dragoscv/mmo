"use client";

/**
 * Visible metadata nudge + auto-backfill orchestrator.
 *
 * On /watch mount we ask the server how many movies/shows still have
 * no poster. If any are missing:
 *   1. Show a slim banner pinned under the hero ("12 items need metadata")
 *      with a "Fetch now" button.
 *   2. Auto-kick the fetch on first visit per session (silent).
 *   3. While running, the banner morphs into a progress chip.
 *   4. When done, banner shows summary and auto-dismisses after 6s.
 *
 * Session flag avoids re-triggering on every navigation within /watch.
 */
import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Loader2, X, Check, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { backfillMissingTmdbMetadata, countMissingTmdb } from "@/actions/video-backfill";

const SESSION_AUTORUN_KEY = "mmo:watch-backfill-ran";
const SESSION_DISMISS_KEY = "mmo:watch-backfill-dismissed";

type State =
    | { kind: "idle" }
    | { kind: "missing"; movies: number; shows: number }
    | { kind: "running"; total: number }
    | { kind: "done"; updated: number }
    | { kind: "error"; message: string };

export function AutoBackfill() {
    const router = useRouter();
    const [state, setState] = useState<State>({ kind: "idle" });
    const [pending, startTransition] = useTransition();

    const probe = useCallback(async () => {
        const missing = await countMissingTmdb().catch(() => ({ movies: 0, shows: 0 }));
        const total = missing.movies + missing.shows;
        if (total === 0) {
            setState({ kind: "idle" });
            return 0;
        }
        setState({ kind: "missing", movies: missing.movies, shows: missing.shows });
        return total;
    }, []);

    const run = useCallback(() => {
        startTransition(async () => {
            const result = await backfillMissingTmdbMetadata(50).catch((err) => ({
                error: err instanceof Error ? err.message : "Eroare neașteptată",
                moviesUpdated: 0, showsUpdated: 0, moviesSkipped: 0, showsSkipped: 0,
            }));
            if (!result || result.error) {
                const msg = result?.error === "TMDB_API_KEY not configured"
                    ? "Cheia TMDB lipsește. Adaug-o în .env.local (TMDB_API_KEY)."
                    : `Backfill eșuat: ${result?.error ?? "necunoscut"}`;
                toast.error(msg, { duration: 8000 });
                setState({ kind: "error", message: msg });
                return;
            }
            const updated = result.moviesUpdated + result.showsUpdated;
            setState({ kind: "done", updated });
            if (updated > 0) {
                toast.success(`Metadata actualizată pentru ${updated} ${updated === 1 ? "titlu" : "titluri"}.`);
                router.refresh();
            }
            setTimeout(() => {
                probe().then((remaining) => {
                    if (remaining === 0) setState({ kind: "idle" });
                });
            }, 6000);
        });
    }, [router, probe]);

    // First-mount probe + optional auto-run.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const dismissed = sessionStorage.getItem(SESSION_DISMISS_KEY) === "1";
        (async () => {
            const total = await probe();
            if (total === 0) return;
            if (dismissed) return; // user said "not now"
            if (sessionStorage.getItem(SESSION_AUTORUN_KEY) === "1") return;
            sessionStorage.setItem(SESSION_AUTORUN_KEY, "1");
            run();
        })();
    }, [probe, run]);

    const dismiss = useCallback(() => {
        sessionStorage.setItem(SESSION_DISMISS_KEY, "1");
        setState({ kind: "idle" });
    }, []);

    if (state.kind === "idle" && !pending) return null;

    return (
        <div className="watch-backfill-banner" role="status" aria-live="polite">
            {pending || state.kind === "running" ? (
                <>
                    <Loader2 size={16} className="spin" aria-hidden />
                    <span>Fetching posters, overviews and trailers from TMDB…</span>
                </>
            ) : state.kind === "done" ? (
                <>
                    <Check size={16} aria-hidden />
                    <span>Updated {state.updated} item{state.updated === 1 ? "" : "s"}</span>
                    <Sparkles size={14} aria-hidden />
                </>
            ) : state.kind === "error" ? (
                <>
                    <AlertTriangle size={16} aria-hidden />
                    <span>{state.message}</span>
                    <button type="button" className="watch-backfill-close" onClick={dismiss} aria-label="Dismiss">
                        <X size={14} />
                    </button>
                </>
            ) : state.kind === "missing" ? (
                <>
                    <Sparkles size={16} aria-hidden />
                    <span>
                        {state.movies + state.shows} item{state.movies + state.shows === 1 ? "" : "s"} missing metadata
                        {state.movies > 0 && state.shows > 0
                            ? ` (${state.movies} films, ${state.shows} series)`
                            : ""}
                    </span>
                    <button type="button" className="watch-backfill-cta" onClick={run} disabled={pending}>
                        Fetch now
                    </button>
                    <button type="button" className="watch-backfill-close" onClick={dismiss} aria-label="Dismiss">
                        <X size={14} />
                    </button>
                </>
            ) : null}
            <style>{`.spin{animation:spin 800ms linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
    );
}
