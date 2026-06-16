#!/bin/bash
# eval-reaper.sh — contain orphaned eval/farm command processes on dev-01 during an offense eval.
#
# Why: eval-offense.js SIGKILLs its LOCAL ssh on per-command timeout, but the REMOTE
# `bash -s` and the children the model spawned (recursive greps/finds, scan tools) can
# survive as orphans (reparented to init, ppid=1) and pin cores. On an 8-core box a few
# runaway greps are enough to drive load past 40. This reaps such orphans every ~40s.
#
# Safety: only targets processes whose PARENT is init (ppid=1) — i.e. already orphaned,
# never an in-flight command (those have a live sshd parent). Names are restricted to the
# eval's own shell + known offensive/search tools, never systemd-managed dev-01 services
# (Prowlarr/Sonarr/redis/mysql/dockerd/node etc.). Run during an eval; kill it after.
set +e
KILL_COMMS="grep find sqlmap nmap gobuster hydra nikto dirb ffuf wfuzz dirsearch masscan"
while true; do
  while read -r pid ppid comm args; do
    [ "$ppid" = "1" ] || continue
    # orphaned remote eval shell: bash -s
    if [ "$comm" = "bash" ] && printf '%s' "$args" | grep -q -- '-s'; then
      kill -9 "$pid" 2>/dev/null; sudo -n kill -9 "$pid" 2>/dev/null; continue
    fi
    # orphaned runaway search/scan tools
    for k in $KILL_COMMS; do
      if [ "$comm" = "$k" ]; then
        kill -9 "$pid" 2>/dev/null; sudo -n kill -9 "$pid" 2>/dev/null; break
      fi
    done
  done < <(ps -eo pid=,ppid=,comm=,args=)
  sleep 40
done
