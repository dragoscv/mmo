import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultProviderRegistry } from "./index";
import {
    CODAI_MOCK_REPLY,
    CODAI_MODELS,
    CODAI_SESSION_HEADER,
    CODAI_TIER_MODEL,
    codaiAdapter,
    codaiLanguageModel,
    createCodaiMockModel,
    createCodaiProvider,
    isCodaiConfigured,
} from "./codai";
import type { ProviderConnection } from "./types";

const processEnv = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const ORIGINAL_KEY = processEnv.CODAI_API_KEY;

function conn(apiKey: string): ProviderConnection {
    return {
        id: "c1",
        userId: "user-42",
        provider: "codai",
        secrets: { kind: "apiKey", apiKey },
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

describe("codaiAdapter", () => {
    beforeEach(() => {
        delete processEnv.CODAI_API_KEY;
    });
    afterEach(() => {
        if (ORIGINAL_KEY === undefined) delete processEnv.CODAI_API_KEY;
        else processEnv.CODAI_API_KEY = ORIGINAL_KEY;
    });

    it("is registered FIRST in the default registry", () => {
        const ids = defaultProviderRegistry.list().map((a) => a.id);
        expect(ids[0]).toBe("codai");
        expect(defaultProviderRegistry.get("codai")).toBe(codaiAdapter);
        expect(ids).toContain("copilot");
    });

    it("exposes every alias with capability tags", async () => {
        const ids = CODAI_MODELS.map((m) => m.id);
        expect(ids).toEqual([
            "codai",
            "codai-fast",
            "codai-smart",
            "codai-vision",
            "codai-embed",
            "codai-transcribe",
            "codai-tts",
        ]);
        const byId = Object.fromEntries(CODAI_MODELS.map((m) => [m.id, m]));
        expect(byId["codai-vision"]!.capabilities.vision).toBe(true);
        expect(byId["codai-embed"]!.capabilities.embeddings).toBe(true);
        expect(byId["codai-embed"]!.capabilities.chat).toBe(false);
        expect(byId["codai-transcribe"]!.capabilities.audioIn).toBe(true);
        expect(byId["codai-tts"]!.capabilities.audioOut).toBe(true);
        expect(byId["codai-fast"]!.tags).toContain("fast");

        const infos = await codaiAdapter.listModels(conn("codai_x"));
        expect(infos.map((i) => i.id)).toEqual(ids);
        expect(infos.every((i) => i.provider === "codai")).toBe(true);
        expect(Object.values(CODAI_TIER_MODEL).every((id) => ids.includes(id))).toBe(true);
    });

    it("isConfigured reflects CODAI_API_KEY", () => {
        expect(isCodaiConfigured()).toBe(false);
        expect(codaiAdapter.isConfigured()).toBe(false);
        processEnv.CODAI_API_KEY = "codai_test";
        expect(isCodaiConfigured()).toBe(true);
    });

    it("returns a mock model that answers the fixed string when no key exists", async () => {
        const model = codaiLanguageModel("codai");
        expect(model.provider).toBe("codai-mock");
        expect(model.modelId).toBe("codai");
        const gen = await model.doGenerate({ prompt: [] });
        expect(gen.content).toEqual([{ type: "text", text: CODAI_MOCK_REPLY }]);
        expect(gen.finishReason.unified).toBe("stop");

        const { stream } = await model.doStream({ prompt: [] });
        const parts: unknown[] = [];
        const reader = stream.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
        }
        const deltas = parts.filter((p) => (p as { type: string }).type === "text-delta") as { delta: string }[];
        expect(deltas.map((d) => d.delta).join("")).toBe(CODAI_MOCK_REPLY);
        expect((parts.at(-1) as { type: string }).type).toBe("finish");
    });

    it("adapter.languageModel uses mock when connection key is empty and env key is absent", () => {
        const model = codaiAdapter.languageModel(conn(""), "codai-fast") as ReturnType<typeof createCodaiMockModel>;
        expect(model.provider).toBe("codai-mock");
        expect(model.modelId).toBe("codai-fast");
    });

    it("builds a real openai-compatible model when a key is present", () => {
        const model = codaiAdapter.languageModel(conn("codai_real"), "codai-smart") as { provider: string; modelId: string };
        expect(model.provider).not.toBe("codai-mock");
        expect(model.provider).toContain("codai");
        expect(model.modelId).toBe("codai-smart");
    });

    it("sends bearer auth and the sticky session header", async () => {
        const seen: { url: string; headers: Headers }[] = [];
        const provider = createOpenAICompatibleWithCapture(seen);
        const model = provider.chatModel("codai");
        await Promise.resolve(
            model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
        ).catch(() => undefined);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.url).toBe("https://ai.codai.ro/v1/chat/completions");
        expect(seen[0]!.headers.get("authorization")).toBe("Bearer codai_k");
        expect(seen[0]!.headers.get(CODAI_SESSION_HEADER)).toBe("user-42");
    });

    it("createCodaiProvider throws without a key", () => {
        expect(() => createCodaiProvider()).toThrow(/no API key/);
    });
});

/** Wrap createCodaiProvider with a capturing fetch via globalThis. */
function createOpenAICompatibleWithCapture(seen: { url: string; headers: Headers }[]) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        seen.push({ url, headers: new Headers(init?.headers) });
        globalThis.fetch = realFetch;
        return new Response(JSON.stringify({ error: "captured" }), { status: 500 });
    }) as typeof fetch;
    return createCodaiProvider({ apiKey: "codai_k", sessionId: "user-42" });
}
