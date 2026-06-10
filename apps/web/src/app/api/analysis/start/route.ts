import { NextResponse } from "next/server";
import { getAnalysisManager } from "@/lib/analysis-manager";
import { requireSessionWithRate } from "@/lib/api-guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const guard = await requireSessionWithRate(request, { bucket: "analysis", windowMs: 60_000, max: 10 });
    if (guard.response) return guard.response;
    try {
        const body = await request.json();
        const { mode, options } = body;

        if (!mode || !options) {
            return NextResponse.json(
                { error: "Missing mode or options" },
                { status: 400 }
            );
        }

        const result = await getAnalysisManager(guard.userId!).start(mode, options);
        return NextResponse.json(result);
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Failed to start" },
            { status: 409 }
        );
    }
}
