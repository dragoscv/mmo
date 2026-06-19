"use server";

/**
 * Maestro session-management server actions.
 *
 * The chat stream itself goes through POST /api/maestro/chat (so we can
 * pipe AI SDK ReadableStream back). These actions handle list/get/delete
 * + listing user's connections + available roles for the chat dock's
 * model picker.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import {
    aiAgentMessages,
    aiAgentSessions,
    aiProviderConnections,
    aiModelChoices,
} from "@/db/schema-ai";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

async function uid(): Promise<string> {
    const s = await auth();
    if (!s?.user?.id) throw new Error("Not signed in");
    return s.user.id;
}

export interface SessionDto {
    id: string;
    title: string | null;
    description: string | null;
    autonomy: string;
    createdAt: Date | null;
    updatedAt: Date | null;
}

export interface MessageDto {
    id: string;
    index: number;
    role: string;
    content: unknown;
    modelId: string | null;
    createdAt: Date | null;
}

export interface ConnectionPickerDto {
    id: string;
    provider: string;
    label: string;
}

export interface RoleChoiceDto {
    role: string;
    connectionId: string;
    modelId: string;
}

export async function listSessions(): Promise<SessionDto[]> {
    const userId = await uid();
    const rows = await db
        .select({
            id: aiAgentSessions.id,
            title: aiAgentSessions.title,
            description: aiAgentSessions.description,
            autonomy: aiAgentSessions.autonomy,
            createdAt: aiAgentSessions.createdAt,
            updatedAt: aiAgentSessions.updatedAt,
        })
        .from(aiAgentSessions)
        .where(eq(aiAgentSessions.userId, userId))
        .orderBy(desc(aiAgentSessions.updatedAt))
        .limit(50);
    return rows;
}

/**
 * Return the last session for the current user (used by the chat dock to
 * auto-restore after a page refresh). null when the user has never chatted.
 */
export async function getLastSession(): Promise<SessionDto | null> {
    // Read path: no session → no last session (don't 500 on signed-out callers).
    const s = await auth();
    const userId = s?.user?.id;
    if (!userId) return null;
    const [row] = await db
        .select({
            id: aiAgentSessions.id,
            title: aiAgentSessions.title,
            description: aiAgentSessions.description,
            autonomy: aiAgentSessions.autonomy,
            createdAt: aiAgentSessions.createdAt,
            updatedAt: aiAgentSessions.updatedAt,
        })
        .from(aiAgentSessions)
        .where(eq(aiAgentSessions.userId, userId))
        .orderBy(desc(aiAgentSessions.updatedAt))
        .limit(1);
    return row ?? null;
}

export async function getSessionMessages(sessionId: string): Promise<MessageDto[]> {
    const userId = await uid();
    const [s] = await db
        .select()
        .from(aiAgentSessions)
        .where(and(eq(aiAgentSessions.id, sessionId), eq(aiAgentSessions.userId, userId)))
        .limit(1);
    if (!s) return [];
    const msgs = await db
        .select({
            id: aiAgentMessages.id,
            index: aiAgentMessages.index,
            role: aiAgentMessages.role,
            content: aiAgentMessages.content,
            modelId: aiAgentMessages.modelId,
            createdAt: aiAgentMessages.createdAt,
        })
        .from(aiAgentMessages)
        .where(eq(aiAgentMessages.sessionId, sessionId))
        .orderBy(aiAgentMessages.index);
    return msgs;
}

/**
 * Return only the last `limit` messages for a session (newest at the end).
 * Used by the chat dock to paint the latest exchange instantly on refresh,
 * then load the full history in the background.
 */
export async function getSessionMessagesTail(
    sessionId: string,
    limit = 10,
): Promise<MessageDto[]> {
    const userId = await uid();
    const [s] = await db
        .select({ id: aiAgentSessions.id })
        .from(aiAgentSessions)
        .where(and(eq(aiAgentSessions.id, sessionId), eq(aiAgentSessions.userId, userId)))
        .limit(1);
    if (!s) return [];
    const tail = await db
        .select({
            id: aiAgentMessages.id,
            index: aiAgentMessages.index,
            role: aiAgentMessages.role,
            content: aiAgentMessages.content,
            modelId: aiAgentMessages.modelId,
            createdAt: aiAgentMessages.createdAt,
        })
        .from(aiAgentMessages)
        .where(eq(aiAgentMessages.sessionId, sessionId))
        .orderBy(desc(aiAgentMessages.index))
        .limit(Math.max(1, Math.min(50, limit)));
    return tail.reverse();
}

export async function renameSession(sessionId: string, title: string): Promise<{ ok: true }> {
    const userId = await uid();
    await db
        .update(aiAgentSessions)
        .set({ title: title.slice(0, 200), updatedAt: new Date() })
        .where(and(eq(aiAgentSessions.id, sessionId), eq(aiAgentSessions.userId, userId)));
    revalidatePath("/");
    return { ok: true };
}

/**
 * Update title and/or description for a session. Either field is optional;
 * undefined fields are left unchanged. Used by both the user (manual rename)
 * and Maestro itself (via the updateConversationMeta tool).
 */
export async function updateSessionMeta(
    sessionId: string,
    patch: { title?: string | null; description?: string | null },
): Promise<{ ok: true }> {
    const userId = await uid();
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) set.title = patch.title === null ? null : patch.title.slice(0, 200);
    if (patch.description !== undefined) set.description = patch.description === null ? null : patch.description.slice(0, 2000);
    await db
        .update(aiAgentSessions)
        .set(set)
        .where(and(eq(aiAgentSessions.id, sessionId), eq(aiAgentSessions.userId, userId)));
    revalidatePath("/");
    return { ok: true };
}

export async function deleteSession(sessionId: string): Promise<{ ok: true }> {
    const userId = await uid();
    await db
        .delete(aiAgentSessions)
        .where(and(eq(aiAgentSessions.id, sessionId), eq(aiAgentSessions.userId, userId)));
    revalidatePath("/");
    return { ok: true };
}

/** Picker data for the chat dock — connections + per-role model assignments. */
export async function getChatPickerData(): Promise<{
    connections: ConnectionPickerDto[];
    choices: RoleChoiceDto[];
}> {
    const userId = await uid();
    const [conns, choices] = await Promise.all([
        db
            .select({
                id: aiProviderConnections.id,
                provider: aiProviderConnections.provider,
                label: aiProviderConnections.label,
            })
            .from(aiProviderConnections)
            .where(
                and(
                    eq(aiProviderConnections.userId, userId),
                    eq(aiProviderConnections.status, "active"),
                ),
            ),
        db
            .select({
                role: aiModelChoices.role,
                connectionId: aiModelChoices.connectionId,
                modelId: aiModelChoices.modelId,
            })
            .from(aiModelChoices)
            .where(eq(aiModelChoices.userId, userId)),
    ]);
    return { connections: conns, choices };
}
