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

## MMO Server (companion) client — `@mmo/sdk/mmo-server`

Typed client for the local **MMO Server** REST API (`server/openapi.yaml`, OpenAPI 3.1),
built on [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/). Paths, params, bodies
and responses are checked against the generated types in `src/generated/mmo-server.d.ts`.

```ts
import { createMmoServerClient } from "@mmo/sdk/mmo-server";

const mmo = createMmoServerClient({
    baseUrl: "http://192.168.1.10:17899",
    token: deviceToken, // from Quick Connect pairing → sent as `x-device-token`
    userId, // optional → `x-user-id` (needed by /library, /voice, /plugins, /mixai-profile)
});

const { data: health } = await mmo.GET("/health");
const { data: scan } = await mmo.POST("/video/scan", { body: {} });
const info = await mmo.GET("/video/file/{fileId}/info", { params: { path: { fileId } } });
```

Regenerate the types after editing the spec:

```sh
pnpm gen:openapi        # here, or `pnpm openapi:gen` in server/ (also emits the Kotlin models)
pnpm typecheck && pnpm test
```

`openapi-typescript` runs from `server/` (it needs TypeScript 5.x as a peer; this package
is on TypeScript 7). See [`docs/companion/api.md`](../../docs/companion/api.md).

## Status

`MmoClient` (cloud REST + SSE) is scaffolded in P0; the functional client lands in P11.
The MMO Server client above is functional (WP9-06).
