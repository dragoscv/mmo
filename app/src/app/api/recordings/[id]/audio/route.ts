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

    const row = db.select().from(recordings).where(eq(recordings.id, id)).get();
    if (!row) return new NextResponse("Not found", { status: 404 });

    // Authorization: a logged-in user can only access their own recordings.
    // Anonymous-uploaded recordings (userId=null) are accessible to anyone — they
    // were created in a single-user dev context.
    const session = await auth().catch(() => null);
    if (row.userId && row.userId !== session?.user?.id) {
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
