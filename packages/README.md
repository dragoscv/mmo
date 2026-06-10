# Shared workspace packages

These four packages are the MMO **shared core**:

| Package | Purpose |
|---------|---------|
| [`@mmo/ai`](./ai) | Providers, models, Maestro agent, tools, prompts, RAG, settings |
| [`@mmo/audio-gen`](./audio-gen) | Generative audio (T0 in-browser, T1 WebGPU/WASM, T2 companion/remote) |
| [`@mmo/ai-mcp`](./ai-mcp) | MCP server exposing Maestro tools to external clients |
| [`@mmo/sdk`](./sdk) | Thin REST + SSE client for external projects |

## Consumption

Right now the packages are consumed via **TypeScript path aliases** (see `app/tsconfig.json` → `paths`), not via pnpm `workspace:*`. This sidesteps the split-lockfile constraint (see root `.npmrc`) until we're ready to consolidate lockfiles. Each package's `package.json` is already valid so they can be promoted to true workspace deps with one PR later.

## Architecture

See [docs/followups/ai-daw-master-plan.md](../docs/followups/ai-daw-master-plan.md) for the full vision and phased roadmap.
