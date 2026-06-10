"use server";

/**
 * Server actions for the AI Copilot settings page.
 *
 * Covers:
 *   - GitHub Copilot device-code flow (start / poll / cancel)
 *   - BYO-key provider connection CRUD (all 6 LLM providers)
 *   - Listing models for a connection
 *   - Per-role model choice CRUD
 *
 * All token/secret material is AES-GCM encrypted via token-crypto.ts
 * before persistence. Plaintext never leaves this module.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import {
    aiProviderConnections,
    aiModelChoices,
    aiDeviceCodeFlows,
} from "@/db/schema-ai";
import { decryptToken, encryptToken } from "@/lib/token-crypto";
import {
    PROVIDER_IDS,
    type ProviderId,
} from "@mmo/ai/providers/types";
import {
    VSCODE_COPILOT_CLIENT_ID,
    requestDeviceCode,
    pollAccessToken,
    exchangeForSessionToken,
    listCopilotModels,
    toModelInfo,
    CopilotAuthError,
    type CopilotClientConfig,
} from "@mmo/ai/providers/copilot";
import { MODEL_ROLES, type ModelRole } from "@mmo/ai/models";
import { and, eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";

// ─── Public DTOs ────────────────────────────────────────────────────────────

export interface ConnectionDto {
    id: string;
    provider: ProviderId;
    label: string;
    status: "active" | "expired" | "revoked";
    isCopilot: boolean;
    copilotClientStrategy?: string | null;
    sessionExpiresAt: Date | null;
    lastVerifiedAt: Date | null;
    createdAt: Date | null;
    updatedAt: Date | null;
    hasSecret: boolean;
}

export interface DeviceFlowDto {
    flowId: string;
    userCode: string;
    verificationUri: string;
    expiresAt: Date;
    intervalSec: number;
}

export interface ModelDto {
    provider: ProviderId;
    modelId: string;
    label: string;
    family?: string | null;
    chat: boolean;
    tools: boolean;
    vision: boolean;
    embeddings: boolean;
    contextTokens: number;
    outputTokens: number;
}

export interface ModelChoiceDto {
    role: ModelRole;
    connectionId: string;
    provider: ProviderId;
    modelId: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function requireUserId(): Promise<string> {
    const session = await auth();
    if (!session?.user?.id) throw new Error("Not signed in");
    return session.user.id;
}

function asProviderId(value: string): ProviderId {
    if ((PROVIDER_IDS as readonly string[]).includes(value)) return value as ProviderId;
    throw new Error(`Unknown provider: ${value}`);
}

function copilotConfig(strategy: string, clientId: string | null): CopilotClientConfig {
    return {
        clientId: strategy === "custom" && clientId ? clientId : VSCODE_COPILOT_CLIENT_ID,
    };
}

// ─── Connection listing ────────────────────────────────────────────────────

export async function listConnections(): Promise<ConnectionDto[]> {
    const userId = await requireUserId();
    const rows = await db
        .select()
        .from(aiProviderConnections)
        .where(eq(aiProviderConnections.userId, userId))
        .orderBy(desc(aiProviderConnections.updatedAt));
    return rows.map((r) => ({
        id: r.id,
        provider: asProviderId(r.provider),
        label: r.label,
        status: (r.status as "active" | "expired" | "revoked") ?? "active",
        isCopilot: r.provider === "copilot",
        copilotClientStrategy: r.copilotClientStrategy,
        sessionExpiresAt: r.sessionExpiresAt,
        lastVerifiedAt: r.lastVerifiedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        hasSecret: !!(r.encApiKey || r.encOauthToken),
    }));
}

export async function deleteConnection(connectionId: string): Promise<{ ok: true }> {
    const userId = await requireUserId();
    await db
        .delete(aiProviderConnections)
        .where(and(eq(aiProviderConnections.id, connectionId), eq(aiProviderConnections.userId, userId)));
    revalidatePath("/settings/copilot");
    return { ok: true };
}

// ─── BYO-key connection ────────────────────────────────────────────────────

export async function upsertApiKeyConnection(input: {
    provider: ProviderId;
    label?: string;
    apiKey: string;
    /** Azure OpenAI: { endpoint, apiVersion?, deployment? }. Other providers ignore. */
    endpointsJson?: Record<string, string> | null;
}): Promise<{ ok: true; connectionId: string }> {
    const userId = await requireUserId();
    if (input.provider === "copilot") {
        throw new Error("Use startCopilotDeviceFlow / pollCopilotDeviceFlow for Copilot connections.");
    }
    const trimmed = input.apiKey.trim();
    if (trimmed.length < 8 || trimmed.length > 500) {
        throw new Error("API key looks invalid (must be 8–500 chars).");
    }
    if (input.provider === "azure") {
        const ep = (input.endpointsJson?.endpoint as string | undefined)?.trim();
        if (!ep || !/^https?:\/\//.test(ep)) {
            throw new Error("Azure OpenAI requires endpointsJson.endpoint (https://<resource>.openai.azure.com/).");
        }
    }
    const label = (input.label ?? "default").slice(0, 60);
    const enc = await encryptToken(trimmed);

    const existing = await db
        .select({ id: aiProviderConnections.id })
        .from(aiProviderConnections)
        .where(
            and(
                eq(aiProviderConnections.userId, userId),
                eq(aiProviderConnections.provider, input.provider),
                eq(aiProviderConnections.label, label),
            ),
        )
        .limit(1);
    if (existing[0]) {
        await db
            .update(aiProviderConnections)
            .set({
                encApiKey: enc,
                endpointsJson: input.endpointsJson ?? null,
                status: "active",
                updatedAt: new Date(),
                lastVerifiedAt: new Date(),
            })
            .where(eq(aiProviderConnections.id, existing[0].id));
        revalidatePath("/settings/copilot");
        return { ok: true, connectionId: existing[0].id };
    }
    const [inserted] = await db
        .insert(aiProviderConnections)
        .values({
            userId,
            provider: input.provider,
            label,
            encApiKey: enc,
            endpointsJson: input.endpointsJson ?? null,
            status: "active",
            lastVerifiedAt: new Date(),
        })
        .returning({ id: aiProviderConnections.id });
    revalidatePath("/settings/copilot");
    return { ok: true, connectionId: inserted!.id };
}

// ─── Copilot device-code flow ──────────────────────────────────────────────

export async function startCopilotDeviceFlow(input: {
    clientStrategy: "vscode" | "custom";
    clientId?: string;
    label?: string;
}): Promise<DeviceFlowDto> {
    const userId = await requireUserId();
    const strategy = input.clientStrategy === "custom" ? "custom" : "vscode";
    const clientId =
        strategy === "custom"
            ? input.clientId?.trim() || (() => { throw new Error("Custom strategy requires clientId"); })()
            : VSCODE_COPILOT_CLIENT_ID;
    const label = (input.label ?? "default").slice(0, 60);

    const device = await requestDeviceCode({ clientId });
    const [row] = await db
        .insert(aiDeviceCodeFlows)
        .values({
            userId,
            provider: "copilot",
            deviceCode: device.device_code,
            userCode: device.user_code,
            verificationUri: device.verification_uri,
            intervalSec: device.interval,
            expiresAt: new Date(Date.now() + device.expires_in * 1000),
            clientStrategy: strategy,
            clientId,
            label,
            status: "pending",
        })
        .returning({ id: aiDeviceCodeFlows.id, expiresAt: aiDeviceCodeFlows.expiresAt });
    return {
        flowId: row!.id,
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        expiresAt: row!.expiresAt,
        intervalSec: device.interval,
    };
}

export interface PollResult {
    status: "pending" | "success" | "expired" | "denied" | "error";
    error?: string;
    connectionId?: string;
}

/** Single poll attempt. Client should poll every `intervalSec` returned by start. */
export async function pollCopilotDeviceFlow(flowId: string): Promise<PollResult> {
    const userId = await requireUserId();
    const [flow] = await db
        .select()
        .from(aiDeviceCodeFlows)
        .where(and(eq(aiDeviceCodeFlows.id, flowId), eq(aiDeviceCodeFlows.userId, userId)))
        .limit(1);
    if (!flow) return { status: "error", error: "Flow not found" };
    if (flow.status !== "pending") return { status: flow.status as PollResult["status"] };
    if (flow.expiresAt.getTime() < Date.now()) {
        await db
            .update(aiDeviceCodeFlows)
            .set({ status: "expired", completedAt: new Date() })
            .where(eq(aiDeviceCodeFlows.id, flow.id));
        return { status: "expired" };
    }
    const cfg = copilotConfig(flow.clientStrategy, flow.clientId);
    let access;
    try {
        access = await pollAccessToken(flow.deviceCode, cfg);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof CopilotAuthError && e.code === "access_denied") {
            await db
                .update(aiDeviceCodeFlows)
                .set({ status: "failed", completedAt: new Date() })
                .where(eq(aiDeviceCodeFlows.id, flow.id));
            return { status: "denied", error: msg };
        }
        if (e instanceof CopilotAuthError && e.code === "expired_token") {
            await db
                .update(aiDeviceCodeFlows)
                .set({ status: "expired", completedAt: new Date() })
                .where(eq(aiDeviceCodeFlows.id, flow.id));
            return { status: "expired" };
        }
        return { status: "error", error: msg };
    }
    if (!access) return { status: "pending" };

    // Exchange + session token.
    let session;
    try {
        session = await exchangeForSessionToken(access.access_token, cfg);
    } catch (e) {
        return { status: "error", error: e instanceof Error ? e.message : String(e) };
    }

    const encOauth = await encryptToken(access.access_token);
    const encSession = await encryptToken(session.token);

    // Upsert connection row (provider=copilot + label).
    const existing = await db
        .select({ id: aiProviderConnections.id })
        .from(aiProviderConnections)
        .where(
            and(
                eq(aiProviderConnections.userId, userId),
                eq(aiProviderConnections.provider, "copilot"),
                eq(aiProviderConnections.label, flow.label),
            ),
        )
        .limit(1);
    let connectionId: string;
    const sessionExpiresAt = new Date(session.expires_at * 1000);
    if (existing[0]) {
        connectionId = existing[0].id;
        await db
            .update(aiProviderConnections)
            .set({
                encOauthToken: encOauth,
                encSessionToken: encSession,
                sessionExpiresAt,
                endpointsJson: session.endpoints,
                copilotClientStrategy: flow.clientStrategy,
                copilotClientId: flow.clientId,
                status: "active",
                lastVerifiedAt: new Date(),
                updatedAt: new Date(),
            })
            .where(eq(aiProviderConnections.id, connectionId));
    } else {
        const [inserted] = await db
            .insert(aiProviderConnections)
            .values({
                userId,
                provider: "copilot",
                label: flow.label,
                encOauthToken: encOauth,
                encSessionToken: encSession,
                sessionExpiresAt,
                endpointsJson: session.endpoints,
                copilotClientStrategy: flow.clientStrategy,
                copilotClientId: flow.clientId,
                status: "active",
                lastVerifiedAt: new Date(),
            })
            .returning({ id: aiProviderConnections.id });
        connectionId = inserted!.id;
    }

    await db
        .update(aiDeviceCodeFlows)
        .set({ status: "success", completedAt: new Date() })
        .where(eq(aiDeviceCodeFlows.id, flow.id));

    revalidatePath("/settings/copilot");
    return { status: "success", connectionId };
}

export async function cancelCopilotDeviceFlow(flowId: string): Promise<{ ok: true }> {
    const userId = await requireUserId();
    await db
        .update(aiDeviceCodeFlows)
        .set({ status: "failed", completedAt: new Date() })
        .where(and(eq(aiDeviceCodeFlows.id, flowId), eq(aiDeviceCodeFlows.userId, userId)));
    return { ok: true };
}

// ─── Model listing ─────────────────────────────────────────────────────────

export async function listModelsForConnection(connectionId: string): Promise<ModelDto[]> {
    const userId = await requireUserId();
    const [conn] = await db
        .select()
        .from(aiProviderConnections)
        .where(and(eq(aiProviderConnections.id, connectionId), eq(aiProviderConnections.userId, userId)))
        .limit(1);
    if (!conn) throw new Error("Connection not found");

    if (conn.provider === "copilot") {
        if (!conn.encOauthToken) throw new Error("Copilot connection has no OAuth token");
        const oauth = await decryptToken(conn.encOauthToken);

        // Refresh session token if missing or near expiry (< 60 s).
        const needsRefresh =
            !conn.encSessionToken ||
            !conn.sessionExpiresAt ||
            conn.sessionExpiresAt.getTime() < Date.now() + 60_000;
        let sessionToken: string;
        let endpoints = conn.endpointsJson;
        if (needsRefresh) {
            const cfg = copilotConfig(conn.copilotClientStrategy ?? "vscode", conn.copilotClientId);
            const fresh = await exchangeForSessionToken(oauth, cfg);
            sessionToken = fresh.token;
            endpoints = fresh.endpoints;
            await db
                .update(aiProviderConnections)
                .set({
                    encSessionToken: await encryptToken(fresh.token),
                    sessionExpiresAt: new Date(fresh.expires_at * 1000),
                    endpointsJson: fresh.endpoints,
                    lastVerifiedAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(eq(aiProviderConnections.id, conn.id));
        } else {
            sessionToken = await decryptToken(conn.encSessionToken!);
        }
        if (!endpoints?.api) throw new Error("Copilot endpoints missing");
        const endpointsTyped = endpoints as { api: string; [k: string]: string };

        const raw = await listCopilotModels(
            {
                token: sessionToken,
                expires_at: Math.floor((conn.sessionExpiresAt?.getTime() ?? Date.now() + 60_000) / 1000),
                refresh_in: 1500,
                endpoints: endpointsTyped,
                raw: {},
            },
            copilotConfig(conn.copilotClientStrategy ?? "vscode", conn.copilotClientId),
        );
        return raw.map(toModelInfo).map((m) => ({
            provider: m.provider,
            modelId: m.id,
            label: m.label,
            family: m.family ?? null,
            chat: m.capabilities.chat,
            tools: m.capabilities.tools,
            vision: m.capabilities.vision,
            embeddings: m.capabilities.embeddings,
            contextTokens: m.capabilities.contextTokens,
            outputTokens: m.capabilities.outputTokens,
        }));
    }

    // Non-Copilot model listing lands in P1 follow-up (per-provider /models endpoints).
    return [];
}

// ─── Role → model choice ───────────────────────────────────────────────────

export async function listModelChoices(): Promise<ModelChoiceDto[]> {
    const userId = await requireUserId();
    const rows = await db
        .select()
        .from(aiModelChoices)
        .where(eq(aiModelChoices.userId, userId));
    return rows.map((r) => ({
        role: r.role as ModelRole,
        connectionId: r.connectionId,
        provider: asProviderId(r.provider),
        modelId: r.modelId,
    }));
}

export async function setModelChoice(input: {
    role: ModelRole;
    connectionId: string;
    provider: ProviderId;
    modelId: string;
}): Promise<{ ok: true }> {
    const userId = await requireUserId();
    if (!(MODEL_ROLES as readonly string[]).includes(input.role)) {
        throw new Error(`Unknown role: ${input.role}`);
    }
    const existing = await db
        .select({ userId: aiModelChoices.userId })
        .from(aiModelChoices)
        .where(and(eq(aiModelChoices.userId, userId), eq(aiModelChoices.role, input.role)))
        .limit(1);
    if (existing[0]) {
        await db
            .update(aiModelChoices)
            .set({
                connectionId: input.connectionId,
                provider: input.provider,
                modelId: input.modelId,
                updatedAt: new Date(),
            })
            .where(and(eq(aiModelChoices.userId, userId), eq(aiModelChoices.role, input.role)));
    } else {
        await db.insert(aiModelChoices).values({
            userId,
            role: input.role,
            connectionId: input.connectionId,
            provider: input.provider,
            modelId: input.modelId,
        });
    }
    revalidatePath("/settings/copilot");
    return { ok: true };
}

export async function clearModelChoice(role: ModelRole): Promise<{ ok: true }> {
    const userId = await requireUserId();
    await db
        .delete(aiModelChoices)
        .where(and(eq(aiModelChoices.userId, userId), eq(aiModelChoices.role, role)));
    revalidatePath("/settings/copilot");
    return { ok: true };
}
