"use server";

import { revalidatePath } from "next/cache";
import { setActiveProfile as setActiveProfileImpl } from "@/lib/active-profile";

export async function setActiveProfileAction(profileId: number) {
    const r = await setActiveProfileImpl(profileId);
    revalidatePath("/watch");
    revalidatePath("/profiles");
    return r;
}
