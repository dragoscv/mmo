import { NextResponse } from "next/server";
import { analysisManager } from "@/lib/analysis-manager";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const url = new URL(request.url);
    const jobIdParam = url.searchParams.get("jobId");
    const jobId = jobIdParam ? parseInt(jobIdParam, 10) : null;
    const changes = analysisManager.getChanges(
        jobId != null && Number.isFinite(jobId) ? jobId : null,
    );
    return NextResponse.json({ changes });
}
