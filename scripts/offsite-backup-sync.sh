#!/bin/bash
# offsite-backup-sync.sh — mirror encrypted ozzu backups to interim offsite (CIS 11.2)
# Created 2026-09-25 (SKYLINE-SOC-2026-106 / security-roadmap Phase 1).
# Target: OC box ubuntu@157.137.236.234:~/offsite-ozzu/ — keeps latest 2 generations
# (cut from 5 on 2026-09-27: OC disk hit 100% — restore 3-5 after OC cleanup / OCI target).
# Backups are ALREADY encrypted (AES-256-CBC, passphrase = BRIDGE_API_KEY; offsite key
# copy at ~/offsite-ozzu/RESTORE-KEY on OC, 0600). Permanent target (KK decision): OCI
# object storage — see private/security-roadmap/ROADMAP.md §4 Phase 2.
set -uo pipefail

OC="ubuntu@157.137.236.234"
SRC="/home/gcp/ozzu/backups"
REMOTE_DIR="offsite-ozzu"
STATUS="/home/gcp/ozzu/data/infra/offsite-backup-status.json"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15"
now=$(date +%s)

write_status() { # $1=ok(1/0) $2=latest_name $3=match(true/false) $4=remote_count $5=msg
  mkdir -p "$(dirname "$STATUS")"
  jq -n --argjson ok "$1" --arg latest "$2" --argjson match "$3" --argjson count "${4:-0}" \
        --arg msg "$5" --argjson ts "$now" \
    '{generated_at:$ts, ok:($ok==1), latest_backup:$latest, checksum_match:$match, remote_generations:$count, message:$msg}' \
    > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}

ssh $SSH_OPTS "$OC" "mkdir -p ~/$REMOTE_DIR" || { write_status 0 "" false 0 "ssh to OC failed"; exit 1; }

# 2026-09-27 (disk-full emergency): send ONLY the latest $RETENTION local generations.
# Old --delete directory-mirror re-copied every pruned-remote file nightly = churn the
# 96%-full OC disk can't afford (and it fought the retention trim every run).
RETENTION=2
mapfile -t SEND < <(ls -t "$SRC"/ozzu-backup-*.tar.gz.enc 2>/dev/null | head -"$RETENTION")
[ ${#SEND[@]} -gt 0 ] || { write_status 0 "" false 0 "no local backups found"; exit 1; }
rsync -a -e "ssh $SSH_OPTS" "${SEND[@]}" "$OC:$REMOTE_DIR/" || { write_status 0 "" false 0 "rsync failed"; exit 1; }

# retention: keep latest $RETENTION remote generations (OC disk is shared with fuzz work)
ssh $SSH_OPTS "$OC" "cd ~/$REMOTE_DIR && ls -t ozzu-backup-*.tar.gz.enc 2>/dev/null | tail -n +$((RETENTION+1)) | xargs -r rm -f"

# verify newest generation: sha256 both ends
LATEST=$(ls -t "$SRC"/ozzu-backup-*.tar.gz.enc 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then write_status 0 "" false 0 "no local backups found"; exit 1; fi
LNAME=$(basename "$LATEST")
LSUM=$(sha256sum "$LATEST" | cut -d' ' -f1)
RSUM=$(ssh $SSH_OPTS "$OC" "sha256sum ~/$REMOTE_DIR/$LNAME 2>/dev/null | cut -d' ' -f1")
COUNT=$(ssh $SSH_OPTS "$OC" "ls ~/$REMOTE_DIR/ozzu-backup-*.tar.gz.enc 2>/dev/null | wc -l")

if [ "$LSUM" = "$RSUM" ] && [ -n "$RSUM" ]; then
  write_status 1 "$LNAME" true "$COUNT" "sync+checksum OK"
else
  write_status 0 "$LNAME" false "$COUNT" "checksum mismatch: local=$LSUM remote=$RSUM"
  exit 1
fi
