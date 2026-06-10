// ─────────────────────────────────────────────────────────────────────────────
// MMO — Postgres (Cloud SQL) + user files bucket + Secret Manager
//
// Cloud SQL `mmo-pg` (POSTGRES_16, db-f1-micro, ~$10/mo + storage) is the
// source-of-truth for app metadata. The companion app keeps a local SQLite
// cache and owns the actual audio files; the bucket here is only for user
// uploads we WANT in the cloud (recording exports, artwork, account avatars).
//
// These resources were provisioned via gcloud first (so we already have an
// IP/password); declare them here so future changes go through Terraform.
// Run `terraform import` once after creating these files — see README.
// ─────────────────────────────────────────────────────────────────────────────

resource "google_project_service" "sqladmin" {
  service            = "sqladmin.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "secretmanager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "storage" {
  service            = "storage.googleapis.com"
  disable_on_destroy = false
}

// ── Postgres password ──────────────────────────────────────────────────────

resource "random_password" "postgres" {
  length  = 32
  special = true
  // Keep characters URL-safe and shell-safe for connection strings.
  override_special = "!#%&*+-_=?^"
}

// ── Cloud SQL ──────────────────────────────────────────────────────────────

resource "google_sql_database_instance" "mmo" {
  name             = "mmo-pg"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    edition           = "ENTERPRISE"
    tier              = "db-f1-micro"
    availability_type = "ZONAL"
    disk_size         = 10
    disk_type         = "PD_HDD"
    disk_autoresize   = true

    backup_configuration {
      enabled    = true
      start_time = "03:00"
      // Point-in-time recovery requires PD_SSD; off for the cheap tier.
      point_in_time_recovery_enabled = false
    }

    ip_configuration {
      ipv4_enabled = true
      // Open to the world but require SSL + strong password. For production
      // hardening, swap this for an authorized_networks list of Vercel egress
      // ranges + your office IPs, or move to Private Service Connect.
      authorized_networks {
        name  = "allow-all"
        value = "0.0.0.0/0"
      }
      // require_ssl was deprecated in google provider v6. Use the
      // explicit ssl_mode enum instead. ENCRYPTED_ONLY = TLS required
      // but no cert verification (same effective semantics).
      ssl_mode = "ENCRYPTED_ONLY"
    }

    insights_config {
      query_insights_enabled = true
      record_application_tags = false
      record_client_address   = false
    }
  }

  // Don't accidentally destroy on `terraform destroy` — DB has user data.
  deletion_protection = true

  depends_on = [google_project_service.sqladmin]
}

resource "google_sql_user" "postgres" {
  name     = "postgres"
  instance = google_sql_database_instance.mmo.name
  password = random_password.postgres.result
}

resource "google_sql_database" "mmo" {
  name     = "mmo"
  instance = google_sql_database_instance.mmo.name
}

// ── Secret Manager ─────────────────────────────────────────────────────────

resource "google_secret_manager_secret" "db_url" {
  secret_id = "mmo-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "db_url" {
  secret      = google_secret_manager_secret.db_url.id
  secret_data = "postgres://postgres:${urlencode(random_password.postgres.result)}@${google_sql_database_instance.mmo.public_ip_address}:5432/mmo?sslmode=require"
}

resource "google_secret_manager_secret" "db_password" {
  secret_id = "mmo-postgres-password"
  replication {
    auto {}
  }
  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.postgres.result
}

// ── GCS bucket for user-uploaded files (recordings, artwork) ───────────────

resource "google_storage_bucket" "user_files" {
  name                        = "mmo-user-files-prod"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = false
  }

  lifecycle_rule {
    condition {
      age = 30
      with_state = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  cors {
    origin          = ["https://muzicai.ro", "http://localhost:3000", "http://localhost:13789"]
    method          = ["GET", "PUT", "POST", "DELETE", "HEAD"]
    response_header = ["*"]
    max_age_seconds = 3600
  }

  depends_on = [google_project_service.storage]
}

// ── Service account for the web app to mint signed URLs ────────────────────

resource "google_service_account" "web_app" {
  account_id   = "mmo-web-app"
  display_name = "MMO Web App (Vercel)"
}

resource "google_storage_bucket_iam_member" "web_app_storage" {
  bucket = google_storage_bucket.user_files.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.web_app.email}"
}

resource "google_service_account_key" "web_app" {
  service_account_id = google_service_account.web_app.name
  // The JSON key needs to be copied into Vercel env as GCP_SERVICE_ACCOUNT_KEY
  // (base64-decoded). Sensitive output below.
}
