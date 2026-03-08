#!/usr/bin/env python3
"""
Context Enricher — retroactively enrich existing Qdrant face vectors with page context.

Phase 1 of Identity Resolution Engine (EPIC dir_1773012573094).

For vectors that have a source_url but no page_title/nearby_text, fetches the source
page and extracts context metadata (title, description, alt-text, nearby text).

Runs on dev-01 or GCP. Processes vectors in batches via Qdrant scroll API.

Usage:
    python3 context-enricher.py                    # Run continuous enrichment
    python3 context-enricher.py --batch-size 100   # Custom batch size
    python3 context-enricher.py --stats            # Show enrichment stats
    python3 context-enricher.py --dry-run          # Preview without updating
"""

import os
import sys
import json
import time
import re
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

QDRANT_URL = os.environ.get("QDRANT_URL", "http://10.8.0.1:6333")
COLLECTION = "faces"
BATCH_SIZE = 50          # vectors to process per batch
FETCH_WORKERS = 8        # parallel page fetchers
FETCH_TIMEOUT = 6        # seconds per page fetch
ENRICH_DELAY = 0.5       # seconds between batches (be polite)
PROGRESS_FILE = os.path.expanduser("~/.ozzu-enricher-progress.json")

_stats = {
    "scanned": 0,
    "enriched": 0,
    "skipped_no_url": 0,
    "skipped_already": 0,
    "fetch_failed": 0,
    "started_at": time.time(),
}
_stats_lock = Lock()


def log(msg):
    print(msg, flush=True)


def load_progress():
    try:
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    except Exception:
        return {"last_offset": None, "total_enriched": 0, "total_scanned": 0}


def save_progress(progress):
    try:
        with open(PROGRESS_FILE, "w") as f:
            json.dump(progress, f, indent=2)
    except Exception:
        pass


def qdrant_request(path, data=None, method="GET"):
    """Make a request to Qdrant REST API."""
    url = f"{QDRANT_URL}{path}"
    if data:
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
        req.get_method = lambda: method if method != "GET" else "POST"
    else:
        req = urllib.request.Request(url)
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read())


def scroll_vectors(offset=None, limit=BATCH_SIZE):
    """Scroll through Qdrant vectors, returning points with payloads."""
    data = {
        "limit": limit,
        "with_payload": True,
        "with_vector": False,
    }
    if offset:
        data["offset"] = offset
    return qdrant_request(f"/collections/{COLLECTION}/points/scroll", data)


def update_payload(point_id, payload_update):
    """Update payload fields for a single Qdrant point."""
    data = {
        "payload": payload_update,
        "points": [point_id],
    }
    return qdrant_request(f"/collections/{COLLECTION}/points/payload", data, method="PUT")


def batch_update_payloads(updates):
    """Update payload fields for multiple Qdrant points.
    updates: list of (point_id, payload_dict)"""
    for point_id, payload in updates:
        try:
            update_payload(point_id, payload)
        except Exception as e:
            log(f"  [update] Failed for {point_id}: {e}")


def fetch_page_context(url, timeout=FETCH_TIMEOUT):
    """Fetch a page and extract context: title, meta description, nearby text."""
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        })
        resp = urllib.request.urlopen(req, timeout=timeout)
        html = resp.read().decode("utf-8", errors="ignore")

        ctx = {}

        # Page title
        title_m = re.search(r'<title[^>]*>([^<]+)</title>', html, re.IGNORECASE)
        if title_m:
            ctx["page_title"] = title_m.group(1).strip()[:300]

        # Meta description
        desc_m = re.search(r'<meta[^>]*name=["\']description["\'][^>]*content=["\']([^"\']+)', html, re.IGNORECASE)
        if not desc_m:
            desc_m = re.search(r'<meta[^>]*content=["\']([^"\']+)["\'][^>]*name=["\']description', html, re.IGNORECASE)
        if desc_m:
            ctx["meta_description"] = desc_m.group(1).strip()[:500]

        # OG description fallback
        if not ctx.get("meta_description"):
            og_m = re.search(r'<meta[^>]*property=["\']og:description["\'][^>]*content=["\']([^"\']+)', html, re.IGNORECASE)
            if og_m:
                ctx["meta_description"] = og_m.group(1).strip()[:500]

        # Extract visible text (strip tags)
        text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        if text:
            ctx["nearby_text"] = text[:500]

        # Extract alt text from images
        alt_texts = re.findall(r'alt=["\']([^"\']+)["\']', html, re.IGNORECASE)
        if alt_texts:
            # Pick the longest alt text (most descriptive)
            best_alt = max(alt_texts, key=len)
            if len(best_alt) > 5:
                ctx["alt_text"] = best_alt[:300]

        # Domain
        try:
            ctx["domain"] = urllib.parse.urlparse(url).netloc
        except Exception:
            pass

        ctx["page_url"] = url
        return ctx

    except Exception:
        return None


def needs_enrichment(payload):
    """Check if a vector's payload needs context enrichment."""
    # Must have a source_url to enrich from
    source_url = payload.get("source_url", "")
    if not source_url or not source_url.startswith("http"):
        return False
    # Already enriched if has page_title or nearby_text with real content
    if payload.get("page_title") and len(payload["page_title"]) > 10:
        return False
    if payload.get("nearby_text") and len(payload["nearby_text"]) > 50:
        return False
    return True


def process_batch(points, dry_run=False):
    """Process a batch of points: fetch context for those that need it."""
    to_enrich = []
    for point in points:
        payload = point.get("payload", {})
        pid = point.get("id")
        if not needs_enrichment(payload):
            with _stats_lock:
                if not payload.get("source_url", "").startswith("http"):
                    _stats["skipped_no_url"] += 1
                else:
                    _stats["skipped_already"] += 1
            continue
        to_enrich.append((pid, payload["source_url"]))

    if not to_enrich:
        return 0

    if dry_run:
        log(f"  [dry-run] Would enrich {len(to_enrich)} vectors")
        return len(to_enrich)

    # Fetch page context in parallel
    updates = []

    def fetch_one(item):
        pid, url = item
        ctx = fetch_page_context(url)
        if ctx:
            return (pid, ctx)
        return None

    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as executor:
        futures = {executor.submit(fetch_one, item): item for item in to_enrich}
        for future in as_completed(futures):
            try:
                result = future.result()
                if result:
                    updates.append(result)
                else:
                    with _stats_lock:
                        _stats["fetch_failed"] += 1
            except Exception:
                with _stats_lock:
                    _stats["fetch_failed"] += 1

    # Batch update Qdrant payloads
    if updates:
        batch_update_payloads(updates)
        with _stats_lock:
            _stats["enriched"] += len(updates)

    return len(updates)


def show_stats():
    """Show enrichment progress stats."""
    progress = load_progress()
    try:
        info = qdrant_request(f"/collections/{COLLECTION}")
        total = info["result"]["points_count"]
    except Exception:
        total = "?"

    # Sample some vectors to estimate enrichment coverage
    try:
        sample = scroll_vectors(limit=100)
        points = sample["result"]["points"]
        enriched = sum(1 for p in points if p.get("payload", {}).get("page_title"))
        has_url = sum(1 for p in points if p.get("payload", {}).get("source_url", "").startswith("http"))
        log(f"=== Context Enrichment Stats ===")
        log(f"Total vectors: {total}")
        log(f"Sample (100): {enriched} enriched, {has_url} have web URLs")
        log(f"Estimated enrichment: {enriched}%")
        log(f"Enrichable (has URL, no context): {has_url - enriched} in sample")
        log(f"Progress: {progress.get('total_enriched', 0)} enriched, {progress.get('total_scanned', 0)} scanned")
    except Exception as e:
        log(f"Error: {e}")


def main():
    if "--stats" in sys.argv:
        show_stats()
        return

    dry_run = "--dry-run" in sys.argv
    batch_size = BATCH_SIZE
    if "--batch-size" in sys.argv:
        idx = sys.argv.index("--batch-size")
        batch_size = int(sys.argv[idx + 1])

    progress = load_progress()
    offset = progress.get("last_offset")

    log("=" * 60)
    log("CONTEXT ENRICHER — Retroactive Identity Resolution")
    log(f"Qdrant: {QDRANT_URL}")
    log(f"Batch size: {batch_size}, Workers: {FETCH_WORKERS}")
    log(f"Previous progress: {progress.get('total_enriched', 0)} enriched")
    if dry_run:
        log("MODE: DRY RUN (no updates)")
    log("=" * 60)

    batch_num = 0
    while True:
        try:
            result = scroll_vectors(offset=offset, limit=batch_size)
            points = result.get("result", {}).get("points", [])
            next_offset = result.get("result", {}).get("next_page_offset")

            if not points:
                log("\n[done] No more vectors to process")
                break

            with _stats_lock:
                _stats["scanned"] += len(points)

            enriched = process_batch(points, dry_run=dry_run)
            batch_num += 1

            if batch_num % 10 == 0 or enriched > 0:
                uptime = time.time() - _stats["started_at"]
                rate = _stats["enriched"] / (uptime / 60) if uptime > 0 else 0
                log(f"[batch {batch_num}] scanned={_stats['scanned']}, enriched={_stats['enriched']}, "
                    f"skipped={_stats['skipped_already']}, no_url={_stats['skipped_no_url']}, "
                    f"failed={_stats['fetch_failed']}, rate={rate:.0f}/min")

            # Save progress
            offset = next_offset
            progress["last_offset"] = offset
            progress["total_enriched"] = progress.get("total_enriched", 0) + enriched
            progress["total_scanned"] = progress.get("total_scanned", 0) + len(points)
            save_progress(progress)

            if not next_offset:
                log("\n[done] Reached end of collection")
                break

            time.sleep(ENRICH_DELAY)

        except KeyboardInterrupt:
            log("\n[interrupted] Saving progress...")
            save_progress(progress)
            break
        except Exception as e:
            log(f"[error] {e}")
            time.sleep(5)

    log(f"\n=== Final Stats ===")
    log(f"Scanned: {_stats['scanned']}")
    log(f"Enriched: {_stats['enriched']}")
    log(f"Skipped (already enriched): {_stats['skipped_already']}")
    log(f"Skipped (no web URL): {_stats['skipped_no_url']}")
    log(f"Fetch failed: {_stats['fetch_failed']}")


if __name__ == "__main__":
    main()
