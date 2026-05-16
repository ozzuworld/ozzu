#!/usr/bin/env bash
# CUCM 15 publisher upgrade — drives the platform CLI `utils system upgrade initiate` wizard.
#
# Directive: dir_1777219561098
# From: 15.0.1.12900-234 (RTM)
# To:   15.0.1.14901-2  (latest UNRST upgrade ISO King Kazuma downloaded)
#
# Prereqs:
#   - cucm-01 platform admin creds in /home/gcp/ozzu/private/cucm/cucm-01-platform-creds.txt
#   - dev-01 has 172.168.0.250/24 alias on wlan0 (run scripts/dev01-cucm-bridge.sh first)
#   - ISO at /home/hadmin/cucm-iso/<filename> on dev-01
#   - hadmin SSH password to dev-01 must be available in $HADMIN_SUDO_PASS
#     (source ~/.ozzu-secrets or set inline before running this script).
#
# This script writes an expect playbook to dev-01, runs it from there (since dev-01 is on
# the same L2 segment as cucm-01), then polls upgrade status every 60s until complete.

set -uo pipefail

CREDS_FILE="/home/gcp/ozzu/private/cucm/cucm-01-platform-creds.txt"
[[ -f "$CREDS_FILE" ]] || { echo "Missing $CREDS_FILE" >&2; exit 1; }

CUCM_HOST=$(grep '^host:' "$CREDS_FILE" | awk '{print $2}')
CUCM_USER=$(grep '^user:' "$CREDS_FILE" | awk '{print $2}')
CUCM_PASS=$(grep '^pass:' "$CREDS_FILE" | awk '{print $2}')

SFTP_HOST="172.168.0.250"            # dev-01's wlan0 alias on the lab subnet
SFTP_USER="hadmin"
SFTP_PASS="${HADMIN_SUDO_PASS:?HADMIN_SUDO_PASS not set — source ~/.ozzu-secrets first}"
SFTP_DIR="/home/hadmin/cucm-iso"
ISO_NAME="UCSInstall_UCOS_UNRST_15.0.1.14901-2.sha512.iso"
EXPECTED_BUILD="15.0.1.14901-2"

echo "=== 1. Pre-flight: verify ISO is staged on dev-01 ==="
ssh dev-01 "test -f $SFTP_DIR/$ISO_NAME && stat -c '%n %s bytes' $SFTP_DIR/$ISO_NAME" || {
  echo "ISO not at $SFTP_DIR/$ISO_NAME" >&2; exit 2; }

echo
echo "=== 2. Pre-flight: cucm-01 reachable from dev-01 + current version ==="
ssh dev-01 "ping -c 2 -W 2 $CUCM_HOST >/dev/null && echo 'cucm-01 ping OK'"

echo
echo "=== 3. Stage upgrade-driver expect script on dev-01 ==="
scp /home/gcp/ozzu/scripts/cucm-upgrade-drive.exp dev-01:/tmp/cucm-upgrade-drive.exp >/dev/null
ssh dev-01 'chmod +x /tmp/cucm-upgrade-drive.exp && echo "expect script staged"'

echo
echo "=== 4. KICK OFF UPGRADE — driving wizard ==="
ssh dev-01 "/tmp/cucm-upgrade-drive.exp '$CUCM_USER' '$CUCM_HOST' '$CUCM_PASS' '$SFTP_DIR' '$SFTP_HOST' '$SFTP_USER' '$SFTP_PASS'" 2>&1 | tee /tmp/cucm-upgrade-init.log

echo
echo "=== 5. Polling upgrade status every 60s ==="
echo "(Will exit when 'switch-version complete' or 'failed' appears, or after 120 min)"
DEADLINE=$(($(date +%s) + 7200))
while [[ $(date +%s) -lt $DEADLINE ]]; do
  STATUS=$(ssh dev-01 "/tmp/cucm-upgrade-drive.exp.status '$CUCM_USER' '$CUCM_HOST' '$CUCM_PASS'" 2>/dev/null \
            || ssh dev-01 "expect -c '
              set timeout 60
              log_user 0
              spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
                -o KexAlgorithms=+diffie-hellman-group14-sha1 -o HostKeyAlgorithms=+ssh-rsa \
                -o PubkeyAuthentication=no -o PreferredAuthentications=password \
                $CUCM_USER@$CUCM_HOST
              expect { -re {yes/no} {send \"yes\r\";exp_continue} -re {assword} {send \"$CUCM_PASS\r\"} }
              expect -re {admin:}
              send \"set cli pagination off\r\"
              expect -re {admin:}
              log_user 1
              send \"utils system upgrade status\r\"
              expect { -re {admin:} {} -re {Press <enter>} {send \" \"; exp_continue} }
              send \"quit\r\"
              expect eof'")
  echo "[$(date +%T)] $(echo "$STATUS" | tail -20)"
  if echo "$STATUS" | grep -qiE "switch-version completed|upgrade complete|operation succeeded"; then
    echo "==> upgrade COMPLETE"
    break
  fi
  if echo "$STATUS" | grep -qiE "upgrade failed|operation failed"; then
    echo "==> upgrade FAILED" >&2
    exit 11
  fi
  sleep 60
done

echo
echo "=== 6. Post-upgrade verification: show version active ==="
ssh dev-01 "expect -c '
  set timeout 60
  log_user 0
  spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o KexAlgorithms=+diffie-hellman-group14-sha1 -o HostKeyAlgorithms=+ssh-rsa \
    -o PubkeyAuthentication=no -o PreferredAuthentications=password \
    $CUCM_USER@$CUCM_HOST
  expect { -re {yes/no} {send \"yes\r\";exp_continue} -re {assword} {send \"$CUCM_PASS\r\"} }
  expect -re {admin:}
  send \"set cli pagination off\r\"
  expect -re {admin:}
  log_user 1
  send \"show version active\r\"
  expect -re {admin:}
  send \"show version inactive\r\"
  expect -re {admin:}
  send \"quit\r\"
  expect eof'"

echo
echo "=== Done. Verify version above matches expected: $EXPECTED_BUILD ==="
