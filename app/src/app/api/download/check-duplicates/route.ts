import { NextResponse } from "next/server";
export async function POST() {
    return NextResponse.json({ duplicates: [] });
}
export async function GET() {
    return NextResponse.json({ duplicates: [] });
}
