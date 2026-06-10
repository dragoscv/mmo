// ─────────────────────────────────────────────────────────────────────────────
// MMO — additional GCP resources for ML training + Cloud Run services
//
// Adopted out-of-band on 2026-05-20:
//   - Bucket "mmo-training-prod" (training datasets + LoRA artifacts)
//   - Artifact Registry: mmo-mastering, mmo-clap, mmo-training (docker, europe-west1)
//   - Service accounts: sa-mastering, sa-clap, sa-vertex-trainer
//   - IAM bindings: sa-mastering → objectAdmin on mmo-generated-prod,
//                   sa-vertex-trainer → objectAdmin on mmo-training-prod
//                                      + aiplatform.user project-wide
// ─────────────────────────────────────────────────────────────────────────────

# ── Training bucket (ML datasets + checkpoints) ─────────────────────────────

resource "google_storage_bucket" "training" {
  name                        = "mmo-training-prod"
  location                    = "EUROPE-WEST1"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Training artifacts are large but accessed rarely after the run completes.
  # Move to ARCHIVE after 30d, delete after 1y.
  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
    condition {
      age = 30
    }
  }
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 365
    }
  }

  labels = {
    app  = "mmo"
    env  = "prod"
    role = "training"
  }
}

import {
  to = google_storage_bucket.training
  id = "mmo-training-prod"
}

# ── Artifact Registry repos for our Cloud Run + Vertex images ───────────────

resource "google_artifact_registry_repository" "mastering" {
  location      = "europe-west1"
  repository_id = "mmo-mastering"
  format        = "DOCKER"
  description   = "Cloud Run audio-mastering service images"
}

import {
  to = google_artifact_registry_repository.mastering
  id = "projects/${var.project_id}/locations/europe-west1/repositories/mmo-mastering"
}

resource "google_artifact_registry_repository" "clap" {
  location      = "europe-west1"
  repository_id = "mmo-clap"
  format        = "DOCKER"
  description   = "Cloud Run CLAP audio-embedding fallback images"
}

import {
  to = google_artifact_registry_repository.clap
  id = "projects/${var.project_id}/locations/europe-west1/repositories/mmo-clap"
}

resource "google_artifact_registry_repository" "training" {
  location      = "europe-west1"
  repository_id = "mmo-training"
  format        = "DOCKER"
  description   = "Vertex AI training container images (ACE-Step LoRA)"
}

import {
  to = google_artifact_registry_repository.training
  id = "projects/${var.project_id}/locations/europe-west1/repositories/mmo-training"
}

# ── Service accounts for Cloud Run + Vertex ─────────────────────────────────

resource "google_service_account" "mastering" {
  account_id   = "sa-mastering"
  display_name = "MMO mastering Cloud Run service"
}

import {
  to = google_service_account.mastering
  id = "projects/${var.project_id}/serviceAccounts/sa-mastering@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_service_account" "clap" {
  account_id   = "sa-clap"
  display_name = "MMO CLAP embedding Cloud Run service"
}

import {
  to = google_service_account.clap
  id = "projects/${var.project_id}/serviceAccounts/sa-clap@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_service_account" "vertex_trainer" {
  account_id   = "sa-vertex-trainer"
  display_name = "MMO Vertex AI custom job trainer"
}

import {
  to = google_service_account.vertex_trainer
  id = "projects/${var.project_id}/serviceAccounts/sa-vertex-trainer@${var.project_id}.iam.gserviceaccount.com"
}

# ACE-Step inference on Cloud Run GPU (L4 in europe-west4). Backstops the
# companion when the user is offline / on mobile / wants to spare local
# VRAM. See infra/cloud-run/ace-step/.
resource "google_service_account" "ace_step" {
  account_id   = "sa-ace-step"
  display_name = "MMO ACE-Step Cloud Run GPU service"
}

# Demucs stem separation on Cloud Run GPU (L4 in europe-west4).
resource "google_service_account" "demucs" {
  account_id   = "sa-demucs"
  display_name = "MMO Demucs Cloud Run GPU service"
}

# Piper TTS on Cloud Run CPU (europe-west1). Light, fast, no GPU.
resource "google_service_account" "piper" {
  account_id   = "sa-piper"
  display_name = "MMO Piper TTS Cloud Run service"
}

# RVC voice conversion on Cloud Run GPU (L4). Endpoint live; full
# implementation gated on per-user voice-model GCS storage.
resource "google_service_account" "rvc" {
  account_id   = "sa-rvc"
  display_name = "MMO RVC voice-conversion Cloud Run GPU service"
}

# Voice-cloning TTS (XTTS / F5 / Fish) on Cloud Run GPU (L4). Same
# storage-layer gating as RVC.
resource "google_service_account" "voice_tts" {
  account_id   = "sa-voice-tts"
  display_name = "MMO voice-cloning TTS Cloud Run GPU service"
}

# ── IAM bindings ────────────────────────────────────────────────────────────

# ACE-Step writes generated songs into the generated bucket and reads any
# user-supplied LoRA checkpoints from the training bucket.
resource "google_storage_bucket_iam_member" "ace_step_generated_writer" {
  bucket = google_storage_bucket.generated.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.ace_step.email}"
}

resource "google_storage_bucket_iam_member" "ace_step_training_reader" {
  bucket = google_storage_bucket.training.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.ace_step.email}"
}

# Demucs reads uploaded source mixes and writes split stems back to the
# generated bucket.
resource "google_storage_bucket_iam_member" "demucs_generated_writer" {
  bucket = google_storage_bucket.generated.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.demucs.email}"
}

# Piper reads voice .onnx files from the generated bucket (under
# voices/piper/) and writes rendered audio back.
resource "google_storage_bucket_iam_member" "piper_generated_writer" {
  bucket = google_storage_bucket.generated.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.piper.email}"
}

# RVC reads voice models + writes converted audio. Storage layer for
# per-user voice models is the gating item — bindings are in place.
resource "google_storage_bucket_iam_member" "rvc_generated_writer" {
  bucket = google_storage_bucket.generated.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.rvc.email}"
}

# Voice-cloning TTS reads reference samples + writes generated vocals.
resource "google_storage_bucket_iam_member" "voice_tts_generated_writer" {
  bucket = google_storage_bucket.generated.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.voice_tts.email}"
}

# Mastering service writes back into the generated bucket.
resource "google_storage_bucket_iam_member" "mastering_generated_writer" {
  bucket = google_storage_bucket.generated.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.mastering.email}"
}

# Vertex trainer reads dataset + writes checkpoints in the training bucket.
resource "google_storage_bucket_iam_member" "vertex_training_admin" {
  bucket = google_storage_bucket.training.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.vertex_trainer.email}"
}

# Vertex trainer needs aiplatform.user to submit + run custom jobs.
resource "google_project_iam_member" "vertex_trainer_aiplatform_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.vertex_trainer.email}"
}

# CLAP service reads from the generated bucket (to embed uploaded assets).
resource "google_storage_bucket_iam_member" "clap_generated_reader" {
  bucket = google_storage_bucket.generated.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.clap.email}"
}
