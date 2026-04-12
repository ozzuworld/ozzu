#!/usr/bin/env bash
# volts-compact.sh — Post-compaction state restore
# Called by SessionStart hook with "compact" matcher.
# Replaces post-compact-directive-load.sh with Ledger-first approach.
# Outputs structured Pulse with all typed fields + auto-loads Canon files.

exec /home/gcp/ozzu/.claude/hooks/post-compact-directive-load.sh
