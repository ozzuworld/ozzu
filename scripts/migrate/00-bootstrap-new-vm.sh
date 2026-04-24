#!/usr/bin/env bash
# Phase 0 of the Ozzu migration protocol — King Kazuma runs this in
# Cloud Shell of the *new* GCP project. Provisions the VM with all
# settings baked in so Cipher can take over.
#
# Usage in Cloud Shell:
#   1. Open https://console.cloud.google.com — make sure project selector
#      shows your NEW project.
#   2. Open Cloud Shell (>_ icon, top right).
#   3. Edit the two `export` lines below (PROJECT_ID + CIPHER_PUBKEY).
#   4. Paste the whole script.
#   5. Last line of output: `NEW_VM_USER=... NEW_VM_IP=...` — give those to Cipher.
#
# Why each step exists: see /home/gcp/ozzu/MIGRATION.md, "Cycle 1 lessons".

set -euo pipefail

# ─── EDIT THESE TWO ───────────────────────────────────────────────────
export PROJECT_ID="project-XXXXXXXX-XXXX-XXXX-XXX"   # New GCP project ID
export CIPHER_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB01S/kr4/rCDO3hz6OM+7XUnpJRD7UmGfpgQEsDb8cC cipher-migration"
# ──────────────────────────────────────────────────────────────────────

if [[ "$PROJECT_ID" == *"XXXXXXXX"* ]]; then
  echo "ERROR: edit PROJECT_ID at the top of this script first." >&2
  exit 1
fi

echo "=== Phase 0: provisioning new VM in $PROJECT_ID ==="

gcloud config set project "$PROJECT_ID"

echo "[1/6] Enable Compute Engine API…"
gcloud services enable compute.googleapis.com

echo "[2/6] Disable OS Login at project level (so metadata SSH keys + Cipher's pubkey work)…"
gcloud compute project-info add-metadata --metadata=enable-oslogin=FALSE

echo "[3/6] Reserve static external IP…"
gcloud compute addresses create ozzu-static-ip --region=us-central1
IP=$(gcloud compute addresses describe ozzu-static-ip --region=us-central1 --format='value(address)')
echo "    Static IP: $IP"

echo "[4/6] Create VM (e2-standard-4, 250 GB pd-balanced, Ubuntu 24.04 LTS)…"
gcloud compute instances create ozzu-vm \
  --zone=us-central1-a \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=250GB \
  --boot-disk-type=pd-balanced \
  --address="$IP" \
  --tags=ozzu-vm,http-server,https-server \
  --metadata=enable-oslogin=FALSE

echo "[5/6] Open public ports (80, 443, 3333, 6333, 6969 + UDP 1194 for OpenVPN)…"
gcloud compute firewall-rules create allow-ozzu-public \
  --allow=tcp:80,tcp:443,tcp:3333,tcp:6333,tcp:6969,udp:1194 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=ozzu-vm

echo "[6/6] Inject Cipher's SSH pubkey via gcloud compute ssh (Google signed-SSH path — works regardless of OS Login state)…"
NEW_VM_USER=$(gcloud compute ssh ozzu-vm --zone=us-central1-a --command="
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  if ! grep -qF '$CIPHER_PUBKEY' ~/.ssh/authorized_keys 2>/dev/null; then
    echo '$CIPHER_PUBKEY' >> ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
  fi
  whoami
" 2>/dev/null | tail -1)

echo
echo "════════════════════════════════════════════════════════"
echo "✅ Phase 0 complete."
echo "NEW_VM_USER=$NEW_VM_USER"
echo "NEW_VM_IP=$IP"
echo "════════════════════════════════════════════════════════"
echo "Give those two values to Cipher and they'll take it from there."
