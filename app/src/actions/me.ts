"use server";

/**
 * Lightweight session probe for client components that can't easily
 * receive `auth()` via props (e.g. deep inside a client-only context).
 *
 * Returns `null` for guests so the caller can skip rendering collab /
 * snapshot UI rather than throwing.
 */

import { auth } from "@/auth";

export interface MeInfo {
    id: string;
    name: string;
    email: string | null;
    image: string | null;
}

export async function getMe(): Promise<MeInfo | null> {
    const session = await auth();
    const u = session?.user;
    if (!u?.id) return null;
    return {
        id: u.id,
        name: u.name ?? u.email ?? "Anonymous",
        email: u.email ?? null,
        image: u.image ?? null,
    };
}
