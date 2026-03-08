#!/usr/bin/env python3
"""
Satellite Face Crawler v2 — SCALED for mass indexing on dev-01

Architecture:
  - 4 parallel NAME workers (process different people simultaneously)
  - 5 search engines per name (Google, Bing, Yandex, DuckDuckGo, Flickr) run concurrently
  - 8 parallel INDEX workers (local ArcFace → direct Qdrant insert)
  - 500+ seed names from Wikipedia notable people lists
  - Auto-discovers new names from Wikipedia category pages
  - Minimal delays — just enough to avoid IP bans

Target: 50,000+ faces/day (vs ~3,000 with v1)

Usage:
  python3 satellite-crawler.py              # Run continuous service
  python3 satellite-crawler.py --once       # Run one cycle and exit
  python3 satellite-crawler.py --status     # Check stats
  python3 satellite-crawler.py --expand     # Fetch more names from Wikipedia
"""

import sys
import os
import json
import time
import re
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

BRIDGE_URL = "http://10.8.0.1:3333"
LOCAL_FACE_API = "http://127.0.0.1:5555"  # Local ArcFace on dev-01
STATE_FILE = os.path.expanduser("~/.ozzu-crawler-state.json")
CYCLE_INTERVAL = 120  # 2 minutes between cycles
NAMES_PER_CYCLE = 20  # 20 names per cycle (4 workers × 5 names each)
NAME_WORKERS = 4      # parallel name processing
INDEX_WORKERS = 8     # parallel image indexing
ENGINE_WORKERS = 5    # parallel search engines per name
SEARCH_DELAY = 0.3    # delay between search engine calls (per engine)
INDEX_DELAY = 0.05    # delay between index calls (faster with local processing)

state_lock = Lock()

# ── 500+ seed names — notable public figures ──

SEED_NAMES = [
    # ── US Presidents & VP ──
    "Joe Biden", "Donald Trump", "Barack Obama", "George W Bush",
    "Bill Clinton", "Kamala Harris", "Mike Pence", "Hillary Clinton",
    # ── World Leaders ──
    "Emmanuel Macron", "Olaf Scholz", "Rishi Sunak", "Keir Starmer",
    "Justin Trudeau", "Narendra Modi", "Xi Jinping", "Vladimir Putin",
    "Volodymyr Zelensky", "Lula da Silva", "Javier Milei", "Giorgia Meloni",
    "Pedro Sanchez", "Mark Rutte", "Fumio Kishida", "Shigeru Ishiba",
    "Yoon Suk Yeol", "Anthony Albanese", "Recep Tayyip Erdogan",
    "Mohammed bin Salman", "Benjamin Netanyahu", "Abdel Fattah el-Sisi",
    "Gustavo Petro", "Gabriel Boric", "Claudia Sheinbaum",
    "Nayib Bukele", "Jacinda Ardern", "Angela Merkel",
    # ── Tech CEOs & Founders ──
    "Elon Musk", "Mark Zuckerberg", "Jeff Bezos", "Tim Cook",
    "Satya Nadella", "Sundar Pichai", "Sam Altman", "Jensen Huang",
    "Lisa Su", "Dario Amodei", "Demis Hassabis", "Arvind Krishna",
    "Andy Jassy", "Pat Gelsinger", "Reed Hastings", "Daniel Ek",
    "Jack Dorsey", "Brian Chesky", "Travis Kalanick", "Drew Houston",
    "Stewart Butterfield", "Tobi Lutke", "Evan Spiegel", "Bobby Kotick",
    "Sergey Brin", "Larry Page", "Steve Wozniak", "Michael Dell",
    "Marc Benioff", "Ginni Rometty", "Sheryl Sandberg", "Susan Wojcicki",
    "Marissa Mayer", "Kevin Systrom", "Jan Koum", "Peter Thiel",
    "Reid Hoffman", "Marc Andreessen", "Ben Horowitz", "Vitalik Buterin",
    "Brian Armstrong", "Changpeng Zhao", "Sam Bankman-Fried",
    # ── Billionaires & Business ──
    "Warren Buffett", "Bill Gates", "Larry Ellison", "Bernard Arnault",
    "Mukesh Ambani", "Gautam Adani", "Carlos Slim", "Francoise Bettencourt Meyers",
    "Amancio Ortega", "Larry Fink", "Jamie Dimon", "David Solomon",
    "Ray Dalio", "Ken Griffin", "George Soros", "Carl Icahn",
    "Rupert Murdoch", "Michael Bloomberg", "Charles Koch", "Steve Schwarzman",
    "Stephen Schwarzman", "John Paulson", "Bill Ackman", "Masayoshi Son",
    "Jack Ma", "Pony Ma", "Zhang Yiming", "Richard Branson",
    "Elon Musk", "Oprah Winfrey", "Rihanna", "Jay Z",
    # ── Hollywood Actors ──
    "Leonardo DiCaprio", "Brad Pitt", "Angelina Jolie", "Tom Cruise",
    "Margot Robbie", "Timothee Chalamet", "Zendaya", "Tom Holland",
    "Robert Downey Jr", "Scarlett Johansson", "Chris Hemsworth", "Chris Evans",
    "Jennifer Lawrence", "Emma Stone", "Ryan Gosling", "Denzel Washington",
    "Morgan Freeman", "Samuel L Jackson", "Meryl Streep", "Cate Blanchett",
    "Joaquin Phoenix", "Christian Bale", "Matt Damon", "Ben Affleck",
    "Will Smith", "Dwayne Johnson", "Vin Diesel", "Jason Statham",
    "Keanu Reeves", "Johnny Depp", "Al Pacino", "Robert De Niro",
    "Florence Pugh", "Ana de Armas", "Sydney Sweeney", "Jenna Ortega",
    "Pedro Pascal", "Oscar Isaac", "Jason Momoa", "Gal Gadot",
    "Natalie Portman", "Anne Hathaway", "Sandra Bullock", "Julia Roberts",
    "Nicole Kidman", "Reese Witherspoon", "Viola Davis", "Lupita Nyongo",
    "Idris Elba", "Daniel Craig", "Henry Cavill", "Tom Hardy",
    "Benedict Cumberbatch", "Ryan Reynolds", "Hugh Jackman", "Jake Gyllenhaal",
    "Timothee Chalamet", "Austin Butler", "Barry Keoghan", "Paul Mescal",
    # ── Music Artists ──
    "Taylor Swift", "Beyonce", "Bad Bunny", "Drake", "Shakira",
    "Rihanna", "Billie Eilish", "Ariana Grande", "Dua Lipa",
    "The Weeknd", "Ed Sheeran", "Post Malone", "Travis Scott",
    "Kendrick Lamar", "J Cole", "Kanye West", "Nicki Minaj", "Cardi B",
    "Olivia Rodrigo", "Doja Cat", "SZA", "Lil Nas X", "Harry Styles",
    "Justin Bieber", "Selena Gomez", "Miley Cyrus", "Lady Gaga",
    "Bruno Mars", "Adele", "Sam Smith", "Lizzo", "Megan Thee Stallion",
    "Ice Spice", "Peso Pluma", "Karol G", "Rosalia", "J Balvin",
    "Daddy Yankee", "Ozuna", "Anuel AA", "Rauw Alejandro", "Feid",
    "BTS", "Blackpink", "Stray Kids", "NewJeans", "Twice",
    "Jungkook", "Lisa Manoban", "Jennie Kim",
    "Eminem", "Jay Z", "50 Cent", "Snoop Dogg", "Dr Dre",
    "Lana Del Rey", "Charli XCX", "Chappell Roan", "Sabrina Carpenter",
    # ── Sports ──
    "Lionel Messi", "Cristiano Ronaldo", "Kylian Mbappe", "Erling Haaland",
    "Neymar", "Mohamed Salah", "Vinicius Junior", "Jude Bellingham",
    "LeBron James", "Stephen Curry", "Kevin Durant", "Giannis Antetokounmpo",
    "Luka Doncic", "Nikola Jokic", "Joel Embiid", "Jayson Tatum",
    "Serena Williams", "Naomi Osaka", "Carlos Alcaraz", "Novak Djokovic",
    "Rafael Nadal", "Roger Federer", "Coco Gauff", "Iga Swiatek",
    "Lewis Hamilton", "Max Verstappen", "Charles Leclerc", "Lando Norris",
    "Simone Biles", "Usain Bolt", "Michael Phelps", "Katie Ledecky",
    "Patrick Mahomes", "Travis Kelce", "Tom Brady", "Aaron Rodgers",
    "Shohei Ohtani", "Mike Trout", "Bryce Harper",
    "Tiger Woods", "Rory McIlroy", "Phil Mickelson",
    "Conor McGregor", "Jon Jones", "Israel Adesanya", "Alex Pereira",
    # ── Media & Journalists ──
    "Tucker Carlson", "Rachel Maddow", "Anderson Cooper", "Don Lemon",
    "Joe Rogan", "Lex Fridman", "Ben Shapiro", "Jordan Peterson",
    "Andrew Huberman", "Tim Ferriss", "Alex Jones",
    "Piers Morgan", "Trevor Noah", "John Oliver", "Jimmy Fallon",
    "Jimmy Kimmel", "Stephen Colbert", "Ellen DeGeneres", "Oprah Winfrey",
    "David Letterman", "Jay Leno", "Conan OBrien",
    # ── Directors & Producers ──
    "Steven Spielberg", "Martin Scorsese", "Christopher Nolan",
    "Quentin Tarantino", "James Cameron", "Denis Villeneuve",
    "Greta Gerwig", "Ridley Scott", "Wes Anderson",
    "David Fincher", "Guillermo del Toro", "Jordan Peele",
    # ── Scientists & Academics ──
    "Neil deGrasse Tyson", "Michio Kaku", "Stephen Hawking",
    "Jane Goodall", "Richard Dawkins", "Noam Chomsky",
    "Yuval Noah Harari", "Malcolm Gladwell", "Steven Pinker",
    # ── Fashion & Models ──
    "Gigi Hadid", "Bella Hadid", "Kendall Jenner", "Naomi Campbell",
    "Cara Delevingne", "Kate Moss", "Hailey Bieber", "Emily Ratajkowski",
    "Adriana Lima", "Alessandra Ambrosio",
    # ── Social Media & Influencers ──
    "Kim Kardashian", "Kylie Jenner", "Khloe Kardashian", "Kourtney Kardashian",
    "MrBeast", "PewDiePie", "Logan Paul", "Jake Paul",
    "KSI", "Addison Rae", "Charli DAmelio", "Dixie DAmelio",
    "David Dobrik", "Emma Chamberlain",
    # ── Royals ──
    "King Charles III", "Prince William", "Kate Middleton",
    "Prince Harry", "Meghan Markle", "Queen Rania",
    "Crown Prince Frederik", "Queen Letizia",
    # ── Historical but alive / recently deceased ──
    "Pope Francis", "Dalai Lama", "Henry Kissinger",
    "Jimmy Carter", "Al Gore", "John Kerry",
    "Condoleezza Rice", "Colin Powell", "Nancy Pelosi",
    # ── Latin America notable ──
    "Sofia Vergara", "Salma Hayek", "Penelope Cruz",
    "Diego Maradona", "Pele", "Shakira", "J Balvin",
    "Maluma", "Sebastian Yatra", "Camilo",
    "Gabriel Garcia Marquez", "Paulo Coelho",
    "Anitta", "Julieta Venegas", "Mon Laferte",
    # ── Asian Entertainment ──
    "Jackie Chan", "Jet Li", "Tony Leung", "Gong Li",
    "Fan Bingbing", "Dilraba Dilmurat", "Yang Mi",
    "Hyun Bin", "Song Hye-kyo", "Lee Min-ho", "Park Seo-joon",
    "Takeshi Kitano", "Ken Watanabe", "Rinko Kikuchi",
    "Priyanka Chopra", "Deepika Padukone", "Shah Rukh Khan",
    "Aamir Khan", "Hrithik Roshan", "Aishwarya Rai",
    # ── Comedians ──
    "Kevin Hart", "Dave Chappelle", "Chris Rock", "Adam Sandler",
    "Jim Carrey", "Steve Carell", "Tina Fey", "Amy Poehler",
    "Ricky Gervais", "Russell Brand", "Bill Burr", "Bo Burnham",
    # ── Gaming & Esports ──
    "Ninja", "Shroud", "xQc", "Pokimane", "Faker",
    # ── Chefs ──
    "Gordon Ramsay", "Jamie Oliver", "Anthony Bourdain", "Guy Fieri",
    "Salt Bae", "Massimo Bottura",
    # ── Astronauts ──
    "Buzz Aldrin", "Chris Hadfield", "Scott Kelly",
]

# Deduplicate seed names
SEED_NAMES = list(dict.fromkeys(SEED_NAMES))


def log(msg):
    print(msg, flush=True)


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {
            "names_processed": [],
            "names_queue": list(SEED_NAMES),
            "total_indexed": 0,
            "total_processed": 0,
            "total_scraped": 0,
            "cycles": 0,
            "discovered_names": [],
        }


def save_state(state):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass


def api_call(path, data=None, timeout=30, base_url=None):
    url = f"{base_url or BRIDGE_URL}{path}"
    if data:
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
    else:
        req = urllib.request.Request(url)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        return json.loads(resp.read())
    except Exception:
        return None


def local_face_index(image_url, label="", source_platform=""):
    """Send image URL to local face API for embedding + Qdrant insert."""
    try:
        # Use multipart form data (what the face API expects)
        import urllib.parse as up
        boundary = "----CrawlerBoundary"
        fields = {
            "image_url": image_url,
            "label": label,
            "source_platform": source_platform,
        }
        body = b""
        for key, val in fields.items():
            body += f"--{boundary}\r\n".encode()
            body += f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode()
            body += f"{val}\r\n".encode()
        body += f"--{boundary}--\r\n".encode()

        req = urllib.request.Request(
            f"{LOCAL_FACE_API}/index",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        resp = urllib.request.urlopen(req, timeout=30)
        result = json.loads(resp.read())
        return result and result.get("ok")
    except Exception:
        return False


def check_local_face_api():
    """Check if local face API is running."""
    try:
        req = urllib.request.Request(f"{LOCAL_FACE_API}/health")
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read())
        return data.get("status") == "ok"
    except Exception:
        return False


_use_local = None

def use_local_api():
    """Check once if local face API is available, cache result."""
    global _use_local
    if _use_local is None:
        _use_local = check_local_face_api()
        if _use_local:
            log("[config] Using LOCAL face API (dev-01 ArcFace → Qdrant direct)")
        else:
            log("[config] Local face API not available, falling back to BRIDGE")
    return _use_local


def make_request(url, headers=None, timeout=15):
    """HTTP GET with default User-Agent"""
    default_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if headers:
        default_headers.update(headers)
    req = urllib.request.Request(url, headers=default_headers)
    return urllib.request.urlopen(req, timeout=timeout)


# ── Search Engines (all return list of image URLs) ──

def scrape_google_images(name):
    """Google Images — residential IP advantage"""
    results = []
    query = urllib.parse.quote(name + " face photo")
    for start in [0, 20]:  # Two pages
        url = f"https://www.google.com/search?q={query}&tbm=isch&start={start}&num=40"
        try:
            resp = make_request(url)
            html = resp.read().decode("utf-8", errors="ignore")
            if "/sorry/" in html or "captcha" in html.lower():
                break
            # Pattern 1: JSON blobs
            for img_url in re.findall(r'\["(https?://[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)",[0-9]+,[0-9]+\]', html):
                if "google.com" not in img_url and "gstatic.com" not in img_url:
                    results.append(img_url)
            # Pattern 2: src/data-src
            for src in re.findall(r'(?:data-src|src)="(https?://[^"]+)"', html):
                if any(ext in src.lower() for ext in [".jpg", ".jpeg", ".png", ".webp"]):
                    if "google.com" not in src and "gstatic.com" not in src:
                        results.append(src)
            # Pattern 3: ou= redirect
            for ou_url in re.findall(r'ou=(https?://[^&"]+)', html):
                results.append(urllib.parse.unquote(ou_url))
            time.sleep(SEARCH_DELAY)
        except Exception:
            break
    return list(set(results))


def scrape_bing_images(name):
    """Bing Images with face filter — multiple pages"""
    results = []
    query = urllib.parse.quote(name)
    for first in [1, 36, 71]:  # Three pages
        url = f"https://www.bing.com/images/search?q={query}&qft=+filterui:face-face&first={first}&count=35"
        try:
            resp = make_request(url)
            html = resp.read().decode("utf-8", errors="ignore")
            for murl in re.findall(r'"murl":"(https?://[^"]+)"', html):
                results.append(murl)
            for src in re.findall(r'data-src="(https?://[^"]+)"', html):
                if "bing.com" not in src:
                    results.append(src)
            time.sleep(SEARCH_DELAY)
        except Exception:
            break
    return list(set(results))


def scrape_yandex_images(name):
    """Yandex Images — no anti-bot for image search"""
    results = []
    query = urllib.parse.quote(name + " face")
    for page in [0, 1]:
        url = f"https://yandex.com/images/search?text={query}&p={page}&isize=medium"
        try:
            resp = make_request(url, headers={"Accept-Language": "en-US,en;q=0.9"})
            html = resp.read().decode("utf-8", errors="ignore")
            # Extract from data attributes and JSON
            for img_url in re.findall(r'"(?:img_url|url|orig)"\s*:\s*"(https?://[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"', html):
                if "yandex" not in img_url and "avatars.mds" not in img_url:
                    results.append(img_url)
            for img_url in re.findall(r'data-url="(https?://[^"]+)"', html):
                results.append(img_url)
            time.sleep(SEARCH_DELAY)
        except Exception:
            break
    return list(set(results))


def scrape_ddg_images(name):
    """DuckDuckGo Images"""
    results = []
    query = urllib.parse.quote(name)
    try:
        token_url = f"https://duckduckgo.com/?q={query}&iax=images&ia=images"
        resp = make_request(token_url)
        html = resp.read().decode("utf-8", errors="ignore")
        vqd_match = re.search(r'vqd="([^"]+)"', html) or re.search(r"vqd='([^']+)'", html) or re.search(r'vqd=([^&"]+)', html)
        if not vqd_match:
            return results
        vqd = vqd_match.group(1)
        api_url = f"https://duckduckgo.com/i.js?l=us-en&o=json&q={query}&vqd={vqd}&f=,,,,,&p=1"
        resp2 = make_request(api_url, headers={"Referer": "https://duckduckgo.com/"})
        data = json.loads(resp2.read())
        for item in data.get("results", []):
            img_url = item.get("image", "")
            if img_url.startswith("http"):
                results.append(img_url)
    except Exception:
        pass
    return list(set(results))


def scrape_flickr(name):
    """Flickr public photos"""
    results = []
    query = urllib.parse.quote(name)
    try:
        url = f"https://www.flickr.com/search/?text={query}&sort=relevance&media=photos"
        resp = make_request(url)
        html = resp.read().decode("utf-8", errors="ignore")
        for img_url in re.findall(r'"(https://live\.staticflickr\.com/[^"]+\.jpg)"', html):
            large_url = re.sub(r'_[smtq]\.jpg', '_b.jpg', img_url)
            results.append(large_url)
    except Exception:
        pass
    return list(set(results))


# All engines with names
ENGINES = [
    ("google", scrape_google_images),
    ("bing", scrape_bing_images),
    ("yandex", scrape_yandex_images),
    ("ddg", scrape_ddg_images),
    ("flickr", scrape_flickr),
]


# ── Wikipedia name discovery ──

def discover_names_from_wikipedia():
    """Fetch notable people lists from Wikipedia to expand the name pool"""
    categories = [
        "List_of_heads_of_state_and_government",
        "Forbes_list_of_the_world%27s_most_powerful_people",
        "List_of_Nobel_laureates",
        "List_of_living_national_treasures_(Japan)",
        "List_of_most-followed_Instagram_accounts",
        "List_of_most-subscribed_YouTube_channels",
        "List_of_most-streamed_artists_on_Spotify",
    ]
    discovered = []
    for cat in categories:
        try:
            url = f"https://en.wikipedia.org/wiki/{cat}"
            resp = make_request(url)
            html = resp.read().decode("utf-8", errors="ignore")
            # Extract names from links — Wikipedia article titles in /wiki/First_Last format
            for match in re.findall(r'/wiki/([A-Z][a-z]+(?:_[A-Z][a-z]+)+)"', html):
                name = match.replace("_", " ")
                # Filter: must look like a person name (2-4 words, all capitalized)
                words = name.split()
                if 2 <= len(words) <= 4 and all(w[0].isupper() for w in words):
                    if name not in discovered:
                        discovered.append(name)
            time.sleep(0.5)
        except Exception:
            continue
    return discovered


# ── Parallel indexing ──

def index_batch(urls_with_meta):
    """Index a batch of images in parallel using ThreadPoolExecutor.
    Uses local face API if available, otherwise falls back to bridge."""
    indexed = 0
    processed = 0
    local = use_local_api()

    def index_one(item):
        img_url, label, source = item
        if local:
            ok = local_face_index(img_url, label, f"satellite_{source}")
        else:
            result = api_call("/osint/face/index", {
                "imageUrl": img_url,
                "label": label,
                "sourcePlatform": f"satellite_{source}",
            }, timeout=30)
            ok = result and result.get("ok")
        time.sleep(INDEX_DELAY)
        return 1 if ok else 0

    with ThreadPoolExecutor(max_workers=INDEX_WORKERS) as executor:
        futures = {executor.submit(index_one, item): item for item in urls_with_meta}
        for future in as_completed(futures):
            processed += 1
            try:
                indexed += future.result()
            except Exception:
                pass

    return indexed, processed


# ── Process a single name (runs in parallel) ──

def process_name(name):
    """Scrape all engines for a name and index results — runs as a worker"""
    all_urls = []

    # Run all search engines in parallel
    with ThreadPoolExecutor(max_workers=ENGINE_WORKERS) as executor:
        future_to_engine = {}
        for engine_name, engine_fn in ENGINES:
            future_to_engine[executor.submit(engine_fn, name)] = engine_name

        for future in as_completed(future_to_engine):
            engine_name = future_to_engine[future]
            try:
                urls = future.result()
                log(f"  [{engine_name}] {len(urls)} — {name}")
                all_urls.extend([(u, engine_name) for u in urls])
            except Exception as e:
                log(f"  [{engine_name}] error — {name}: {e}")

    # Deduplicate
    seen = set()
    unique = []
    for url, source in all_urls:
        if url not in seen:
            seen.add(url)
            unique.append((url, name, source))

    log(f"  [total] {len(unique)} unique — {name}")

    # Index in parallel
    if unique:
        indexed, processed = index_batch(unique)
        log(f"  [indexed] {indexed}/{processed} — {name}")
        return indexed, processed, len(unique)

    return 0, 0, 0


# ── Crawl Cycle ──

def run_cycle(state):
    """Run one crawl cycle — process batch of names with parallel workers"""
    cycle_indexed = 0
    cycle_processed = 0
    cycle_scraped = 0

    # Get next names
    queue = state.get("names_queue", [])
    if not queue:
        # Refill: seed + discovered + bridge queue
        all_names = list(SEED_NAMES)
        all_names.extend(state.get("discovered_names", []))
        status = api_call("/osint/face/crawl/status")
        if status and status.get("crawlState", {}).get("named", {}).get("queue"):
            all_names.extend(status["crawlState"]["named"]["queue"])
        # Remove already processed (but allow re-processing after full rotation)
        processed_set = set(state.get("names_processed", []))
        queue = [n for n in dict.fromkeys(all_names) if n not in processed_set]
        if not queue:
            # Full rotation complete — reset processed list
            log("[cycle] Full rotation complete — resetting processed list")
            state["names_processed"] = []
            queue = list(dict.fromkeys(all_names))
        state["names_queue"] = queue

    batch = queue[:NAMES_PER_CYCLE]
    state["names_queue"] = queue[NAMES_PER_CYCLE:]

    log(f"[cycle] Processing {len(batch)} names with {NAME_WORKERS} workers")

    # Process names in parallel
    with ThreadPoolExecutor(max_workers=NAME_WORKERS) as executor:
        futures = {executor.submit(process_name, name): name for name in batch}
        for future in as_completed(futures):
            name = futures[future]
            try:
                indexed, processed, scraped = future.result()
                cycle_indexed += indexed
                cycle_processed += processed
                cycle_scraped += scraped
            except Exception as e:
                log(f"  [error] {name}: {e}")

            with state_lock:
                if name not in state.get("names_processed", []):
                    state.setdefault("names_processed", []).append(name)

    # Keep processed list manageable
    if len(state.get("names_processed", [])) > 10000:
        state["names_processed"] = state["names_processed"][-5000:]

    state["total_indexed"] = state.get("total_indexed", 0) + cycle_indexed
    state["total_processed"] = state.get("total_processed", 0) + cycle_processed
    state["total_scraped"] = state.get("total_scraped", 0) + cycle_scraped
    state["cycles"] = state.get("cycles", 0) + 1

    return cycle_indexed, cycle_processed, cycle_scraped


def main():
    if "--status" in sys.argv:
        state = load_state()
        stats = api_call("/osint/face/stats")
        log(json.dumps({
            "qdrant": stats,
            "crawler": {
                "queue": len(state.get("names_queue", [])),
                "processed": len(state.get("names_processed", [])),
                "total_indexed": state.get("total_indexed", 0),
                "total_scraped": state.get("total_scraped", 0),
                "cycles": state.get("cycles", 0),
                "discovered": len(state.get("discovered_names", [])),
            }
        }, indent=2))
        return

    if "--expand" in sys.argv:
        log("Discovering names from Wikipedia...")
        names = discover_names_from_wikipedia()
        log(f"Found {len(names)} names")
        state = load_state()
        existing = set(SEED_NAMES + state.get("discovered_names", []))
        new_names = [n for n in names if n not in existing]
        state.setdefault("discovered_names", []).extend(new_names)
        state.setdefault("names_queue", []).extend(new_names)
        save_state(state)
        log(f"Added {len(new_names)} new names to queue")
        return

    once = "--once" in sys.argv
    state = load_state()

    # Migrate old state
    if "google_offset" in state:
        del state["google_offset"]
    if "discovered_names" not in state:
        state["discovered_names"] = []
    if "total_scraped" not in state:
        state["total_scraped"] = 0

    # Expand queue if it was from v1 (only 41 names)
    if len(state.get("names_queue", [])) < 100 and state.get("cycles", 0) < 2:
        existing_queue = set(state.get("names_queue", []))
        existing_processed = set(state.get("names_processed", []))
        for name in SEED_NAMES:
            if name not in existing_queue and name not in existing_processed:
                state.setdefault("names_queue", []).append(name)

    log("=" * 60)
    log("SATELLITE FACE CRAWLER v2 — SCALED")
    log(f"Bridge: {BRIDGE_URL}")
    log(f"Workers: {NAME_WORKERS} name × {ENGINE_WORKERS} engine × {INDEX_WORKERS} index")
    log(f"Queue: {len(state.get('names_queue', []))} names")
    log(f"Processed: {len(state.get('names_processed', []))} names")
    log(f"Total indexed: {state.get('total_indexed', 0)}")
    log(f"Total scraped: {state.get('total_scraped', 0)}")
    log(f"Seed names: {len(SEED_NAMES)}")
    log("=" * 60)

    # Verify connectivity
    stats = api_call("/osint/face/stats")
    if not stats:
        log(f"ERROR: Cannot reach bridge API at {BRIDGE_URL}")
        sys.exit(1)
    log(f"Bridge OK — Qdrant: {stats.get('points_count', '?')} faces")

    # Check local face API
    if check_local_face_api():
        local_stats = api_call("/stats", base_url=LOCAL_FACE_API)
        log(f"Local Face API OK — processing on dev-01 CPU")
        if local_stats:
            log(f"Qdrant (direct): {local_stats.get('points_count', '?')} faces")
    else:
        log(f"Local Face API not running — using bridge (slower)")

    # Auto-discover names on first run
    if not state.get("discovered_names") and not once:
        log("\n[discovery] Fetching names from Wikipedia...")
        discovered = discover_names_from_wikipedia()
        new_names = [n for n in discovered if n not in SEED_NAMES]
        state["discovered_names"] = new_names
        state.setdefault("names_queue", []).extend(new_names)
        log(f"[discovery] Added {len(new_names)} names (total queue: {len(state.get('names_queue', []))})")
        save_state(state)

    while True:
        log(f"\n{'=' * 60}")
        log(f"Cycle {state.get('cycles', 0) + 1} — queue: {len(state.get('names_queue', []))} names")
        start = time.time()

        try:
            indexed, processed, scraped = run_cycle(state)
            elapsed = time.time() - start
            rate = indexed / (elapsed / 60) if elapsed > 0 else 0
            log(f"\nCycle done: {indexed}/{processed} indexed, {scraped} scraped in {elapsed:.0f}s ({rate:.0f} faces/min)")

            stats = api_call("/osint/face/stats")
            if stats:
                log(f"Qdrant DB: {stats.get('points_count', '?')} faces")

        except Exception as e:
            log(f"Cycle error: {e}")

        save_state(state)

        if once:
            break

        log(f"Next cycle in {CYCLE_INTERVAL}s...")
        time.sleep(CYCLE_INTERVAL)


if __name__ == "__main__":
    main()
