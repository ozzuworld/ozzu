#!/usr/bin/env python3
"""
Profile Builder — Phase 3 of Identity Resolution Engine

Takes face clusters from Phase 2 and builds identity profiles using:
  - Named Entity Recognition (NER) on cluster context text
  - Fellegi-Sunter probabilistic record linkage for name deduplication
  - Confidence scoring based on source agreement

For each cluster:
  1. Collect all context metadata (labels, page_titles, nearby_text, alt_text)
  2. Extract named entities (PERSON, ORG, GPE/LOC, DATE)
  3. Score candidate names using Fellegi-Sunter match weights
  4. Create/update face_identities record in PostgreSQL

Usage:
    python3 profile-builder.py                  # Build profiles for all clusters
    python3 profile-builder.py --stats          # Show profile stats
    python3 profile-builder.py --cluster ID     # Build profile for specific cluster
"""

import os
import sys
import json
import time
import re
import uuid
import urllib.request
from collections import Counter, defaultdict
from difflib import SequenceMatcher

QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
PG_CONNSTR = os.environ.get("PG_CONNSTR", "host=localhost port=5432 dbname=ozzu user=ozzu password=ozzu")
COLLECTION = "faces"


def log(msg):
    print(msg, flush=True)


# ── Qdrant helpers ──

def qdrant_request(path, data=None, method=None):
    url = f"{QDRANT_URL}{path}"
    if data:
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
        if method:
            req.get_method = lambda: method
    else:
        req = urllib.request.Request(url)
        if method:
            req.get_method = lambda: method
    resp = urllib.request.urlopen(req, timeout=60)
    return json.loads(resp.read())


def get_cluster_points(cluster_id, limit=500):
    """Get all points belonging to a cluster."""
    data = {
        "filter": {
            "must": [{"key": "cluster_id", "match": {"value": cluster_id}}]
        },
        "limit": limit,
        "with_payload": True,
        "with_vector": False,
    }
    result = qdrant_request(f"/collections/{COLLECTION}/points/scroll", data)
    return result.get("result", {}).get("points", [])


# ── PostgreSQL helpers ──

def get_pg():
    try:
        import psycopg2
        return psycopg2.connect(PG_CONNSTR)
    except Exception as e:
        log(f"[pg] Connection failed: {e}")
        return None


def get_all_clusters(conn):
    """Get all clusters from face_clusters table."""
    cur = conn.cursor()
    cur.execute("SELECT id, cluster_size, representative_label FROM face_clusters ORDER BY cluster_size DESC")
    rows = cur.fetchall()
    cur.close()
    return rows


def get_existing_identity(conn, cluster_id):
    """Check if an identity already exists for this cluster."""
    cur = conn.cursor()
    cur.execute("SELECT id, primary_name, confidence FROM face_identities WHERE cluster_id = %s", (cluster_id,))
    row = cur.fetchone()
    cur.close()
    return row


def save_identity(conn, identity):
    """Insert or update a face_identity record."""
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO face_identities (id, cluster_id, primary_name, alternate_names, organizations,
            locations, occupations, confidence, source_count, domain_count, first_seen, last_seen, metadata)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (id) DO UPDATE SET
            primary_name = EXCLUDED.primary_name,
            alternate_names = EXCLUDED.alternate_names,
            organizations = EXCLUDED.organizations,
            locations = EXCLUDED.locations,
            occupations = EXCLUDED.occupations,
            confidence = EXCLUDED.confidence,
            source_count = EXCLUDED.source_count,
            domain_count = EXCLUDED.domain_count,
            last_seen = EXCLUDED.last_seen,
            metadata = EXCLUDED.metadata,
            updated_at = NOW()
    """, (
        identity["id"], identity["cluster_id"], identity["primary_name"],
        identity["alternate_names"], identity["organizations"],
        identity["locations"], identity["occupations"],
        identity["confidence"], identity["source_count"], identity["domain_count"],
        identity["first_seen"], identity["last_seen"],
        json.dumps(identity["metadata"]),
    ))
    conn.commit()
    cur.close()


# ── NER: Named Entity Recognition ──
# Lightweight regex-based NER (no spaCy dependency required)
# Falls back to pattern matching for PERSON, ORG, GPE extraction

def extract_entities_regex(texts):
    """Extract named entities using regex patterns.
    Returns dict with keys: persons, organizations, locations, dates."""
    entities = {
        "persons": [],
        "organizations": [],
        "locations": [],
        "dates": [],
        "occupations": [],
    }

    combined = " ".join(texts)

    # Person names: Capitalized word pairs/triples
    # Filter out common non-name patterns
    not_names = {
        "The", "This", "That", "These", "Those", "There", "Their", "What", "When",
        "Where", "Which", "About", "After", "Before", "During", "Under", "Over",
        "Image", "Photo", "Picture", "File", "Source", "Credit", "Getty", "Reuters",
        "Associated Press", "Wikipedia", "Wikimedia", "Commons", "Category",
        "New York", "Los Angeles", "San Francisco", "Hong Kong", "United States",
        "United Kingdom", "North Korea", "South Korea", "Saudi Arabia",
        "Red Carpet", "White House", "Wall Street", "Super Bowl",
    }

    # Extract from labels/titles (most reliable source)
    for text in texts:
        if not text:
            continue
        # Clean up common prefixes/suffixes
        text = re.sub(r'\s*[-–—]\s*(Wikipedia|Getty|Reuters|AP|AFP).*$', '', text)
        text = re.sub(r'\s*\|.*$', '', text)
        text = re.sub(r'\s*\(.*?\)\s*', ' ', text)

        # Capitalized name patterns (2-4 words)
        for match in re.finditer(r'(?:^|\s)([A-Z][a-z]+(?:\s+(?:de|van|von|al|el|la|del|dos|da|bin|ibn)\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)', text):
            name = match.group(1).strip()
            if name not in not_names and len(name) > 3 and len(name) < 60:
                entities["persons"].append(name)

    # Organizations: keywords + patterns
    org_patterns = [
        r'(?:at|for|of|with)\s+((?:[A-Z][a-z]*\s+){0,3}(?:Inc|Corp|LLC|Ltd|Co|Group|Foundation|Institute|University|College|Association|Organization|Company|Bank|Agency|Network|Studios|Entertainment|Records|Music|Sports)\.?)',
        r'((?:[A-Z][a-z]*\s+){0,3}(?:NASA|FBI|CIA|WHO|UN|EU|NATO|IMF|UNICEF|OPEC|SEC|FTC|FDA))',
        r'(Google|Apple|Microsoft|Amazon|Meta|Tesla|SpaceX|Netflix|Disney|Nike|Samsung|Sony|IBM|Intel|Oracle|Adobe|Nvidia|AMD|Qualcomm)',
    ]
    for pattern in org_patterns:
        for match in re.finditer(pattern, combined):
            org = match.group(1).strip()
            if org and len(org) > 2:
                entities["organizations"].append(org)

    # Locations
    loc_patterns = [
        r'(?:in|from|at|near)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)',
        r'(New York|Los Angeles|London|Paris|Tokyo|Beijing|Moscow|Berlin|Rome|Madrid|Sydney|Toronto|Mumbai|Dubai|Singapore|Hong Kong|Shanghai|Seoul|Bangkok|Istanbul)',
    ]
    for pattern in loc_patterns:
        for match in re.finditer(pattern, combined):
            loc = match.group(1).strip()
            if loc and len(loc) > 2 and loc not in not_names:
                entities["locations"].append(loc)

    # Occupation keywords
    occ_keywords = [
        "actor", "actress", "singer", "musician", "artist", "director", "producer",
        "president", "prime minister", "senator", "governor", "mayor", "politician",
        "CEO", "founder", "entrepreneur", "businessman", "businesswoman",
        "athlete", "player", "coach", "manager",
        "journalist", "reporter", "anchor", "correspondent",
        "professor", "scientist", "researcher", "doctor", "engineer",
        "model", "designer", "photographer",
        "author", "writer", "poet", "comedian",
    ]
    combined_lower = combined.lower()
    for occ in occ_keywords:
        if occ in combined_lower:
            entities["occupations"].append(occ)

    return entities


def try_spacy_ner(texts):
    """Try to use spaCy for NER if available. Returns entities dict or None."""
    try:
        import spacy
        try:
            nlp = spacy.load("en_core_web_sm")
        except OSError:
            return None

        entities = {
            "persons": [],
            "organizations": [],
            "locations": [],
            "dates": [],
            "occupations": [],
        }

        combined = " ".join(t for t in texts if t)[:5000]
        doc = nlp(combined)

        for ent in doc.ents:
            if ent.label_ == "PERSON":
                entities["persons"].append(ent.text)
            elif ent.label_ == "ORG":
                entities["organizations"].append(ent.text)
            elif ent.label_ in ("GPE", "LOC"):
                entities["locations"].append(ent.text)
            elif ent.label_ == "DATE":
                entities["dates"].append(ent.text)

        return entities
    except ImportError:
        return None


def extract_entities(texts):
    """Extract entities using spaCy if available, otherwise regex."""
    result = try_spacy_ner(texts)
    if result:
        return result
    return extract_entities_regex(texts)


# ── Fellegi-Sunter Record Linkage ──

def name_similarity(name_a, name_b):
    """Compute similarity between two name strings.
    Uses SequenceMatcher + special handling for name variants."""
    a = name_a.lower().strip()
    b = name_b.lower().strip()

    if a == b:
        return 1.0

    # Check if one is a subset of the other
    a_parts = set(a.split())
    b_parts = set(b.split())
    if a_parts.issubset(b_parts) or b_parts.issubset(a_parts):
        return 0.85

    # SequenceMatcher for general similarity
    return SequenceMatcher(None, a, b).ratio()


def fellegi_sunter_resolve(name_candidates):
    """Fellegi-Sunter style name resolution.
    Takes a list of candidate names, groups similar ones,
    returns (primary_name, alternate_names, confidence)."""
    if not name_candidates:
        return "", [], 0.0

    # Count occurrences
    counts = Counter(name_candidates)

    # Group similar names using greedy clustering
    groups = []
    used = set()

    for name, count in counts.most_common():
        if name in used:
            continue

        group = [(name, count)]
        used.add(name)

        for other, other_count in counts.most_common():
            if other in used:
                continue
            if name_similarity(name, other) > 0.7:
                group.append((other, other_count))
                used.add(other)

        groups.append(group)

    if not groups:
        return "", [], 0.0

    # Pick the largest group
    best_group = max(groups, key=lambda g: sum(c for _, c in g))

    # Primary name: most frequent in the group
    primary = max(best_group, key=lambda x: x[1])[0]
    alternates = [name for name, _ in best_group if name != primary]

    # Confidence: proportion of total mentions that agree with primary group
    total_mentions = sum(counts.values())
    group_mentions = sum(c for _, c in best_group)
    confidence = group_mentions / total_mentions if total_mentions > 0 else 0

    # Boost confidence if many unique sources agree
    unique_sources = len(best_group)
    if unique_sources >= 5:
        confidence = min(1.0, confidence * 1.2)

    return primary, alternates, round(confidence, 3)


# ── Profile building ──

def build_profile_for_cluster(cluster_id, points):
    """Build an identity profile from cluster points."""
    # Collect all text metadata
    labels = []
    page_titles = []
    nearby_texts = []
    alt_texts = []
    meta_descs = []
    domains = set()
    platforms = set()
    timestamps = []

    for point in points:
        payload = point.get("payload", {})
        if payload.get("label"):
            labels.append(payload["label"])
        if payload.get("page_title"):
            page_titles.append(payload["page_title"])
        if payload.get("nearby_text"):
            nearby_texts.append(payload["nearby_text"])
        if payload.get("alt_text"):
            alt_texts.append(payload["alt_text"])
        if payload.get("meta_description"):
            meta_descs.append(payload["meta_description"])
        if payload.get("domain"):
            domains.add(payload["domain"])
        if payload.get("source_platform"):
            platforms.add(payload["source_platform"])

    # Run NER on all text
    all_texts = labels + page_titles + nearby_texts + alt_texts + meta_descs
    entities = extract_entities(all_texts)

    # Combine label-extracted names with NER-extracted names
    all_person_names = entities["persons"] + labels

    # Clean: remove non-name labels (search engine artifacts, platform tags)
    cleaned_names = []
    skip_patterns = re.compile(
        r'(satellite_|image search|google|bing|yandex|flickr|ddg|wikipedia|'
        r'photo|picture|image|file:|category:|commons|reddit|r/|u/|'
        r'\d{4}|\.jpg|\.png|\.jpeg|\.webp|http)',
        re.IGNORECASE
    )
    for name in all_person_names:
        if not name or len(name) < 3 or len(name) > 80:
            continue
        if skip_patterns.search(name):
            # But allow "Name — wikipedia" type labels, just clean them
            name = re.sub(r'\s*[-–—].*$', '', name).strip()
            name = re.sub(r'\s*\|.*$', '', name).strip()
            if len(name) < 3:
                continue
        # Must have at least one uppercase letter (name-like)
        if not re.search(r'[A-Z]', name):
            continue
        cleaned_names.append(name)

    # Fellegi-Sunter resolution
    primary_name, alternate_names, name_confidence = fellegi_sunter_resolve(cleaned_names)

    # Deduplicate other entities
    organizations = list(set(entities["organizations"]))[:20]
    locations = list(set(entities["locations"]))[:20]
    occupations = list(set(entities["occupations"]))[:10]

    # Build identity record
    identity_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"identity-{cluster_id}"))

    return {
        "id": identity_id,
        "cluster_id": cluster_id,
        "primary_name": primary_name,
        "alternate_names": alternate_names[:10],
        "organizations": organizations,
        "locations": locations,
        "occupations": occupations,
        "confidence": name_confidence,
        "source_count": len(points),
        "domain_count": len(domains),
        "first_seen": None,
        "last_seen": None,
        "metadata": {
            "platforms": list(platforms),
            "domains": list(domains)[:50],
            "ner_method": "spacy" if try_spacy_ner(["test"]) else "regex",
            "name_candidates_count": len(cleaned_names),
            "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
    }


def run_profile_builder():
    """Build profiles for all clusters."""
    conn = get_pg()
    if not conn:
        log("[error] Cannot connect to PostgreSQL")
        return

    clusters = get_all_clusters(conn)
    log(f"Found {len(clusters)} clusters to process")

    built = 0
    skipped = 0
    updated = 0

    for cluster_id, cluster_size, rep_label in clusters:
        cluster_id_str = str(cluster_id)

        # Check if identity already exists
        existing = get_existing_identity(conn, cluster_id_str)
        if existing and existing[2] and existing[2] > 0.5:
            skipped += 1
            continue

        # Get cluster points from Qdrant
        try:
            points = get_cluster_points(cluster_id_str)
        except Exception as e:
            log(f"  [error] Failed to get points for cluster {cluster_id_str[:12]}: {e}")
            continue

        if not points:
            skipped += 1
            continue

        # Build profile
        identity = build_profile_for_cluster(cluster_id_str, points)

        if not identity["primary_name"]:
            # No name could be resolved — skip
            skipped += 1
            continue

        # Save to PostgreSQL
        try:
            save_identity(conn, identity)
            if existing:
                updated += 1
            else:
                built += 1

            if (built + updated) % 50 == 0:
                log(f"  [progress] built={built}, updated={updated}, skipped={skipped}")

        except Exception as e:
            log(f"  [error] Failed to save identity for {identity['primary_name']}: {e}")

    conn.close()
    log(f"\n=== Profile Builder Results ===")
    log(f"New profiles: {built}")
    log(f"Updated: {updated}")
    log(f"Skipped: {skipped}")
    log(f"Total clusters: {len(clusters)}")


def show_stats():
    """Show profile building statistics."""
    conn = get_pg()
    if not conn:
        return

    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM face_clusters")
    total_clusters = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM face_identities")
    total_identities = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM face_identities WHERE primary_name IS NOT NULL AND primary_name != ''")
    named = cur.fetchone()[0]

    cur.execute("SELECT AVG(confidence), MAX(confidence), MIN(confidence) FROM face_identities WHERE confidence > 0")
    row = cur.fetchone()

    log(f"=== Profile Builder Stats ===")
    log(f"Total clusters: {total_clusters}")
    log(f"Total identities: {total_identities}")
    log(f"Named identities: {named}")
    if row and row[0]:
        log(f"Confidence — avg: {row[0]:.2f}, max: {row[1]:.2f}, min: {row[2]:.2f}")

    cur.execute("""
        SELECT primary_name, confidence, source_count, domain_count, array_length(organizations, 1) as org_count
        FROM face_identities
        WHERE primary_name IS NOT NULL AND primary_name != ''
        ORDER BY confidence DESC, source_count DESC
        LIMIT 15
    """)
    rows = cur.fetchall()
    if rows:
        log(f"\nTop 15 identities by confidence:")
        for name, conf, sources, domains, orgs in rows:
            log(f"  {name}: conf={conf:.2f}, sources={sources}, domains={domains}, orgs={orgs or 0}")

    cur.close()
    conn.close()


def main():
    if "--stats" in sys.argv:
        show_stats()
        return

    log("=" * 60)
    log("PROFILE BUILDER — Identity Resolution Phase 3")
    log(f"Qdrant: {QDRANT_URL}")
    log(f"PostgreSQL: {PG_CONNSTR.split('host=')[1].split(' ')[0] if 'host=' in PG_CONNSTR else '?'}")
    log("=" * 60)

    try:
        run_profile_builder()
    except KeyboardInterrupt:
        log("\n[interrupted]")
    except Exception as e:
        log(f"[error] {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
