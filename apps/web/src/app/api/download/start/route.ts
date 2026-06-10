import { NextResponse } from "next/server";

/**
 * yt-dlp download pipeline currently disabled while the downloads table
 * is being relocated to the companion library.
 */
export async function POST() {
    return NextResponse.json(
        { error: "Downloads are temporarily disabled while the library is migrated to the companion." },
        { status: 501 },
    );
}
