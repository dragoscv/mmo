# Design review — MixAI Live desktop, "Stage Console" (WP21-20)

Two passes: a **code-level** one (scoring the source and the layout maths) and, added 2026-11-14, a
**RENDERED** one on the cloud browser runner — `pnpm e2e:cloud --target vm-live`, 3 Playwright tests
at 1280x720 against the app's own production build, with axe. The rendered pass is the one that
counts; the code-level score below is kept because it is what the prescriptions came from.

Scope reviewed: `apps/live/desktop/src/App.tsx`, `components/SafetyBar.tsx`, `components/PitchRibbon.tsx`,
`components/MixStrip.tsx`, `components/Header.tsx`, `components/Tuner.tsx`, `lib/palette.ts`.

USER ASKED FOR: direction A "Stage Console" — a fixed safety bar (limiter/clip/xrun/latency), Stage mode on
F11, the pitch ribbon as the main visual, a hero visual per effect, and a spectrum.

## Scores

Craft (25): **15/25**

1. Subject presence — **3/5**. The pitch ribbon now owns the centre column and is the only thing on screen
   that moves with the voice, but it is a polyline on a card: a subject, not a hero.
2. Composition — **3/5**. Three columns (meters | ribbon + chain | mix) on a 5-row grid; the ribbon gets the
   flexible row. Dense by design for a console, and it holds at 1280x720, but there is no compositional break.
3. Three layers — **2/5**. Background is a flat token surface; no depth. Deliberate here, penalised by the rubric.
4. Palette discipline — **4/5**. Tokens only (`--success/--warning/--destructive/--muted`), read at draw time and
   re-read on theme change (`lib/palette.ts`, shared by meters and ribbon). States carry words, never colour alone.
5. Typography — **3/5**. One scale, tabular numbers, the display face only on the note and the titles.

Game feel (25): **7/25** — most of this rubric is for cinematic surfaces a stage console deliberately avoids.

6. Choreographed entrance — **1/5**. None, on purpose.
7. Tactile interactions — **2/5**. Knobs drag, buttons have states; nothing compresses or glows.
8. Living background — **1/5**. Static, on purpose.
9. Route morphing — **1/5**. One screen, no routes.
10. Subject artistry — **2/5**. The ribbon's live point and coloured segments are the whole artistry.

Discipline (10): **8/10**

11. Ship a small initial bundle — **4/5**. The three dialogs are lazy; the performance bundle is ~139 kB + vendor.
12. A11y + reduced motion — **4/5**. `role="meter"` with `aria-valuenow` on the limiter, `role="status"` on the
    states, the ribbon's canvas mirrored by live text, `aria-pressed` on the Stage button; the shared loop drops
    to ~10 fps under reduced motion. Not verified with axe (no rendered pass).

**TOTAL: 30/60.** Read it against the applicable-only total: about 15 of the 60 points are cinematic qualities
(criteria 3, 6, 8, 9, 10) that a performance console should *not* pursue, so on the criteria that matter the
slice is roughly 30/42. The previous audit scored this screen 33/60 code-level.

## Prescriptions (priority order)

All four applied in the same pass:

1. `Presets.tsx` — Stage mode keeps the preset *recall* and drops the editing: the delete/revert button and
   "save as" are hidden while `store.stage` is on.
2. `SafetyBar.tsx` + `PitchRibbon.tsx` — tactility: the Stage button compresses (`active:scale-[0.97]`) and the
   ribbon's live point has a soft halo so the eye lands on it before it reads the trace.
3. `SafetyBar.tsx` — the clip chip holds for 2 s after `meters.clipped` clears (the engine's flag is per snapshot,
   so a momentary clip would otherwise vanish before the performer looked up).
4. `PitchRibbon.tsx` — `min-h-40`, so the chain cannot squeeze the ribbon to a strip on a short window.

## Still owed in WP21-20

- A **rendered** design-critic pass (cloud browser runner) — nothing here has been seen on screen.
- Mobile/compact widths are not designed: the screen assumes >= 1280 px, which is the stated target.

Delivered since this review was written: the **spectrum** (the engine's own analysis — the callback only taps a
ring, the FFT runs on the engine's control thread — drawn on a log frequency axis under the ribbon) and the
**hero visual per effect** (`lib/fx-visual.ts` + `FxVisual.tsx`: the gate's threshold, the compressor's transfer
curve, the EQ's response, the de-esser's notch, the delay's taps, the reverb's decay, the limiter's ceiling … one
shape per effect, driven by the insert's parameters, in the insert panel and small on each chain card). Both are
unit-tested for geometry rather than looked at, which is the same caveat as above.

---

## RENDERED PASS (2026-11-14, cloud runner, the one that counts)

`pnpm e2e:cloud --target vm-live` — the desktop app's own `pnpm build` served by `vite preview` on an
ephemeral GCE spot VM, with Playwright + axe. **3 passed, exit 0**, 25 s, ~$0.001. Artifacts:
`.copilot-tmp/e2e-live/out/test-results/live-desktop-{1280x720,stage-1280x720}.png` (screenshots were
brought back and looked at) and `pw-results.json`. Spec: `apps/web/e2e/live-desktop.spec.ts`; the mode
and the bundle change are in `scripts/e2e-cloud/{run.mjs,vm-run.sh}` (commit `749da286`).

**What the rendered screen confirms.**

- The console lays out at its target size with **no horizontal overflow** (measured, not eyeballed) and
  **no page error**, and ships both languages (`document.title` = MixAI; the runner rendered RO).
- The **safety bar** is on screen in both modes: `CURAT` / `MOTOR OPRIT` badges, the engine status, and
  `LIMITATOR 0 dB` reading through a real `role="meter"`. The header also offers `Scenă` / `Ieși din
  scenă` (Stage / Exit stage, i.e. `aria-pressed` works).
- The **spine of direction A** is visible and in the intended order: level meters left, the tuner strip
  and the **pitch ribbon** (with its in-tune bands) in the middle column, **SPECTRU** directly under it
  with its 100 / 1k / 10k log marks, the setlist panel right, and the mix strip at the bottom (Intrare /
  Principal / Monitor / Monitor sec, `Urechi netunate`, `Panică`, `Ocolire`, `Mut`).
- **Stage mode** removes the chain and the setlist editing and keeps the safety bar, the ribbon, the
  spectrum and the mix — seen in the second screenshot, and asserted (the chain region goes from present
  to absent and back).
- **axe reports no serious or critical violation** (WCAG 2.0/2.1 A + AA tags) on the console.

**Two real defects the render caught — both fixed the same hour (`67764bbe`).**

1. **Escape was a no-op after entering Stage mode.** The dialog's own handler and the app's window-level
   shortcut ran in an order that could lose the key, so the console stayed in Stage mode with a dialog
   that reopened: `expect(Chain).toBeVisible()` after Escape failed, twice (both attempts, 5 s each). The
   handler now closes an open panel itself, so the outcome no longer depends on listener order. This is
   exactly the class of bug the source review cannot see, and it was the only failing assertion — the
   first cloud run was 2 passed / 1 failed.
2. **Stale copy on the measure button**: `setup.measureHint` still promised "The live engine stops while
   it measures", which stopped being true in WP21-19 part 3 (measuring now refuses while the engine
   runs). Visible in the rendered Setup panel; both languages corrected.

**Not visible in this pass, and still only code-level.** There is no Tauri runtime in a browser, so the
app opens Setup and reports it (`errors.notTauri` toast, visible in both screenshots): there is no
engine, no catalogue, no session state. Therefore the following are **still unseen on screen**: the
**hero visual per effect** and the chain cards that carry them (the chain renders "Lanțul e gol"), the
**pitch ribbon and spectrum with real data**, and the meters moving. Closing that needs a real desktop
run, or a stub that feeds the console a synthetic session — a follow-up, not a claim.

**Score, rendered (rubric /60; the cinematic criteria 3, 6, 8, 9, 10 are not applicable to a
performance console and are scored 1-2 as the rubric demands, not by intent).**

| | Code-level | Rendered |
|---|---|---|
| Craft (25) | 15 | **17** — composition and typography confirmed in pixels; "subject presence" is still the ribbon as a card, not a hero |
| Game feel (25) | 7 | **7** — unchanged: no entrance, no living background, no morphing, by design |
| Discipline (10) | 8 | **9** — axe clean and the overflow measured; the initial bundle is unchanged |
| **Total** | 30/60 | **33/60** (≈ 33/42 on the criteria that apply) |

**Remaining prescriptions.**

1. `lib/` — a synthetic session fixture so the rendered pass can also *see* the chain, the hero visuals,
   the ribbon and the spectrum with data (the one real gap in this pass).
2. `components/Presets.tsx` — the Stage-mode recall row still shows a truncated `Salvează ca...` on a
   narrow window in normal mode; check at 1280 px with a long preset list.
3. `components/SafetyBar.tsx` — the `LIMITATOR` bar and its `0 dB` readout are the smallest type on the
   screen; size them up one step so they read from a metre away on stage.

## User-intent gap

Partial. The safety bar, Stage mode and the pitch ribbon as the main visual are in; the spectrum and the
per-effect hero visuals are not, so the screen reads as functional-first rather than the finished direction A.
