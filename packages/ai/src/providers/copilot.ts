/**
 * GitHub Copilot provider — Device Code Flow authentication.
 *
 * Reproduces the same handshake VS Code / GitHub CLI use:
 *   1. POST github.com/login/device/code      → user_code + verification_uri
 *   2. User authorizes in browser
 *   3. Poll github.com/login/oauth/access_token → long-lived OAuth token
 *   4. Exchange via api.github.com/copilot_internal/v2/token → short Copilot session token + endpoints
 *   5. Call {endpoints.api}/models, /chat/completions (OpenAI-compatible)
 *
 * The session token (step 4) expires ~25 min, refresh by re-running step 4
 * with the OAuth token from step 3 — that's why we store both.
 *
 * SECURITY: Tokens MUST be encrypted with AES-256-GCM via app/src/lib/token-crypto.ts
 * before persistence. This module only deals with the wire protocol.
 *
 * LEGAL: This integration is for personal use of the user's own Copilot
 * subscription only. See /settings/copilot disclaimer.
 */

import type { ModelCapabilities, ModelInfo, ProviderAdapter, ProviderConnection, ProviderSecrets } from "./types";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV2 } from "@ai-sdk/provider";

/**
 * Public client_id for the VS Code Copilot extension. Same id used by
 * GitHub CLI's `gh copilot` and other community Copilot clients. Works
 * out of the box; users may switch to their own OAuth App if preferred.
 */
export const VSCODE_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export interface CopilotClientConfig {
    /** Override the OAuth client_id (use a registered "MMO" GitHub OAuth App). */
    clientId?: string;
    /** Editor identification headers — GitHub uses these for telemetry. */
    editorVersion?: string;
    editorPluginVersion?: string;
    /** Used as Copilot-Integration-Id. */
    integrationId?: string;
    /** Override the user-agent. */
    userAgent?: string;
}

const DEFAULT_CONFIG: Required<CopilotClientConfig> = {
    clientId: VSCODE_COPILOT_CLIENT_ID,
    editorVersion: "MMO/0.1",
    editorPluginVersion: "copilot-chat/0.1",
    integrationId: "vscode-chat",
    userAgent: "MMO-Copilot/0.1",
};

export interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
}

export interface AccessTokenResponse {
    access_token: string;
    token_type: string;
    scope: string;
}

export interface CopilotSessionToken {
    token: string;
    expires_at: number;
    refresh_in: number;
    endpoints: { api: string; [k: string]: string };
    /** Raw response for forward compatibility. */
    raw: Record<string, unknown>;
}

export interface CopilotModelListEntry {
    id: string;
    name?: string;
    object?: string;
    vendor?: string;
    version?: string;
    preview?: boolean;
    model_picker_enabled?: boolean;
    capabilities?: {
        family?: string;
        type?: string;
        tokenizer?: string;
        limits?: { max_context_window_tokens?: number; max_output_tokens?: number };
        supports?: { tool_calls?: boolean; vision?: boolean; streaming?: boolean };
    };
}

interface CopilotModelsResponse {
    data?: CopilotModelListEntry[];
}

export class CopilotAuthError extends Error {
    constructor(message: string, readonly code?: string, readonly status?: number) {
        super(message);
        this.name = "CopilotAuthError";
    }
}

function commonHeaders(cfg: Required<CopilotClientConfig>) {
    return {
        "accept": "application/json",
        "editor-version": cfg.editorVersion,
        "editor-plugin-version": cfg.editorPluginVersion,
        "user-agent": cfg.userAgent,
    } as const;
}

/** Step 1: request a device code. */
export async function requestDeviceCode(config: CopilotClientConfig = {}): Promise<DeviceCodeResponse> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const res = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: { ...commonHeaders(cfg), "content-type": "application/json" },
        body: JSON.stringify({ client_id: cfg.clientId, scope: "read:user" }),
    });
    if (!res.ok) {
        throw new CopilotAuthError(`device/code failed: ${res.status} ${await safeText(res)}`, "device_code_failed", res.status);
    }
    return (await res.json()) as DeviceCodeResponse;
}

/** Step 3: single poll attempt. Returns null when authorization is still pending. */
export async function pollAccessToken(
    deviceCode: string,
    config: CopilotClientConfig = {},
): Promise<AccessTokenResponse | null> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { ...commonHeaders(cfg), "content-type": "application/json" },
        body: JSON.stringify({
            client_id: cfg.clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
    });
    const json = (await res.json()) as { access_token?: string; token_type?: string; scope?: string; error?: string; error_description?: string };
    if (json.access_token) {
        return {
            access_token: json.access_token,
            token_type: json.token_type ?? "bearer",
            scope: json.scope ?? "",
        };
    }
    switch (json.error) {
        case "authorization_pending":
        case "slow_down":
            return null;
        case "expired_token":
            throw new CopilotAuthError("Device code expired. Restart the connection.", "expired_token");
        case "access_denied":
            throw new CopilotAuthError("Authorization was denied.", "access_denied");
        default:
            throw new CopilotAuthError(json.error_description ?? json.error ?? "Unknown OAuth error", json.error);
    }
}

/** Convenience: poll until authorized or timeout. Caller can pass an AbortSignal to cancel. */
export async function pollUntilAuthorized(
    deviceCode: string,
    intervalSec: number,
    expiresInSec: number,
    config: CopilotClientConfig = {},
    signal?: AbortSignal,
): Promise<AccessTokenResponse> {
    const deadline = Date.now() + expiresInSec * 1000;
    let wait = Math.max(1, intervalSec) * 1000;
    while (Date.now() < deadline) {
        if (signal?.aborted) throw new CopilotAuthError("Polling aborted", "aborted");
        const r = await pollAccessToken(deviceCode, config).catch((e: unknown) => {
            if (e instanceof CopilotAuthError && e.code === "slow_down") {
                wait += 5000;
                return null;
            }
            throw e;
        });
        if (r) return r;
        await delay(wait, signal);
    }
    throw new CopilotAuthError("Device code expired before authorization", "expired_token");
}

/** Step 4: exchange OAuth token for a Copilot session token + endpoints. */
export async function exchangeForSessionToken(
    oauthToken: string,
    config: CopilotClientConfig = {},
): Promise<CopilotSessionToken> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
        headers: {
            ...commonHeaders(cfg),
            authorization: `token ${oauthToken}`,
        },
    });
    if (!res.ok) {
        throw new CopilotAuthError(
            `copilot_internal/v2/token failed: ${res.status} ${await safeText(res)}`,
            "session_exchange_failed",
            res.status,
        );
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const token = raw["token"] as string | undefined;
    const expiresAt = raw["expires_at"] as number | undefined;
    const refreshIn = raw["refresh_in"] as number | undefined;
    const endpoints = (raw["endpoints"] as { api?: string }) ?? {};
    if (!token || !expiresAt || !endpoints.api) {
        throw new CopilotAuthError("Malformed session token response", "session_malformed");
    }
    return {
        token,
        expires_at: expiresAt,
        refresh_in: refreshIn ?? 1500,
        endpoints: endpoints as CopilotSessionToken["endpoints"],
        raw,
    };
}

/** Step 5: list models available to this Copilot subscription. */
export async function listCopilotModels(
    session: CopilotSessionToken,
    config: CopilotClientConfig = {},
): Promise<CopilotModelListEntry[]> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const url = `${session.endpoints.api.replace(/\/+$/, "")}/models`;
    const res = await fetch(url, {
        headers: {
            ...commonHeaders(cfg),
            authorization: `Bearer ${session.token}`,
            "copilot-integration-id": cfg.integrationId,
        },
    });
    if (!res.ok) {
        throw new CopilotAuthError(`models failed: ${res.status} ${await safeText(res)}`, "models_failed", res.status);
    }
    const json = (await res.json()) as CopilotModelsResponse;
    return json.data ?? [];
}

/** Map a raw Copilot model entry to our normalized ModelInfo. */
export function toModelInfo(entry: CopilotModelListEntry): ModelInfo {
    const caps = entry.capabilities ?? {};
    const supports = caps.supports ?? {};
    const limits = caps.limits ?? {};
    const capabilities: ModelCapabilities = {
        chat: caps.type !== "embeddings",
        tools: !!supports.tool_calls,
        vision: !!supports.vision,
        audioIn: false,
        audioOut: false,
        embeddings: caps.type === "embeddings",
        contextTokens: limits.max_context_window_tokens ?? 0,
        outputTokens: limits.max_output_tokens ?? 0,
    };
    return {
        provider: "copilot",
        id: entry.id,
        label: entry.name ?? entry.id,
        family: caps.family,
        capabilities,
    };
}

/** ProviderAdapter implementation. languageModel() returns a fetch-based
 *  OpenAI-compatible client until @ai-sdk/openai-compatible is wired up
 *  in the consuming app (P1). */
export const copilotAdapter: ProviderAdapter = {
    id: "copilot",
    async listModels(conn) {
        if (conn.secrets.kind !== "copilot") throw new Error("Wrong secret kind for copilot adapter");
        const session = await ensureSession(conn.secrets);
        const raw = await listCopilotModels(session);
        return raw.map(toModelInfo);
    },
    languageModel(conn, modelId): LanguageModelV2 {
        if (conn.secrets.kind !== "copilot") throw new Error("Wrong secret kind for copilot adapter");
        const secrets = conn.secrets;
        // We build the openai-compatible provider with a Bearer token that
        // is re-resolved on every fetch — so session refresh is automatic.
        const baseURL = secrets.endpoints?.api?.replace(/\/+$/, "") ?? "https://api.githubcopilot.com";
        const provider = createOpenAICompatible({
            name: "copilot",
            baseURL,
            headers: {
                "copilot-integration-id": DEFAULT_CONFIG.integrationId,
                "editor-version": DEFAULT_CONFIG.editorVersion,
                "editor-plugin-version": DEFAULT_CONFIG.editorPluginVersion,
            },
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                const session = await ensureSession(secrets);
                const headers = new Headers(init?.headers);
                headers.set("authorization", `Bearer ${session.token}`);
                return fetch(input, { ...init, headers });
            },
        });
        return provider.chatModel(modelId);
    },
    async refresh(conn) {
        if (conn.secrets.kind !== "copilot") throw new Error("Wrong secret kind for copilot adapter");
        const session = await exchangeForSessionToken(conn.secrets.oauthToken);
        return {
            kind: "copilot",
            oauthToken: conn.secrets.oauthToken,
            sessionToken: session.token,
            sessionExpiresAt: new Date(session.expires_at * 1000),
            endpoints: session.endpoints,
        };
    },
};

async function ensureSession(secrets: Extract<ProviderConnection["secrets"], { kind: "copilot" }>): Promise<CopilotSessionToken> {
    const valid = secrets.sessionToken && secrets.sessionExpiresAt && secrets.sessionExpiresAt.getTime() > Date.now() + 60_000;
    if (valid && secrets.endpoints?.api) {
        return {
            token: secrets.sessionToken!,
            expires_at: Math.floor(secrets.sessionExpiresAt!.getTime() / 1000),
            refresh_in: 1500,
            endpoints: secrets.endpoints,
            raw: {},
        };
    }
    return exchangeForSessionToken(secrets.oauthToken);
}

async function safeText(res: Response): Promise<string> {
    try {
        return await res.text();
    } catch {
        return "<no body>";
    }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new CopilotAuthError("aborted", "aborted"));
        }, { once: true });
    });
}
