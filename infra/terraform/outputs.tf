output "turn_ip" {
  description = "Public IPv4 address of the TURN server"
  value       = google_compute_address.turn_ip.address
}

output "turn_host" {
  description = "Value to put in TURN_HOST env var (host:port)"
  value       = "${google_compute_address.turn_ip.address}:3478"
}

output "turn_shared_secret" {
  description = "HMAC secret for ephemeral REST credentials. Put in TURN_SHARED_SECRET."
  value       = random_password.turn_secret.result
  sensitive   = true
}

output "turn_realm" {
  description = "TURN realm. Put in TURN_REALM."
  value       = var.realm
}

output "ssh_command" {
  description = "Shell command to SSH into the VM via IAP tunnel"
  value       = "gcloud compute ssh ${google_compute_instance.turn.name} --zone=${var.zone} --tunnel-through-iap --project=${var.project_id}"
}
