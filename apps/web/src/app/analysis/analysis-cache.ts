/**
 * Module-level cache for the /analysis page's polled state.
 *
 * The analysis page component unmounts on every navigation (App Router swaps
 * `children`), so its `useState` for health/status/batches/scope was lost and
 * the page showed empty until the first poll completed — a visible "reload"
 * wait every time you came back.
 *
 * This survives navigation (module singletons persist for the tab's lifetime),
 * so the page can seed its initial state instantly from the last snapshot while
 * the polling loop refreshes in the background. It is NOT a substitute for the
 * server — just a warm cache for perceived instant remounts.
 */

import type {
    AnalyzerHealth,
    AnalyzerStatus,
    AnalyzerBatch,
} from "@/lib/companion-library";
import type { AnalysisScope } from "@/actions/analyze";

interface AnalysisSnapshot {
    health: AnalyzerHealth | null;
    status: AnalyzerStatus | null;
    batches: AnalyzerBatch[];
    scope: AnalysisScope | null;
}

const snapshot: AnalysisSnapshot = {
    health: null,
    status: null,
    batches: [],
    scope: null,
};

export function getAnalysisSnapshot(): AnalysisSnapshot {
    return snapshot;
}

export function setAnalysisHealth(health: AnalyzerHealth | null): void {
    snapshot.health = health;
}

export function setAnalysisStatus(status: AnalyzerStatus | null): void {
    snapshot.status = status;
}

export function setAnalysisBatches(batches: AnalyzerBatch[]): void {
    snapshot.batches = batches;
}

export function setAnalysisScope(scope: AnalysisScope | null): void {
    snapshot.scope = scope;
}
