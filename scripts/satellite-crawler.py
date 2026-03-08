#!/usr/bin/env python3
"""
Satellite Face Crawler — runs on dev-01 (residential IP)

Crawls sources that block datacenter IPs:
  - Google Image Search (by name)
  - Instagram public profiles
  - Twitter/X via Nitter

Downloads images, extracts base64, sends to GCP bridge API
for face detection + Qdrant indexing via VPN.

Usage:
  python3 satellite-crawler.py              # Run continuous service
  python3 satellite-crawler.py --once       # Run one cycle and exit
  python3 satellite-crawler.py --status     # Check GCP crawler status
"""

import sys
import os
import json
import time
import base64
import hashlib
import re
import urllib.request
import urllib.parse
import urllib.error
from pathlib import Path
from html.parser import HTMLParser

BRIDGE_URL = "http://10.8.0.1:3333"
STATE_FILE = os.path.expanduser("~/.ozzu-crawler-state.json")
CYCLE_INTERVAL = 300  # 5 minutes
DELAY = 0.8  # between image downloads

# ── Names to crawl — fetched from GCP + self-discovered ──

SEED_NAMES = [
    # World leaders
    "Joe Biden", "Donald Trump", "Emmanuel Macron", "Olaf Scholz",
    "Rishi Sunak", "Justin Trudeau", "Narendra Modi", "Xi Jinping",
    "Volodymyr Zelensky", "Lula da Silva",
    # Tech
    "Elon Musk", "Mark Zuckerberg", "Jeff Bezos", "Tim Cook",
    "Satya Nadella", "Sundar Pichai", "Sam Altman", "Jensen Huang",
    "Lisa Su", "Dario Amodei",
    # Entertainment
    "Taylor Swift", "Beyonce", "Bad Bunny", "Drake",
    "Shakira", "BTS", "Rihanna", "Billie Eilish",
    "Margot Robbie", "Timothee Chalamet",
    # Sports
    "Lionel Messi", "Cristiano Ronaldo", "LeBron James",
    "Serena Williams", "Lewis Hamilton", "Simone Biles",
    # Business
    "Warren Buffett", "Bill Gates", "Larry Ellison",
    "Bernard Arnault", "Mukesh Ambani",
]


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except:
        return {
            "names_processed": [],
            "names_queue": list(SEED_NAMES),
            "google_offset": 0,
            "total_indexed": 0,
            "total_processed": 0,
            "cycles": 0,
        }


def save_state(state):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except:
        pass


def api_call(path, data=None, timeout=30):
    """Call bridge API"""
    url = f"{BRIDGE_URL}{path}"
    if data:
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    else:
        req = urllib.request.Request(url)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        return json.loads(resp.read())
    except Exception as e:
        return None


def download_image(url, timeout=10):
    """Download image, return base64 or None"""
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        })
        resp = urllib.request.urlopen(req, timeout=timeout)
        data = resp.read()
        if len(data) < 2000:
            return None
        return base64.b64encode(data).decode()
    except:
        return None


def index_face(image_url, label="", source_url="", source_platform=""):
    """Send image to bridge for face indexing"""
    result = api_call("/osint/face/index", {
        "imageUrl": image_url,
        "label": label,
        "sourcePlatform": source_platform,
    })
    return result and result.get("indexed", 0) > 0


# ── Google Image Search ──────────────────────────

def scrape_google_images(name, num=50):
    """Search Google Images by name — works with residential IP"""
    results = []
    query = urllib.parse.quote(name)
    url = f"https://www.google.com/search?q={query}&tbm=isch&num={num}"

    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        })
        resp = urllib.request.urlopen(req, timeout=15)
        html = resp.read().decode("utf-8", errors="ignore")

        # Check for CAPTCHA
        if "/sorry/" in html or "captcha" in html.lower():
            print(f"  [google] CAPTCHA for '{name}' — skipping")
            return results

        # Extract image URLs from Google's inline JSON data
        # Google embeds image URLs in various JSON blobs
        # Pattern 1: ["url","http://...jpg",width,height]
        img_pattern = re.findall(r'\["(https?://[^"]+\.(?:jpg|jpeg|png)(?:\?[^"]*)?)",[0-9]+,[0-9]+\]', html)
        for img_url in img_pattern:
            if "google.com" not in img_url and "gstatic.com" not in img_url:
                results.append(img_url)

        # Pattern 2: data-src or src in img tags
        src_pattern = re.findall(r'(?:data-src|src)="(https?://[^"]+)"', html)
        for src in src_pattern:
            if any(ext in src.lower() for ext in [".jpg", ".jpeg", ".png"]):
                if "google.com" not in src and "gstatic.com" not in src:
                    if src not in results:
                        results.append(src)

        # Pattern 3: ou= parameter in Google image redirect URLs
        ou_pattern = re.findall(r'ou=(https?://[^&"]+)', html)
        for ou_url in ou_pattern:
            decoded = urllib.parse.unquote(ou_url)
            if decoded not in results:
                results.append(decoded)

    except Exception as e:
        print(f"  [google] Error for '{name}': {e}")

    return list(set(results))[:80]


# ── Bing Image Search (face filter) ─────────────

def scrape_bing_images(name, num=50):
    """Search Bing Images with face filter"""
    results = []
    query = urllib.parse.quote(name)
    url = f"https://www.bing.com/images/search?q={query}&qft=+filterui:face-face&first=1&count={num}"

    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        })
        resp = urllib.request.urlopen(req, timeout=15)
        html = resp.read().decode("utf-8", errors="ignore")

        # Extract from m={"murl":"..."} JSON blobs
        murl_pattern = re.findall(r'"murl":"(https?://[^"]+)"', html)
        for murl in murl_pattern:
            if murl not in results:
                results.append(murl)

        # Fallback: data-src attributes
        src_pattern = re.findall(r'data-src="(https?://[^"]+)"', html)
        for src in src_pattern:
            if "bing.com" not in src and src not in results:
                results.append(src)

    except Exception as e:
        print(f"  [bing] Error for '{name}': {e}")

    return list(set(results))[:80]


# ── DuckDuckGo Image Search ─────────────────────

def scrape_ddg_images(name, num=50):
    """Search DuckDuckGo Images — less aggressive anti-bot"""
    results = []
    query = urllib.parse.quote(name)

    try:
        # DDG requires a token from the search page first
        token_url = f"https://duckduckgo.com/?q={query}&iax=images&ia=images"
        req = urllib.request.Request(token_url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        })
        resp = urllib.request.urlopen(req, timeout=15)
        html = resp.read().decode("utf-8", errors="ignore")

        # Extract vqd token
        vqd_match = re.search(r'vqd="([^"]+)"', html) or re.search(r"vqd='([^']+)'", html) or re.search(r'vqd=([^&"]+)', html)
        if not vqd_match:
            return results

        vqd = vqd_match.group(1)
        api_url = f"https://duckduckgo.com/i.js?l=us-en&o=json&q={query}&vqd={vqd}&f=,,,,,&p=1"
        req2 = urllib.request.Request(api_url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://duckduckgo.com/",
        })
        resp2 = urllib.request.urlopen(req2, timeout=15)
        data = json.loads(resp2.read())

        for item in data.get("results", []):
            img_url = item.get("image", "")
            if img_url.startswith("http"):
                results.append(img_url)

    except Exception as e:
        print(f"  [ddg] Error for '{name}': {e}")

    return list(set(results))[:80]


# ── Flickr Public Photos ────────────────────────

def scrape_flickr(name, num=30):
    """Search Flickr public photos — no API key needed for public search"""
    results = []
    query = urllib.parse.quote(name)

    try:
        url = f"https://www.flickr.com/search/?text={query}&sort=relevance&media=photos&content_type=1"
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        })
        resp = urllib.request.urlopen(req, timeout=15)
        html = resp.read().decode("utf-8", errors="ignore")

        # Extract image URLs from Flickr's page
        img_pattern = re.findall(r'"(https://live\.staticflickr\.com/[^"]+\.jpg)"', html)
        for img_url in img_pattern:
            # Convert to larger size
            large_url = re.sub(r'_[smtq]\.jpg', '_b.jpg', img_url)
            if large_url not in results:
                results.append(large_url)

    except Exception as e:
        print(f"  [flickr] Error for '{name}': {e}")

    return list(set(results))[:num]


# ── Crawl Cycle ──────────────────────────────────

def run_cycle(state):
    """Run one crawl cycle — process next batch of names"""
    cycle_indexed = 0
    cycle_processed = 0

    # Get next names to process
    queue = state.get("names_queue", [])
    if not queue:
        # Refill from seed + add new names from bridge
        queue = list(SEED_NAMES)
        # Try to get names from GCP crawler queue
        status = api_call("/osint/face/crawl/status")
        if status and status.get("crawlState", {}).get("named", {}).get("queue"):
            queue.extend(status["crawlState"]["named"]["queue"])
        queue = [n for n in queue if n not in state.get("names_processed", [])]
        state["names_queue"] = queue

    batch = queue[:5]  # 5 names per cycle
    state["names_queue"] = queue[5:]

    for name in batch:
        print(f"\n[satellite] Processing: {name}")

        # Collect image URLs from all sources
        all_urls = []

        # Google Images (primary advantage of residential IP)
        google_urls = scrape_google_images(name)
        print(f"  [google] {len(google_urls)} images")
        all_urls.extend([(u, "google") for u in google_urls])
        time.sleep(2)  # Be nice to Google

        # Bing Images
        bing_urls = scrape_bing_images(name)
        print(f"  [bing] {len(bing_urls)} images")
        all_urls.extend([(u, "bing") for u in bing_urls])
        time.sleep(1)

        # DuckDuckGo
        ddg_urls = scrape_ddg_images(name)
        print(f"  [ddg] {len(ddg_urls)} images")
        all_urls.extend([(u, "duckduckgo") for u in ddg_urls])
        time.sleep(1)

        # Flickr
        flickr_urls = scrape_flickr(name)
        print(f"  [flickr] {len(flickr_urls)} images")
        all_urls.extend([(u, "flickr") for u in flickr_urls])

        # Deduplicate
        seen = set()
        unique_urls = []
        for url, source in all_urls:
            if url not in seen:
                seen.add(url)
                unique_urls.append((url, source))

        print(f"  Total unique: {len(unique_urls)}")

        # Index each image via bridge API
        name_indexed = 0
        for img_url, source in unique_urls:
            cycle_processed += 1
            try:
                result = api_call("/osint/face/index", {
                    "imageUrl": img_url,
                    "label": name,
                    "sourcePlatform": f"satellite_{source}",
                }, timeout=30)
                if result and result.get("ok"):
                    name_indexed += 1
                    cycle_indexed += 1
            except:
                pass
            time.sleep(DELAY)

        print(f"  Indexed: {name_indexed}/{len(unique_urls)}")

        if name not in state.get("names_processed", []):
            state.setdefault("names_processed", []).append(name)

        # Keep processed list manageable
        if len(state["names_processed"]) > 5000:
            state["names_processed"] = state["names_processed"][-2500:]

    state["total_indexed"] = state.get("total_indexed", 0) + cycle_indexed
    state["total_processed"] = state.get("total_processed", 0) + cycle_processed
    state["cycles"] = state.get("cycles", 0) + 1

    return cycle_indexed, cycle_processed


def main():
    if "--status" in sys.argv:
        status = api_call("/osint/face/crawl/status")
        if status:
            print(json.dumps(status, indent=2))
        else:
            print("Cannot reach bridge API")
        return

    once = "--once" in sys.argv
    state = load_state()

    print("=" * 50)
    print("SATELLITE FACE CRAWLER — dev-01")
    print(f"Bridge: {BRIDGE_URL}")
    print(f"Queue: {len(state.get('names_queue', []))} names")
    print(f"Processed: {len(state.get('names_processed', []))} names")
    print(f"Total indexed: {state.get('total_indexed', 0)}")
    print("=" * 50)

    # Verify bridge connectivity
    stats = api_call("/osint/face/stats")
    if not stats:
        print("ERROR: Cannot reach bridge API at", BRIDGE_URL)
        sys.exit(1)
    print(f"Bridge OK — Qdrant: {stats.get('points_count', '?')} faces")

    while True:
        print(f"\n{'=' * 50}")
        print(f"Cycle {state.get('cycles', 0) + 1} starting...")
        start = time.time()

        try:
            indexed, processed = run_cycle(state)
            elapsed = time.time() - start
            print(f"\nCycle complete: {indexed}/{processed} indexed in {elapsed:.1f}s")

            # Check DB size
            stats = api_call("/osint/face/stats")
            if stats:
                print(f"Qdrant DB: {stats.get('points_count', '?')} faces")

        except Exception as e:
            print(f"Cycle error: {e}")

        save_state(state)

        if once:
            break

        print(f"Sleeping {CYCLE_INTERVAL}s until next cycle...")
        time.sleep(CYCLE_INTERVAL)


if __name__ == "__main__":
    main()
