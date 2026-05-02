#!/usr/bin/env python3
# extract-last-session.py — extract the tail of the most recent Cipher session
# from on-disk Claude Code JSONL transcripts. Used by cipher.sh when the bridge
# is unreachable or as a freshness check against postgres.
#
# Output format (consumed by cipher.sh awk filter):
#   [user] <text>
#   [cipher] <text>
#
# Args:
#   --max-chars N  cap output at N chars from the END (default 15000)
#   --skip-current SESSION_ID  exclude this session ID (avoid loading the live one)
#   --print-mtime  print the unix mtime of the chosen file instead of content

import argparse
import glob
import json
import os
import sys

PROJECT_DIRS = [
    os.path.expanduser('~/.claude/projects/-home-gcp-ozzu-scripts/'),
    os.path.expanduser('~/.claude/projects/-home-gcp-ozzu/'),
]


def find_latest_jsonl(skip_session_id=None):
    candidates = []
    for d in PROJECT_DIRS:
        if not os.path.isdir(d):
            continue
        for f in glob.glob(os.path.join(d, '*.jsonl')):
            if os.path.getsize(f) < 1024:
                continue
            if skip_session_id and skip_session_id in os.path.basename(f):
                continue
            candidates.append((os.path.getmtime(f), f))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def extract_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get('type') == 'text':
                parts.append(c.get('text', ''))
        return '\n'.join(p for p in parts if p)
    return ''


def is_synthetic(text):
    if not text:
        return True
    s = text.lstrip()
    if s.startswith('<task-notification>') or s.startswith('<local-command-'):
        return True
    if s.startswith('<command-name>') or s.startswith('<command-message>'):
        return True
    if s.startswith('Caveat: The messages below were generated'):
        return True
    return False


def parse_jsonl(path):
    turns = []
    with open(path, 'r', errors='replace') as f:
        for line in f:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = e.get('type')
            if t not in ('user', 'assistant'):
                continue
            msg = e.get('message') or {}
            text = extract_text(msg.get('content', ''))
            if is_synthetic(text) or not text.strip():
                continue
            role = 'user' if t == 'user' else 'cipher'
            turns.append((role, text.strip()))
    return turns


def format_turns(turns, max_chars):
    out_lines = []
    total = 0
    for role, text in reversed(turns):
        block = f'[{role}] {text}\n'
        if total + len(block) > max_chars and out_lines:
            break
        out_lines.append(block)
        total += len(block)
    out_lines.reverse()
    return ''.join(out_lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max-chars', type=int, default=15000)
    ap.add_argument('--skip-current', default=None,
                    help='Session ID to skip (avoid loading the live session)')
    ap.add_argument('--print-mtime', action='store_true',
                    help='Print mtime of selected JSONL instead of content')
    args = ap.parse_args()

    path = find_latest_jsonl(skip_session_id=args.skip_current)
    if not path:
        return 1

    if args.print_mtime:
        print(int(os.path.getmtime(path)))
        return 0

    turns = parse_jsonl(path)
    if not turns:
        return 1

    sys.stdout.write(format_turns(turns, args.max_chars))
    return 0


if __name__ == '__main__':
    sys.exit(main())
