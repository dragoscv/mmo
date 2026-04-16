import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";

const DOWNLOAD_SETTINGS_KEYS = ["downloadFolder", "audioQuality", "audioFormat"];

// GET — load download settings
export async function GET() {
    const result: Record<string, string> = {};
    for (const key of DOWNLOAD_SETTINGS_KEYS) {
        const row = db.select().from(settings).where(eq(settings.key, `download.${key}`)).get();
        if (row) result[key] = row.value;
    }
    return NextResponse.json(result);
}

// POST — save a download setting
export async function POST(request: NextRequest) {
    const body = await request.json();
    const { key, value } = body as { key?: string; value?: string };

    if (!key || typeof key !== "string" || !DOWNLOAD_SETTINGS_KEYS.includes(key)) {
        return NextResponse.json({ error: "Invalid setting key" }, { status: 400 });
    }

    const dbKey = `download.${key}`;
    const existing = db.select().from(settings).where(eq(settings.key, dbKey)).get();

    if (existing) {
        db.update(settings).set({ value: value || "" }).where(eq(settings.key, dbKey)).run();
    } else {
        db.insert(settings).values({ key: dbKey, value: value || "" }).run();
    }

    return NextResponse.json({ success: true });
}
