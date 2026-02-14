#!/bin/bash
# Cipher Overnight Training Runner
# Launches sequential Claude Code sessions that train Cipher
# Run in tmux: tmux new-session -d -s training './run-training.sh'

set -e
cd /home/gcp/ozzu

# Prevent nested Claude Code session detection
unset CLAUDECODE

TRAINING_DIR="backend/bridge/training"
LOG_DIR="/tmp/ozzu-training"
mkdir -p "$LOG_DIR"

BRIDGE="http://localhost:3333"
MAX_SESSIONS=6
SESSION_TIMEOUT=5400  # 90 min per session (in seconds)

log() {
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_DIR/runner.log"
}

# Check bridge is running
check_bridge() {
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" "$BRIDGE/status" 2>/dev/null || echo "000")
  if [ "$status" != "200" ]; then
    log "ERROR: Bridge not responding (HTTP $status). Waiting 30s..."
    sleep 30
    return 1
  fi
  return 0
}

# Wait for any running directive agents to finish
wait_for_agents() {
  local max_wait=300  # 5 min max
  local waited=0
  while [ $waited -lt $max_wait ]; do
    local agents
    agents=$(curl -s "$BRIDGE/directives/agents" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    if [ "$agents" = "0" ]; then
      return 0
    fi
    log "Waiting for $agents running agent(s) to finish..."
    sleep 30
    waited=$((waited + 30))
  done
  log "WARN: Agents still running after ${max_wait}s, proceeding anyway"
}

log "=== Cipher Training Started ==="
log "Max sessions: $MAX_SESSIONS, timeout per session: ${SESSION_TIMEOUT}s"
log "Training curriculum: $TRAINING_DIR/curriculum.md"

for i in $(seq 1 $MAX_SESSIONS); do
  log "--- Session $i/$MAX_SESSIONS ---"

  # Check bridge health
  if ! check_bridge; then
    if ! check_bridge; then
      log "Bridge still down. Skipping session $i."
      continue
    fi
  fi

  SESSION_LOG="$LOG_DIR/session-$i.log"

  # Build the prompt for this session based on current state
  CURRENT_PHASE=$(python3 -c "import json; print(json.load(open('$TRAINING_DIR/state.json'))['currentPhase'])" 2>/dev/null || echo "1a")

  PROMPT="You are running an overnight Cipher training session on the ozzu project.

READ THESE FILES FIRST:
1. /home/gcp/ozzu/backend/bridge/training/curriculum.md — the full training plan
2. /home/gcp/ozzu/backend/bridge/training/state.json — current progress
3. /home/gcp/ozzu/CLAUDE.md — project context

Current phase: $CURRENT_PHASE
Session: $i of $MAX_SESSIONS

YOUR ROLE: You are acting as King Kazuma (the architect) training Cipher (the AI agent).

FOR PHASE 1 (pipeline hardening): Make direct code changes to agent-spawner.js and server.js.
FOR PHASES 2-3 (directive testing): Submit directives via curl to $BRIDGE/directives, observe agent behavior by reading logs in /tmp/ozzu-bridge/, analyze and improve the agent prompts.
FOR PHASE 4: Review all logs, write the training report.

IMPORTANT RULES:
- After completing each sub-phase, update state.json with progress
- When submitting test directives, wait for the agent to finish (check logs) before analyzing
- Be methodical: change one thing, test, observe, iterate
- Don't rush — quality over quantity
- If a phase takes longer than expected, that's fine — do it right
- Commit and push code changes to main
- After modifying bridge code, restart bridge: docker compose -f /home/gcp/ozzu/backend/docker-compose.yml restart bridge

START WORKING NOW. Begin with whatever phase state.json says is current."

  log "Launching Claude Code for phase $CURRENT_PHASE..."

  # Run claude with timeout (dangerously-skip-permissions needed for non-interactive tmux)
  timeout "$SESSION_TIMEOUT" claude \
    --model opus \
    --dangerously-skip-permissions \
    -p "$PROMPT" \
    > "$SESSION_LOG" 2>&1 || true

  log "Session $i completed (phase was: $CURRENT_PHASE)"
  log "Log: $SESSION_LOG"

  # Brief pause between sessions
  sleep 10
done

log "=== Cipher Training Complete ==="
log "Review report at: $TRAINING_DIR/report-$(date +%Y-%m-%d).md"
log "Review logs at: $LOG_DIR/"
