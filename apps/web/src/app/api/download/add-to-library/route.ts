import { NextResponse } from "next/server";

/** Downloads moved to the companion library. Endpoint stubbed until proxy is wired. */
export async function POST() {
    return NextResponse.json(
        { error: "Downloads are temporarily disabled while the library is migrated to the companion." },
        { status: 501 },
    );
}
export async function GET() {
    return NextResponse.json({ items: [], total: 0 });
}
