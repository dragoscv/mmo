/**
 * POST /api/internal/revalidate — internal cache-bust hook for the gateway.
 *
 * The gateway owns the sync data plane now, but the /library facet cache
 * lives in this Next app (per-user `revalidateTag`). When the gateway
 * applies track changes it POSTs here so the facets refresh promptly.
 *
 * Auth: shared secret header `x-revalidate-secret` (WEB_REVALIDATE_SECRET).
 * Not a public endpoint.
 */

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { libraryFacetsTag } from "@/lib/cloud-library";

export const runtime = "nodejs";

export async function POST(req: Request) {
    const secret = process.env.WEB_REVALIDATE_SECRET;
    if (!secret || req.headers.get("x-revalidate-secret") !== secret) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await req.json().catch(() => null) as { tag?: string; userId?: string } | null;
    if (!body?.userId) {
        return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }
    if (body.tag === "library-facets" || !body.tag) {
        revalidateTag(libraryFacetsTag(body.userId), "max");
    }
    return NextResponse.json({ ok: true });
}
