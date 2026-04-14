import { NextResponse } from "next/server";
import { analysisManager } from "@/lib/analysis-manager";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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
