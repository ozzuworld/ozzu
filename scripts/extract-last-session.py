#!/usr/bin/env python3
# extract-last-session.py — extract the tail of the most recent SUBSTANTIVE
# Cipher session from on-disk transcripts across ALL providers/harnesses:
#   - Claude Code:  ~/.claude/projects/*/*.jsonl        (any cwd slug)
#   - Reasonix:     ~/.reasonix/projects/*/sessions/*.jsonl (any cwd slug)
#   - Reasonix cold archive: ~/.reasonix/archive/*.jsonl
#   - opencode:     ~/.local/share/opencode/opencode.db (SQLite)
# This is what keeps Cipher's timeline linear regardless of which runtime was
# used last — cipher.sh appends the result as "Last Conversation" to
# CLAUDE.local.md. The provider is irrelevant; Cipher carries the memory.
#
# Selection: newest-first, but SKIPS sessions that parse to less than
# MIN_SUBSTANTIVE_CHARS (throwaway test sessions like "Reply with exactly: OK"
# used to shadow real work and cause amnesia). Live sessions (lock files or
# touched within MIN_AGE_SECONDS) are never picked.
#
# Output format (consumed by cipher.sh awk filter):
#   [user] <text>
#   [cipher] <text>
#
# Args:
#   --max-chars N   cap output at N chars from the END (default 15000)
#   --skip-current SESSION_KEY  exclude sessions whose key contains this
#   --print-mtime   print the unix mtime of the chosen session instead of content
#   --list          print candidates (newest first) as TSV: mtime, key, source

import argparse
import glob
import json
import os
import sqlite3
import sys
import time

HOME = os.path.expanduser('~')

# A session still being written (lock sibling or touched recently) must never
# be picked — only finished sessions go into the timeline.
MIN_AGE_SECONDS = 60
# Sessions whose parsed transcript is shorter than this are noise (connectivity
# tests, "OK" checks). Never let one shadow a real working session.
MIN_SUBSTANTIVE_CHARS = 200


# Locks older than this are stale leftovers (reasonix does not always clean up
# after itself) — a hours-old lock must not hide a finished session forever.
STALE_LOCK_SECONDS = 600


def _lock_is_live(lock_path):
    try:
        return time.time() - os.path.getmtime(lock_path) < STALE_LOCK_SECONDS
    except OSError:
        return False


def is_live_file(path):
    if os.path.exists(path + '.lock') and _lock_is_live(path + '.lock'):
        return True
    if os.path.exists(path + '.lease.lock') and _lock_is_live(path + '.lease.lock'):
        return True
    if time.time() - os.path.getmtime(path) < MIN_AGE_SECONDS:
        return True
    return False


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
    for prefix in ('<task-notification>', '<local-command-', '<command-name>',
                   '<command-message>', '<system-reminder>', '<user-memory>',
                   'Caveat: The messages below were generated'):
        if s.startswith(prefix):
            return True
    return False


def parse_jsonl(path):
    """Parse Claude Code or Reasonix JSONL into [(role, text), ...]."""
    turns = []
    with open(path, 'r', errors='replace') as f:
        for line in f:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(e, dict):
                continue
            # Reasonix format: {"role": "user|assistant", "content": "..."}
            if e.get('type') is None and e.get('role') in ('user', 'assistant'):
                text = extract_text(e.get('content', ''))
                if is_synthetic(text) or not text.strip():
                    continue
                role = 'user' if e['role'] == 'user' else 'cipher'
                turns.append((role, text.strip()))
                continue
            # Claude Code format: {"type": "user|assistant", "message": {"content": ...}}
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


def file_session_times(path):
    """Best-effort (started_at_ms, ended_at_ms) for a transcript file."""
    mtime_ms = int(os.path.getmtime(path) * 1000)
    start_ms = mtime_ms
    # Reasonix filenames carry the start time: YYYYMMDD-HHMMSS.xxx-<model>.jsonl
    base = os.path.basename(path)
    if len(base) >= 15 and base[8] == '-' and base[15] == '.':
        try:
            from datetime import datetime
            dt = datetime.strptime(base[:15], '%Y%m%d-%H%M%S')
            start_ms = int(dt.timestamp() * 1000)
        except ValueError:
            pass
    else:
        # Claude Code lines carry ISO timestamps — sample head and tail
        try:
            first_ts = last_ts = None
            with open(path, 'r', errors='replace') as f:
                head = [next(f, None) for _ in range(30)]
            lines = [l for l in head if l]
            for l in lines:
                try:
                    ts = json.loads(l).get('timestamp')
                    if ts:
                        from datetime import datetime
                        first_ts = int(datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000)
                        break
                except Exception:
                    continue
            if first_ts:
                start_ms = first_ts
        except OSError:
            pass
    return start_ms, mtime_ms


def discover_file_sessions(skip_key=None):
    """Yield candidate dicts for claude + reasonix jsonl transcripts."""
    candidates = []
    patterns = [
        ('claude', os.path.join(HOME, '.claude', 'projects', '*', '*.jsonl')),
        ('reasonix', os.path.join(HOME, '.reasonix', 'projects', '*', 'sessions', '*.jsonl')),
        ('reasonix-archive', os.path.join(HOME, '.reasonix', 'archive', '*.jsonl')),
    ]
    for provider, pattern in patterns:
        for f in glob.glob(pattern):
            base = os.path.basename(f)
            # Reasonix companion files — main transcript only
            if '.events.jsonl' in base or '.recovery' in base:
                continue
            try:
                if os.path.getsize(f) < 1024:
                    continue
                mtime = os.path.getmtime(f)
            except OSError:
                continue
            key = f'{provider}:{os.path.splitext(base)[0]}'
            if skip_key and skip_key in key:
                continue
            candidates.append({
                'mtime': mtime,
                'key': key,
                'provider': provider,
                'path': f,
                'live': is_live_file(f),
                'source': f,
            })
    return candidates


def discover_opencode_sessions(skip_key=None):
    """Yield candidate dicts for opencode sessions stored in SQLite."""
    db_path = os.path.join(HOME, '.local', 'share', 'opencode', 'opencode.db')
    if not os.path.exists(db_path):
        return []
    candidates = []
    try:
        conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=3)
        cur = conn.cursor()
        rows = cur.execute(
            "SELECT id, directory, time_created, time_updated FROM session "
            "WHERE time_updated IS NOT NULL"
        ).fetchall()
        conn.close()
        now_ms = time.time() * 1000
        for sid, directory, t_created, t_updated in rows:
            if directory and os.path.basename(directory) not in ('ozzu',):
                # Only Cipher's own box projects — everything here is Cipher,
                # but skip foreign repos if ever present.
                if '/ozzu' not in (directory or ''):
                    continue
            key = f'opencode:{sid}'
            if skip_key and skip_key in key:
                continue
            candidates.append({
                'mtime': t_updated / 1000.0,
                'key': key,
                'provider': 'opencode',
                'path': db_path,
                'session_id': sid,
                'time_created': t_created,
                'live': (now_ms - t_updated) < MIN_AGE_SECONDS * 1000,
                'source': db_path,
            })
    except sqlite3.Error:
        pass
    return candidates


def discover_all(skip_key=None):
    cands = discover_file_sessions(skip_key) + discover_opencode_sessions(skip_key)
    cands.sort(key=lambda c: c['mtime'], reverse=True)
    return cands


def parse_opencode_session(db_path, session_id):
    turns = []
    try:
        conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=3)
        cur = conn.cursor()
        rows = cur.execute(
            "SELECT m.data, p.data FROM message m JOIN part p ON p.message_id = m.id "
            "WHERE m.session_id = ? ORDER BY m.time_created, p.time_created",
            [session_id]
        ).fetchall()
        conn.close()
        for msg_raw, part_raw in rows:
            try:
                msg = json.loads(msg_raw)
                part = json.loads(part_raw)
            except (json.JSONDecodeError, TypeError):
                continue
            role = msg.get('role')
            if role not in ('user', 'assistant'):
                continue
            if part.get('type') != 'text':
                continue
            text = (part.get('text') or '').strip()
            if not text or is_synthetic(text):
                continue
            turns.append(('user' if role == 'user' else 'cipher', text))
    except sqlite3.Error:
        pass
    return turns


def parse_session(candidate):
    if candidate['provider'] == 'opencode':
        return parse_opencode_session(candidate['path'], candidate['session_id'])
    return parse_jsonl(candidate['path'])


def session_times(candidate):
    if candidate['provider'] == 'opencode':
        return (candidate.get('time_created') or int(candidate['mtime'] * 1000),
                int(candidate['mtime'] * 1000))
    return file_session_times(candidate['path'])


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


def find_latest_substantive(skip_key=None, max_chars=15000):
    """Newest-first walk; return (candidate, turns, text) of the first session
    that parses to a substantive transcript. Never returns throwaway noise."""
    for cand in discover_all(skip_key):
        if cand['live']:
            continue
        turns = parse_session(cand)
        text = format_turns(turns, max_chars)
        if len(text) >= MIN_SUBSTANTIVE_CHARS:
            return cand, turns, text
    return None, [], ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max-chars', type=int, default=15000)
    ap.add_argument('--skip-current', default=None,
                    help='Session key substring to skip (avoid loading the live one)')
    ap.add_argument('--print-mtime', action='store_true',
                    help='Print mtime of selected session instead of content')
    ap.add_argument('--list', action='store_true',
                    help='List candidates newest-first as TSV and exit')
    args = ap.parse_args()

    if args.list:
        for c in discover_all(args.skip_current):
            live = 'LIVE' if c['live'] else 'ok'
            print(f"{int(c['mtime'])}\t{c['key']}\t{live}")
        return 0

    cand, turns, text = find_latest_substantive(args.skip_current, args.max_chars)
    if not cand:
        return 1

    if args.print_mtime:
        print(int(cand['mtime']))
        return 0

    sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    main()
