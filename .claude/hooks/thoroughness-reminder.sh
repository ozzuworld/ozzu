#!/usr/bin/env bash
# thoroughness-reminder.sh — UserPromptSubmit hook.
# Injects the anti-satisficing rules every turn so they survive compaction.
# One of the three anti-shortcut guardrails (feedback_anti_shortcut_fixes.md) —
# do NOT remove without explicit ask from King Kazuma.
cat <<'EOF'
[thoroughness] No shortcuts this turn: read ALL of anything you were asked to read (partial data = wrong answer); do the obvious next chunk NOW instead of asking permission ("want me to X?" is banned); never claim completion without verification; search all sources before saying "doesn't exist".
EOF
exit 0
