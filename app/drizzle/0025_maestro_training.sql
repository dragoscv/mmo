-- Migration 0025: Maestro training platform.
-- Adds five tables that back the /training page, the Maestro `training.*`
-- tools, the SSE event stream at /api/training/events/[jobId], and the
-- control-signal polling loop the Python trainer hits at
-- /api/training/control/[jobId]. See app/src/db/schema-training.ts and
-- docs/maestro-training/PLAN.md for the design.

-- ── training_datasets ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_datasets (
    id                   text PRIMARY KEY,
    user_id              text REFERENCES "user"(id) ON DELETE SET NULL,
    scope                text NOT NULL DEFAULT 'user',          -- user | shared
    name                 text NOT NULL,
    description          text,
    source_kind          text NOT NULL,                          -- user-library | thumbs-up | shipped-loops | uploaded-refs | fma | mtg-jamendo | mixed
    item_count           integer NOT NULL DEFAULT 0,
    total_duration_sec   real NOT NULL DEFAULT 0,
    tag_histogram        jsonb NOT NULL DEFAULT '{}'::jsonb,
    gcs_uri              text,
    status               text NOT NULL DEFAULT 'draft',          -- draft | ready | materializing | failed | archived
    error                text,
    created_at           timestamp DEFAULT now(),
    updated_at           timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS training_datasets_user_idx ON training_datasets (user_id, created_at);
CREATE INDEX IF NOT EXISTS training_datasets_scope_idx ON training_datasets (scope, status);

-- ── training_dataset_items ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_dataset_items (
    id                    text PRIMARY KEY,
    dataset_id            text NOT NULL REFERENCES training_datasets(id) ON DELETE CASCADE,
    asset_kind            text NOT NULL,                         -- generated | scanned | sample | uploaded | external
    asset_id              text NOT NULL,
    generated_asset_id    text REFERENCES generated_assets(id) ON DELETE SET NULL,
    caption               text NOT NULL DEFAULT '',
    weight                real NOT NULL DEFAULT 1,
    duration_sec          real,
    sample_rate           integer,
    tempo_bpm             real,
    key_root              text,
    key_mode              text,
    tags                  jsonb NOT NULL DEFAULT '[]'::jsonb,
    metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at            timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS training_dataset_items_dataset_idx ON training_dataset_items (dataset_id);
CREATE UNIQUE INDEX IF NOT EXISTS training_dataset_items_uniq
    ON training_dataset_items (dataset_id, asset_kind, asset_id);

-- ── training_jobs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_jobs (
    id                       text PRIMARY KEY,
    user_id                  text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    dataset_id               text REFERENCES training_datasets(id) ON DELETE SET NULL,
    kind                     text NOT NULL,                      -- style-lora | user-lora | conductor-sft | conductor-dpo | acestep-dpo | stem-aware
    provider                 text NOT NULL DEFAULT 'vertex',     -- vertex | local | runpod
    external_job_name        text,
    external_job_id          text,
    console_url              text,
    name                     text NOT NULL,
    description              text,
    config                   jsonb NOT NULL,
    control_signal           jsonb NOT NULL DEFAULT '{}'::jsonb,
    current_step             integer NOT NULL DEFAULT 0,
    last_loss                real,
    last_eval_loss           real,
    loss_history             jsonb NOT NULL DEFAULT '[]'::jsonb,
    latest_sample_uri        text,
    latest_checkpoint_uri    text,
    status                   text NOT NULL DEFAULT 'pending',    -- pending | submitted | running | paused | succeeded | failed | cancelled
    error                    text,
    estimated_cost_usd       real,
    actual_cost_usd          real,
    max_runtime_hours        real NOT NULL DEFAULT 8,
    created_by               text NOT NULL DEFAULT 'user',       -- user | maestro | system
    submitted_at             timestamp,
    started_at               timestamp,
    finished_at              timestamp,
    created_at               timestamp DEFAULT now(),
    updated_at               timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS training_jobs_user_idx ON training_jobs (user_id, created_at);
CREATE INDEX IF NOT EXISTS training_jobs_status_idx ON training_jobs (status, updated_at);
CREATE INDEX IF NOT EXISTS training_jobs_kind_idx ON training_jobs (kind);

-- ── training_events ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_events (
    id            text PRIMARY KEY,
    job_id        text NOT NULL REFERENCES training_jobs(id) ON DELETE CASCADE,
    kind          text NOT NULL,                                  -- submitted | started | step | sample | checkpoint | controlPatch | warning | error | finished | cancelled
    step          integer,
    message       text,
    data          jsonb NOT NULL DEFAULT '{}'::jsonb,
    source        text NOT NULL DEFAULT 'trainer',                -- trainer | maestro | user | system | vertex
    created_at    timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS training_events_job_idx ON training_events (job_id, created_at);
CREATE INDEX IF NOT EXISTS training_events_kind_idx ON training_events (job_id, kind);

-- ── lora_assets ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lora_assets (
    id                text PRIMARY KEY,
    user_id           text REFERENCES "user"(id) ON DELETE SET NULL,
    scope             text NOT NULL DEFAULT 'user',                -- user | shared
    kind              text NOT NULL,                                -- style | user | stem | mood
    job_id            text REFERENCES training_jobs(id) ON DELETE SET NULL,
    name              text NOT NULL,
    description       text,
    trigger_token     text,
    base_model        text NOT NULL,
    rank              integer NOT NULL,
    weights_uri       text NOT NULL,
    preview_uri       text,
    tags              jsonb NOT NULL DEFAULT '[]'::jsonb,
    eval_loss         real,
    usage_count       integer NOT NULL DEFAULT 0,
    thumbs_up_rate    real,
    status            text NOT NULL DEFAULT 'active',              -- active | deprecated | archived
    created_at        timestamp DEFAULT now(),
    updated_at        timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lora_assets_user_idx ON lora_assets (user_id, created_at);
CREATE INDEX IF NOT EXISTS lora_assets_scope_kind_idx ON lora_assets (scope, kind, status);
CREATE UNIQUE INDEX IF NOT EXISTS lora_assets_weights_uniq ON lora_assets (weights_uri);

-- ── generation_feedback ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS generation_feedback (
    id              text PRIMARY KEY,
    user_id         text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    asset_id        text NOT NULL REFERENCES generated_assets(id) ON DELETE CASCADE,
    verdict         text NOT NULL,                                 -- up | down | flag
    reasons         jsonb NOT NULL DEFAULT '[]'::jsonb,
    note            text,
    score           integer,
    used_in_dpo     boolean NOT NULL DEFAULT false,
    created_at      timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_feedback_user_idx ON generation_feedback (user_id, created_at);
CREATE INDEX IF NOT EXISTS generation_feedback_asset_idx ON generation_feedback (asset_id);
CREATE INDEX IF NOT EXISTS generation_feedback_verdict_idx ON generation_feedback (verdict, used_in_dpo);
CREATE UNIQUE INDEX IF NOT EXISTS generation_feedback_user_asset_uniq
    ON generation_feedback (user_id, asset_id);
