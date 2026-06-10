import { NextResponse } from "next/server";
import { getAnalysisManager } from "@/lib/analysis-manager";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    const jobIdParam = url.searchParams.get("jobId");
    const jobId = jobIdParam ? parseInt(jobIdParam, 10) : null;
    const changes = getAnalysisManager(session.user.id).getChanges(
        jobId != null && Number.isFinite(jobId) ? jobId : null,
    );
    return NextResponse.json({ changes });
}
