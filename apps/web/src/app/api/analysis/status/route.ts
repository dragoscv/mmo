import { NextResponse } from "next/server";
import { getAnalysisManager } from "@/lib/analysis-manager";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export async function GET() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.json(getAnalysisManager(session.user.id).getStatus());
}
