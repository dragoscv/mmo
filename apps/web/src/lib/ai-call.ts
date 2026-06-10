/**
 * Tiny provider-agnostic chat client. Given a provider + plaintext API
 * key + a prompt, returns the model's text reply.
 *
 * Lives server-side only — never import from client components. The
 * plaintext key reaches this module via `getAiKey()` which decrypts the
 * value out of `user_preferences`.
 *
 * No SDK dependencies: all five providers are reachable with `fetch`.
 * Default models picked for cost/quality balance and JSON-mode support.
 */

import type { AiProvider } from "@/lib/ai-providers";

const DEFAULT_MODEL: Record<AiProvider, string> = {
    azure: "gpt-4o-mini",
    openai: "gpt-4o-mini",
    anthropic: "claude-3-5-haiku-latest",
    google: "gemini-2.0-flash",
    mistral: "mistral-small-latest",
    groq: "llama-3.3-70b-versatile",
};

export interface AiCallOptions {
    provider: AiProvider;
    apiKey: string;
    system: string;
    user: string;
    model?: string;
    /** When true, append a JSON-mode instruction or use response_format. */
    json?: boolean;
    /** Hard cap on the request — we never need more than a few hundred tokens for tagging. */
    maxTokens?: number;
    /** Abort signal forwarded to fetch. */
    signal?: AbortSignal;
}

export class AiCallError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = "AiCallError";
    }
}

export async function aiCall(opts: AiCallOptions): Promise<string> {
    const model = opts.model ?? DEFAULT_MODEL[opts.provider];
    const maxTokens = opts.maxTokens ?? 600;
    switch (opts.provider) {
        case "azure":
            return callAzure({ ...opts, model, maxTokens });
        case "openai":
            return callOpenAiCompatible({
                url: "https://api.openai.com/v1/chat/completions",
                ...opts, model, maxTokens,
            });
        case "groq":
            return callOpenAiCompatible({
                url: "https://api.groq.com/openai/v1/chat/completions",
                ...opts, model, maxTokens,
            });
        case "mistral":
            return callOpenAiCompatible({
                url: "https://api.mistral.ai/v1/chat/completions",
                ...opts, model, maxTokens,
            });
        case "anthropic":
            return callAnthropic({ ...opts, model, maxTokens });
        case "google":
            return callGoogle({ ...opts, model, maxTokens });
    }
}

/**
 * Azure AI Foundry / Azure OpenAI Service. Uses the Chat Completions
 * API on a per-deployment URL. The user's encrypted key is the Azure
 * resource key; the *endpoint* and *deployment name* come from env
 * vars (`AZURE_AI_ENDPOINT`, `AZURE_AI_DEPLOYMENT`) so they're easy to
 * change without re-encrypting per-user secrets. `opts.model` is
 * treated as the deployment name when explicitly provided.
 */
async function callAzure(opts: NormalisedOpts): Promise<string> {
    const endpoint = process.env.AZURE_AI_ENDPOINT?.replace(/\/+$/, "");
    const deployment = opts.model || process.env.AZURE_AI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_AI_API_VERSION ?? "2024-08-01-preview";
    if (!endpoint || !deployment) {
        throw new AiCallError(
            "Azure provider requires AZURE_AI_ENDPOINT and AZURE_AI_DEPLOYMENT env vars.",
        );
    }
    const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
    const body: Record<string, unknown> = {
        max_tokens: opts.maxTokens,
        messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
        ],
        temperature: 0.3,
    };
    if (opts.json) body.response_format = { type: "json_object" };
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "api-key": opts.apiKey,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
    });
    if (!res.ok) throw new AiCallError(await safeBody(res), res.status);
    const data = await res.json() as {
        choices?: { message?: { content?: string } }[];
    };
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new AiCallError("Empty response");
    return text;
}

interface NormalisedOpts extends Required<Pick<AiCallOptions, "system" | "user" | "apiKey" | "model" | "maxTokens">> {
    json?: boolean;
    signal?: AbortSignal;
}

async function callOpenAiCompatible(opts: NormalisedOpts & { url: string }): Promise<string> {
    const body: Record<string, unknown> = {
        model: opts.model,
        max_tokens: opts.maxTokens,
        messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
        ],
        temperature: 0.3,
    };
    if (opts.json) body.response_format = { type: "json_object" };
    const res = await fetch(opts.url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
    });
    if (!res.ok) throw new AiCallError(await safeBody(res), res.status);
    const data = await res.json() as {
        choices?: { message?: { content?: string } }[];
    };
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new AiCallError("Empty response");
    return text;
}

async function callAnthropic(opts: NormalisedOpts): Promise<string> {
    const body = {
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        temperature: 0.3,
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: opts.signal,
    });
    if (!res.ok) throw new AiCallError(await safeBody(res), res.status);
    const data = await res.json() as {
        content?: { type: string; text?: string }[];
    };
    const text = data?.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") throw new AiCallError("Empty response");
    return text;
}

async function callGoogle(opts: NormalisedOpts): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
    const body: Record<string, unknown> = {
        contents: [{ role: "user", parts: [{ text: opts.user }] }],
        systemInstruction: { parts: [{ text: opts.system }] },
        generationConfig: {
            temperature: 0.3,
            maxOutputTokens: opts.maxTokens,
            ...(opts.json ? { responseMimeType: "application/json" } : {}),
        },
    };
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
    });
    if (!res.ok) throw new AiCallError(await safeBody(res), res.status);
    const data = await res.json() as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("");
    if (!text) throw new AiCallError("Empty response");
    return text;
}

async function safeBody(res: Response): Promise<string> {
    try {
        const t = await res.text();
        return `${res.status} ${res.statusText}: ${t.slice(0, 500)}`;
    } catch {
        return `${res.status} ${res.statusText}`;
    }
}

/**
 * Pull the first JSON object out of a model response. Models occasionally
 * wrap JSON in ```json fences or add a leading sentence even when asked
 * for pure JSON, so we tolerate both.
 */
export function extractJson<T = unknown>(text: string): T | null {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try { return JSON.parse(trimmed) as T; } catch { /* fall through */ }
    }
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (fence) {
        try { return JSON.parse(fence[1]) as T; } catch { /* fall through */ }
    }
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last > first) {
        try { return JSON.parse(trimmed.slice(first, last + 1)) as T; } catch { /* fall through */ }
    }
    return null;
}
