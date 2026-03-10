#!/usr/bin/env python3
"""
Relationship Builder — Phase 4 of Identity Resolution Engine

Builds relationship edges between face identities based on co-occurrence:
  - Same-photo co-occurrence (weight 0.8): multiple faces in same image
  - Same-page co-occurrence (weight 0.4): faces from same page URL
  - Same-domain co-occurrence (weight 0.2): faces appearing on same domains
  - Temporal patterns strengthen edges over time

Uses face_relationships table in PostgreSQL.

Usage:
    python3 relationship-builder.py               # Build all relationships
    python3 relationship-builder.py --stats       # Show relationship stats
"""

import os
import sys
import json
import time
import uuid
import urllib.request
from collections import defaultdict

QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
PG_CONNSTR = os.environ.get("PG_CONNSTR", "host=localhost port=5432 dbname=ozzu user=ozzu password=ozzu")
COLLECTION = "faces"

CO_PHOTO_WEIGHT = 0.8
CO_PAGE_WEIGHT = 0.4
CO_DOMAIN_WEIGHT = 0.2
MIN_WEIGHT = 0.3  # minimum weight to store


def log(msg):
    print(msg, flush=True)


def qdrant_request(path, data=None, method=None):
    url = f"{QDRANT_URL}{path}"
    if data:
        body = json.dumps(data).encode()
        req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
        if method:
            req.get_method = lambda: method
    else:
        req = urllib.request.Request(url)
    resp = urllib.request.urlopen(req, timeout=60)
    return json.loads(resp.read())


def get_pg():
    try:
        import psycopg2
        return psycopg2.connect(PG_CONNSTR)
    except Exception as e:
        log(f"[pg] Connection failed: {e}")
        return None


def get_identities(conn):
    """Get all identities with their cluster IDs."""
    cur = conn.cursor()
    cur.execute("SELECT id, cluster_id, primary_name FROM face_identities WHERE primary_name IS NOT NULL AND primary_name != ''")
    rows = cur.fetchall()
    cur.close()
    return rows


def get_cluster_sources(cluster_id):
    """Get source URLs and pages for a cluster's vectors."""
    data = {
        "filter": {"must": [{"key": "cluster_id", "match": {"value": cluster_id}}]},
        "limit": 500,
        "with_payload": ["source_url", "page_url", "domain"],
        "with_vector": False,
    }
    try:
        result = qdrant_request(f"/collections/{COLLECTION}/points/scroll", data)
        return result.get("result", {}).get("points", [])
    except Exception:
        return []


def build_co_occurrence_index(identities):
    """Build indexes for co-occurrence detection.
    Returns: page_index (page_url → [identity_ids]), domain_index (domain → [identity_ids])"""

    page_index = defaultdict(set)    # page_url → set of identity IDs
    domain_index = defaultdict(set)  # domain → set of identity IDs
    source_index = defaultdict(set)  # source_url → set of identity IDs

    for identity_id, cluster_id, name in identities:
        cluster_id_str = str(cluster_id)
        points = get_cluster_sources(cluster_id_str)

        for point in points:
            payload = point.get("payload", {})

            page_url = payload.get("page_url", "")
            if page_url:
                page_index[page_url].add(identity_id)

            source_url = payload.get("source_url", "")
            if source_url:
                source_index[source_url].add(identity_id)

            domain = payload.get("domain", "")
            if domain:
                domain_index[domain].add(identity_id)

    return page_index, domain_index, source_index


def compute_relationships(page_index, domain_index, source_index):
    """Compute relationship edges from co-occurrence indexes."""
    edges = defaultdict(lambda: {"weight": 0, "evidence": [], "types": set()})

    def add_edge(id_a, id_b, weight, rel_type, evidence_url=""):
        if id_a == id_b:
            return
        # Normalize edge direction (smaller UUID first)
        key = (min(str(id_a), str(id_b)), max(str(id_a), str(id_b)))
        edges[key]["weight"] = min(1.0, edges[key]["weight"] + weight)
        edges[key]["types"].add(rel_type)
        if evidence_url and len(edges[key]["evidence"]) < 20:
            edges[key]["evidence"].append({"url": evidence_url, "type": rel_type})

    # Same-source co-occurrence (strongest — same image URL means same photo)
    for source_url, identity_ids in source_index.items():
        ids = list(identity_ids)
        if len(ids) < 2:
            continue
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                add_edge(ids[i], ids[j], CO_PHOTO_WEIGHT, "co_photo", source_url)

    # Same-page co-occurrence
    for page_url, identity_ids in page_index.items():
        ids = list(identity_ids)
        if len(ids) < 2:
            continue
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                add_edge(ids[i], ids[j], CO_PAGE_WEIGHT, "co_page", page_url)

    # Same-domain co-occurrence (weaker)
    for domain, identity_ids in domain_index.items():
        ids = list(identity_ids)
        if len(ids) < 2 or len(ids) > 50:  # skip very common domains
            continue
        for i in range(len(ids)):
            for j in range(i + 1, min(len(ids), i + 10)):  # limit pairs
                add_edge(ids[i], ids[j], CO_DOMAIN_WEIGHT, "co_domain", domain)

    # Filter by minimum weight
    return {k: v for k, v in edges.items() if v["weight"] >= MIN_WEIGHT}


def save_relationships(conn, edges, identity_names):
    """Save relationship edges to PostgreSQL."""
    cur = conn.cursor()
    saved = 0

    for (id_a, id_b), edge in edges.items():
        rel_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"rel-{id_a}-{id_b}"))
        rel_type = ",".join(sorted(edge["types"]))

        try:
            cur.execute("""
                INSERT INTO face_relationships (id, identity_a, identity_b, relationship_type, weight, evidence_count, evidence, first_seen, last_seen)
                VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
                ON CONFLICT (identity_a, identity_b) DO UPDATE SET
                    weight = GREATEST(face_relationships.weight, EXCLUDED.weight),
                    evidence_count = face_relationships.evidence_count + EXCLUDED.evidence_count,
                    evidence = face_relationships.evidence || EXCLUDED.evidence,
                    last_seen = NOW()
            """, (rel_id, id_a, id_b, rel_type, edge["weight"], len(edge["evidence"]),
                  json.dumps(edge["evidence"][:20])))
            saved += 1
        except Exception as e:
            log(f"  [error] Failed to save edge {id_a[:8]}↔{id_b[:8]}: {e}")
            conn.rollback()
            continue

    conn.commit()
    cur.close()
    return saved


def run_relationship_builder():
    conn = get_pg()
    if not conn:
        return

    identities = get_identities(conn)
    log(f"Found {len(identities)} named identities")

    if len(identities) < 2:
        log("Need at least 2 identities to build relationships")
        conn.close()
        return

    # Build identity name lookup
    identity_names = {str(row[0]): row[2] for row in identities}

    log("Building co-occurrence indexes...")
    page_index, domain_index, source_index = build_co_occurrence_index(identities)
    log(f"  Pages: {len(page_index)}, Domains: {len(domain_index)}, Sources: {len(source_index)}")

    log("Computing relationships...")
    edges = compute_relationships(page_index, domain_index, source_index)
    log(f"  Found {len(edges)} relationship edges (≥{MIN_WEIGHT} weight)")

    if edges:
        log("Saving to PostgreSQL...")
        saved = save_relationships(conn, edges, identity_names)
        log(f"  Saved {saved} relationships")

        # Show top relationships
        sorted_edges = sorted(edges.items(), key=lambda x: x[1]["weight"], reverse=True)
        log(f"\nTop 10 relationships:")
        for (id_a, id_b), edge in sorted_edges[:10]:
            name_a = identity_names.get(id_a, id_a[:12])
            name_b = identity_names.get(id_b, id_b[:12])
            types = ",".join(edge["types"])
            log(f"  {name_a} ↔ {name_b}: weight={edge['weight']:.2f} ({types})")

    conn.close()


def show_stats():
    conn = get_pg()
    if not conn:
        return
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM face_relationships")
    total = cur.fetchone()[0]

    cur.execute("SELECT relationship_type, COUNT(*), AVG(weight) FROM face_relationships GROUP BY relationship_type")
    rows = cur.fetchall()

    log(f"=== Relationship Stats ===")
    log(f"Total edges: {total}")
    for rel_type, count, avg_weight in rows:
        log(f"  {rel_type}: {count} edges, avg weight={avg_weight:.2f}")

    cur.execute("""
        SELECT fi_a.primary_name, fi_b.primary_name, fr.weight, fr.relationship_type, fr.evidence_count
        FROM face_relationships fr
        JOIN face_identities fi_a ON fr.identity_a = fi_a.id
        JOIN face_identities fi_b ON fr.identity_b = fi_b.id
        ORDER BY fr.weight DESC
        LIMIT 15
    """)
    rows = cur.fetchall()
    if rows:
        log(f"\nTop 15 relationships:")
        for name_a, name_b, weight, rel_type, evidence in rows:
            log(f"  {name_a} ↔ {name_b}: {weight:.2f} ({rel_type}, {evidence} evidence)")

    cur.close()
    conn.close()


def main():
    if "--stats" in sys.argv:
        show_stats()
        return

    log("=" * 60)
    log("RELATIONSHIP BUILDER — Identity Resolution Phase 4")
    log("=" * 60)

    try:
        run_relationship_builder()
    except KeyboardInterrupt:
        log("\n[interrupted]")
    except Exception as e:
        log(f"[error] {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
