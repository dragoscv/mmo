/**
 * "Separate stems", from the deck's STEMS tab and from a library row: `companionRequestStems` →
 * poll `companionStemJob`, plus attaching the result to the deck that asked
 * (`companionTrackStems` → `loadStems`, as the track loader does).
 *
 * Jobs live in ONE store keyed by track id, so the progress survives a tab switch or a library
 * remount, the deck tab and the library row show the same job, and a track never gets two.
 */
import { create } from "zustand";
import { engine } from "@/bridge/engine";
import type { DeckId, TrackStems } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { isLibraryTrackId } from "./tab-math";

export interface StemJobView {
    state: "running" | "done" | "error";
    /** 0..1. */
    progress: number;
    /** `notLibrary` = the deck's track is not a library track, so there is nothing to separate. */
    reason?: "notLibrary" | "failed";
}

interface StemJobsStore {
    jobs: Record<string, StemJobView>;
}

export const useStemJobs = create<StemJobsStore>(() => ({ jobs: {} }));

const POLL_MS = 1500;
/** Consecutive unanswered polls before the job counts as failed. */
const MAX_POLL_FAILS = 4;

function setJob(trackId: string, job: StemJobView): void {
    useStemJobs.setState((s) => ({ jobs: { ...s.jobs, [trackId]: job } }));
}

function hasPaths(s: TrackStems | null | undefined): s is TrackStems {
    return !!s && !!(s.vocals || s.drums || s.bass || s.melody);
}

/** Attach `stems` to `deck` when it still holds `trackId`. */
async function attach(deck: DeckId, trackId: string, stems: TrackStems): Promise<void> {
    if (useMixerStore.getState().deck(deck).trackId !== trackId) return;
    await engine.loadStems(deck, { vocals: stems.vocals, drums: stems.drums, bass: stems.bass, melody: stems.melody });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function run(deck: DeckId | null, trackId: string, id: number): Promise<void> {
    // Separated already (e.g. from the library after this deck was loaded): attach, no new job.
    const existing = await engine.companionTrackStems(id).catch(() => null);
    if (hasPaths(existing)) {
        if (deck) await attach(deck, trackId, existing);
        setJob(trackId, { state: "done", progress: 1 });
        return;
    }
    const jobId = await engine.companionRequestStems(id);
    if (!jobId) throw new Error("no job id");
    let fails = 0;
    for (;;) {
        await sleep(POLL_MS);
        const job = await engine.companionStemJob(jobId).catch(() => null);
        if (!job) {
            fails += 1;
            if (fails >= MAX_POLL_FAILS) throw new Error("no answer from the stem job");
            continue;
        }
        fails = 0;
        if (job.state === "error") throw new Error(job.message ?? "stem job failed");
        if (job.state === "done") {
            const stems = hasPaths(job.stems) ? job.stems : await engine.companionTrackStems(id).catch(() => null);
            if (deck && hasPaths(stems)) await attach(deck, trackId, stems);
            setJob(trackId, { state: "done", progress: 1 });
            return;
        }
        setJob(trackId, { state: "running", progress: Math.min(1, Math.max(0, job.progress || 0)) });
    }
}

/**
 * Start (or re-try) stem separation for `trackId`: the track on `deck`, or a library row
 * (`deck` = null: nothing to attach the result to). A running job is left alone.
 */
export function separateStems(deck: DeckId | null, trackId: string | null): void {
    if (!trackId) return;
    if (useStemJobs.getState().jobs[trackId]?.state === "running") return;
    // A library row is a library track by definition; a deck may hold a local file or a dev demo track.
    if (deck !== null && !isLibraryTrackId(trackId)) {
        setJob(trackId, { state: "error", progress: 0, reason: "notLibrary" });
        return;
    }
    const id = Number(trackId);
    setJob(trackId, { state: "running", progress: 0 });
    void run(deck, trackId, id).catch(() => setJob(trackId, { state: "error", progress: 0, reason: "failed" }));
}
