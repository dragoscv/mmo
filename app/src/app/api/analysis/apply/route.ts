import { NextResponse } from "next/server";
import { getAnalysisManager } from "@/lib/analysis-manager";
import { requireSessionWithRate } from "@/lib/api-guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const guard = await requireSessionWithRate(request, { bucket: "analysis-apply", windowMs: 60_000, max: 30 });
    if (guard.response) return guard.response;
    try {
        const body = await request.json();
        const ids = Array.isArray(body?.changeIds) ? body.changeIds as number[] : [];
        const result = await getAnalysisManager(guard.userId!).apply(ids);
        return NextResponse.json(result);
    } catch (err) {
        return NextResponse.json(
            { applied: 0, errors: 1, error: err instanceof Error ? err.message : "apply failed" },
            { status: 500 },
        );
    }
}
