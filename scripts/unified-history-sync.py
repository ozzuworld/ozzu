#!/usr/bin/env python3
# unified-history-sync.py — keep postgres conversation history in sync with
# EVERY provider transcript on disk (Claude Code, Reasonix + archive, opencode).
#
# Why: on-disk transcripts are the source of truth, but postgres drives the
# "Last session" header, /cipher/search and the fallback tail. Previously only
# Claude Code had a SessionEnd hook, so reasonix/opencode sessions never
# reached postgres and Cipher's own history looked frozen. This runs from
# cipher.sh at startup (before context pull) and is safe to run anytime.
#
# Idempotent: the bridge's /cipher/session-save dedupes by sessionId and by
# (turn_count + started_at) proximity, so re-runs never duplicate.
#
# Flags:
#   --quiet    one-line summary (startup mode)
#   --dry-run  report what would be ingested, POST nothing
#   --limit N  ingest at most N sessions this run (newest first)

import argparse
import hashlib
import importlib.util
import json
import os
import sys
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_URL = os.environ.get('BRIDGE_URL', 'http://localhost:3333')
# Local seen-cache: sessionIds the bridge already accepted (success OR
# duplicate). Stops re-POSTing sessions whose matching row carries no
# sessionId (legacy rows) — the bridge would re-detect them forever.
SEEN_CACHE = os.path.join(os.path.expanduser('~'),
                          '.cache', 'cipher', 'history-sync-seen.json')


def load_seen():
    try:
        with open(SEEN_CACHE) as f:
            return set(json.load(f))
    except (OSError, ValueError):
        return set()


def save_seen(seen):
    try:
        os.makedirs(os.path.dirname(SEEN_CACHE), exist_ok=True)
        with open(SEEN_CACHE, 'w') as f:
            json.dump(sorted(seen), f)
    except OSError:
        pass

# Load the extractor (shared discovery/parsing logic; dash in filename).
_spec = importlib.util.spec_from_file_location(
    'extract_last_session', os.path.join(HERE, 'extract-last-session.py'))
ext = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ext)


def bridge_get(path):
    req = urllib.request.Request(BRIDGE_URL + path)
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.read().decode('utf-8', 'replace')


def bridge_post(path, payload):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        BRIDGE_URL + path, data=data,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    try:
        raw = bridge_get('/cipher/ingested-sessions')
        ingested = set(json.loads(raw).get('sessionIds', []))
    except (urllib.error.URLError, OSError, ValueError):
        if not args.dry_run:
            if not args.quiet:
                print('bridge unreachable — skipping history sync', file=sys.stderr)
            return 0  # never block startup on this
        ingested = set()  # dry-run proceeds assuming empty DB
    seen = load_seen()
    known = ingested | seen

    candidates = [c for c in ext.discover_all() if not c['live']]
    ingested_now = 0
    duplicates = 0
    skipped_noise = 0
    errors = 0

    for cand in candidates:  # already newest-first
        if args.limit and ingested_now >= args.limit:
            break
        if cand['key'] in known:
            continue
        turns = ext.parse_session(cand)
        if len(turns) < 2 or sum(len(t) for _, t in turns) < 50:
            skipped_noise += 1
            continue
        started_ms, ended_ms = ext.session_times(cand)
        content_hash = hashlib.sha256(
            '\n'.join(f'{r}:{t}' for r, t in turns).encode('utf-8', 'replace')
        ).hexdigest()
        payload = {
            'sessionId': cand['key'],
            'contentHash': content_hash,
            'turns': [{'role': r, 'content': t} for r, t in turns],
            'startedAt': started_ms,
            'endedAt': ended_ms,
            'noLLM': True,
        }
        if args.dry_run:
            print(f"would ingest {cand['key']} ({len(turns)} turns, "
                  f"{ended_ms // 1000})")
            ingested_now += 1
            continue
        try:
            resp = bridge_post('/cipher/session-save', payload)
            if resp.get('duplicate'):
                duplicates += 1
            else:
                ingested_now += 1
            seen.add(cand['key'])  # accepted or matched — never POST again
        except (urllib.error.URLError, OSError, ValueError) as e:
            errors += 1
            if not args.quiet:
                print(f"failed {cand['key']}: {e}", file=sys.stderr)
            if errors >= 3:
                break  # bridge struggling — bail, retry next launch

    save_seen(seen)
    if args.quiet:
        print(f"history-sync: {ingested_now} ingested, {duplicates} duplicates, "
              f"{skipped_noise} noise skipped, {len(known)} already known")
    else:
        print(f"Ingested {ingested_now} session(s); {duplicates} duplicate(s); "
              f"{skipped_noise} trivial session(s) skipped; "
              f"{len(known)} already known; {errors} error(s).")
    return 0


if __name__ == '__main__':
    main()
