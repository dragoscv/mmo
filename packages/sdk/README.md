# @mmo/sdk

Tiny TypeScript SDK for MMO's REST + SSE API. Use from any third-party project.

```ts
import { MmoClient } from "@mmo/sdk";

const mmo = new MmoClient({
    baseUrl: "https://mmo.example.com",
    token: process.env.MMO_PAT!,
});

// Drive Maestro from an external app:
const run = await mmo.agent.run({
    projectId: "abc123",
    prompt: "Make me a 4-bar 128bpm tech-house drum loop, add a sub-bass.",
});
for await (const evt of run.stream) console.log(evt);
```

## Status

Scaffolded in P0. Functional client lands in P11.
