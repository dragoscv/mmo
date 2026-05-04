import { NextResponse } from "next/server";
import { analysisManager } from "@/lib/analysis-manager";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const ids = Array.isArray(body?.changeIds) ? body.changeIds as number[] : [];
        const result = await analysisManager.apply(ids);
        return NextResponse.json(result);
    } catch (err) {
        return NextResponse.json(
            { applied: 0, errors: 1, error: err instanceof Error ? err.message : "apply failed" },
            { status: 500 },
        );
    }
}
