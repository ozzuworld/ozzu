#!/usr/bin/env python3
"""
LAION-Face Pipeline — Phase 1 of Face DB Scale-Up
Epic: dir_1772936492816 | Phase: dir_1772936668030

Streams through LAION relaion400m parquets, filters face-related captions,
extracts URLs, and sends them to dev-01's face API for download + ArcFace + Qdrant insert.

Usage:
    python3 laion-face-pipeline.py [--start-part N] [--end-part N] [--dry-run] [--extract-only]
"""

import os
import sys
import re
import json
import time
import argparse
import asyncio
import aiohttp
import pyarrow.parquet as pq
from pathlib import Path
from huggingface_hub import hf_hub_download

HF_TOKEN = os.environ.get('HF_TOKEN', '')
REPO_ID = 'laion/relaion400m'
CACHE_DIR = '/home/gcp/ozzu/data/laion-face/cache'
URL_OUTPUT_DIR = '/home/gcp/ozzu/data/laion-face/urls'
PROGRESS_FILE = '/home/gcp/ozzu/data/laion-face/progress.json'

# Face API on dev-01 (processes image URL → face detect → ArcFace embed → Qdrant insert)
# When running on GCP: use SSH port forward (ssh -L 5555:localhost:5555 dev-01)
# When running on dev-01: use localhost directly
FACE_API_URL = os.environ.get('FACE_API_URL', 'http://localhost:5555')

# Qdrant direct (for checking stats)
QDRANT_URL = 'http://localhost:6333'

# Batch settings
DOWNLOAD_BATCH_SIZE = 50  # URLs per batch to face API
CONCURRENT_BATCHES = 4    # Parallel batch requests
BATCH_DELAY = 0.5         # Seconds between batches

# Caption filter for face-related images
FACE_PATTERN = re.compile(
    r'\b('
    r'portrait|headshot|face|selfie|mugshot|profile photo|profile picture|'
    r'photo of|picture of|image of|photograph of|'
    r'politician|actor|actress|singer|president|CEO|minister|athlete|player|'
    r'coach|celebrity|model|professor|doctor|author|journalist|businessman|'
    r'businesswoman|director|founder|spokesperson|anchor|correspondent|'
    r'senator|governor|mayor|official|ambassador|diplomat|commander|general|'
    r'captain|chief|officer|leader|chairman|chairwoman|'
    r'woman|man|person|people|boy|girl|lady|gentleman|'
    r'smiling|laughing|posing|looking at camera|close-up|closeup'
    r')\b', re.IGNORECASE
)

# Parquet file name pattern
PARQUET_PATTERN = 'part-{:05d}-4227e361-38e7-40d5-8822-c6db46ea077c-c000.snappy.parquet'
TOTAL_PARTS = 128


def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    return {'completed_parts': [], 'total_urls_extracted': 0, 'total_faces_inserted': 0}


def save_progress(progress):
    with open(PROGRESS_FILE, 'w') as f:
        json.dump(progress, f, indent=2)


def filter_face_urls(parquet_path):
    """Extract face-related URLs from a LAION parquet file."""
    table = pq.read_table(parquet_path, columns=['url', 'caption', 'original_width', 'original_height', 'NSFW'])

    captions = table.column('caption').to_pylist()
    urls = table.column('url').to_pylist()
    widths = table.column('original_width').to_pylist()
    heights = table.column('original_height').to_pylist()
    nsfw_col = table.column('NSFW').to_pylist()

    face_urls = []
    for i, cap in enumerate(captions):
        if not cap or not FACE_PATTERN.search(cap):
            continue
        w, h = widths[i] or 0, heights[i] or 0
        if w < 100 or h < 100:
            continue
        if nsfw_col[i] == 'NSFW':
            continue
        url = urls[i]
        if url and url.startswith('http'):
            face_urls.append({
                'url': url,
                'caption': cap[:200],
                'width': w,
                'height': h
            })

    return face_urls


async def send_batch_to_face_api(session, urls, batch_num):
    """Send a batch of image URLs to dev-01 face API for processing.
    Uses the /batch endpoint which expects Form data with JSON batch string."""
    try:
        items = []
        for u in urls:
            entry = {
                'url': u['url'],
                'label': u.get('caption', '')[:100],
                'source_platform': 'laion',
                'nearby_text': u.get('caption', '')[:500],
            }
            # Extract domain from URL for context
            try:
                from urllib.parse import urlparse
                entry['domain'] = urlparse(u['url']).netloc
            except Exception:
                pass
            items.append(entry)
        form_data = aiohttp.FormData()
        form_data.add_field('batch', json.dumps(items))

        async with session.post(
            f'{FACE_API_URL}/batch',
            data=form_data,
            timeout=aiohttp.ClientTimeout(total=180)
        ) as resp:
            if resp.status == 200:
                result = await resp.json()
                indexed = result.get('indexed', 0)
                if indexed > 0 and batch_num % 10 == 0:
                    print(f'  [batch {batch_num}] +{indexed} faces ({result.get("failed", 0)} failed, {result.get("skipped", 0)} skipped)')
                return indexed
            else:
                text = await resp.text()
                print(f'  [batch {batch_num}] Error {resp.status}: {text[:100]}')
                return 0
    except asyncio.TimeoutError:
        print(f'  [batch {batch_num}] Timeout (180s)')
        return 0
    except Exception as e:
        print(f'  [batch {batch_num}] Failed: {e}')
        return 0


async def process_urls_via_face_api(face_urls):
    """Send face URLs to dev-01 face API in parallel batches."""
    total_inserted = 0
    batches = [face_urls[i:i+DOWNLOAD_BATCH_SIZE] for i in range(0, len(face_urls), DOWNLOAD_BATCH_SIZE)]

    connector = aiohttp.TCPConnector(limit=CONCURRENT_BATCHES)
    async with aiohttp.ClientSession(connector=connector) as session:
        for i in range(0, len(batches), CONCURRENT_BATCHES):
            chunk = batches[i:i+CONCURRENT_BATCHES]
            tasks = [send_batch_to_face_api(session, batch, i+j) for j, batch in enumerate(chunk)]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for r in results:
                if isinstance(r, int):
                    total_inserted += r

            if i % 20 == 0 and i > 0:
                print(f'  [progress] {i}/{len(batches)} batches, {total_inserted} faces inserted')

            await asyncio.sleep(BATCH_DELAY)

    return total_inserted


def download_parquet(part_num):
    """Download a single parquet file from HuggingFace."""
    filename = PARQUET_PATTERN.format(part_num)
    print(f'[part {part_num:03d}] Downloading {filename}...')

    path = hf_hub_download(
        repo_id=REPO_ID,
        filename=filename,
        repo_type='dataset',
        token=HF_TOKEN,
        cache_dir=CACHE_DIR
    )
    return path


def get_qdrant_count():
    """Get current face count from Qdrant."""
    try:
        import urllib.request
        req = urllib.request.urlopen(f'{QDRANT_URL}/collections/faces', timeout=5)
        data = json.loads(req.read())
        return data['result']['points_count']
    except:
        return -1


def main():
    parser = argparse.ArgumentParser(description='LAION-Face Pipeline')
    parser.add_argument('--start-part', type=int, default=0, help='Start partition (0-127)')
    parser.add_argument('--end-part', type=int, default=127, help='End partition (0-127)')
    parser.add_argument('--extract-only', action='store_true', help='Only extract URLs to files, do not process')
    parser.add_argument('--dry-run', action='store_true', help='Just count, do not download anything')
    args = parser.parse_args()

    os.makedirs(URL_OUTPUT_DIR, exist_ok=True)
    progress = load_progress()

    qdrant_start = get_qdrant_count()
    print(f'=== LAION-Face Pipeline ===')
    print(f'Qdrant faces at start: {qdrant_start:,}')
    print(f'Parts to process: {args.start_part} to {args.end_part}')
    print(f'Mode: {"dry-run" if args.dry_run else "extract-only" if args.extract_only else "full pipeline"}')
    print()

    total_urls = 0
    total_faces = 0

    for part_num in range(args.start_part, args.end_part + 1):
        if part_num in progress['completed_parts']:
            print(f'[part {part_num:03d}] Already completed, skipping')
            continue

        start_time = time.time()

        if args.dry_run:
            print(f'[part {part_num:03d}] Would download and process')
            continue

        # Step 1: Download parquet
        try:
            parquet_path = download_parquet(part_num)
        except Exception as e:
            print(f'[part {part_num:03d}] Download failed: {e}')
            continue

        # Step 2: Filter for face URLs
        print(f'[part {part_num:03d}] Filtering face-related URLs...')
        face_urls = filter_face_urls(parquet_path)
        print(f'[part {part_num:03d}] Found {len(face_urls):,} face URLs')
        total_urls += len(face_urls)

        # Step 3: Save URLs to file
        url_file = os.path.join(URL_OUTPUT_DIR, f'face_urls_part_{part_num:03d}.jsonl')
        with open(url_file, 'w') as f:
            for u in face_urls:
                f.write(json.dumps(u) + '\n')
        print(f'[part {part_num:03d}] Saved to {url_file}')

        # Step 4: Send to face API (unless extract-only)
        if not args.extract_only:
            print(f'[part {part_num:03d}] Processing {len(face_urls):,} URLs via face API...')
            faces_inserted = asyncio.run(process_urls_via_face_api(face_urls))
            total_faces += faces_inserted
            print(f'[part {part_num:03d}] Inserted {faces_inserted:,} faces')

        elapsed = time.time() - start_time
        print(f'[part {part_num:03d}] Done in {elapsed:.0f}s')

        # Update progress
        progress['completed_parts'].append(part_num)
        progress['total_urls_extracted'] += len(face_urls)
        progress['total_faces_inserted'] += total_faces
        save_progress(progress)

    qdrant_end = get_qdrant_count()
    print(f'\n=== Summary ===')
    print(f'URLs extracted: {total_urls:,}')
    print(f'Faces inserted: {total_faces:,}')
    print(f'Qdrant: {qdrant_start:,} → {qdrant_end:,} (+{qdrant_end - qdrant_start:,})')


if __name__ == '__main__':
    main()
