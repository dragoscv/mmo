---
applyTo: "packages/ui/**, apps/web/src/components/**, apps/mixai/src/**, server/ui/src/**"
description: "@mmo/ui is built on Base UI (@base-ui/react), not Radix — API differences and dedupe traps"
---

# Base UI primitives (`@mmo/ui`, ADR-0008 D6)

## Rules
- Import primitives from `@mmo/ui` (tsconfig path alias), never from `@radix-ui/*` or `radix-ui`. Web's
  `components/ui/*` are thin wrappers (`withAsChild` HOC, `NativeSelect` for `<option>` callers) — extend them,
  don't fork.
- Composition: `render={<Link href="…" />}` (Base UI `useRender`), NOT `asChild`.
- State attributes: `data-open`, `data-checked`, `data-highlighted`, `data-starting-style`, `data-ending-style`.
  Never select on `data-state="open"`.
- Callbacks carry a second arg: `onOpenChange(open, eventDetails)`, `onValueChange(value, eventDetails)`.
- Families and names are shadcn-compatible: layout (`AppShell`, `Sidebar*`, `BottomTabBar`, `Page*`),
  feedback (`Skeleton*`, `EmptyState` + `NotSignedInState`/`NoCompanionState`/`ErrorState`/`NoResultsState`,
  `Progress`, `ProgressJob`, `Toaster`), data (`DataTable` on TanStack Table 9), overlays (`Dialog`, `Sheet`,
  `AlertDialog`, `Popover`, `Tooltip`, `DropdownMenu`, `ContextMenu`, `CommandDialog`, `ShortcutsOverlay`),
  forms (`Input`, `Select`, `Checkbox`, `Switch`, `Slider`, `RadioGroup`, `ToggleGroup`, `Field*`), theme
  (`ThemeProvider`, `useThemePrefs`, `ThemeSettings`), motion presets, hooks, shortcuts registry.
- Motion: `motion` 13 presets (`fade`, `rise`, `scale`, `slideUp`, `stagger`) + React 19.3 `<ViewTransition>`
  on web routes; `<PageTransition>` in mixai/companion. Never add `framer-motion`.
- One shortcuts registry per app: `registerShortcut`/`useRegisterShortcut`. Web layout already mounts ONE
  `ShortcutsOverlay` (id `shortcuts-overlay`) — trigger via `getShortcuts().find(id).handler()`, never mount a
  second `useShortcutsOverlay` (duplicate registry id).
- `DataTable`: TanStack Table **v9** — `tableFeatures({...})` + `useTable({ features, columns, data })`;
  there is NO `useReactTable`/`getCoreRowModel`. State is a TanStack Store (`table.state.x`).
- `cmdk` 1.1: root is `Command`, sub-parts `Command.Input/List/Item/Group/Empty`; items expose
  `data-selected="true"`; async results must pass `keywords={[query]}` or the client filter hides them.

## Gotchas (exact strings)
- `Cannot read properties of null (reading 'useState')` → duplicated React. Dedupe `react`, `react-dom`,
  `motion`, `@base-ui/react`, `lucide-react` to the consuming app's `node_modules`
  (web: `next.config.ts` `turbopack.resolveAlias` + `vitest.config.ts` `resolve.dedupe`; Vite apps:
  `resolve.dedupe` + alias). In `server/ui/tsconfig.json` map `"react": ["../node_modules/@types/react"]`
  (mapping to the JS package → TS7016 "no declaration file" across packages/ui).
- Tests in jsdom: Base UI `Select`/`Menu` do NOT open on `fireEvent.click(trigger)` → render with `defaultOpen`;
  `Select.Item` commits only on `keyDown Enter` after focus. cmdk group headings are not `role=heading` →
  query `[cmdk-group-heading]`. `ChoiceCards` with description have name "Label Description".
- ESLint `react-hooks/set-state-in-effect` and `react-hooks/purity` are ERRORS on web: reset derived state
  in the change handler, no `Date.now()` in render (compute in SQL or pass from caller).
- `packages/ui` has its own `node_modules/react`; do not import types from it in consumers.

## Verify
- `pnpm -C packages/ui typecheck` and `pnpm -C packages/ui test` (RTL + jsdom) via a hidden
  `Start-Process pwsh -File .copilot-tmp/ui-verify.ps1` — the shared terminal prints only "RUN" then dies.
- Consumer typecheck: `pnpm -C apps/web typecheck` / `pnpm -C apps/mixai typecheck` / `pnpm -C server ui:typecheck`.
- Visual: `/dev/ui` catalog on web (`MIXAI_DEV_UI=1` in prod), `pnpm -C apps/web e2e` specs `ui-catalog`,
  `theme-matrix`, `a11y`.
