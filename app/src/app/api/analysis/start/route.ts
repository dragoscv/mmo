import { NextResponse } from "next/server";
import { analysisManager } from "@/lib/analysis-manager";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { mode, options } = body;

        if (!mode || !options) {
            return NextResponse.json(
                { error: "Missing mode or options" },
                { status: 400 }
            );
        }

        const result = await analysisManager.start(mode, options);
        return NextResponse.json(result);
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : "Failed to start" },
            { status: 409 }
        );
    }
}
