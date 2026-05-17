# Next.js 16 modernisation — follow-up tranches

This file scopes the three remaining audit recommendations that intentionally did **not** land in the recent mega-session because each one is a multi-day refactor whose risk does not fit alongside small ship-it changes.

Each tranche below is sized to a dedicated branch / PR with its own QA pass.

---

## Tranche A — `experimental.cacheComponents: true`

**Why**: opt into Next.js 16's directive-based caching (`"use cache"`, `cacheLife`, `cacheTag`). Today every page is dynamic. With cacheComponents the framework can serve cached HTML for the auth-free public surface (`/`, `/downloads`, `/learn/**`, `/.well-known/**`) while keeping dynamic pages dynamic via `<Suspense>` boundaries around each `auth()` / `cookies()` / DB call.

**Concrete work** (verified by enabling the flag and reading the failing build):

1. Remove `export const dynamic = "force-dynamic"` from **35** files:

    - **App pages (22)**: `analysis`, `status`, `live`, `editor`, `settings`, `download`, `drives`, `plugins`, `library`, `devices`, `scanner`, `playlists`, `library/import`, `daw`, `library/hidden`, `mixer`, `profile`, `library/duplicates`, `remote`, `recordings` (each `page.tsx`).
    - **API routes (13)**: `api/export/rekordbox`, `api/downloads/manifest`, `api/remote/send`, `api/system-stats`, `api/remote/events`, `api/push/subscribe`, `api/lan-url`, `api/recordings/[id]/audio`, `api/turn-credentials`, `api/recordings/save`, `api/health`, `api/usb-copy`, `api/analysis/{apply,changes,control,start,stream,status}` (6 files in that last group).

    Under cacheComponents these declarations become a build error. Each page is dynamic by default once it touches dynamic IO — the declaration is redundant.

2. Replace `export const dynamic = "force-static"` + `export const revalidate = N` with the `"use cache"` directive + `cacheLife({ stale, revalidate, expire })` in **6** files:

    - `.well-known/assetlinks.json/route.ts` (was: `force-static` + `revalidate: 3600`).
    - `.well-known/apple-app-site-association/route.ts` (same).
    - `learn/page.tsx`, `learn/[section]/page.tsx`, `learn/[section]/[slug]/page.tsx` (currently `force-static`; should become `"use cache"` with a long `cacheLife`).
    - `offline/page.tsx` (currently `force-static`; should be `"use cache"` + immutable).

3. Migrate `export const revalidate = 300` on `app/src/app/page.tsx` (the homepage) to `"use cache"` + `cacheLife({ revalidate: 300 })`.

4. Audit shared layouts (`app/src/app/layout.tsx` and any nested layouts) to confirm there are no top-level `auth()` / `cookies()` calls without a `<Suspense>` parent. Today the root layout does **not** call `auth()` directly — it relies on each page calling `auth()` — so this should pass; verify before declaring done.

5. Re-enable the flag in `app/next.config.ts` (`experimental.cacheComponents: true`) and run `pnpm build` until it succeeds with **0** route-segment-config errors.

6. QA pass: hit every page in dev, confirm the dynamic ones still render fresh data and the cached ones serve from cache. Verify the auth redirects still fire on the gated pages (they will only ever execute server-side because they call `auth()` directly, which under cacheComponents marks the render boundary as dynamic).

**Estimated effort**: 1 focused day with the build loop running.

---

## Tranche B — `useEffect + fetch` → server actions / RSC

**Why**: 22 client components do a `useEffect(() => { fetch(...) }, [])` pattern that could be a server action or an RSC data fetch. Switching them removes the `loading` flash, removes a network round-trip, and shrinks the client bundle.

**Concrete work**:

- Enumerate the 22 sites with `rg -n "useEffect.*fetch\(" app/src` (filter false positives).
- Group by feature (library, scanner, mixer, recordings, …) and convert one feature per commit.
- For each conversion:
    - Lift the fetch into the surrounding server component (or a `"use server"` action) and pass the result as a prop.
    - Remove the local `loading` / `error` state; rely on Suspense + error boundaries instead.
- After each feature is green, re-run the playwright suite for that feature.

**Risk**: behavioural regression in client-heavy pages (mixer, live, daw). Each conversion must keep the existing optimistic-update semantics intact.

**Estimated effort**: 2-3 days, one feature group per session.

---

## Tranche C — mega-component refactor

**Why**: six components are >1000 lines and are the dominant source of slow HMR + churn in code review:

| File                                                | Lines (approx) |
| --------------------------------------------------- | -------------- |
| `app/src/app/live/page.tsx`                         | ~3000          |
| `app/src/app/download/download-client.tsx`         | ~2500          |
| `app/src/components/mixer-view.tsx`                | ~1800          |
| `app/src/app/daw/page.tsx`                          | ~1600          |
| `app/src/app/analysis/analysis-client.tsx`          | ~1200          |
| `app/src/components/mixer-browser-modal-v2.tsx`    | ~1100          |

**Concrete work**: for each file, extract sub-components per visual region (header, sidebar list, detail pane, action bar, modals). Preserve behaviour by extracting in this order:

1. Pure presentational sub-components (no props mutation) first — these can be moved verbatim into a sibling `_components/` folder.
2. State-owning regions — pass state down via props or lift into a small zustand store scoped to the page.
3. Side-effect hooks — collect into a single `use<Feature>Engine.ts` hook.

After each extraction, run the page in dev and click through every interactive control. Commit one extraction at a time so any regression bisects to a small change.

**Risk**: highest of the three tranches. These components have intricate cross-state dependencies (especially `mixer-view` and `live`). A bad extraction can desync deck state or break MIDI routing.

**Estimated effort**: 3-5 days, one file per session.

---

## Suggested order

A → B → C. Tranche A unlocks the cache primitives that Tranche B benefits from (cached server actions). Tranche C should come last because it touches the largest surface area and benefits from having the simpler client code shape that Tranche B produces.
