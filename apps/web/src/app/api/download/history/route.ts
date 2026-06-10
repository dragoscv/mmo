import { NextResponse } from "next/server";
/** Download history moved to companion. Returns empty list for now. */
export async function GET() {
    return NextResponse.json({ items: [], total: 0 });
}
