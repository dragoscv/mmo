import { NextResponse } from "next/server";
import { db } from "@/db";
import { analysisChanges } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");

    if (!jobId) {
        return NextResponse.json(
            { error: "Missing jobId" },
            { status: 400 }
        );
    }

    const changes = db
        .select({
            id: analysisChanges.id,
            jobId: analysisChanges.jobId,
            trackId: analysisChanges.trackId,
            trackArtist: analysisChanges.trackArtist,
            trackTitle: analysisChanges.trackTitle,
            field: analysisChanges.field,
            fieldLabel: analysisChanges.fieldLabel,
            oldValue: analysisChanges.oldValue,
            // For lyrics fields, don't send the full text (can be huge)
            newValue: analysisChanges.newValue,
            source: analysisChanges.source,
            checked: analysisChanges.checked,
        })
        .from(analysisChanges)
        .where(eq(analysisChanges.jobId, parseInt(jobId, 10)))
        .all();

    // Truncate lyrics display for the client
    const mapped = changes.map((c) => ({
        ...c,
        newValueDisplay:
            c.field === "lyrics" || c.field === "syncedLyrics"
                ? `${c.newValue.split("\n").length} lines`
                : c.field === "artworkUrl"
                    ? "New artwork"
                    : c.newValue,
        // Don't send full lyrics/artwork URL to client for display
        newValue:
            c.field === "lyrics" || c.field === "syncedLyrics"
                ? `[${c.newValue.split("\n").length} lines]`
                : c.newValue,
    }));

    return NextResponse.json({ changes: mapped });
}
