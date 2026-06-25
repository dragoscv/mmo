import { auth } from "@/auth";
import { getAllCompanionLinks } from "@/lib/companion-library";
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
    const links = await getAllCompanionLinks();
    if (links.length === 0) return noCompanionFor("analysis");

    return <AnalysisClient />;
}
