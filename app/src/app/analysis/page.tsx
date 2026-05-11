import { auth } from "@/auth";
import { getCompanionLink } from "@/lib/companion-library";
import { notSignedInFor, noCompanionFor } from "@/components/empty-state-server";
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
    const session = await auth();
    if (!session?.user?.id) return notSignedInFor("analysis");
    const link = await getCompanionLink();
    if (!link) return noCompanionFor("analysis");

    return <AnalysisClient />;
}
