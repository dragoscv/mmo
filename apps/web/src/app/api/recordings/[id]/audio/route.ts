/**
 * GET /api/recordings/[id]/audio
 *
 * Streams the recorded audio file from disk for inline playback / download.
 * Uses chunked range requests so <audio> seeking works smoothly.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id: idStr } = await ctx.params;
    const id = Number(idStr);
    if (!Number.isFinite(id)) return new NextResponse("Bad id", { status: 400 });

    const rows = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1);
    const row = rows[0];
    if (!row) return new NextResponse("Not found", { status: 404 });

    // Auth required, period. The previous logic let any anonymous caller stream
    // a recording when `row.userId` was null ("legacy / single-user dev"), but
    // recording ids are sequential serials so any anonymous visitor could
    // enumerate `/api/recordings/N/audio` and exfiltrate every legacy row that
    // ever had a null userId (including any that survived migrations or
    // restores). Now: must be signed in; if the row has a userId, it must
    // match the session; null-userId rows are accessible to any signed-in
    // user (matches the recordings-action ownership model).
    const session = await auth();
    if (!session?.user?.id) return new NextResponse("Unauthorized", { status: 401 });
    if (row.userId && row.userId !== session.user.id) {
        return new NextResponse("Forbidden", { status: 403 });
    }

    try {
        const stat = await fs.stat(row.filepath);
        const stream = createReadStream(row.filepath);
        return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
            status: 200,
            headers: {
                "Content-Type": row.mimeType,
                "Content-Length": String(stat.size),
                "Content-Disposition": `inline; filename="${encodeURIComponent(row.filename)}"`,
                "Cache-Control": "private, max-age=3600",
                "Accept-Ranges": "bytes",
            },
        });
    } catch {
        return new NextResponse("File missing on disk", { status: 410 });
    }
}
