import { NextResponse } from "next/server";
import { db } from "@/db";
import { analysisChanges, tracks } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    const body = await request.json();
    const { changeIds } = body as { changeIds: number[] };

    if (!changeIds || !Array.isArray(changeIds) || changeIds.length === 0) {
        return NextResponse.json(
            { error: "Missing or empty changeIds" },
            { status: 400 }
        );
    }

    // Fetch full change data from DB (includes full lyrics text)
    const changesToApply = db
        .select()
        .from(analysisChanges)
        .where(inArray(analysisChanges.id, changeIds))
        .all();

    // Group changes by trackId for efficient updates
    const grouped = new Map<
        number,
        Array<{ field: string; newValue: string }>
    >();
    for (const change of changesToApply) {
        const existing = grouped.get(change.trackId) ?? [];
        existing.push({ field: change.field, newValue: change.newValue });
        grouped.set(change.trackId, existing);
    }

    let applied = 0;
    let errorCount = 0;

    for (const [trackId, trackChanges] of grouped) {
        try {
            const updateObj: Record<string, unknown> = {};
            for (const change of trackChanges) {
                if (change.field === "bpm") {
                    updateObj.bpm = parseFloat(change.newValue);
                } else if (change.field === "year") {
                    updateObj.year = parseInt(change.newValue, 10);
                } else {
                    updateObj[change.field] = change.newValue;
                }
            }

            updateObj.analyzedAt = new Date().toISOString();

            db.update(tracks)
                .set(updateObj)
                .where(eq(tracks.id, trackId))
                .run();

            applied += trackChanges.length;
        } catch {
            errorCount += trackChanges.length;
        }
    }

    return NextResponse.json({ applied, errors: errorCount });
}
