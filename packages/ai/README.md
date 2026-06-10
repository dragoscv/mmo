# @mmo/ai

Shared AI core for MMO. Wraps Vercel AI SDK v5 with:

- Provider registry (OpenAI, Anthropic, Google, Mistral, Groq, Azure, **GitHub Copilot via device-code**)
- Model registry with capability flags + per-role defaults
- `Maestro` agent runtime (planner, tool calls, traces)
- Multi-agent skill system (sub-agents callable as tools)
- Typed tool definitions (Zod-validated)
- Prompt templates (versioned)
- RAG adapters (pgvector / sqlite-vss)

See [docs/followups/ai-daw-master-plan.md](../../docs/followups/ai-daw-master-plan.md).

## Layout

```
src/
  providers/   ← provider adapters (BYO-key + Copilot OAuth)
  models/      ← model metadata + role assignment
  agent/       ← Maestro orchestrator
  tools/       ← typed tool registry + DAW tool catalogue
  prompts/     ← versioned prompt templates
  rag/         ← embeddings + vector store adapters
  settings/    ← user-level role→model preferences
```

## Status

Scaffolded in P0. Functional core lands across P1–P5.
