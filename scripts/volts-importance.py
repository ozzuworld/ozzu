#!/usr/bin/env python3
"""Volts importance scoring — heuristic scoring for conversation turns.

Scores each message 1-10 based on content patterns. No LLM calls.
Used by volts-session-end.sh and volts-checkpoint.sh to filter
what goes into the Ledger's recentInstructions.

Score table:
  10 — User frustration (profanity + caps), explicit "NEVER do X"
   9 — Direct instruction ("build X", "fix Y", "set up Z")
   8 — Decision ("use VPN not Decodo", "we will use X")
   7 — Approval/rejection of plan ("approved", "yes do it", "no")
   6 — State question ("are we routing through proxy?")
   5 — Informational question
   3 — Assistant explanation
   2 — Assistant status update
   1 — Tool output / raw data
"""
import re
import json
import sys


def score_message(role: str, content: str) -> int:
    """Score a single message by importance. Returns 1-10."""
    if not content or not content.strip():
        return 1

    text = content.strip()
    upper_ratio = sum(1 for c in text if c.isupper()) / max(len(text), 1)

    if role == "user":
        # 10: Frustration — profanity + caps, or explicit NEVER/ALWAYS rules
        profanity = bool(re.search(r'\b(fuck|shit|stupid|idiot|damn|hell)\b', text, re.I))
        has_never = bool(re.search(r'\b(NEVER|ALWAYS|DO NOT|DONT|DON\'T)\b', text))
        if profanity and (upper_ratio > 0.3 or has_never):
            return 10
        if has_never:
            return 10

        # 9: Direct instruction — imperative verbs
        if re.match(r'^(build|fix|set up|setup|create|add|remove|delete|deploy|implement|make|write|update|change|move|install|configure|run|start|stop|restart|check|verify|test|open|close|push|pull|merge|revert|rollback|refactor|optimize|migrate|route|connect|disconnect|upload|download|send|kill|enable|disable)\b', text, re.I):
            return 9
        # Also catch "please <verb>" and "go and <verb>" and "lets <verb>"
        if re.match(r'^(please|go and|go|lets|let\'s|can you|could you|I need you to|I want you to|you need to|we need to)\s+(build|fix|set up|setup|create|add|remove|delete|deploy|implement|make|write|update|change|move|install|configure|run|start|stop|restart)\b', text, re.I):
            return 9

        # 8: Decision — choosing between options
        if re.search(r'\b(we will use|we dont want|we don\'t want|use .+ not .+|use .+ instead|lets not|let\'s not|I prefer|switch to|go with|stick with|from now on)\b', text, re.I):
            return 8

        # 7: Approval/rejection
        if re.match(r'^(yes|approved|approve|no|rejected|reject|do it|go ahead|go for it|proceed|cancel|abort|stop|nah|nope|ok do it|ok go)\b', text, re.I):
            return 7
        if len(text) < 20 and re.match(r'^(yes|no|ok|approved|rejected|do it|go)\s*$', text, re.I):
            return 7

        # 6: State question
        if re.search(r'\b(are we|is it|is the|does it|do we|have we|what is the status|what\'s the status|where are we|how is|is .+ working|is .+ running|is .+ connected|is .+ ready)\b', text, re.I):
            return 6

        # 5: Informational question
        if text.rstrip().endswith('?') or re.match(r'^(what|how|why|when|where|which|who|can|could|would|should|do|does|is|are)\b', text, re.I):
            return 5

        # Default user message
        return 6

    else:
        # Assistant messages
        # 3: Explanation (longer text, contains "because", "the reason", etc.)
        if len(text) > 300 or re.search(r'\b(because|the reason|this means|in other words|essentially|basically)\b', text, re.I):
            return 3

        # 2: Status update
        if re.search(r'\b(done|completed|working|deployed|merged|committed|fixed|ready|running|started|stopped|failed|error|success)\b', text, re.I):
            return 2

        # 1: Tool output / raw data (code blocks, JSON, long output)
        if text.startswith('```') or text.startswith('{') or text.startswith('['):
            return 1

        return 2


def score_turns(turns: list) -> list:
    """Score a list of turns. Each turn is {role, content}.
    Returns list with added 'importance' field."""
    scored = []
    for turn in turns:
        role = turn.get("role", "assistant")
        content = turn.get("content", "")
        importance = score_message(role, content)
        scored.append({**turn, "importance": importance})
    return scored


def filter_important(turns: list, min_score: int = 6, max_items: int = 10) -> list:
    """Filter turns to only those meeting minimum importance threshold.
    Returns most recent max_items turns scoring >= min_score."""
    important = [t for t in turns if t.get("importance", 0) >= min_score]
    return important[-max_items:]


if __name__ == "__main__":
    # CLI: read JSON turns from stdin, output scored turns
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        # Self-test
        tests = [
            ("user", "WHY THE FUCK IS THIS NOT WORKING", 10),
            ("user", "NEVER commit to main", 10),
            ("user", "build the fleet infrastructure", 9),
            ("user", "please remove everything related to Decodo", 9),
            ("user", "we will use the self-hosted proxy", 8),
            ("user", "approved", 7),
            ("user", "yes", 7),
            ("user", "are we already routing through proxy?", 6),
            ("user", "how many proxies will we need?", 5),
            ("assistant", "The r605 VPN is down because the HMAC authentication is failing due to a key mismatch.", 3),
            ("assistant", "Done. Fleet is live.", 2),
        ]
        passed = 0
        for role, text, expected in tests:
            got = score_message(role, text)
            status = "PASS" if got == expected else "FAIL"
            if status == "FAIL":
                print(f"  {status}: score_message({role!r}, {text[:50]!r}...) = {got}, expected {expected}")
            else:
                passed += 1
        print(f"{passed}/{len(tests)} tests passed")
        sys.exit(0 if passed == len(tests) else 1)

    # Normal mode: read turns from stdin
    raw = sys.stdin.read().strip()
    if not raw:
        print("[]")
        sys.exit(0)

    try:
        turns = json.loads(raw)
        if not isinstance(turns, list):
            turns = [turns]
    except json.JSONDecodeError:
        # Try line-delimited JSON
        turns = []
        for line in raw.split('\n'):
            line = line.strip()
            if line:
                try:
                    turns.append(json.loads(line))
                except json.JSONDecodeError:
                    continue

    scored = score_turns(turns)

    # Output mode
    if len(sys.argv) > 1 and sys.argv[1] == "--filter":
        min_score = int(sys.argv[2]) if len(sys.argv) > 2 else 6
        max_items = int(sys.argv[3]) if len(sys.argv) > 3 else 10
        filtered = filter_important(scored, min_score, max_items)
        print(json.dumps(filtered))
    else:
        print(json.dumps(scored))
