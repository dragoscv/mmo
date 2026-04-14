"use server";

import { db } from "@/db";
import { drives } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getConnectedDrives, type DriveInfo } from "@/lib/drives";
import { revalidatePath } from "next/cache";

export async function detectDrives(): Promise<DriveInfo[]> {
    return getConnectedDrives();
}

export async function getSavedDrives() {
    return db.select().from(drives).all();
}

export async function addDrive(data: {
    path: string;
    label: string;
    type: string;
    format?: string;
}) {
    db.insert(drives)
        .values({
            path: data.path,
            label: data.label,
            type: data.type,
            format: data.format,
        })
        .run();
    revalidatePath("/drives");
    return { success: true };
}

export async function removeDrive(id: number) {
    db.delete(drives).where(eq(drives.id, id)).run();
    revalidatePath("/drives");
    return { success: true };
}
