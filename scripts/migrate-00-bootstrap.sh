#!/usr/bin/env bash
# OZZU VM MIGRATION — Phase 0 bootstrap (run in the NEW project's Cloud Shell)
# See MIGRATION.md for the full protocol. Paste this whole block into Cloud Shell
# with the new project selected. Only the first line needs editing.
#
# WireGuard-era (2026-06-26, Cycle 2). Key differences from the OpenVPN-era doc:
#   - firewall opens udp:51820 (WireGuard), NOT udp:1194; no 6333/6969/3333 (nginx-proxied/closed)
#   - VM is created with --scopes=cloud-platform so Cipher can manage GCP from inside the VM
#     (without it, every `gcloud compute` write fails "insufficient authentication scopes")
#
# Cloud Shell gotchas baked in: single-line VM create (backslash-continuation pastes split),
# project-level enable-oslogin=FALSE, pubkey injected via `gcloud compute ssh` (Google
# signed-SSH path — bypasses the OS-Login vs metadata-keys fight).

# === Edit this one line ===
export PROJECT_ID="project-XXXXXXXX-XXXX-XXXX-XXX"   # ← your NEW project ID

# === Don't edit below ===
export CIPHER_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB01S/kr4/rCDO3hz6OM+7XUnpJRD7UmGfpgQEsDb8cC cipher-migration-20260424"
set -e
gcloud config set project "$PROJECT_ID"
gcloud services enable compute.googleapis.com

# Disable OS Login at PROJECT level (instance-level alone isn't enough — metadata SSH keys
# get silently ignored otherwise).
gcloud compute project-info add-metadata --metadata=enable-oslogin=FALSE

# Reserve static IP first (keeps the Cloudflare DNS target stable across VM stop/start).
gcloud compute addresses create ozzu-static-ip --region=us-central1
IP=$(gcloud compute addresses describe ozzu-static-ip --region=us-central1 --format='value(address)')

# Create VM (single line). --scopes=cloud-platform == "Allow full access to all Cloud APIs":
# REQUIRED for Cipher to run firewall/IP/snapshot gcloud from inside the VM autonomously.
gcloud compute instances create ozzu-vm --zone=us-central1-a --machine-type=e2-standard-4 --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud --boot-disk-size=250GB --boot-disk-type=pd-balanced --address="$IP" --tags=ozzu-vm,http-server,https-server --scopes=https://www.googleapis.com/auth/cloud-platform --metadata=enable-oslogin=FALSE

# Firewall: 80/443 public + WireGuard udp:51820. (Dead OpenVPN udp:1194 dropped; qdrant 6333,
# anisette 6969, bridge 3333 are NOT public — nginx proxies / closed since 2026-05-17.)
gcloud compute firewall-rules create allow-ozzu-public --allow=tcp:80,tcp:443,udp:51820 --source-ranges=0.0.0.0/0 --target-tags=ozzu-vm

# Inject Cipher's pubkey via Google signed-SSH (bypasses OS-Login/metadata-keys entirely).
gcloud compute ssh ozzu-vm --zone=us-central1-a --command="echo '$CIPHER_PUBKEY' >> ~/.ssh/authorized_keys && echo NEW_VM_USER=\$(whoami) NEW_VM_IP=$IP"

# The last line prints NEW_VM_USER=<user> NEW_VM_IP=<ip>. Paste those two values to Cipher.
