import { NextResponse } from "next/server";
import { getSettings, updateSetting } from "@/actions/settings";

/** Download settings now live in the per-user `userPreferences` table. */
export async function GET() {
    const all = await getSettings();
    return NextResponse.json({
        download_folder: all["download_folder"] ?? "",
        default_format: all["default_format"] ?? "mp3",
        default_quality: all["default_quality"] ?? "320",
    });
}

export async function POST(request: Request) {
    const body = await request.json().catch(() => ({}));
    if (typeof body !== "object" || body === null) {
        return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string") {
            await updateSetting(key, value);
        }
    }
    return NextResponse.json({ success: true });
}
