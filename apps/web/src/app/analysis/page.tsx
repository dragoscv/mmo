import { auth } from "@/auth";
import { notSignedInFor } from "@/components/empty-state-server";
import { AnalysisClient } from "./analysis-client";

export const dynamic = "force-dynamic";

/**
 * Library Analysis page.
 *
 * Dedicated workspace for the Companion DSP / Stems / Fingerprint
 * pipeline. Shows live job queue, per-job progress, full append-only
 * log feed, system health, and the bulk-reanalyze controls in one
 * place — far more informative than the cramped modal version.
 */
export default async function AnalysisPage() {
    // Only gate on auth here — keep the server work minimal so the page shell
    // renders fast on every (re)navigation. The "no companion paired" case is
    // handled client-side by AnalysisClient (it already polls companion health
    // and renders an offline state), which lets the cached client component
    // paint its last data instantly instead of waiting on a server DB round
    // trip (auth + device lookup + token decrypt) every time.
    const session = await auth();
    if (!session?.user?.id) return notSignedInFor("analysis");

    return <AnalysisClient />;
}
