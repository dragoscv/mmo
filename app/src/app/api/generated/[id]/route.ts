import { NextRequest } from "next/server";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { and, eq } from "drizzle-orm";

import { auth } from "@/auth";
import { db } from "@/db";
import { generatedAssets } from "@/db/schema-ai";

export const runtime = "nodejs";

const GENERATED_DIR = path.join(process.cwd(), "data", "generated");

const MIME_BY_EXT: Record<string, string> = {
    wav: "audio/wav",
    mp3: "audio/mpeg",
    flac: "audio/flac",
    ogg: "audio/ogg",
    mp4: "audio/mp4",
    m4a: "audio/mp4",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const [row] = await db
        .select()
        .from(generatedAssets)
        .where(and(eq(generatedAssets.id, id), eq(generatedAssets.userId, userId)))
        .limit(1);
    if (!row || !row.filePath) return new Response("Not found", { status: 404 });

    // ?stem=drums|bass|other|vocals → resolve via params.stems[name]
    const stemName = req.nextUrl.searchParams.get("stem");
    let relPath = row.filePath;
    if (stemName) {
        if (!/^[A-Za-z0-9_-]+$/.test(stemName)) return new Response("Bad stem", { status: 400 });
        const params = (row.params ?? {}) as { stems?: Record<string, string> };
        const stemRel = params.stems?.[stemName];
        if (!stemRel) return new Response("Stem not found", { status: 404 });
        relPath = stemRel;
    }

    const abs = path.join(GENERATED_DIR, userId, relPath);
    let size: number;
    try {
        size = statSync(abs).size;
    } catch {
        return new Response("File missing on disk", { status: 410 });
    }

    const ext = relPath.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const stream = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream;
    return new Response(stream, {
        headers: {
            "Content-Type": mime,
            "Content-Length": String(size),
            "Cache-Control": "private, max-age=3600",
        },
    });
}
