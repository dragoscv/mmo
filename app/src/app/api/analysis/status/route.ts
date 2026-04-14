import { NextResponse } from "next/server";
import { analysisManager } from "@/lib/analysis-manager";

export const dynamic = "force-dynamic";

export async function GET() {
    return NextResponse.json(analysisManager.getStatus());
}
