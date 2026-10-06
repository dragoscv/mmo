# ADR-0006 — codai is the default AI provider

- Status: Accepted · 2026-09-17

## Context
MixAI calls Gemini, Azure OpenAI, Anthropic and OpenAI directly with server-side keys
(`lib/maestro/model-resolver.ts`); `packages/ai` only has a Copilot adapter. codai
(`https://ai.codai.ro`) exposes an OpenAI-compatible API with one model name and
aliases (`codai`, `codai-fast`, `codai-embed`, `codai-transcribe`, `codai-tts`,
`codai-voice`), per-user spend caps, prompt caching by `x-codai-session-id`, and a
management API to mint per-end-user keys (`POST https://api.codai.ro/apps/keys`
with a `codai_app_*` token; responses are `{ ok, data }` envelopes).

## Decision
- `packages/ai` gains `codaiAdapter` built on `@ai-sdk/openai-compatible` with
  `baseURL: https://ai.codai.ro/v1`; it is first in the resolver order. Existing
  providers remain as fallback; when no key exists the adapter runs in mock mode.
- MixAI registers as a codai App. On first AI use a per-user key is minted via mgmt
  and stored encrypted; browser/TV surfaces get ephemeral tokens (`POST /v1/tokens`,
  scopes `audio|embeddings|realtime`).
- Embeddings (`codai-embed`) power semantic library search; `codai-transcribe`
  generates subtitles/lyrics; `codai-fast` parses natural-language playlist intents
  (filter-first: candidates by embedding, LLM only ranks).
- MMO Server on a Pi never runs local ML; it calls codai or the Companion PC.

## Consequences
- New env: `CODAI_API_KEY` (server default), `CODAI_APP_TOKEN` (mgmt), `CODAI_BASE_URL`.
- `packages/ai-mcp` can be registered as a BYO MCP server for the MixAI app id later.
