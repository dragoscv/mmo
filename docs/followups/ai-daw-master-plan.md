# MMO — AI Copilot + Generative DAW Master Plan

> **Status:** v0.2 — Round-1 decisions locked. Awaiting Round-2 technical decisions, then code.
> **Owner:** Dragos Catalin Vladulescu
> **Scope:** Multi-phase refactor + greenfield modules. Single comprehensive plan.
> **Last updated:** 2026-05-19

## Round-1 decisions (locked)

| Topic | Decision |
|---|---|
| Implementation pass scope | **All phases P0–P12**, run continuously until done. |
| AI SDK | **Vercel AI SDK v5** (`generateText`, `streamText`, multi-step tools). |
| Copilot client_id | **Support BOTH** the well-known VS Code Copilot client_id and a user-registered "MMO" OAuth App; chosen per-connection in `/settings/copilot`. |
| Generative providers | **NO third-party music APIs** (no Suno, Udio, ElevenLabs, Replicate). Only: local WebGPU/WASM (T0–T1), MusicGen via companion (T2), Stable Audio Open via companion (T2). Plus MMO-owned **remote workers** the user can provision (Cloud Run / RunPod / their own GPU box) — not third-party music vendors. |
| Companion app | Required for T2 (heavy local models). Web works standalone for T0–T1. Remote workers always work. |
| Agent autonomy default | **auto** (silent apply + trace), switchable in real time between `ask` / `propose` / `auto`. |
| Voice input | Yes — Web Speech API + Whisper transcription + hum-to-MIDI via pitch detection. |
| AgentDock UI | **Floating dock bottom-right** (Cursor-style) that expands into a side panel. |
| Generated-file storage | `app/data/generated/<userId>/<uuid>.wav` + manifest. Traces in DB. Kept indefinitely with a manual purge button. |
| License policy default | All enabled by default with a one-time disclaimer per provider on first use. |
| Agent name | **Maestro**. |

### Reframing implication

The user explicitly wants MMO to be **the platform** other apps consume, not a thin wrapper over Suno/ElevenLabs. So `@mmo/ai` and `@mmo/audio-gen` are designed as **first-class libraries with an MCP server façade** so:

- Other MMO apps (Tauri, mobile, extension, server companion) use them as in-process libraries.
- **External** apps (any third party) can consume them via:
  1. **MCP server** (`@mmo/ai-mcp`) exposing tools over stdio + HTTP/SSE — works with Claude Desktop, VS Code, Cursor, etc.
  2. **REST + SSE API** under `/api/ai/*` (signed PAT tokens, scoped per project).
  3. **TypeScript SDK** (`@mmo/sdk`) re-exporting safe client-side helpers.

This is now a load-bearing requirement (see new §13).

---

## 0. Executive summary

We are turning MMO from a "DJ‑library + experimental DAW" into a **production‑grade, AI‑native music studio** with:

1. A **fully functional in-browser DAW** (timeline, mixer, MIDI, audio, plugins, automation, export) on top of the existing engines in `app/src/lib/daw/*`.
2. A **shared AI core** (`packages/ai/`) that any current or future MMO app (web, Tauri desktop, Android, browser extension, server companion) consumes through one stable API.
3. A **`/settings/copilot` page** that supports BYO‑keys for OpenAI / Anthropic / Google / Mistral / Groq / Azure **and** a **GitHub Copilot connection via Device Code Flow** (same mechanism VS Code uses) to list and use the user's Copilot models.
4. A **generative sound/sample/loop/track/song engine** built entirely from open models we host:
   - Local DSP (Web Audio + AudioWorklet + WASM/Faust) for instant, sub‑100 ms generation of one‑shots, drum hits, loops, MIDI patterns.
   - Local heavy models via the **companion** (MusicGen, Stable Audio Open) for samples/loops/short tracks.
   - **MMO-owned remote workers** (Cloud Run + GPU pool the user provisions) for the same models at higher throughput.
   - **No third-party music APIs** (Suno/Udio/ElevenLabs/Replicate) wired in — MMO is the platform; others integrate with us, not vice-versa.
5. A **first‑class AI Agent ("Maestro")** that can read full DAW state, plan, call tools (create track, generate clip, set FX, schedule notes, render, etc.), explain itself, and produce reversible edits — inspired by REAPER's DAWZY (arXiv 2512.03289) but native to MMO.

This document is the single source of truth for the refactor. Smaller per‑phase docs will live under `docs/followups/ai-daw/`.

---

## 1. North star & non‑negotiables

| # | Principle | Why |
|---|-----------|-----|
| N1 | **DAW must be fully usable without AI.** AI is an accelerator, never a hard dependency. | Offline‑friendly, regulatory safety, low latency. |
| N2 | **Every AI action is reversible** (undo/redo + diff preview before commit). | DAWZY pattern; trust + safety. |
| N3 | **Shared `@mmo/ai` core**, never duplicate provider/model glue per app. | Future apps (mobile, extension) reuse same surface. |
| N4 | **BYO keys + Copilot device-code** — no MMO‑owned proxy by default. Optional managed tier later. | Cost, privacy, license clarity. |
| N5 | **Tool calling > chat.** Agent operates the DAW through a typed tool registry, not by writing free‑text. | Determinism + auditability. |
| N6 | **Local‑first generation** for sub‑bar latency things (one‑shot, drum, MIDI). Remote only for songs/stems. | Snappy creative flow. |
| N7 | **Romanian + English** UI for everything user‑facing (project already i18n via `next-intl`). | Existing convention. |
| N8 | **Drizzle‑first schema** for all new persistence. Cache Components + Server Actions for all reads/writes. | Matches Next.js 16 stack already in repo. |
| N9 | **Animated, modern, dark, "studio rack" aesthetic** with framer-motion + View Transitions. No layout jank during agent edits. | UX bar. |
| N10 | **No commercial AI‑music model trained on copyrighted audio is shipped by default.** User opts in per provider with a clear disclaimer (license-clarity matters — Udio/Suno are murky, ElevenLabs/Stable Audio are clean). | Legal. |

---

## 2. Current state (from codebase map)

Verified via session-memory map (`/memories/session/mmo-codebase-map.md`):

### 2.1 What already works
- **Engines:** `DAWEngine`, `MixerEngine` (4 decks), `EQEngine`, `LiveEngine`, `AudioFxEngine`, `StemsEngine`.
- **23 DAW components** including timeline, piano roll, mixer, step sequencer, effects rack, browser, export.
- **Transport, history (undo/redo), clipboard, snapshots.**
- **MIDI engine** + drivers for DDJ‑FLX4, Circuit Tracks, generic MIDI keyboards.
- **6 LLM providers** (OpenAI / Anthropic / Gemini / Mistral / Groq / Azure) — keys are AES‑256‑GCM encrypted.
- **Auth.js v5** + Drizzle adapter, Google + GitHub (repo scope) providers.
- **Tagging AI** via `suggestTrackTags()` / `bulkSuggestAndApplyTags()`.
- **Audio analysis sidecar (Python):** BPM/key/loudness/fingerprint via librosa/pyloudnorm/pyacoustid in `server/python/`.
- **shadcn/ui** (20 components), **framer-motion 12.38**, **dockview 5.2**, **next-intl 4.0.2**.

### 2.2 Identified gaps (the work)

| Gap | File / area | Status |
|---|---|---|
| Piano-roll lacks drum-kits UI | `app/src/components/daw/piano-roll/*` | synth‑only |
| Builder AI mode (smart playlists) schema ready, inference not wired | `app/src/lib/ai/builder.ts` (?) | stub |
| No GitHub Copilot device-code flow | `app/src/lib/ai/providers/*` | missing |
| No agent / tool-calling layer | nowhere | missing |
| No generative audio / sample / loop engine | nowhere | missing |
| Video schema present, playback minimal | `app/src/lib/video/*` | minimal |
| Yjs collab infra present, real-time DAW sync untested | `infra/yjs-relay/` | untested |
| `apps/native/` and `apps/extension/` mostly stubs | — | stubs |
| No automation lanes / parameter automation on tracks | DAW | missing |
| No bounce / freeze / render to file beyond simple export | DAW | partial |
| No VST / CLAP host bridge from companion | `server/` | missing |
| No `packages/ai` shared workspace package | repo root | missing |

---

## 3. Target architecture

### 3.1 New / changed top‑level layout

```
mmo/
├── packages/
│   ├── ai/                    ← NEW shared core
│   │   ├── src/
│   │   │   ├── providers/     ← openai, anthropic, gemini, mistral, groq, azure, copilot
│   │   │   ├── models/        ← model registry + capability flags
│   │   │   ├── agent/         ← Maestro: planner, tool runtime, memory, traces
│   │   │   ├── tools/         ← typed tool definitions (Zod-validated)
│   │   │   ├── prompts/       ← shared prompt templates, versioned
│   │   │   ├── rag/           ← embeddings, vector store adapters
│   │   │   └── settings/      ← role→model mapping (chat/agent/tag/generate/embedding)
│   │   └── package.json
│   ├── audio-gen/             ← NEW generative audio core (WASM/Worklets)
│   │   ├── src/
│   │   │   ├── synth/         ← FM, additive, subtractive, wavetable, granular
│   │   │   ├── drum/          ← 808/909/linear drum synth, kit randomizer
│   │   │   ├── loop/          ← bar-level loop generator (chord+rhythm)
│   │   │   ├── midi/          ← motif/chord/bassline/melody generators
│   │   │   └── render/        ← OfflineAudioContext + WAV encode
│   ├── ui/                    ← NEW shared shadcn-based primitives (optional split)
│   └── db/                    ← move existing drizzle/* here (optional, later)
├── app/                       ← Next.js 16 web (uses packages/*)
├── server/                    ← Electron companion (uses packages/ai for local agent + DSP bridge)
├── apps/native/               ← Tauri desktop
└── apps/extension/            ← browser ext
```

> We can ship `packages/ai` and `packages/audio-gen` first without touching `db` move; the `db` migration is optional and low priority.

### 3.2 `@mmo/ai` public surface (sketch)

```ts
// packages/ai/src/index.ts
export { createAI } from "./client";          // factory bound to user session
export type { AIClient } from "./client";

export { ProviderRegistry } from "./providers";
export { ModelRegistry, ModelRole } from "./models";
// ModelRole = 'chat' | 'agent' | 'tag' | 'embed' | 'vision' | 'audio-caption' | 'lyrics'

export { Maestro } from "./agent";            // the music agent
export { ToolRegistry, defineTool } from "./tools";
export { useCopilot } from "./react";         // React hook bound to AIClient

// Convenience
export { generateText, generateObject, streamText, streamObject } from "./facade"; // proxies to Vercel AI SDK
```

Under the hood we use **Vercel AI SDK v5** (`generateText`, `streamText`, multi‑step tools) — it already abstracts OpenAI/Anthropic/Google/Mistral/Groq/Azure and we add a **`copilot` provider** that wraps the Copilot token + Copilot API base URL (`https://api.githubcopilot.com/`).

### 3.3 Role → model mapping (persisted per user)

| Role | Purpose | Default |
|------|---------|---------|
| `chat` | UI chat side‑panel | `gpt-5-mini` (or Copilot equiv) |
| `agent` | Maestro tool-calling planner | `claude-sonnet-4.5` (or Copilot equiv) |
| `tag` | Track tagging / classification | `gpt-5-nano` |
| `embed` | RAG embeddings | `text-embedding-3-large` |
| `vision` | Album-art / waveform vision | `gpt-5-mini` |
| `audio-caption` | Audio → text description | `whisper-1` / clap |
| `lyrics` | Lyrics generation | `claude-sonnet-4.5` |
| `music-full` | Full song generation | `musicgen-large` (companion or remote worker) |
| `music-loop` | Short loop generation | `stable-audio-open-1.0` (companion or remote worker) |
| `music-stem` | Stem generation | `musicgen-stereo-melody` (companion or remote worker) |
| `music-vocal` | Vocal stem | local Coqui-XTTS / Bark variant (companion); deferred if no good license-clean option lands |

Stored in `user_ai_settings` (new table). UI lives at `/settings/copilot`.

---

## 4. `/settings/copilot` page

### 4.1 Layout (dockview tabs / shadcn tabs)

1. **Accounts** — list provider connections with status pills (Connected / Not connected / Expired).
   - For each: API‑key input (masked), test button, delete button.
   - **GitHub Copilot** card: "Connect with GitHub" button → starts device-code flow.
2. **Models** — full table of every model the user has access to across all connected providers, with columns: provider, model id, context window, modalities, cost (if known), capability flags.
3. **Roles** — assign default model per role (see 3.3) with combobox per row.
4. **Agent** — Maestro settings: max steps, max tool calls per step, allow file system?, allow web?, allow audio render?, allow destructive ops?, voice input on/off, autonomy slider (`ask | propose | auto`).
5. **Generation** — generative music defaults: preferred lyrics model, preferred song model, preferred sample/loop model, default tempo/key bias, NSFW filter, license filter ("commercial‑clean only").
6. **Privacy & Telemetry** — toggle "share prompts with provider", "save traces", "redact PII", "encrypt at rest" (always on).
7. **Usage** — per-provider counters (calls, tokens, cost estimate, quota left for Copilot).

### 4.2 GitHub Copilot device-code flow

Reproduces the same flow used by GitHub CLI / VS Code Copilot:

```
POST https://github.com/login/device/code
  client_id=<COPILOT_CLIENT_ID>   ← public client id for VS Code Copilot family
  scope=read:user

→ { device_code, user_code, verification_uri, interval, expires_in }

Show user_code + open verification_uri in browser.

Poll: POST https://github.com/login/oauth/access_token
  client_id=<COPILOT_CLIENT_ID>
  device_code=<...>
  grant_type=urn:ietf:params:oauth:grant-type:device_code

→ { access_token, token_type, scope }   ← this is the OAuth token

Exchange for Copilot session token:
GET https://api.github.com/copilot_internal/v2/token
  Authorization: Bearer <access_token>
  Editor-Version: MMO/0.1
  Editor-Plugin-Version: copilot/0.1

→ { token, expires_at, refresh_in, endpoints: { api: "https://api.githubcopilot.com" }, ... }

List models:
GET {endpoints.api}/models
  Authorization: Bearer <copilot_session_token>
  Copilot-Integration-Id: vscode-chat
  Editor-Version: MMO/0.1

→ { data: [{id, name, vendor, capabilities, ...}] }

Chat completion (OpenAI-compatible):
POST {endpoints.api}/chat/completions
  Authorization: Bearer <copilot_session_token>
  Copilot-Integration-Id: vscode-chat
  Editor-Version: MMO/0.1
  body: standard OpenAI chat-completions JSON
```

We must show the user the **legal disclaimer** ("personal use only, not a resale service, your account may be restricted by GitHub if you violate AUP") and require explicit consent before storing tokens. Tokens stored AES‑256‑GCM encrypted (existing helper).

### 4.3 New tables (Drizzle)

```ts
export const aiProviderConnection = pgTable("ai_provider_connection", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text().notNull(),  // 'openai' | 'anthropic' | ... | 'copilot'
  // For BYO keys:
  encKey: bytea(),             // AES-GCM ciphertext
  encIv: bytea(),
  encTag: bytea(),
  // For copilot OAuth:
  encOauthToken: bytea(),
  encSessionToken: bytea(),
  sessionExpiresAt: timestamp({ withTimezone: true }),
  endpointsJson: jsonb(),
  // Meta
  label: text(),               // user-set label
  status: text().notNull().default("active"),  // active | expired | revoked
  createdAt: timestamp({ withTimezone: true }).defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow(),
}, (t) => [uniqueIndex().on(t.userId, t.provider, t.label)]);

export const aiModelChoice = pgTable("ai_model_choice", {
  userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text().notNull(),      // 'chat' | 'agent' | 'tag' | ...
  provider: text().notNull(),
  modelId: text().notNull(),
  paramsJson: jsonb(),         // temperature, top_p, etc.
}, (t) => [primaryKey({ columns: [t.userId, t.role] })]);

export const aiAgentSession = pgTable("ai_agent_session", { ... });
export const aiAgentMessage = pgTable("ai_agent_message", { ... });
export const aiAgentToolCall = pgTable("ai_agent_tool_call", { ... });
```

---

## 5. Maestro — the music agent

### 5.1 Anatomy

```
User prompt (text or voice)
        │
        ▼
  Context builder ────► Project snapshot, selected track, transport state,
        │                last N edits, role-based system prompt
        ▼
   Planner (LLM)  ───► JSON plan: ordered tool calls with rationale
        │
        ▼
   Tool runtime  ────► Executes tools sequentially; each tool emits a
        │              DAW patch (diff) AND a human-readable description
        ▼
   Preview / Auto ──► If autonomy=ask: show diff modal, wait for accept.
        │              If autonomy=propose: apply but show toast w/ undo.
        │              If autonomy=auto: apply silently, log.
        ▼
   Reflexion  ──────► Listen back (render preview), self-grade, optional retry.
```

### 5.2 Tool catalogue (v1)

Grouped by domain. Each tool is `defineTool({ name, description, zodSchema, execute })`.

**Project & transport**
- `project.create`, `project.open`, `project.save`, `project.export`
- `transport.play`, `transport.stop`, `transport.setBpm`, `transport.setTimeSignature`, `transport.toggleLoop`, `transport.setLoop`

**Tracks**
- `track.create`(kind: audio|midi|return|group)
- `track.delete`, `track.rename`, `track.setColor`, `track.duplicate`
- `track.setVolume`, `track.setPan`, `track.setMute`, `track.setSolo`
- `track.addSend`, `track.setSendAmount`

**Clips**
- `clip.create` (audio|midi, start, length)
- `clip.delete`, `clip.move`, `clip.resize`, `clip.split`, `clip.duplicate`
- `clip.setFadeIn`, `clip.setFadeOut`
- `clip.setNotes` (MIDI)

**FX / instruments**
- `fx.add`(trackId, instrument), `fx.remove`, `fx.setParam`, `fx.reorder`
- `instrument.setPreset`, `instrument.randomize`

**Automation**
- `automation.addLane`, `automation.setPoint`, `automation.clearLane`

**Generative**
- `generate.oneShot`({ kind: 'kick'|'snare'|'hat'|'bass'|'lead'|..., character, length }) → audio file id
- `generate.drumLoop`({ bars, genre, swing }) → MIDI + audio
- `generate.bassline`({ key, mode, bars, density, style }) → MIDI
- `generate.chordProgression`({ key, mode, bars, mood, complexity }) → MIDI
- `generate.melody`({ key, mode, scale, motif, bars }) → MIDI
- `generate.sample`({ description, length, bpmLock }) → audio (local Stable Audio / MusicGen)
- `generate.song`({ lyrics?, style, durationSec, vocals }) → audio (Suno/Udio/MusicGen)
- `generate.stem`({ part: 'drums'|'bass'|'vocals'|'other', refClipId? }) → audio
- `generate.lyrics`({ topic, language, style, structure }) → text
- `generate.coverArt`({ description }) → image (optional later)

**Analysis**
- `analyze.bpm`, `analyze.key`, `analyze.loudness`, `analyze.stems`, `analyze.caption`(clip → text), `analyze.similar`(clip → library matches)

**Library / file**
- `library.search`(query) → tracks
- `library.import`(path|url)
- `file.bounce`(trackId|range) → wav/mp3

**Meta**
- `agent.ask`(question to user — pauses agent)
- `agent.thought`(internal note — not user-visible)

### 5.3 Safety guard‑rails
- Hard whitelist; tools outside the registry are ignored.
- `destructive=true` tools (delete, clear, overwrite) need confirmation unless autonomy=auto **and** the action is reversible via history engine.
- Every tool call writes a row in `aiAgentToolCall` with input, output, latency, model, cost estimate.
- Per-session token & cost cap (configurable).

---

## 6. Generative audio engine (`packages/audio-gen`)

### 6.1 Tiers

| Tier | Latency | Where | Models / tech |
|------|---------|-------|---------------|
| T0 — instant | <50 ms | Browser (AudioWorklet + WASM) | DSP: subtractive/FM/wavetable/granular synth; drum synth; rule-based MIDI generators (Markov + music21-like) |
| T1 — fast | <2 s  | Browser (WebGPU) or local companion | Small diffusion: Stable Audio Open (tiny), Riffusion-style spectrogram diffusion. |
| T2 — medium | 5–60 s | Companion sidecar or remote GPU | MusicGen (small/medium), Stable Audio Open full, ACE-Step |
| T3 — heavy | 30 s – 5 min | Remote API | Suno, Udio, ElevenLabs Music, DiffRhythm, MusicGen-large |

### 6.2 What T0 gives us (instant, no model)
- **Drum kit synth** (808/909/linear) with parameter randomization per genre → "make me a techno kit" returns 10 layered one-shots in <200 ms.
- **Polyphonic subtractive + FM synth** with preset bank (lead, pad, pluck, bass).
- **Granular sampler** for "stretch this clip 2× without pitch change".
- **MIDI generators** (Markov chains + music-theory rules) for chord progression / bassline / melody / drum patterns conditioned on key+BPM+genre.
- **Loop builder**: combine MIDI generators → render with synths → WAV → drop as clip in <500 ms.

### 6.3 What T1–T3 add
- Text→sample, text→loop, text→song.
- Stem extraction (already in Python sidecar via `audio-separator`).
- Vocal synthesis (ElevenLabs / Suno).
- Mastering (Matchering style — also pip-installable in sidecar).

### 6.4 Render pipeline
- All generative tools return either a **MIDI patch** (applied to a track) or an **audio file** (stored in `data/generated/<uuid>.wav`) **plus a manifest** (model, params, prompt, seed, license, cost) saved alongside.
- Files are content-addressed so re-generation with same seed+params is free.

---

## 7. DAW completion checklist

Beyond what already exists:

- [ ] Drum-kit piano-roll mode (pads grid + per-pad sample slot)
- [ ] Per-track automation lanes (volume, pan, send, every FX param)
- [ ] Sidechain compression UI on FX chain
- [ ] Bus / group tracks (currently only return tracks)
- [ ] Freeze / bounce track to audio (in-place render)
- [ ] Time-stretch + pitch-shift on audio clips (granular T0)
- [ ] Warp markers (Ableton-style) on audio clips
- [ ] Comping (multiple takes → best-of)
- [ ] Tempo automation (tempo map)
- [ ] Marker / arrangement section labels
- [ ] Crossfade editor on overlapping clips
- [ ] Score view (notation render of MIDI) — optional
- [ ] Project versioning UI (snapshots already exist, expose as “versions” tab)
- [ ] Export stems as zip
- [ ] Real-time collab via Yjs (already infra'd, finish hookup) — optional v2

---

## 8. UI / motion language

- Base aesthetic already dark, neon-on-charcoal — keep.
- Standardize **View Transitions** (React 19.2) for: route changes, panel open/close, agent "diff apply" animations.
- **framer-motion** for: gain/knob micro-interactions, mixer fader inertia, agent thought bubbles, tool-call cards sliding into a "trace" panel.
- New global **AgentDock** component: bottom-right floating dock that expands into a chat + plan + trace view. Reachable from any page (`/music`, `/mixer`, `/editor`, `/visualizations`, `/library`).
- Agent shows **typed-out plan** then **per-tool progress chips**; failed tools turn red with "retry / explain / abort".
- Color tokens already in `tailwind.config` — extend with `--ai-accent` (cyan) for AI surfaces vs `--rec-accent` (red) for recording surfaces.

---

## 9. Phased roadmap (single sprint, multi-PR)

Phases are sequential within the same long-running implementation pass; each phase is committable on its own.

| # | Name | Outcome |
|---|------|---------|
| **P0** | Workspace prep | `packages/ai`, `packages/audio-gen` scaffolded; pnpm workspaces wired; existing `app/src/lib/ai/*` re-exports from package shim (no breakage). |
| **P1** | Provider unification | Refactor existing 6 providers into `@mmo/ai/providers`, behind Vercel AI SDK v5; existing tag-suggestion features keep working. |
| **P2** | Copilot connector | Implement GitHub device-code flow + Copilot token exchange + model list. New Drizzle tables + migration. |
| **P3** | `/settings/copilot` UI | Accounts, Models, Roles tabs. |
| **P4** | Agent runtime | `Maestro` planner, tool registry, trace store, AgentDock UI. Ship with project/transport/track/clip tools. |
| **P5** | Generative T0 | `audio-gen` instant synths, drum kits, MIDI generators, loop builder. Wire `generate.*` tools to agent. |
| **P6** | DAW gap pack 1 | Automation lanes, drum-kit piano-roll, freeze/bounce, crossfades. |
| **P7** | Generative T1/T2 | Local Stable Audio Open via companion + WebGPU (if available); MusicGen via companion sidecar. |
| **P8** | Generative T3 | Suno/Udio/ElevenLabs/Riffusion remote connectors (opt-in per provider). Lyrics + cover art + full-song. |
| **P9** | DAW gap pack 2 | Warp markers, comping, tempo automation, stems export. |
| **P10** | Settings polish + telemetry | Usage dashboard, cost caps, trace export. |
| **P11** | Cross-app reuse | Wire `@mmo/ai` into `server/` (companion CLI agent) and `apps/native` (Tauri). Extension can use shared chat via web bridge. |
| **P12** | Collab + Yjs DAW sync (optional) | Multi-user editing of timeline. |

---

## 10. Risks & decisions needed

1. **License risk** with Suno/Udio outputs. → Default policy = "personal use only, no upload to streaming" until user accepts per-provider terms.
2. **Copilot ToS** — GitHub may rate-limit / revoke accounts used by third-party clients. We must disclose this. Personal use only.
3. **Local model size** — MusicGen-medium ~3.3 GB, Stable Audio Open ~1.1 GB. Need a download manager in companion.
4. **WebGPU availability** — fallback to companion sidecar when missing.
5. **Cost runaway** — agent must enforce per-session and per-day caps.
6. **Audio latency under load** — render generative audio on a worker, never on main thread.
7. **Schema migration risk** — new AI tables are additive, safe; only one move (legacy AI table → new) needs care.

---

## 11. Out of scope for this pass (deliberately deferred)

- VST/CLAP plugin hosting in browser (huge effort; companion bridge can come later).
- Mobile native audio capture (Android Tauri build) — keep as future work.
- Marketplace for shared presets / agent skills.
- Third-party music-vendor connectors (Suno, Udio, ElevenLabs, Replicate). MMO does not consume them.

## 12. Open questions for the user

See `docs/followups/ai-daw/round-1-questions.md` (mirrored to the askQuestions tool).

## 13. Platform façade — how other projects consume MMO AI

Follows directly from the round-1 reframe ("I want others to wire MMO to their projects").

### 13.1 Three façades over the same `@mmo/ai` core

```
┌────────────────────────────────────────────────────────────────┐
│                       @mmo/ai (core lib)                       │
│  providers • models • Maestro agent • tools • prompts • rag    │
└──────────────┬──────────────────┬──────────────────┬───────────┘
               │                  │                  │
        in-process              MCP            HTTP / SSE
               │                  │                  │
        ┌──────▼──────┐    ┌──────▼──────┐    ┌──────▼──────────┐
        │  app/       │    │ @mmo/ai-mcp │    │ /api/ai/*       │
        │  server/    │    │ stdio + HTTP│    │ + /api/agent/*  │
        │  apps/*     │    │ for Claude, │    │ PAT-scoped REST │
        │             │    │ Cursor, VSC │    │ for any client  │
        └─────────────┘    └─────────────┘    └─────────────────┘
```

### 13.2 MCP server (`packages/ai-mcp`)

- Implements the **Model Context Protocol** (Anthropic standard, now adopted by Cursor, VS Code, Claude Desktop, OpenAI ChatGPT desktop).
- Exposes the same **Maestro tool catalogue** (project/track/clip/fx/generate/analyze/library) as MCP tools.
- Two transports: **stdio** (desktop integration) and **HTTP/SSE** (web/remote integration).
- Auth: per-user PAT issued from `/settings/copilot → Developer → Tokens`.
- Scopes: `daw:read`, `daw:write`, `generate:audio`, `generate:midi`, `library:read`, `library:write`.

### 13.3 REST + SSE API (`/api/ai/*`, `/api/agent/*`)

- Mirrors MCP tool calls 1:1 as POST endpoints.
- Streams agent runs over SSE (Vercel AI SDK `toDataStreamResponse`).
- OpenAPI 3.1 spec auto-generated from Zod tool schemas (zod → OpenAPI).
- Rate-limit + cost-cap per PAT.

### 13.4 TypeScript SDK (`packages/sdk`)

- Tiny client (`new MmoClient({ baseUrl, token })`) wrapping REST + SSE.
- Same shape as in-process `@mmo/ai` for drop-in replacement.
- Bundled `<400 kB`, ESM-only, zero React dependency.

### 13.5 Tier matrix for compute

| Tier | Runs on | When chosen |
|------|---------|-------------|
| **In-browser (T0–T1)** | WebGPU + WASM | Always available; instant; default for one-shots & MIDI gen. |
| **Companion local (T2)** | Electron + Python sidecar | When user has companion installed and toggled "prefer local" — heavier models, zero cost. |
| **MMO remote worker (T2–T3)** | Cloud Run + optional GPU (RunPod/GCP) the user provisions | When companion absent or queue full, or for batch jobs. User holds the secrets; we never proxy by default. |

No path requires a third-party music vendor.

---

## 12. Open questions for the user

See `docs/followups/ai-daw/round-1-questions.md` (mirrored to the askQuestions tool).
