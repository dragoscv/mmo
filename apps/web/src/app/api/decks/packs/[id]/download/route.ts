import { NextResponse, type NextRequest } from "next/server";
import { requireRate } from "@/lib/api-guard";
import { findPack, readPackFile } from "@/lib/decks-packs/catalog";
import { findDeviceByToken } from "@/lib/device-token";
import { hasEntitlement } from "@/lib/entitlements";
import { getSubscription } from "@/lib/stripe";

/**
 * Download a `.mixaipack`. Free packs: anyone. Pro packs: `Authorization: Bearer <device token>`
 * of a device whose user holds `decks_pro`; otherwise 401/402 `{ error: "pro_required" }`.
 * The app re-verifies signature + sha256 (= ETag) in Rust before installing.
 */
const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Expose-Headers": "ETag, Content-Disposition",
};

const proRequired = (status: 401 | 402) =>
    NextResponse.json({ error: "pro_required" }, { status, headers: { ...CORS, "Cache-Control": "no-store" } });

async function entitled(request: NextRequest): Promise<401 | 402 | null> {
    const header = request.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(\S{16,512})$/i.exec(header.trim());
    if (!m?.[1]) return 401;
    const device = await findDeviceByToken(m[1]);
    if (!device) return 401;
    const sub = await getSubscription(device.userId);
    return hasEntitlement(sub, "decks_pro") ? null : 402;
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    const pack = findPack(id);
    if (!pack) return NextResponse.json({ error: "not_found" }, { status: 404, headers: CORS });

    if (pack.pro) {
        const blocked = requireRate(request, { bucket: "decks-pack-download", windowMs: 60_000, max: 30 });
        if (blocked) return blocked;
        const denied = await entitled(request);
        if (denied) return proRequired(denied);
    }

    const etag = `"${pack.sha256}"`;
    const cache = pack.pro ? "private, no-store" : "public, max-age=3600";
    if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { ...CORS, ETag: etag, "Cache-Control": cache } });
    }
    const bytes = await readPackFile(pack);
    return new Response(new Uint8Array(bytes), {
        headers: {
            ...CORS,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.length),
            "Content-Disposition": `attachment; filename="${pack.id}.mixaipack"`,
            ETag: etag,
            "Cache-Control": cache,
            "X-Content-Type-Options": "nosniff",
        },
    });
}

export function OPTIONS() {
    return new Response(null, { status: 204, headers: CORS });
}
