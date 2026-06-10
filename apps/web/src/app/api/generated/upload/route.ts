import { NextRequest } from "next/server";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import { auth } from "@/auth";
import { db } from "@/db";
import { generatedAssets } from "@/db/schema-ai";
import { GEN_KINDS, type GenKind } from "@/lib/generate/types";

export const runtime = "nodejs";

const GENERATED_DIR = path.join(process.cwd(), "data", "generated");
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const ALLOWED_EXT = new Set(["wav", "mp3", "flac", "ogg", "m4a", "mp4"]);

/**
 * Manual T2 upload: user-provided audio file (e.g. from an external generator,
 * a render, etc). License is recorded as "unknown" unless overridden by the form.
 */
export async function POST(req: NextRequest) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return new Response("Unauthorized", { status: 401 });

    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return new Response("Invalid form data", { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof File)) return new Response("Missing file", { status: 400 });
    if (file.size <= 0) return new Response("Empty file", { status: 400 });
    if (file.size > MAX_BYTES) return new Response("File too large", { status: 413 });

    const kindRaw = String(form.get("kind") ?? "one-shot");
    const kind = (GEN_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as GenKind) : "one-shot";
    const prompt = String(form.get("prompt") ?? "").slice(0, 2000) || null;
    const license = (() => {
        const v = String(form.get("license") ?? "unknown");
        return v === "commercial-clean" || v === "personal-use" ? v : "unknown";
    })();

    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return new Response(`Unsupported extension: ${ext}`, { status: 415 });

    const buf = Buffer.from(await file.arrayBuffer());
    const hash = createHash("sha256").update(buf).digest("hex");

    const [row] = await db.insert(generatedAssets).values({
        userId,
        kind,
        tier: "T2",
        model: null,
        promptText: prompt,
        license,
        status: "ready",
    }).returning();

    const dir = path.join(GENERATED_DIR, userId);
    await fsp.mkdir(dir, { recursive: true });
    const relPath = `${row!.id}.${ext}`;
    const abs = path.join(dir, relPath);
    await fsp.writeFile(abs, buf);

    const [updated] = await db.update(generatedAssets).set({
        filePath: relPath,
        fileSize: buf.byteLength,
        contentHash: hash,
        updatedAt: new Date(),
    }).where(eq(generatedAssets.id, row!.id)).returning();

    return Response.json({
        id: updated!.id,
        fileUrl: `/api/generated/${updated!.id}`,
        status: "ready",
    });
}
