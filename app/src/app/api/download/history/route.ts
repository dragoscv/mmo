import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { downloads } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

// GET — list download history
export async function GET(request: NextRequest) {
    const limit = Number(request.nextUrl.searchParams.get("limit")) || 50;
    const offset = Number(request.nextUrl.searchParams.get("offset")) || 0;

    const rows = db
        .select()
        .from(downloads)
        .orderBy(desc(downloads.downloadedAt))
        .limit(limit)
        .offset(offset)
        .all();

    return NextResponse.json(rows);
}

// DELETE — clear history or single entry
export async function DELETE(request: NextRequest) {
    const id = request.nextUrl.searchParams.get("id");

    if (id) {
        db.delete(downloads).where(eq(downloads.id, Number(id))).run();
    } else {
        db.delete(downloads).run();
    }

    return NextResponse.json({ success: true });
}
