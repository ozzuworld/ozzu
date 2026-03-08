#!/usr/bin/env python3
"""
LAION-Face Worker v2 — runs on dev-01, reads URL files, processes through local face API.

Key optimization: sends CONCURRENT batches to the face API so download timeouts
on dead URLs don't block the entire pipeline.

Usage (on dev-01):
    python3 laion-face-worker.py /path/to/face_urls_part_000.jsonl [--batch-size 200] [--concurrent 3]
    python3 laion-face-worker.py /path/to/urls_dir/  # process all .jsonl files
"""

import os
import sys
import json
import time
import argparse
import requests
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

FACE_API_URL = 'http://localhost:5555'
BATCH_SIZE = 200      # URLs per API call (face API uses 24 download workers internally)
CONCURRENT = 3        # Parallel batch requests to face API
PROGRESS_DIR = os.path.expanduser('~/laion-progress')


def get_stats():
    try:
        r = requests.get(f'{FACE_API_URL}/stats', timeout=5)
        return r.json()
    except:
        return None


def send_batch(items):
    """Send batch to face API. Returns (indexed, failed, skipped)."""
    try:
        r = requests.post(
            f'{FACE_API_URL}/batch',
            data={'batch': json.dumps(items)},
            timeout=300  # 5 min — 200 URLs with 4s timeout = ~35s with 24 workers
        )
        if r.status_code == 200:
            d = r.json()
            return d.get('indexed', 0), d.get('failed', 0), d.get('skipped', 0)
        return 0, len(items), 0
    except Exception as e:
        return 0, len(items), 0


def process_file(filepath, batch_size=200, concurrent=3, resume=True):
    """Process a single JSONL file of face URLs."""
    filepath = Path(filepath)
    progress_file = Path(PROGRESS_DIR) / f'{filepath.stem}.progress'

    # Load URLs
    urls = []
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    urls.append(json.loads(line))
                except:
                    urls.append({'url': line, 'label': '', 'source_platform': 'laion'})

    # Resume support
    start_idx = 0
    if resume and progress_file.exists():
        try:
            start_idx = int(progress_file.read_text().strip())
        except:
            start_idx = 0
        if start_idx >= len(urls):
            print(f'[{filepath.name}] Already completed ({len(urls):,} URLs)')
            return 0, 0, 0

    total_indexed = 0
    total_failed = 0
    total_skipped = 0
    start_time = time.time()

    remaining = len(urls) - start_idx
    print(f'[{filepath.name}] Processing {remaining:,} URLs (starting at {start_idx}, batch={batch_size}, concurrent={concurrent})')

    # Build all batches
    all_batches = []
    for i in range(start_idx, len(urls), batch_size):
        batch = urls[i:i + batch_size]
        items = [{'url': u['url'], 'label': u.get('caption', u.get('label', ''))[:100], 'source_platform': 'laion', 'timeout': 4} for u in batch]
        all_batches.append((i, items))

    # Process with concurrent batch submissions
    batch_num = 0
    with ThreadPoolExecutor(max_workers=concurrent) as executor:
        futures = {}

        for idx, (offset, items) in enumerate(all_batches):
            # Submit batch
            future = executor.submit(send_batch, items)
            futures[future] = (offset, len(items))

            # When we have enough in-flight or it's the last batch, collect results
            if len(futures) >= concurrent or idx == len(all_batches) - 1:
                for done_future in as_completed(futures):
                    offset, count = futures[done_future]
                    try:
                        indexed, failed, skipped = done_future.result()
                        total_indexed += indexed
                        total_failed += failed
                        total_skipped += skipped
                    except:
                        total_failed += count

                    # Save progress
                    progress_file.write_text(str(offset + count))
                    batch_num += 1

                    # Status update every 10 batches
                    if batch_num % 10 == 0:
                        elapsed = time.time() - start_time
                        rate = total_indexed / (elapsed / 60) if elapsed > 0 else 0
                        processed = offset + count - start_idx
                        pct = processed / remaining * 100 if remaining > 0 else 100
                        eta_min = (remaining - processed) / (processed / elapsed) / 60 if processed > 0 and elapsed > 0 else 0
                        print(f'  [{filepath.name}] {pct:.0f}% ({offset+count:,}/{len(urls):,}) | +{total_indexed:,} faces | {rate:.0f}/min | ETA {eta_min:.0f}min')

                futures.clear()

    elapsed = time.time() - start_time
    rate = total_indexed / (elapsed / 60) if elapsed > 0 else 0
    print(f'[{filepath.name}] Done: +{total_indexed:,} faces, {total_failed:,} failed, {total_skipped:,} skipped ({rate:.0f} faces/min, {elapsed/60:.1f}min)')
    return total_indexed, total_failed, total_skipped


def main():
    parser = argparse.ArgumentParser(description='LAION-Face Worker v2 (dev-01)')
    parser.add_argument('path', help='JSONL file or directory of JSONL files')
    parser.add_argument('--batch-size', type=int, default=BATCH_SIZE)
    parser.add_argument('--concurrent', type=int, default=CONCURRENT)
    parser.add_argument('--no-resume', action='store_true')
    args = parser.parse_args()

    os.makedirs(PROGRESS_DIR, exist_ok=True)

    path = Path(args.path)
    if path.is_dir():
        files = sorted(path.glob('*.jsonl'))
    else:
        files = [path]

    print(f'=== LAION-Face Worker v2 ===')
    print(f'Files: {len(files)}')
    print(f'Batch size: {args.batch_size}, Concurrent: {args.concurrent}')
    stats = get_stats()
    if stats:
        print(f'Qdrant faces: {stats.get("points_count", "?"):,}')
    print()

    grand_indexed = 0
    grand_failed = 0
    grand_skipped = 0
    start = time.time()

    for f in files:
        indexed, failed, skipped = process_file(f, args.batch_size, args.concurrent, resume=not args.no_resume)
        grand_indexed += indexed
        grand_failed += failed
        grand_skipped += skipped

    elapsed = time.time() - start
    rate = grand_indexed / (elapsed / 60) if elapsed > 0 else 0
    print(f'\n=== Summary ===')
    print(f'Total indexed: {grand_indexed:,}')
    print(f'Total failed: {grand_failed:,}')
    print(f'Total skipped: {grand_skipped:,}')
    print(f'Rate: {rate:.0f} faces/min')
    print(f'Time: {elapsed/60:.1f} min')

    stats = get_stats()
    if stats:
        print(f'Qdrant total: {stats.get("points_count", "?"):,}')


if __name__ == '__main__':
    main()
