import { NextRequest, NextResponse } from "next/server";
import { streamTrackFromDevice } from "@/lib/audio-stream";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const trackId = parseInt(id);
    if (isNaN(trackId)) {
        return NextResponse.json({ error: "Invalid track ID" }, { status: 400 });
    }
    return streamTrackFromDevice(request, trackId);
}
