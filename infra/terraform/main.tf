// ─────────────────────────────────────────────────────────────────────────────
// MMO — coturn (TURN/STUN) on Google Cloud
//
// Provisions a single self-managed coturn instance with a static external IP
// in the chosen region.  Uses the RFC "ephemeral REST" auth pattern
// (use-auth-secret + static-auth-secret) so the Next.js app mints short-lived
// credentials at request time — no per-user database on the TURN server itself.
//
//   Cost (europe-west1):  e2-micro $6.11/mo + static IP $1.46/mo + traffic
//   Capacity:             ~150 concurrent audio relays (Opus @ 96 kbps)
// ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.12.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.10"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.10"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

// ── APIs ────────────────────────────────────────────────────────────────────

resource "google_project_service" "compute" {
  service                    = "compute.googleapis.com"
  disable_dependent_services = false
  disable_on_destroy         = false
}

// ── Shared secret (HMAC key for ephemeral TURN credentials) ────────────────

resource "random_password" "turn_secret" {
  length  = 48
  special = false
}

// ── Static external IP ──────────────────────────────────────────────────────

resource "google_compute_address" "turn_ip" {
  name         = "${var.name}-ip"
  region       = var.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"

  depends_on = [google_project_service.compute]
}

// ── Firewall rules ──────────────────────────────────────────────────────────
// coturn listens on 3478/UDP+TCP for STUN/TURN and uses 49160-49200/UDP for
// relays.  We deliberately do NOT expose 5349 (TURNS) here — TLS termination
// requires a domain + cert, which is a separate concern.

resource "google_compute_firewall" "turn" {
  name    = "${var.name}-allow-turn"
  network = "default"

  allow {
    protocol = "udp"
    ports    = ["3478", "49160-49200"]
  }
  allow {
    protocol = "tcp"
    ports    = ["3478"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["coturn"]

  depends_on = [google_project_service.compute]
}

// ── VM ──────────────────────────────────────────────────────────────────────

resource "google_compute_instance" "turn" {
  name         = var.name
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["coturn"]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 10
      type  = "pd-standard"
    }
  }

  network_interface {
    network = "default"
    access_config {
      nat_ip       = google_compute_address.turn_ip.address
      network_tier = "PREMIUM"
    }
  }

  metadata = {
    // Passed to the startup script via the metadata server
    "turn-secret" = random_password.turn_secret.result
    "turn-realm"  = var.realm
  }

  metadata_startup_script = file("${path.module}/coturn.sh")

  service_account {
    // Default compute SA, no scopes beyond what's needed for metadata reads
    scopes = ["https://www.googleapis.com/auth/cloud-platform.read-only"]
  }

  // Avoid replacing the VM if we tweak the script — coturn re-reads on reboot.
  lifecycle {
    ignore_changes = [metadata_startup_script]
  }

  depends_on = [
    google_project_service.compute,
    google_compute_firewall.turn,
  ]
}
