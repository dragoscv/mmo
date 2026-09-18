---
name: openapi-change
description: Add or change an MMO Server HTTP route while keeping the contract chain in sync — server/openapi.yaml, openapi-check drift guard (MOUNTS), redocly lint, generated Kotlin Models.kt for tv-android and the TypeScript SDK types. Use whenever an Express route/router/response shape changes under server/src, when openapi:check fails, or when a TV/SDK client needs a new field. Trigger words: openapi, openapi:check, openapi:gen, Models.kt, mmo-server.d.ts, new route, MOUNTS, redocly.
---

# Change an API route (ADR-0004 contract chain, WP9-06)

Chain: Express route (`server/src/**`) ↔ `server/openapi.yaml` (OpenAPI 3.1) ↔
`apps/tv-android/app/src/main/java/ro/mixai/tv/data/generated/Models.kt` ↔ `packages/sdk/src/generated/mmo-server.d.ts`.
Generated files carry `GENERATED FILE - do not edit by hand`.

## Procedure
1. Implement the route in the right router file. Express 5 syntax: params `:id` (no inline regex — use
   `router.param` guards), splats `/x/*name` (param is an array; `splatParam()` joins). Auth via
   `authMiddleware` unless the route is intentionally public (`/rest`, `/pair/{request,poll,info}`).
2. New router FILE? Add its mount prefix to `MOUNTS` in `server/scripts/openapi-check.mjs`
   (e.g. `"media/routes.ts": "/media"`), otherwise the check throws
   `<file> registers GET /… but has no mount prefix in openapi-check.mjs MOUNTS`.
3. Document it in `server/openapi.yaml`: path with `{param}` syntax, operationId, request/response schemas under
   `components/schemas` (reuse existing ones), 4XX responses, `security: [deviceToken]` when authenticated.
   Bump `info.version` together with `server/package.json` for user-visible changes.
4. Check drift + lint (from `server/`, hidden process or short enough for the terminal):
   ```powershell
   pnpm openapi:check      # textual route discovery vs spec — both directions
   pnpm openapi:lint       # redocly; 7 known warnings (ambiguous /voice paths, 5 ops without 4XX) are accepted
   ```
5. Regenerate clients:
   ```powershell
   pnpm openapi:gen        # = node scripts/openapi-kotlin.mjs && pnpm --dir ../packages/sdk gen:openapi
   ```
   `gen:openapi` shells out to `openapi-typescript` installed in `server/` (needs TS 5.x peer; the sdk itself is
   TS 7 + openapi-fetch). Output: `Models.kt` (kotlinx.serialization data classes) + `mmo-server.d.ts`.
6. Update hand-written wrappers if the shape changed: `packages/sdk/src/mmo-server.ts` (+ test), tv-android
   `MmoApi.kt`/repository, tv-tizen client, web `lib/companion-*.ts`. Kotlin trap: a `@Serializable data class
   Companion` collides with generated companion objects → name it `CompanionServer`.
7. Tests: route test in `server/src/**/**.test.ts` (real `http.Server` on port 0, `vi.mock("../store")`,
   injectable router deps as in `pair/router.ts`); `pnpm -C packages/sdk test`; `pnpm -C packages/sdk typecheck`.
8. Stage explicitly: `git add -- server/src/<files> server/openapi.yaml server/scripts/openapi-check.mjs packages/sdk/src/generated/mmo-server.d.ts apps/tv-android/app/src/main/java/ro/mixai/tv/data/generated/Models.kt`
   (+ `server/package.json`, `server/CHANGELOG.md`). Media Home routes also need a tracker status update (WP10-07).

## Verify
- `pnpm -C server openapi:check` prints no missing/extra routes (exit 0). `pnpm -C server openapi:lint` exit 0
  (warnings only).
- `pnpm openapi:gen` twice → second run leaves `git --no-pager status --short` unchanged (deterministic).
- `pnpm -C server test` and `pnpm -C packages/sdk test` green; tv-android builds (`tv-android-build-test`) since
  `Models.kt` changed.
- Live: `curl.exe -H "x-device-token: <token>" http://127.0.0.1:17899/<route>` returns the documented shape.

## Common failures
- Check reports a route in the spec but not in code (or vice versa) → path param naming differs
  (`:fileId` vs `{id}`) — the guard normalises `:x`→`{x}` and `*x`→`{x}` only.
- `.all()` routes are counted as GET + POST — document both.
- `openapi-typescript` peer error → run it via `pnpm --dir ../../server exec`, never install TS 5 into `packages/sdk`.
- Redocly "ambiguous paths" for `/voice/engines/{engineId}/{command}` vs `/voice/{id}/…` mirrors real Express
  routing — do not "fix" the spec to silence it.
- Kotlin build fails after gen → `Unclosed comment` when a `/x/*` glob lands in a KDoc; the generator emits `//`
  comments — check hand-written files.
