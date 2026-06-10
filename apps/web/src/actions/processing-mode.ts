"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import {
    DEFAULT_PROCESSING_MODE,
    getProcessingMode,
    setProcessingMode,
    type ProcessingMode,
} from "@/lib/processing-mode";

async function uid(): Promise<string> {
    const s = await auth();
    if (!s?.user?.id) throw new Error("not authenticated");
    return s.user.id;
}

export async function getProcessingModeAction(): Promise<ProcessingMode> {
    try {
        const id = await uid();
        return await getProcessingMode(id);
    } catch {
        return DEFAULT_PROCESSING_MODE;
    }
}

export async function setProcessingModeAction(mode: ProcessingMode): Promise<{ ok: true; mode: ProcessingMode } | { ok: false; error: string }> {
    if (mode !== "auto" && mode !== "companion" && mode !== "cloud") {
        return { ok: false, error: "invalid mode" };
    }
    try {
        const id = await uid();
        await setProcessingMode(id, mode);
        revalidatePath("/settings/music");
        return { ok: true, mode };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}
