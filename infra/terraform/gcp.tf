// ─────────────────────────────────────────────────────────────────────────────
// MMO — GCP resources for AI-generated content & cloud-side helpers
//
// Project: mmo-mw-prod (622082681070)
// Region:  europe-west1
//
// Pre-existing:
//   - Cloud SQL instance "mmo-pg" (Postgres 16, db-f1-micro, 34.79.95.212)
//   - Bucket "mmo-user-files-prod" (user uploads, EUROPE-WEST1)
//
// Provisioned 2026-05-20 (out-of-band):
//   - APIs: run, cloudbuild, artifactregistry, speech, texttospeech, aiplatform
//   - Bucket "mmo-generated-prod" for AI-generated audio
//     (lifecycle: 90d -> ARCHIVE, 365d -> DELETE)
//
// The `import {}` blocks adopt these resources into Terraform state.
// ─────────────────────────────────────────────────────────────────────────────

locals {
  gcp_required_services_ai = toset([
    "run.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "speech.googleapis.com",
    "texttospeech.googleapis.com",
    "aiplatform.googleapis.com",
    "iamcredentials.googleapis.com",
    "compute.googleapis.com",
  ])
}

resource "google_project_service" "ai_enabled" {
  for_each           = local.gcp_required_services_ai
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ── AI-generated audio bucket (hot, lifecycle to archive after 90 days) ─────

resource "google_storage_bucket" "generated" {
  name                        = "mmo-generated-prod"
  location                    = "EUROPE-WEST1"
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
    condition {
      age = 90
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
    app = "mmo"
    env = "prod"
  }
}

import {
  to = google_storage_bucket.generated
  id = "mmo-generated-prod"
}
