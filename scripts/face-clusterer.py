#!/usr/bin/env python3
"""
Face Clusterer — Phase 2 of Identity Resolution Engine

Groups face vectors in Qdrant into identity clusters using ArcFace similarity.
Uses Union-Find (disjoint sets) on nearest-neighbor graph for efficient clustering.

Algorithm:
  1. Scroll through all vectors in batches
  2. For each vector, search for nearest neighbors (cosine > 0.65)
  3. Union matching vectors into clusters via Union-Find
  4. Write cluster assignments back to Qdrant (cluster_id payload field)
  5. Save cluster metadata to PostgreSQL face_clusters table

Designed for 10M+ vectors — processes incrementally, saves progress.

Usage:
    python3 face-clusterer.py                    # Run full clustering
    python3 face-clusterer.py --incremental      # Only cluster new (unassigned) vectors
    python3 face-clusterer.py --stats            # Show cluster stats
    python3 face-clusterer.py --batch-size 200   # Custom batch size
"""

import os
import sys
import json
import time
import uuid
import urllib.request
import urllib.parse
from collections import defaultdict
from threading import Lock

QDRANT_URL = os.environ.get("QDRANT_URL", "http://10.8.0.1:6333")
PG_CONNSTR = os.environ.get("PG_CONNSTR", "host=10.8.0.1 port=5432 dbname=ozzu user=ozzu password=ozzu")
COLLECTION = "faces"
SIMILARITY_THRESHOLD = 0.65  # cosine similarity for same person
SEARCH_LIMIT = 10            # max neighbors per vector
BATCH_SIZE = 100             # vectors per scroll batch
PROGRESS_FILE = os.path.expanduser("~/.ozzu-clusterer-progress.json")

_stats = {
    "scanned": 0,
    "clustered": 0,
    "new_clusters": 0,
    "merged_clusters": 0,
    "skipped": 0,
    "started_at": time.time(),
}


def log(msg):
    print(msg, flush=True)


def load_progress():
    try:
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    except Exception:
        return {"last_offset": None, "total_scanned": 0, "total_clustered": 0}


def save_progress(progress):
    try:
        with open(PROGRESS_FILE, "w") as f:
            json.dump(progress, f, indent=2)
    except Exception:
        pass


# ── Union-Find for efficient clustering ──

class UnionFind:
    """Disjoint set / Union-Find with path compression and union by rank."""

    def __init__(self):
        self.parent = {}
        self.rank = {}
        self.size = {}

    def find(self, x):
        if x not in self.parent:
            self.parent[x] = x
            self.rank[x] = 0
            self.size[x] = 1
            return x
        if self.parent[x] != x:
            self.parent[x] = self.find(self.parent[x])  # path compression
        return self.parent[x]

    def union(self, x, y):
        rx, ry = self.find(x), self.find(y)
        if rx == ry:
            return False
        # Union by rank
        if self.rank[rx] < self.rank[ry]:
            rx, ry = ry, rx
        self.parent[ry] = rx
        self.size[rx] += self.size[ry]
        if self.rank[rx] == self.rank[ry]:
            self.rank[rx] += 1
        return True

    def get_clusters(self):
        """Return dict of {root_id: [member_ids]}"""
        clusters = defaultdict(list)
        for x in self.parent:
            clusters[self.find(x)].append(x)
        return dict(clusters)

    def cluster_count(self):
        roots = set()
        for x in self.parent:
            roots.add(self.find(x))
        return len(roots)


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


def scroll_vectors(offset=None, limit=BATCH_SIZE, with_vector=False):
    data = {
        "limit": limit,
        "with_payload": True,
        "with_vector": with_vector,
    }
    if offset:
        data["offset"] = offset
    return qdrant_request(f"/collections/{COLLECTION}/points/scroll", data)


def search_similar(vector, limit=SEARCH_LIMIT, threshold=SIMILARITY_THRESHOLD):
    """Search for similar vectors. Returns list of {id, score}."""
    data = {
        "vector": vector,
        "limit": limit,
        "score_threshold": threshold,
        "with_payload": ["label", "source_platform", "cluster_id"],
        "with_vector": False,
    }
    result = qdrant_request(f"/collections/{COLLECTION}/points/search", data)
    return result.get("result", [])


def get_vectors_batch(point_ids):
    """Get vectors for specific point IDs."""
    data = {
        "ids": point_ids,
        "with_payload": True,
        "with_vector": True,
    }
    result = qdrant_request(f"/collections/{COLLECTION}/points", data, method="POST")
    return result.get("result", [])


def set_cluster_ids(updates):
    """Batch update cluster_id payload for multiple points.
    updates: list of (point_id, cluster_id)"""
    for point_id, cluster_id in updates:
        try:
            qdrant_request(
                f"/collections/{COLLECTION}/points/payload",
                {"payload": {"cluster_id": cluster_id}, "points": [point_id]},
                method="PUT"
            )
        except Exception as e:
            log(f"  [error] Failed to set cluster_id for {point_id}: {e}")


# ── PostgreSQL helpers ──

def get_pg():
    try:
        import psycopg2
        return psycopg2.connect(PG_CONNSTR)
    except ImportError:
        log("[warn] psycopg2 not available — cluster metadata won't be saved to PostgreSQL")
        return None
    except Exception as e:
        log(f"[warn] PostgreSQL connection failed: {e}")
        return None


def save_clusters_to_pg(clusters, point_payloads):
    """Save cluster metadata to face_clusters table."""
    conn = get_pg()
    if not conn:
        return

    try:
        cur = conn.cursor()
        saved = 0
        for root_id, members in clusters.items():
            cluster_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"cluster-{root_id}"))

            # Gather metadata from member payloads
            labels = []
            sources = set()
            det_scores = []
            for mid in members:
                payload = point_payloads.get(mid, {})
                if payload.get("label"):
                    labels.append(payload["label"])
                if payload.get("source_platform"):
                    sources.add(payload["source_platform"])
                if payload.get("det_score"):
                    det_scores.append(payload["det_score"])

            # Pick most common label as representative
            rep_label = ""
            if labels:
                from collections import Counter
                rep_label = Counter(labels).most_common(1)[0][0]

            avg_score = sum(det_scores) / len(det_scores) if det_scores else 0

            cur.execute("""
                INSERT INTO face_clusters (id, cluster_size, representative_point_id, representative_label, avg_det_score, sources, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, NOW())
                ON CONFLICT (id) DO UPDATE SET
                    cluster_size = EXCLUDED.cluster_size,
                    representative_label = EXCLUDED.representative_label,
                    avg_det_score = EXCLUDED.avg_det_score,
                    sources = EXCLUDED.sources,
                    updated_at = NOW()
            """, (cluster_uuid, len(members), root_id, rep_label, avg_score, json.dumps(list(sources))))
            saved += 1

        conn.commit()
        cur.close()
        conn.close()
        log(f"  [pg] Saved {saved} clusters to face_clusters")
    except Exception as e:
        log(f"  [pg] Error saving clusters: {e}")
        try:
            conn.close()
        except Exception:
            pass


# ── Main clustering logic ──

def run_incremental_clustering():
    """Cluster only vectors that don't have a cluster_id yet."""
    log("=== Incremental Clustering Mode ===")
    log("Scanning for unassigned vectors...")

    uf = UnionFind()
    point_payloads = {}
    offset = None
    batch_num = 0
    total_unassigned = 0

    while True:
        result = scroll_vectors(offset=offset, limit=BATCH_SIZE, with_vector=True)
        points = result.get("result", {}).get("points", [])
        next_offset = result.get("result", {}).get("next_page_offset")

        if not points:
            break

        batch_num += 1
        _stats["scanned"] += len(points)

        # Filter to unassigned vectors
        unassigned = [p for p in points if not p.get("payload", {}).get("cluster_id")]
        total_unassigned += len(unassigned)

        for point in unassigned:
            pid = point["id"]
            vector = point.get("vector", [])
            payload = point.get("payload", {})
            point_payloads[pid] = payload

            if not vector:
                continue

            # Search for similar faces
            try:
                neighbors = search_similar(vector, limit=SEARCH_LIMIT)
            except Exception:
                continue

            # Union with neighbors
            for neighbor in neighbors:
                nid = neighbor["id"]
                if nid == pid:
                    continue
                score = neighbor.get("score", 0)
                if score >= SIMILARITY_THRESHOLD:
                    merged = uf.union(pid, nid)
                    if merged:
                        _stats["merged_clusters"] += 1
                    # Also cache neighbor payload
                    if nid not in point_payloads and neighbor.get("payload"):
                        point_payloads[nid] = neighbor["payload"]

            # Ensure this point is in the union-find
            uf.find(pid)

        if batch_num % 5 == 0:
            uptime = time.time() - _stats["started_at"]
            rate = _stats["scanned"] / (uptime / 60) if uptime > 0 else 0
            log(f"[batch {batch_num}] scanned={_stats['scanned']}, unassigned={total_unassigned}, "
                f"clusters={uf.cluster_count()}, merges={_stats['merged_clusters']}, rate={rate:.0f}/min")

        offset = next_offset
        if not next_offset:
            break

    # Get final clusters
    clusters = uf.get_clusters()
    log(f"\n[clustering] Found {len(clusters)} clusters from {total_unassigned} unassigned vectors")

    # Write cluster_ids back to Qdrant
    updates = []
    for root_id, members in clusters.items():
        cluster_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"cluster-{root_id}"))
        for member_id in members:
            updates.append((member_id, cluster_uuid))

    if updates:
        log(f"[qdrant] Writing {len(updates)} cluster assignments...")
        # Batch in chunks of 100
        for i in range(0, len(updates), 100):
            chunk = updates[i:i + 100]
            set_cluster_ids(chunk)
            if (i // 100) % 10 == 0 and i > 0:
                log(f"  [qdrant] {i}/{len(updates)} updated")
        log(f"  [qdrant] Done — {len(updates)} points assigned to {len(clusters)} clusters")

    # Save to PostgreSQL
    if clusters:
        save_clusters_to_pg(clusters, point_payloads)

    return clusters


def show_stats():
    """Show clustering statistics."""
    try:
        info = qdrant_request(f"/collections/{COLLECTION}")
        total = info["result"]["points_count"]
    except Exception:
        total = "?"

    # Sample vectors to check cluster coverage
    try:
        sample = scroll_vectors(limit=200)
        points = sample["result"]["points"]
        with_cluster = sum(1 for p in points if p.get("payload", {}).get("cluster_id"))
        log(f"=== Clustering Stats ===")
        log(f"Total vectors: {total}")
        log(f"Sample (200): {with_cluster} have cluster_id ({with_cluster / 2:.0f}%)")

        # Count unique clusters in sample
        cluster_ids = set()
        for p in points:
            cid = p.get("payload", {}).get("cluster_id")
            if cid:
                cluster_ids.add(cid)
        log(f"Unique clusters in sample: {len(cluster_ids)}")

        # Check PostgreSQL
        conn = get_pg()
        if conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*), SUM(cluster_size), AVG(cluster_size) FROM face_clusters")
            row = cur.fetchone()
            log(f"\nPostgreSQL face_clusters:")
            log(f"  Total clusters: {row[0]}")
            log(f"  Total members: {row[1]}")
            log(f"  Avg cluster size: {row[2]:.1f}" if row[2] else "  Avg cluster size: N/A")

            cur.execute("SELECT representative_label, cluster_size FROM face_clusters ORDER BY cluster_size DESC LIMIT 10")
            rows = cur.fetchall()
            if rows:
                log(f"\nTop 10 clusters by size:")
                for label, size in rows:
                    log(f"  {label or '(unnamed)'}: {size} faces")
            cur.close()
            conn.close()
    except Exception as e:
        log(f"Error: {e}")

    progress = load_progress()
    log(f"\nProgress: {progress.get('total_scanned', 0)} scanned, {progress.get('total_clustered', 0)} clustered")


def main():
    if "--stats" in sys.argv:
        show_stats()
        return

    batch_size_val = BATCH_SIZE
    if "--batch-size" in sys.argv:
        idx = sys.argv.index("--batch-size")
        batch_size_val = int(sys.argv[idx + 1])
        global BATCH_SIZE
        BATCH_SIZE = batch_size_val

    incremental = "--incremental" in sys.argv or True  # Default to incremental

    log("=" * 60)
    log("FACE CLUSTERER — Identity Resolution Phase 2")
    log(f"Qdrant: {QDRANT_URL}")
    log(f"Similarity threshold: {SIMILARITY_THRESHOLD}")
    log(f"Batch size: {BATCH_SIZE}")
    log(f"Mode: {'incremental' if incremental else 'full'}")
    log("=" * 60)

    try:
        clusters = run_incremental_clustering()

        log(f"\n=== Final Stats ===")
        log(f"Scanned: {_stats['scanned']}")
        log(f"Clusters found: {len(clusters)}")
        log(f"Merges performed: {_stats['merged_clusters']}")

        # Show top clusters
        if clusters:
            sorted_clusters = sorted(clusters.items(), key=lambda x: len(x[1]), reverse=True)
            log(f"\nTop 10 clusters:")
            for root_id, members in sorted_clusters[:10]:
                log(f"  {root_id[:12]}... — {len(members)} members")

    except KeyboardInterrupt:
        log("\n[interrupted] Saving progress...")
    except Exception as e:
        log(f"[error] {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
