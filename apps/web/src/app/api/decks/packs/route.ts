import { NextResponse } from "next/server";
import { catalog } from "@/lib/decks-packs/catalog";

/** Public Decks marketplace catalogue (MarketCatalog, apps/mixai/src/bridge/marketplace.ts). */
const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Authorization",
    "Access-Control-Max-Age": "86400",
};

export function GET() {
    return NextResponse.json(catalog, {
        headers: { ...CORS, "Cache-Control": "public, max-age=300" },
    });
}

export function OPTIONS() {
    return new Response(null, { status: 204, headers: CORS });
}
