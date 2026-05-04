import { NextResponse } from "next/server";

/** Shape consumed by `mixer-browser-modal-v2` and `provider-search-panel`. */
export interface SearchDupeResult {
    inLibrary: boolean;
    trackId?: number;
    isVariantOf?: { trackId: number; title: string; artist: string };
}

export async function POST() {
    return NextResponse.json({ duplicates: [] });
}
export async function GET() {
    return NextResponse.json({ duplicates: [] });
}
