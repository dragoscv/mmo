-- Migration 0024: pgvector extension + audio_embeddings table.
-- Powers "music similarity search" over generated_assets and user uploads using
-- CLAP audio embeddings (512-d) extracted on the companion (local CLAP venv).
-- Cloud SQL Postgres 16 has pgvector pre-bundled; CREATE EXTENSION just needs
-- the postgres role (default).

CREATE EXTENSION IF NOT EXISTS vector;

-- One row per (asset, model, version) — same asset can have multiple embedding
-- variants if we ever swap models. asset_id is intentionally text so it can
-- reference either a generated_assets.id or a user-uploaded scanned track id.
CREATE TABLE IF NOT EXISTS audio_embeddings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id        text NOT NULL,
    asset_kind      text NOT NULL,                -- 'generated' | 'scanned' | 'stem'
    model           text NOT NULL DEFAULT 'clap-htsat-fused',
    model_version   text NOT NULL DEFAULT '1',
    dim             integer NOT NULL DEFAULT 512,
    embedding       vector(512) NOT NULL,
    duration_sec    real,
    tempo_bpm       real,
    key_root        text,
    key_mode        text,
    tags            jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ['rock','aggressive','120bpm']
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (asset_id, asset_kind, model, model_version)
);

CREATE INDEX IF NOT EXISTS audio_embeddings_asset_idx
    ON audio_embeddings (asset_id, asset_kind);

-- HNSW index for cosine similarity. Cheap to build at this scale (<10k rows
-- expected for solo dev). Switch to ivfflat once we exceed ~100k rows.
CREATE INDEX IF NOT EXISTS audio_embeddings_hnsw_idx
    ON audio_embeddings USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS audio_embeddings_tags_gin_idx
    ON audio_embeddings USING gin (tags);
