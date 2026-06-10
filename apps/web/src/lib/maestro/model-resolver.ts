import "server-only";

/**
 * Maestro model resolver.
 *
 * Given a user + role (or explicit modelOverride), returns a Vercel AI SDK
 * LanguageModel ready for `streamText`/`generateText`. Looks up the user's
 * role→model mapping in `ai_model_choices`, decrypts the underlying
 * connection's secrets, and constructs the right provider client.
 *
 * Falls back through roles in order: requested role → "agent" → "chat".
 * Throws if no model is configured.
 */

import { db } from "@/db";
import { aiModelChoices, aiProviderConnections } from "@/db/schema-ai";
import { decryptToken } from "@/lib/token-crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import { copilotAdapter } from "@mmo/ai/providers/copilot";

interface CopilotSession {
    token: string;
    expiresAt: Date;
}
import type {
    ProviderConnection,
    ProviderId,
    ProviderSecrets,
} from "@mmo/ai/providers/types";
import type { ModelRole } from "@mmo/ai/models";

export interface ResolvedModel {
    model: LanguageModel;
    provider: ProviderId;
    modelId: string;
    connectionId: string;
    role: ModelRole;
}

export interface ResolveOptions {
    userId: string;
    role: ModelRole;
    /** Force a specific (connectionId, modelId) pair instead of the role mapping. */
    override?: { connectionId: string; modelId: string };
}

const FALLBACK_ROLES: ModelRole[] = ["agent", "chat"];

export async function resolveModel(opts: ResolveOptions): Promise<ResolvedModel> {
    const { userId, role, override } = opts;

    if (override) {
        const connRow = await loadConnection(userId, override.connectionId);
        const provider = connRow.provider as ProviderId;
        const model = await buildLanguageModel(connRow, override.modelId);
        return { model, provider, modelId: override.modelId, connectionId: override.connectionId, role };
    }

    // Try requested role then fallbacks
    const tryRoles = [role, ...FALLBACK_ROLES.filter((r) => r !== role)];
    const choices = await db
        .select()
        .from(aiModelChoices)
        .where(and(eq(aiModelChoices.userId, userId), inArray(aiModelChoices.role, tryRoles)));

    if (choices.length === 0) {
        throw new Error(
            `No model configured for role "${role}". Visit /settings/copilot → Roles to assign one.`,
        );
    }

    // Pick the first role in priority order that has a choice
    const choice = tryRoles
        .map((r) => choices.find((c) => c.role === r))
        .find(Boolean);
    if (!choice) {
        throw new Error(`No model configured for role "${role}".`);
    }

    const connRow = await loadConnection(userId, choice.connectionId);
    const model = await buildLanguageModel(connRow, choice.modelId);
    return {
        model,
        provider: choice.provider as ProviderId,
        modelId: choice.modelId,
        connectionId: choice.connectionId,
        role: choice.role as ModelRole,
    };
}

// ─── Internals ─────────────────────────────────────────────────────────────

type ConnectionRow = typeof aiProviderConnections.$inferSelect;

async function loadConnection(userId: string, connectionId: string): Promise<ConnectionRow> {
    const [row] = await db
        .select()
        .from(aiProviderConnections)
        .where(
            and(
                eq(aiProviderConnections.id, connectionId),
                eq(aiProviderConnections.userId, userId),
            ),
        )
        .limit(1);
    if (!row) throw new Error(`Connection ${connectionId} not found.`);
    if (row.status !== "active") throw new Error(`Connection ${connectionId} is ${row.status}.`);
    return row;
}

async function buildLanguageModel(conn: ConnectionRow, modelId: string): Promise<LanguageModel> {
    const provider = conn.provider as ProviderId;

    if (provider === "copilot") {
        if (!conn.encOauthToken) throw new Error("Copilot connection missing OAuth token.");
        const oauthToken = await decryptToken(conn.encOauthToken);
        const sessionToken = conn.encSessionToken ? await decryptToken(conn.encSessionToken) : undefined;
        const session: CopilotSession | undefined =
            sessionToken && conn.sessionExpiresAt
                ? { token: sessionToken, expiresAt: conn.sessionExpiresAt }
                : undefined;
        const secrets: ProviderSecrets = {
            kind: "copilot",
            oauthToken,
            sessionToken: session?.token,
            sessionExpiresAt: session?.expiresAt,
            endpoints: (conn.endpointsJson as { api: string; [k: string]: string } | null) ?? undefined,
        };
        const providerConn = toProviderConnection(conn, secrets);
        return copilotAdapter.languageModel(providerConn, modelId) as LanguageModel;
    }

    // BYO-key providers — decrypt API key + instantiate the AI SDK provider
    if (!conn.encApiKey) throw new Error(`Connection ${conn.id} (${provider}) has no API key.`);
    const apiKey = await decryptToken(conn.encApiKey);

    switch (provider) {
        case "openai":
            return createOpenAI({ apiKey })(modelId);
        case "anthropic":
            return createAnthropic({ apiKey })(modelId);
        case "google":
            return createGoogleGenerativeAI({ apiKey })(modelId);
        case "mistral":
            return createMistral({ apiKey })(modelId);
        case "groq":
            return createGroq({ apiKey })(modelId);
        case "azure": {
            // Azure OpenAI: connection.endpointsJson holds { endpoint, apiVersion }.
            // The deployment name is passed as `modelId` (NOT the underlying OpenAI
            // model name). See app/.env.local AZURE_OPENAI_DEPLOYMENT.
            const cfg = (conn.endpointsJson ?? {}) as { endpoint?: string; apiVersion?: string };
            const baseURL = (cfg.endpoint ?? "").replace(/\/$/, "") + "/openai/deployments";
            if (!cfg.endpoint) throw new Error(`Azure connection ${conn.id} missing endpointsJson.endpoint`);
            return createOpenAI({
                apiKey,
                baseURL,
                headers: { "api-key": apiKey },
                fetch: async (url, init) => {
                    // Azure requires ?api-version= on every request.
                    const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url;
                    const u = new URL(rawUrl);
                    if (!u.searchParams.has("api-version")) {
                        u.searchParams.set("api-version", cfg.apiVersion ?? "2024-10-21");
                    }
                    return fetch(u, init);
                },
            })(modelId);
        }
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}

/**
 * Server-side fallback when the user has no `aiModelChoices` row configured.
 * Used by the Maestro chat route so the app works out-of-the-box for any
 * authenticated user without forcing them through /settings/copilot first.
 *
 * Priority (cheapest, most-reliable first):
 *   1. Google Gemini 2.5 Pro     — needs GOOGLE_GENERATIVE_AI_API_KEY
 *   2. Azure OpenAI gpt-4o-mini  — needs AZURE_OPENAI_ENDPOINT + KEY + DEPLOYMENT
 *   3. Anthropic Claude Sonnet   — needs ANTHROPIC_API_KEY
 *   4. OpenAI gpt-4o-mini        — needs OPENAI_API_KEY
 *
 * Returns null if no server-default credentials are present.
 */
export function resolveServerDefault(): ResolvedModel | null {
    const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (googleKey) {
        const modelId = process.env.GEMINI_MODEL ?? "gemini-2.5-pro";
        return {
            model: createGoogleGenerativeAI({ apiKey: googleKey })(modelId) as LanguageModel,
            provider: "google" as ProviderId,
            modelId,
            connectionId: "__server_default__",
            role: "agent" as ModelRole,
        };
    }

    const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const azureKey = process.env.AZURE_OPENAI_KEY;
    const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    if (azureEndpoint && azureKey && azureDeployment) {
        const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21";
        const baseURL = azureEndpoint.replace(/\/$/, "") + "/openai/deployments";
        const model = createOpenAI({
            apiKey: azureKey,
            baseURL,
            headers: { "api-key": azureKey },
            fetch: async (url, init) => {
                const rawUrl = typeof url === "string" || url instanceof URL ? url : url.url;
                const u = new URL(rawUrl);
                if (!u.searchParams.has("api-version")) u.searchParams.set("api-version", apiVersion);
                return fetch(u, init);
            },
        })(azureDeployment) as LanguageModel;
        return {
            model,
            provider: "azure" as ProviderId,
            modelId: azureDeployment,
            connectionId: "__server_default__",
            role: "agent" as ModelRole,
        };
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
        const modelId = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
        return {
            model: createAnthropic({ apiKey: anthropicKey })(modelId) as LanguageModel,
            provider: "anthropic" as ProviderId,
            modelId,
            connectionId: "__server_default__",
            role: "agent" as ModelRole,
        };
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
        const modelId = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
        return {
            model: createOpenAI({ apiKey: openaiKey })(modelId) as LanguageModel,
            provider: "openai" as ProviderId,
            modelId,
            connectionId: "__server_default__",
            role: "agent" as ModelRole,
        };
    }

    return null;
}

function toProviderConnection(row: ConnectionRow, secrets: ProviderSecrets): ProviderConnection {
    return {
        id: row.id,
        userId: row.userId,
        provider: row.provider as ProviderId,
        label: row.label,
        secrets,
        status: row.status as "active" | "expired" | "revoked",
        createdAt: row.createdAt ?? new Date(),
        updatedAt: row.updatedAt ?? new Date(),
    };
}
