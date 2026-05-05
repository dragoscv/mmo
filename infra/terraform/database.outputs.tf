// Outputs for the database / storage layer.

output "postgres_host" {
  description = "Cloud SQL public IP. Goes into DATABASE_URL host portion."
  value       = google_sql_database_instance.mmo.public_ip_address
}

output "postgres_connection_name" {
  description = "instance connection name (project:region:name) for Cloud SQL Auth Proxy if you switch to it."
  value       = google_sql_database_instance.mmo.connection_name
}

output "database_url_secret" {
  description = "Secret Manager secret name for DATABASE_URL. Read from gcloud / Secret Manager API."
  value       = google_secret_manager_secret.db_url.secret_id
}

output "user_files_bucket" {
  description = "GCS bucket for user uploads (recordings, artwork)."
  value       = google_storage_bucket.user_files.name
}

output "web_app_sa_email" {
  description = "Service account email used by the web app to sign URLs."
  value       = google_service_account.web_app.email
}

output "web_app_sa_key_json" {
  description = "Base64-encoded JSON key for the web app SA. Decode and put in GCP_SERVICE_ACCOUNT_KEY env. Rotate by running `terraform taint google_service_account_key.web_app && terraform apply`."
  value       = google_service_account_key.web_app.private_key
  sensitive   = true
}
