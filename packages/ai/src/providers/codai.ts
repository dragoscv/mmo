/**
 * codai provider — OpenAI-compatible gateway at https://ai.codai.ro/v1.
 *
 * One model name (`codai`) plus aliases for speed/quality/modality tiers.
 * Auth is `Authorization: Bearer codai_…`. The `x-codai-session-id`
 * header pins requests from one user to the same upstream so prompt
 * caching stays warm — callers should pass the user id (or a chat
 * session id) as the session id.
 *
 * When no key is available the adapter runs in MOCK mode: `languageModel`
 * returns a stub that answers with a fixed string, so the app boots and
 * tests run without network or credentials. See ADR-0006.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModelV4, LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ModelCapabilities, ModelInfo, ProviderAdapter, ProviderConnection } from "./types";

export const CODAI_DEFAULT_BASE_URL = "https://ai.codai.ro/v1";
export const CODAI_SESSION_HEADER = "x-codai-session-id";
export const CODAI_MOCK_REPLY = "[codai mock] No CODAI_API_KEY configured — this is a stub reply.";

export type CodaiTier = "default" | "fast" | "smart" | "vision";
export type CodaiCapabilityTag = "chat" | "fast" | "smart" | "vision" | "embed" | "transcribe" | "tts";

export interface CodaiModelEntry {
    id: string;
    label: string;
    tags: readonly CodaiCapabilityTag[];
    capabilities: ModelCapabilities;
}

const CHAT_BASE: ModelCapabilities = {
    chat: true,
    tools: true,
    vision: false,
    audioIn: false,
    audioOut: false,
    embeddings: false,
    contextTokens: 200_000,
    outputTokens: 32_000,
};

/** Static alias list — codai exposes one model name with tier aliases. */
export const CODAI_MODELS: readonly CodaiModelEntry[] = [
    { id: "codai", label: "codai (default)", tags: ["chat"], capabilities: CHAT_BASE },
    { id: "codai-fast", label: "codai fast", tags: ["chat", "fast"], capabilities: CHAT_BASE },
    { id: "codai-smart", label: "codai smart", tags: ["chat", "smart"], capabilities: CHAT_BASE },
    { id: "codai-vision", label: "codai vision", tags: ["chat", "vision"], capabilities: { ...CHAT_BASE, vision: true } },
    {
        id: "codai-embed",
        label: "codai embeddings",
        tags: ["embed"],
        capabilities: { ...CHAT_BASE, chat: false, tools: false, embeddings: true, outputTokens: 0 },
    },
    {
        id: "codai-transcribe",
        label: "codai transcribe",
        tags: ["transcribe"],
        capabilities: { ...CHAT_BASE, chat: false, tools: false, audioIn: true, outputTokens: 0 },
    },
    {
        id: "codai-tts",
        label: "codai text-to-speech",
        tags: ["tts"],
        capabilities: { ...CHAT_BASE, chat: false, tools: false, audioOut: true, outputTokens: 0 },
    },
] as const;

export const CODAI_TIER_MODEL: Record<CodaiTier, string> = {
    default: "codai",
    fast: "codai-fast",
    smart: "codai-smart",
    vision: "codai-vision",
};

export function codaiModelInfos(): ModelInfo[] {
    return CODAI_MODELS.map((m) => ({ provider: "codai", id: m.id, label: m.label, capabilities: m.capabilities }));
}

/** Read an env var without depending on @types/node (package is runtime-agnostic). */
function env(name: string): string | undefined {
    const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return p?.env?.[name] || undefined;
}

export function codaiBaseUrl(): string {
    return (env("CODAI_BASE_URL") ?? CODAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** True when a server-wide codai key is present in the environment. */
export function isCodaiConfigured(): boolean {
    return !!env("CODAI_API_KEY");
}

export interface CodaiClientOptions {
    apiKey?: string;
    /** Pinned to `x-codai-session-id` for sticky prompt caching. */
    sessionId?: string;
    baseURL?: string;
}

/** Build the raw openai-compatible provider. Throws when no key is available. */
export function createCodaiProvider(opts: CodaiClientOptions = {}) {
    const apiKey = opts.apiKey ?? env("CODAI_API_KEY");
    if (!apiKey) throw new Error("codai: no API key (pass apiKey or set CODAI_API_KEY)");
    const headers: Record<string, string> = {};
    if (opts.sessionId) headers[CODAI_SESSION_HEADER] = opts.sessionId;
    return createOpenAICompatible({
        name: "codai",
        baseURL: opts.baseURL ?? codaiBaseUrl(),
        apiKey,
        headers,
    });
}

/** Chat model. Falls back to the mock model when no key is available. */
export function codaiLanguageModel(modelId = "codai", opts: CodaiClientOptions = {}): LanguageModelV4 {
    if (!(opts.apiKey ?? env("CODAI_API_KEY"))) return createCodaiMockModel(modelId);
    return createCodaiProvider(opts).chatModel(modelId);
}

/** Embedding model (`codai-embed` by default). Requires a key — there is no mock. */
export function codaiEmbeddings(modelId = "codai-embed", opts: CodaiClientOptions = {}): EmbeddingModelV4 {
    return createCodaiProvider(opts).embeddingModel(modelId);
}

/** Minimal LanguageModelV4 that always answers CODAI_MOCK_REPLY. */
export function createCodaiMockModel(modelId = "codai"): LanguageModelV4 {
    const usage = {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
    };
    const finishReason = { unified: "stop" as const, raw: "stop" };
    return {
        specificationVersion: "v4",
        provider: "codai-mock",
        modelId,
        supportedUrls: {},
        async doGenerate() {
            return {
                content: [{ type: "text", text: CODAI_MOCK_REPLY }],
                finishReason,
                usage,
                warnings: [],
            };
        },
        async doStream() {
            const parts: LanguageModelV4StreamPart[] = [
                { type: "stream-start", warnings: [] },
                { type: "text-start", id: "0" },
                { type: "text-delta", id: "0", delta: CODAI_MOCK_REPLY },
                { type: "text-end", id: "0" },
                { type: "finish", finishReason, usage },
            ];
            return {
                stream: new ReadableStream<LanguageModelV4StreamPart>({
                    start(controller) {
                        for (const p of parts) controller.enqueue(p);
                        controller.close();
                    },
                }),
            };
        },
    };
}

function apiKeyFrom(conn: ProviderConnection): string | undefined {
    if (conn.secrets.kind !== "apiKey") throw new Error("Wrong secret kind for codai adapter");
    return conn.secrets.apiKey || env("CODAI_API_KEY");
}

export const codaiAdapter: ProviderAdapter & {
    isConfigured(): boolean;
    models: readonly CodaiModelEntry[];
} = {
    id: "codai",
    models: CODAI_MODELS,
    isConfigured: isCodaiConfigured,
    async listModels() {
        return codaiModelInfos();
    },
    languageModel(conn, modelId): LanguageModelV4 {
        return codaiLanguageModel(modelId, { apiKey: apiKeyFrom(conn), sessionId: conn.userId });
    },
};
