# Maestro Training Platform — Master Plan

> **Goal**: turn Maestro from a chat assistant into a self‑improving music‑producer
> agent that learns from the user's library, the user's feedback, and curated
> public datasets — and that the user can supervise (start jobs, see live progress,
> adjust hyperparameters mid‑flight) from a dedicated **Training** page.
>
> Status: drafted 2026‑05‑20. Owner: Maestro + user (in‑the‑loop).

---

## 0. TL;DR

1. **Multi‑model serving** — ACE‑Step 1.5 stays primary; add YuE 7B and Stable Audio
   Open 1.5 as secondary engines selected by Maestro based on the prompt.
2. **Six training tracks**, all funneling into the same control plane:
   - `style-lora` — per‑genre LoRA on curated public datasets (FMA, MTG‑Jamendo)
   - `user-lora` — per‑user LoRA on their MMO library + thumbs‑up generations
   - `conductor-sft` — Maestro LLM SFT on prompt → ACE‑Step blueprint pairs
   - `conductor-dpo` — preference DPO from clip thumbs (winner/loser pairs)
   - `acestep-dpo` — direct DPO on the diffusion model from `(prompt, A, B, choice)`
   - `stem-aware` — fine‑tune to generate matching drums‑given‑bass etc.
3. **Control plane** = `dawProjects`‑style: Postgres row per job + Cloud
   Storage artifacts + Pub/Sub → SSE to the browser. Maestro reads from
   the same row and may patch it (LR, dataset weights, early‑stop) while the
   trainer polls a `controlSignal` column every N steps.
4. **Two new pages**:
   - `/training` — job table, live charts, sample auditions, action buttons
   - `/training/datasets` — dataset builder (drag music in, auto‑caption, preview)
5. **Maestro additions**: 11 new tools (`training.*`, `dataset.*`, `loras.*`,
   `feedback.*`) gated by a new `ai.agent.allowTraining` scope.
6. **Cost ceiling**: $500/mo on Vertex A100 spot + L4 on‑demand for inference,
   hard‑stopped by a `monthlyBudgetUsd` setting that Maestro must respect.

---

## 1. Why Maestro produces "completely different genres" today

Triaged from current code:

- `app/src/actions/generate.ts → callAceStep()` passes the raw user prompt straight
  to ACE‑Step. The model sees free‑form text, has no structure tags, no BPM/key
  enforcement, no negative tags.
- No reference‑track conditioning — `cover.wav` path is wired in the sidecar but
  the DAW never sends a reference even when one is selected.
- Library tracks are scanned but **not embedded**, so Maestro can't find a "track
  that sounds like what the user is asking for" to inform the prompt.
- No feedback signal — thumbs in the UI go to a feedback table that nothing
  trains on.
- The system prompt (`app/src/lib/maestro/system-prompt.ts`) tells Maestro
  *what tools exist* but not *how to write a music prompt* (no genre/structure
  taxonomy, no negative‑prompt heuristics, no BPM/key reasoning).

**All six are fixed in this plan.**

---

## 2. Architecture (5 layers)

```
┌─────────────────────────────────────────────────────────────────────┐
│  L1  CLIENT                                                         │
│  /training page · /training/datasets · DAW + Maestro chat           │
└──────────────┬──────────────────────────────────────┬───────────────┘
               │  Server Actions + SSE                │
┌──────────────▼──────────────────────────────────────▼───────────────┐
│  L2  APP (Next.js 16, app/)                                         │
│  • actions/training.ts  • actions/datasets.ts                       │
│  • lib/maestro/tools.ts (+ training tools)                          │
│  • api/training/events/[jobId]/route.ts (SSE)                       │
└──────────────┬──────────────────────────────────────┬───────────────┘
               │  Postgres (dawProjects.db)           │  GCS
┌──────────────▼─────────────────┐    ┌───────────────▼───────────────┐
│ L3  CONTROL PLANE              │    │ L4  DATA PLANE                │
│ trainingJobs  trainingEvents   │    │ gs://mmo-training-prod/       │
│ trainingDatasets  loraAssets   │    │   datasets/<dsId>/...         │
│ generationFeedback             │    │   jobs/<jobId>/output/...     │
│ controlSignals (LR, stop, …)   │    │   loras/<userId>/<name>.ckpt  │
└──────────────┬─────────────────┘    └───────────────┬───────────────┘
               │  Pub/Sub topic "training-events"     │
┌──────────────▼──────────────────────────────────────▼───────────────┐
│  L5  GPU WORKERS (Vertex AI Custom Jobs, spot A100 / L4)            │
│  trainer.py — reads dataset, writes events to Pub/Sub every N steps │
│  inference — Cloud Run L4 GPU services (ace-step / yue / sao)       │
└─────────────────────────────────────────────────────────────────────┘
```

### Why this shape

- **Postgres‑centric**: avoids running a separate scheduler (Airflow/Prefect).
  A polling loop in the trainer is enough for live control because runs are
  short (≤4h) and we only need second‑level latency for `pause` / `change‑lr`.
- **GCS for everything > 64KB**: audio, checkpoints, peaks, tensorboard event
  files. App reads via signed URLs.
- **Pub/Sub → SSE**: trainer pushes `step`, `loss`, `sample` events to a topic;
  a thin Cloud Run forwarder bridges them onto an SSE stream per `jobId`.

---

## 3. Database schema (additions to `app/src/db/schema-*.ts`)

```ts
// new file: app/src/db/schema-training.ts

export const trainingDatasets = pgTable("training_datasets", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  externalId: text("external_id").notNull().unique(),       // ds_<nanoid>
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").$type<"style" | "user-library" | "preference" | "stem">().notNull(),
  status: text("status").$type<"draft" | "processing" | "ready" | "failed">().notNull().default("draft"),
  itemCount: integer("item_count").notNull().default(0),
  totalSeconds: doublePrecision("total_seconds").notNull().default(0),
  gcsPrefix: text("gcs_prefix").notNull(),                  // gs://mmo-training-prod/datasets/<extId>/
  manifest: jsonb("manifest").$type<DatasetManifest>().notNull().default({} as any),
  tagsHistogram: jsonb("tags_histogram").$type<Record<string, number>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const trainingDatasetItems = pgTable("training_dataset_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  datasetId: bigint("dataset_id", { mode: "number" }).notNull().references(() => trainingDatasets.id, { onDelete: "cascade" }),
  source: text("source").$type<"library" | "generated" | "uploaded" | "public">().notNull(),
  sourceRef: text("source_ref").notNull(),                  // tracks.id or generation id or URL
  audioGcsUri: text("audio_gcs_uri").notNull(),
  promptText: text("prompt_text").notNull(),                // auto‑captioned, editable
  lyricsText: text("lyrics_text"),
  durationSec: doublePrecision("duration_sec").notNull(),
  bpm: doublePrecision("bpm"),
  keyName: text("key_name"),
  excluded: boolean("excluded").notNull().default(false),
  weight: doublePrecision("weight").notNull().default(1.0), // multiplied with sample weight at train time
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const trainingJobs = pgTable("training_jobs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  externalId: text("external_id").notNull().unique(),       // job_<nanoid>
  userId: text("user_id").notNull(),
  datasetId: bigint("dataset_id", { mode: "number" }).references(() => trainingDatasets.id),
  baseModel: text("base_model").$type<"acestep-1.5" | "acestep-1.5-xl" | "yue-7b">().notNull(),
  trackKind: text("track_kind").$type<
    "style-lora" | "user-lora" | "conductor-sft" | "conductor-dpo" | "acestep-dpo" | "stem-aware"
  >().notNull(),
  status: text("status").$type<
    "pending" | "running" | "paused" | "succeeded" | "failed" | "cancelled"
  >().notNull().default("pending"),
  vertexJobName: text("vertex_job_name"),                   // projects/.../customJobs/123
  consoleUrl: text("console_url"),
  config: jsonb("config").$type<TrainConfig>().notNull(),   // see section 4
  controlSignal: jsonb("control_signal").$type<ControlSignal>(), // Maestro / user patches go here; trainer polls
  progress: jsonb("progress").$type<TrainProgress>().notNull().default({ step: 0, totalSteps: 0 } as any),
  metricsSummary: jsonb("metrics_summary").$type<MetricsSummary>(),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const trainingEvents = pgTable("training_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  jobId: bigint("job_id", { mode: "number" }).notNull().references(() => trainingJobs.id, { onDelete: "cascade" }),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  kind: text("kind").$type<"step" | "eval" | "sample" | "log" | "milestone" | "checkpoint" | "error">().notNull(),
  payload: jsonb("payload").notNull(),                      // { loss, lr, sampleGcsUri, ... }
});

export const loraAssets = pgTable("lora_assets", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  externalId: text("external_id").notNull().unique(),       // lora_<nanoid>
  userId: text("user_id").notNull(),
  jobId: bigint("job_id", { mode: "number" }).references(() => trainingJobs.id),
  name: text("name").notNull(),
  baseModel: text("base_model").notNull(),
  gcsUri: text("gcs_uri").notNull(),                        // gs://.../<name>.safetensors
  rank: integer("rank").notNull(),
  defaultWeight: doublePrecision("default_weight").notNull().default(0.8),
  tags: text("tags").array().notNull().default([] as any),
  isPublic: boolean("is_public").notNull().default(false),
  evalScore: doublePrecision("eval_score"),                 // automated reward score (0..1)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const generationFeedback = pgTable("generation_feedback", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: text("user_id").notNull(),
  generationId: text("generation_id").notNull(),            // matches actions/generate.ts result id
  prompt: text("prompt").notNull(),
  audioGcsUri: text("audio_gcs_uri"),
  rating: integer("rating").notNull(),                       // -1, 0, +1
  detail: jsonb("detail").$type<FeedbackDetail>(),           // { tooSlow?, wrongGenre?, badVocals?, ... }
  pairedAgainst: text("paired_against"),                     // generationId of the "loser" if A/B
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

All five tables are migrations behind the standard Drizzle flow
(`pnpm db:generate` → `pnpm db:migrate`). RLS already enforces `userId` scoping
via the existing `mmo_user_id` JWT claim — no new policies needed beyond
copy‑paste of the `dawProjects` ones.

---

## 4. Training‑job config & control signals

```ts
export interface TrainConfig {
  baseModel: "acestep-1.5" | "acestep-1.5-xl" | "yue-7b";
  // LoRA hyperparameters
  rank: number;                                  // 8 | 16 | 32 | 64
  loraAlpha: number;                             // typically 2 × rank
  targetModules: string[];                       // ["linear_q", "linear_k", ...]
  // Optimiser
  optimizer: "adamw" | "adamw8bit" | "lion";
  lr: number;                                    // 1e‑4 default for rank 16
  lrSchedule: "cosine" | "constant" | "warmup-cosine";
  warmupSteps: number;
  weightDecay: number;
  // Schedule
  maxSteps: number;
  evalEverySteps: number;                        // sample audio every N steps
  saveEverySteps: number;
  batchSize: number;                             // micro‑batch; grad accum auto‑set
  // Data
  repeatCount: number;
  audioMaxSeconds: number;                       // 30 typical, 240 max
  // Compute
  machineType: string;                           // "a2-highgpu-1g"
  acceleratorType: "NVIDIA_TESLA_A100" | "NVIDIA_L4" | "NVIDIA_H100_80GB";
  acceleratorCount: number;
  spot: boolean;
  timeoutHours: number;
  // Guardrails
  monthlyBudgetUsd: number;
  killAboveLoss: number;                         // if loss diverges, auto‑stop
}

export interface ControlSignal {
  /** Trainer polls this every saveEverySteps and applies if `appliedAt` is null. */
  patchId: string;                               // nanoid; trainer writes back appliedAt
  appliedAt?: string;
  origin: "user" | "maestro";
  // Mutable knobs (set any subset)
  lr?: number;
  pause?: boolean;
  stop?: boolean;
  dropoutP?: number;
  datasetWeights?: Array<{ itemId: number; weight: number }>;
  earlyStop?: { metric: "eval_loss" | "user_reward"; patience: number };
  message?: string;                              // freeform reasoning shown in UI
}

export interface TrainProgress {
  step: number;
  totalSteps: number;
  epoch?: number;
  loss?: number;
  lr?: number;
  evalLoss?: number;
  etaSec?: number;
  gpuUtilPct?: number;
  vramGb?: number;
  lastSampleGcsUri?: string;
  lastSampleAt?: string;
}
```

The same `ControlSignal` is the contract between Maestro and the trainer.
`controlSignal` is a *single* JSONB column (latest patch only); a full audit
trail goes into `trainingEvents` with `kind = "log"`. Trainer flow:

```python
# trainer.py – pseudo
while step < cfg.max_steps:
    train_step(...)
    if step % cfg.save_every_steps == 0:
        ctrl = control_table.fetch(job_id)          # one Postgres SELECT
        if ctrl and not ctrl.applied_at:
            apply_patch(ctrl)
            control_table.mark_applied(ctrl.patch_id)
        emit_event("step", { step, loss, lr, gpu })
        if (step % cfg.eval_every_steps) == 0:
            wav = render_sample(eval_prompt)
            upload(wav, gs_uri)
            emit_event("sample", { gcsUri: gs_uri })
    if early_stop_triggered():
        break
```

---

## 5. Data plane — datasets

### 5.1 Sources (all allowed per user)

| Source              | Auto‑included? | Captioning              | Notes                              |
|---------------------|---------------:|-------------------------|------------------------------------|
| User MMO library    | opt‑in        | LP‑MusicCaps + tags     | One LoRA per user                   |
| Thumbs‑up gens      | yes           | reuse original prompt   | Goes to user‑LoRA + preference set  |
| Shipped MMO loops   | yes           | manual tags             | Cleared for training                |
| User refs           | yes (consent) | LP‑MusicCaps            | Disclaimer shown on upload          |
| FMA, MTG‑Jamendo    | curated       | LP‑MusicCaps            | Public CC                           |

### 5.2 Pipeline (Cloud Run job, `mmo-dataset-builder`)

```
1.  Upload / pick tracks  →  GCS gs://.../datasets/<dsId>/raw/
2.  Probe (ffprobe)        →  duration, channels, sample rate
3.  Beat & key detection   →  librosa + Essentia (BPM, key, downbeats)
4.  Vocal/instr separation →  Demucs (already deployed) for stem‑aware track
5.  Auto‑caption           →  LP‑MusicCaps tag→caption + tags via MERT model
6.  Lyric extraction       →  WhisperX (already in voice stack) for vocals only
7.  Pair with ACE format   →  <name>.mp3 + <name>_prompt.txt + <name>_lyrics.txt
8.  HF dataset             →  convert2hf_dataset.py (already exists upstream)
9.  Manifest               →  write trainingDatasets.manifest JSONB
```

Each step is a separate Cloud Run job triggered by a Pub/Sub message; failures
re‑enqueue with backoff. The user sees per‑item progress in the UI.

### 5.3 Dataset manifest schema

```ts
interface DatasetManifest {
  version: 1;
  hfDatasetUri: string;
  itemCount: number;
  durationSeconds: number;
  genres: Record<string, number>;
  bpmHistogram: Record<string, number>;   // "100-110": 12, "110-120": 30, ...
  keyHistogram: Record<string, number>;
  vocalRatio: number;                     // 0..1
  curation: {
    minDuration: number;
    maxDuration: number;
    excludedReasons: Record<string, number>;
  };
}
```

---

## 6. Training tracks (the six pipelines)

### 6.1 `style-lora` (curated genre packs)
- **Input**: 100–500 tracks from FMA/MTG‑Jamendo filtered by genre tag.
- **Compute**: 1×A100 spot, rank 32, 5000 steps, ~3h, ~$3.30.
- **Output**: `loras/<genre>.safetensors`, marked `isPublic = true`.
- **Maestro use**: auto‑select up to 2 LoRAs per generation by matching
  prompt embedding to LoRA tags (cosine in embeddings table).

### 6.2 `user-lora` (personal)
- **Input**: 20–200 tracks from user's MMO library + their thumbs‑up gens.
- **Compute**: 1×L4 (cheaper) or 1×A100, rank 16, 2000 steps, ~1h, ~$1.10.
- **Output**: `loras/<userId>/personal.safetensors`, scoped to user.
- **Trigger**: nightly cron when user added ≥10 new items, OR manual.
- **Maestro use**: blended at weight 0.4 unless user disables.

### 6.3 `conductor-sft` (Maestro LLM prompt → blueprint)
- **Why**: teaches Maestro to write *good* ACE‑Step prompts. The model
  currently just forwards the user's words; that's why genres get mixed up.
- **Input**: synthetic dataset of `(user_request, blueprint_yaml)` pairs.
  10k examples generated by GPT‑4o‑mini from a taxonomy file
  (`docs/maestro-training/taxonomy/`); 1k human‑reviewed.
- **Base**: Qwen 2.5 7B (matches ACE's planner) or fine‑tune
  GPT‑4o‑mini via OpenAI's API.
- **Output**: a system prompt addendum + few‑shot examples, OR a small
  adapter served by Maestro before tool calls.

### 6.4 `conductor-dpo`
- **Input**: `(prompt, blueprint_A, blueprint_B, choice)` pairs derived
  from user A/B preferences on generated clips. Each generation logs the
  blueprint used; when the user picks A over B, that's a preference pair.
- **Algorithm**: DPO (Hugging Face TRL).
- **Trigger**: weekly when ≥200 new pairs.

### 6.5 `acestep-dpo`
- **Input**: same pairs but at the diffusion level (latents, not blueprints).
- **Algorithm**: Diffusion‑DPO (Wallace 2023, adapted to audio latents).
- **Notes**: heavier; only run monthly if `conductor-dpo` plateaus.

### 6.6 `stem-aware`
- **Input**: existing dataset + Demucs‑separated stems. Train ACE to
  generate stem X given stem Y.
- **Use case**: "Maestro, add drums to this bassline" works for real.

---

## 7. Maestro integration

### 7.1 New tool surface (`lib/maestro/tools.ts`)

| Tool                              | Destructive | Scope                       |
|-----------------------------------|:-----------:|-----------------------------|
| `training.listJobs`               | no          | `ai.agent.allowTraining`   |
| `training.getJob`                 | no          | `ai.agent.allowTraining`   |
| `training.getProgress`            | no          | `ai.agent.allowTraining`   |
| `training.proposeJob`             | no          | `ai.agent.allowTraining`   |
| `training.submitJob`              | **yes**     | `+ allowDestructive`        |
| `training.patchControlSignal`     | **yes**     | `+ allowDestructive`        |
| `training.cancelJob`              | **yes**     | `+ allowDestructive`        |
| `dataset.listDatasets`            | no          | `ai.agent.allowTraining`   |
| `dataset.buildFromLibrary`        | **yes**     | `+ allowDestructive`        |
| `dataset.tagItem`                 | yes         | low‑risk; behind scope only |
| `loras.list`                      | no          | n/a                         |
| `loras.activate` / `loras.deactivate` | no      | n/a                         |
| `feedback.summarize`              | no          | n/a                         |

`patchControlSignal` is the autonomous knob the user authorised — Maestro
can change LR, dataset weights, early‑stop without asking, but **every patch
is logged to `trainingEvents` with `origin: "maestro"`** so the user sees
exactly what the agent did.

### 7.2 System‑prompt addendum

A new file `app/src/lib/maestro/training-skills.md` (read at boot) gives
Maestro:

- A genre taxonomy with prototypical BPM/key/instrument tuples.
- The Suno‑style tag vocabulary (`[Verse]`, `[Drop]`, `[Outro]`, `[no vocals]`).
- A 12‑step prompt‑engineering checklist (genre → BPM → key → instruments →
  vocal type → energy → structure → references → negative tags).
- Conduct rules: "if user mentions a song that exists in their library, look
  up its tags via `tracks.search`, copy BPM/key/mood, do NOT name the artist
  in the ACE prompt (copyright safety)".
- Continuous‑training rules: when to propose a new job, never auto‑submit
  paid jobs without `proposeJob → user approve → submitJob`.

### 7.3 Background watcher

A server action runs every 30s for any logged‑in user with an active job and:

1. Reads `trainingJobs.progress` + last 20 `trainingEvents`.
2. If loss plateaued for 500 steps AND eval not improving → Maestro proposes
   an early‑stop patch (or LR cut). Stored as a draft `ControlSignal` with
   `appliedAt = null, origin: "maestro"`. The trainer applies it on the next
   tick. The user sees a chat notification "I cut LR 5× because loss
   plateaued at step 1500; tap to undo."
3. If sample audio reward score (Apollo / CLAP‑score) is dropping → propose
   rollback to last checkpoint.

---

## 8. The Training page (`/training`)

```
┌─ Header ────────────────────────────────────────────────────┐
│  Training · Jobs · Datasets · LoRAs · Feedback ·   Budget  │
│                                            ▓▓▓▓░░░░ 64%    │
└─────────────────────────────────────────────────────────────┘
┌─ Jobs (live) ──────────────────────────────────────────────────────────────┐
│ ◉ user-lora-personal  rank 16  step 1240/2000  loss 0.42 ↘   $0.68 / $1.10 │
│      ▰▰▰▰▰▰▰▱▱▱  ETA 18m   [Pause] [Cancel]  Maestro: cut LR 5× at 1100   │
│   ▶ Listen to last sample (s3:.../sample_1200.wav)  ⓘ 99 BPM, A minor      │
├──────────────────────────────────────────────────────────────────────────────┤
│ ⏸ style-lora-melodic-techno  paused at step 800  Maestro: investigating spike│
├──────────────────────────────────────────────────────────────────────────────┤
│ ✓ user-lora-personal-v3  done  reward 0.71  [Activate as default]          │
└──────────────────────────────────────────────────────────────────────────────┘
┌─ Live charts ──────────────────────────────────────────────────────────────┐
│  loss     eval_loss     lr        sample_reward    gpu_util                │
│  [chart]   [chart]      [chart]   [chart]          [chart]                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

Buttons:
- **Pause / Resume** — sets `controlSignal.pause`.
- **Patch hyperparams** — modal with LR / dropout / early‑stop fields →
  one `controlSignal` patch.
- **Listen to samples** — auditions the last N sample WAVs inline.
- **Diff with parent** — A/B vs the LoRA the job replaces, two players side
  by side, vote feeds `generationFeedback`.
- **Console** — opens the Vertex AI page (already linked from
  `submit-training.py`).

Page is RSC‑first with an SSE component for the live numbers.

---

## 9. Model serving updates

### 9.1 ACE‑Step Cloud Run service

Already deployed. Add three things:

1. **Multi‑LoRA inference** — accept up to 4 LoRA URIs + weights per request.
   Patch `infer-api.py` to call `pipeline.load_lora_weights` per LoRA with
   `adapter_name = lora_<i>`, then `set_adapters([...], weights=[...])`.
2. **Reference conditioning** — accept `referenceAudioGcsUri`; sidecar
   downloads + sets `cover_path` (already supported by ACE).
3. **Returns blueprint + sample id** — so the app can store `(prompt, blueprint,
   audio_uri)` in `generationFeedback`.

### 9.2 New services

- **YuE 7B** (`mmo-yue`, L4, $0.15/song amortised): used when user asks for
  full songs with lyrics in English/Mandarin/Korean/Japanese.
- **Stable Audio Open 1.5** (`mmo-sao`, L4): used for short loops/SFX <30s,
  where ACE‑Step is overkill.

Maestro picks the engine via a simple router:

```ts
function routeEngine(req: GenRequest): EngineId {
  if (req.durationSec <= 12) return "sao";
  if (req.lyrics && req.durationSec > 60) return "yue";
  return "ace-step";
}
```

---

## 10. Cost guardrails

`$500/mo` cap, enforced in three layers:

1. **App‑side budget table** — `userBudgets.monthlySpendUsd` updated after
   each Vertex job by parsing the SKU price ledger; `submitJob` refuses
   when `monthlyToDate + estimateCost > monthlyBudgetUsd`.
2. **Vertex labels** — every job gets `labels: { user: <id>, budget_cap: <usd> }`,
   surfaced in the GCP billing export so we can audit retroactively.
3. **Auto‑pause near cap** — when `monthlyToDate > 0.9 × cap`, Maestro is
   forbidden from `submitJob` and the UI shows an explicit "low budget" badge.

Default per‑job estimates (Vertex pricing, May 2026, spot):

| Track          | GPU       | Hours | Cost   |
|----------------|-----------|------:|-------:|
| user‑lora      | 1× L4     | 1.0   | $0.45  |
| style‑lora     | 1× A100   | 3.0   | $3.30  |
| conductor‑sft  | OpenAI    | n/a   | $5.00  |
| conductor‑dpo  | OpenAI    | n/a   | $8.00  |
| acestep‑dpo    | 1× A100   | 8.0   | $8.80  |
| stem‑aware     | 1× A100   | 5.0   | $5.50  |

Typical month: 4 user‑LoRAs + 5 style‑LoRAs + 2 conductor‑dpos + ad‑hoc = ~$45.

---

## 11. Implementation order (single push)

We implement in dependency order, in one branch, then merge.

1. **Schema + migrations** (`schema-training.ts`, generate, migrate).
2. **GCS bucket layout** (already exists for `mmo-training-prod`; add prefixes).
3. **Pub/Sub topic + Cloud Run forwarder** (`training-events`).
4. **Trainer image upgrade** — extend `infra/vertex/train-acestep/train.py` to:
   - emit events to Pub/Sub every N steps,
   - poll `controlSignal` via a small HTTP endpoint (`/api/training/control/[jobId]`),
   - checkpoint to GCS,
   - render eval samples.
5. **Server actions**:
   - `app/src/actions/training.ts` (submit, get, patch, cancel, list)
   - `app/src/actions/datasets.ts` (build from library, add item, mark item)
   - `app/src/actions/generation-feedback.ts` (rate, summarize)
6. **API routes**:
   - `/api/training/events/[jobId]` SSE
   - `/api/training/control/[jobId]` GET (trainer polls) + PATCH (app writes)
   - `/api/training/webhook` (Pub/Sub push subscription verifies JWT)
7. **Maestro additions** — tools, scope, system prompt addendum.
8. **`/training` page** + dataset builder UI.
9. **Multi‑LoRA inference** in ACE Cloud Run.
10. **Engine router** + add YuE & SAO Cloud Run services (separate deploy).
11. **Background watcher** server action.
12. **Documentation** — update `concept/`, `docs/aplicatie/`, README.

---

## 12. Out of scope (deliberately deferred)

- Replacing ACE‑Step entirely (we evaluate YuE side‑by‑side, but keep ACE as primary).
- Real‑time / streaming generation (ACE doesn't support it yet; revisit in Q3 2026).
- Multi‑user shared LoRA marketplace (privacy review needed).
- Mobile training (always cloud).

---

## 13. Open follow‑ups (ask the user during implementation)

- Lyric copyright posture — strip artist names from prompts but keep lyric
  reference snippets for inspiration? Or zero‑lyrics for safety?
- Should style‑LoRAs be shared across users (`isPublic = true` by default)?
- What's the eval‑sample fixed prompt? (default: "energetic melodic techno,
  124 BPM, female vocal, A minor, dreamy synths").
- Allow Maestro to *originate* training jobs (propose without being asked)?
  Or only on explicit user request?

---

## 14. Definition of done

- A new user can: connect their library → click "Train my personal Maestro" →
  see a job appear → audit live samples → click "Activate" → next generation
  uses the LoRA → thumbs‑up feeds the next training cycle.
- Maestro autonomously cuts LR or early‑stops when loss plateaus, logs each
  decision to `trainingEvents`, and the user sees a one‑line summary.
- Hard budget cap holds: Vertex spend in GCP billing ≤ `monthlyBudgetUsd`.
- Two integration tests pass:
  - `vitest run training-job-lifecycle.test.ts` (Postgres + mocked Vertex).
  - `playwright test e2e/training.spec.ts` (UI flow with stubbed SSE).
