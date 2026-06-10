# Maestro Training Platform

> **Status**: end-to-end skeleton is live. Trainer-side polling/control is
> still pending (Python side will be wired in a follow-up sprint).

## What it does

The training platform turns Maestro into a **background trainer agent**.
You (or Maestro directly) can submit, monitor, and steer fine-tuning runs
without leaving the chat. The whole loop closes through five surfaces:

| Surface                        | Role                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| `/training` page               | Operator UI: jobs list, live SSE detail, control panel, datasets, LoRAs.    |
| Maestro chat                   | 17 new tools — `submitTrainingJob`, `patchTrainingControl`, etc.            |
| `POST /api/training/webhook`   | Trainer sends step / loss / sample / checkpoint events here.                |
| `GET /api/training/control/:id`| Trainer polls this every N steps for live LR / weight / pause patches.      |
| `POST /api/training/reconcile` | Cron sweep that catches up on jobs whose trainer went silent.               |

## Job kinds

| Kind            | Purpose                                  | GPU       | Est. cost | Steps  |
| --------------- | ---------------------------------------- | --------- | --------- | ------ |
| `user-lora`     | Personal taste adapter                   | L4 spot   | ~$0.45    | 2,000  |
| `style-lora`    | Shared genre / artist adapter            | A100 spot | ~$3.30    | 5,000  |
| `acestep-dpo`   | Preference alignment from thumbs-up/down | A100 spot | ~$2.00    | 1,500  |
| `stem-aware`    | Multi-stem conditioning (drums/vox)      | A100 spot | ~$3.00    | 4,000  |
| `conductor-sft` | Maestro brain SFT (not wired yet)        | A100      | varies    | tbd    |
| `conductor-dpo` | Maestro brain DPO  (not wired yet)       | A100      | varies    | tbd    |

Costs are estimates only — guarded by `MMO_TRAINING_BUDGET_USD` (default $500/mo).

## Live control signal

Each row in `training_jobs` carries a small mutable JSON blob,
`control_signal`. The trainer polls it every N steps; the operator (or
Maestro) writes to it from the UI or via `patchTrainingControl`.

```jsonc
{
  "learningRate": 5e-5,
  "datasetItemWeights": { "<itemId>": 2.0 },
  "earlyStop": false,
  "pause": false,
  "evalNow": false,        // auto-clears after one trainer poll
  "evalPrompt": "[Drop] dark melodic techno A minor 124 BPM",
  "updatedBy": "maestro" | "user-<uid>",
  "updatedAt": "<iso>"
}
```

Trainer reads via `GET /api/training/control/:id` with HMAC header
`X-MMO-Trainer-Secret`. The endpoint atomically clears `evalNow` after
serving so the trainer only renders one extra sample per request.

## Feedback loop

`recordGenerationFeedback({assetId, verdict, reasons[], note})` writes a
single row per `(user, asset)`. Re-rating overwrites and resets
`usedInDpo` so the next DPO mining pass picks up the new verdict.

When the rated asset's `params.loraId(s)` references a LoRA, that LoRA's
`thumbs_up_rate` is auto-recomputed. Maestro uses this rate to rank
candidates returned by `recommendLorasForPrompt`.

## Dataset builders

Three free, fast builders:

* `buildDatasetFromThumbsUp({minScore})` — bundles every up-voted
  generation into a training dataset.
* `buildDatasetFromLibrary({genre, bpmRange, key})` — filters the user's
  imported tracks.
* `buildDatasetFromSamplePack({pack})` — wraps a curated sample folder.

All produce `training_datasets` rows with `status='draft'`. Call
`materializeDataset(id)` to upload to GCS in the layout the trainer
expects (`<dataset>/audio/*.wav` + `metadata.jsonl`). This delegates to
the existing `prepareAceStepDataset` so the GCS layout is identical to
what `submitAceStepLoraTrainingVertex` already understands.

## Files

```
app/src/db/schema-training.ts                        # 5 tables
app/drizzle/0025_maestro_training.sql                # migration
app/src/actions/training.ts                          # control plane
app/src/actions/training-datasets.ts                 # dataset builders
app/src/actions/training-reconcile.ts                # Vertex catch-up
app/src/actions/generation-feedback.ts               # thumbs UI backend
app/src/actions/loras.ts                             # registry + rank
app/src/lib/maestro/training-tools.ts                # 17 AI tools
app/src/app/training/page.tsx                        # operator UI
app/src/app/training/training-client.tsx
app/src/components/maestro/feedback-buttons.tsx      # drop-in thumbs UI
app/src/app/api/training/events/[jobId]/route.ts     # SSE
app/src/app/api/training/control/[jobId]/route.ts    # GET (trainer) / PATCH
app/src/app/api/training/webhook/route.ts            # trainer events
app/src/app/api/training/reconcile/route.ts          # cron entry
infra/vertex/status-job.py                           # job state helper
```

## What's left (follow-up sprints)

1. **Trainer-side polling** — extend `infra/vertex/train-acestep/train.py`
   to (a) POST step/loss to `/api/training/webhook` every N steps, and
   (b) GET `/api/training/control/:id` to read & apply LR/dataset-weight
   patches.
2. **Multi-LoRA inference** — companion needs to fetch LoRAs by signed
   GCS URL and pass `lora_paths=[...]` (plural) to the ACE-Step pipeline.
3. **Conductor SFT/DPO** — trainer image for the Maestro brain isn't
   built; the kinds refuse gracefully today.
4. **Cron wiring** — schedule a 60-300s tick that calls
   `POST /api/training/reconcile` with `MMO_TRAINER_SECRET`.
