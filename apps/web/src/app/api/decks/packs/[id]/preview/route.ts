import { NextResponse } from "next/server";
import { findPack, readPreview } from "@/lib/decks-packs/catalog";

/** Preview image of a catalogue pack (extracted at build time by the Skin SDK catalog step). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const pack = findPack(id);
    if (!pack?.previewUrl) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const bytes = await readPreview(pack);
    return new Response(new Uint8Array(bytes), {
        headers: {
            "Content-Type": "image/png",
            "Content-Length": String(bytes.length),
            "Cache-Control": "public, max-age=86400",
            ETag: `"${pack.sha256}"`,
            "Access-Control-Allow-Origin": "*",
            "X-Content-Type-Options": "nosniff",
        },
    });
}
