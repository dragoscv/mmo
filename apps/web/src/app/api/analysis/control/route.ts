import { NextResponse } from "next/server";
import { getAnalysisManager } from "@/lib/analysis-manager";
import { requireSessionWithRate } from "@/lib/api-guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const guard = await requireSessionWithRate(request, { bucket: "analysis-control", windowMs: 60_000, max: 60 });
    if (guard.response) return guard.response;
    const analysisManager = getAnalysisManager(guard.userId!);
    const body = await request.json();
    const { action } = body;

    switch (action) {
        case "pause":
            analysisManager.pause();
            break;
        case "resume":
            analysisManager.resume();
            break;
        case "stop":
            analysisManager.stop();
            break;
        case "reset":
            analysisManager.reset();
            break;
        default:
            return NextResponse.json(
                { error: `Unknown action: ${action}` },
                { status: 400 }
            );
    }

    return NextResponse.json(analysisManager.getStatus());
}
