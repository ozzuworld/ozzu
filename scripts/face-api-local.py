#!/usr/bin/env python3
"""
Local Face API for dev-01 — ArcFace embedding + direct Qdrant insert.

Optimized for throughput:
  - OMP_NUM_THREADS=1 for true per-core parallelism
  - Batch Qdrant inserts (50 vectors per call, cuts VPN round-trips 50x)
  - Concurrent download + embed via thread pool
  - URL dedup set to skip already-processed images

Endpoints:
  POST /embed     — detect + embed faces in an image
  POST /index     — detect + embed + queue for Qdrant batch insert
  POST /batch     — batch: download + embed + batch insert (main crawler endpoint)
  GET  /stats     — Qdrant collection stats + processing stats
  GET  /health    — health check
"""

import io
import os
import sys
import json
import uuid
import base64
import time
import urllib.request
import numpy as np
from PIL import Image
from threading import Thread, Lock
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed

# Force single-threaded ONNX — allows true 8-core parallelism
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["ONNXRUNTIME_NUM_THREADS"] = "1"

_app = None
_qdrant = None

QDRANT_URL = os.environ.get("QDRANT_URL", "http://10.8.0.1:6333")
COLLECTION = "faces"
EMBEDDING_DIM = 512
MODEL_DIR = os.path.expanduser("~/.insightface")
PORT = 5555
QDRANT_BATCH_SIZE = 50      # vectors per Qdrant insert call
QDRANT_FLUSH_INTERVAL = 2.0  # seconds between forced flushes
DOWNLOAD_WORKERS = 12        # parallel image downloaders
EMBED_WORKERS = 6            # parallel ArcFace inference workers

# ── Stats tracking ──
_stats = {
    "indexed": 0,
    "failed": 0,
    "skipped_dedup": 0,
    "qdrant_batches": 0,
    "started_at": time.time(),
}
_stats_lock = Lock()

# ── URL dedup — skip images we've already processed ──
_seen_urls = set()
_seen_lock = Lock()
MAX_SEEN = 500000  # cap memory at ~40MB for 500K URLs


def is_seen(url):
    with _seen_lock:
        if url in _seen_urls:
            return True
        if len(_seen_urls) >= MAX_SEEN:
            # Evict oldest half (set doesn't preserve order, but partial clear is fine)
            to_remove = len(_seen_urls) // 2
            for _ in range(to_remove):
                _seen_urls.pop()
        _seen_urls.add(url)
        return False


# ── Qdrant batch insert queue ──
_insert_queue = deque()
_queue_lock = Lock()


def queue_for_insert(embedding, metadata):
    """Add embedding to batch queue. Flushed periodically or when full."""
    from qdrant_client.models import PointStruct
    face_id = metadata.get("face_id") or f"sat-{uuid.uuid4().hex[:8]}"
    fid = str(uuid.uuid5(uuid.NAMESPACE_URL, face_id))
    point = PointStruct(
        id=fid,
        vector=embedding,
        payload={
            "profile_id": metadata.get("profile_id", ""),
            "source_url": metadata.get("source_url", ""),
            "source_platform": metadata.get("source_platform", ""),
            "label": metadata.get("label", ""),
            "bbox": metadata.get("bbox", []),
            "det_score": metadata.get("det_score", 0),
        },
    )
    with _queue_lock:
        _insert_queue.append(point)
        queue_len = len(_insert_queue)
    if queue_len >= QDRANT_BATCH_SIZE:
        flush_queue()
    return fid


def flush_queue():
    """Flush pending inserts to Qdrant as a batch."""
    with _queue_lock:
        if not _insert_queue:
            return 0
        batch = list(_insert_queue)
        _insert_queue.clear()
    try:
        client = get_qdrant()
        client.upsert(collection_name=COLLECTION, points=batch, wait=False)
        with _stats_lock:
            _stats["indexed"] += len(batch)
            _stats["qdrant_batches"] += 1
        return len(batch)
    except Exception as e:
        print(f"[qdrant] Batch insert failed ({len(batch)} points): {e}", flush=True)
        # Re-queue failed points
        with _queue_lock:
            _insert_queue.extend(batch)
        return 0


def _flush_loop():
    """Background thread: flush Qdrant queue periodically."""
    while True:
        time.sleep(QDRANT_FLUSH_INTERVAL)
        flush_queue()


# ── Model loading ──

def get_face_app():
    global _app
    if _app is None:
        import onnxruntime
        # Set session options for single-threaded inference
        sess_options = onnxruntime.SessionOptions()
        sess_options.intra_op_num_threads = 1
        sess_options.inter_op_num_threads = 1

        from insightface.app import FaceAnalysis
        os.makedirs(MODEL_DIR, exist_ok=True)
        print(f"[face-api] Loading InsightFace buffalo_l (OMP_NUM_THREADS=1)...", flush=True)
        _app = FaceAnalysis(
            name="buffalo_l",
            root=MODEL_DIR,
            providers=["CPUExecutionProvider"],
        )
        _app.prepare(ctx_id=0, det_size=(640, 640))
        print("[face-api] Model loaded", flush=True)
    return _app


def get_qdrant():
    global _qdrant
    if _qdrant is None:
        from qdrant_client import QdrantClient
        from qdrant_client.models import Distance, VectorParams
        _qdrant = QdrantClient(url=QDRANT_URL, timeout=10)
        collections = [c.name for c in _qdrant.get_collections().collections]
        if COLLECTION not in collections:
            _qdrant.create_collection(
                collection_name=COLLECTION,
                vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
            )
            print(f"[qdrant] Created collection '{COLLECTION}'", flush=True)
        print(f"[qdrant] Connected to {QDRANT_URL}", flush=True)
    return _qdrant


# ── Image processing ──

def decode_image(data):
    img = Image.open(io.BytesIO(data)).convert("RGB")
    arr = np.array(img)
    return arr[:, :, ::-1].copy()


def detect_and_embed(img_bgr):
    app = get_face_app()
    faces = app.get(img_bgr)
    results = []
    for face in faces:
        results.append({
            "bbox": face.bbox.tolist(),
            "embedding": face.normed_embedding.tolist(),
            "det_score": float(face.det_score),
        })
    return results


def download_image(url, timeout=8):
    """Download image bytes, return (data, url) or None."""
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        })
        resp = urllib.request.urlopen(req, timeout=timeout)
        data = resp.read()
        if len(data) < 1000:
            return None
        return data
    except Exception:
        return None


def download_and_embed(url, timeout=8):
    """Download + detect face + return embedding dict or None."""
    if is_seen(url):
        with _stats_lock:
            _stats["skipped_dedup"] += 1
        return None
    data = download_image(url, timeout)
    if not data:
        return None
    try:
        img_bgr = decode_image(data)
        faces = detect_and_embed(img_bgr)
        if not faces:
            return None
        return faces[0]
    except Exception:
        return None


# ── Pipeline: parallel download → parallel embed → batch insert ──

def pipeline_process_urls(items):
    """Process a list of {url, label, source_platform} through the full pipeline.
    Downloads and embeds in parallel, batches Qdrant inserts.
    Returns {indexed, failed, skipped, total}."""
    results = {"indexed": 0, "failed": 0, "skipped": 0, "total": len(items)}

    def process_one(item):
        url = item.get("url", "")
        if not url:
            return "failed"
        if is_seen(url):
            return "skipped"
        data = download_image(url, timeout=8)
        if not data:
            return "failed"
        try:
            img_bgr = decode_image(data)
            faces = detect_and_embed(img_bgr)
            if not faces:
                return "failed"
            face = faces[0]
            queue_for_insert(face["embedding"], {
                "label": item.get("label", ""),
                "source_platform": item.get("source_platform", ""),
                "source_url": url,
                "face_id": f"sat-{uuid.uuid4().hex[:8]}",
                "bbox": face["bbox"],
                "det_score": face["det_score"],
            })
            return "indexed"
        except Exception:
            return "failed"

    # Process with thread pool — downloads + inference interleaved
    workers = min(EMBED_WORKERS, len(items))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(process_one, item): item for item in items}
        for future in as_completed(futures):
            try:
                result = future.result()
                results[result] = results.get(result, 0) + 1
            except Exception:
                results["failed"] += 1

    # Final flush
    flush_queue()
    with _stats_lock:
        _stats["failed"] += results["failed"]
        _stats["skipped_dedup"] += results.get("skipped", 0)

    return results


# ── FastAPI server ──

def create_app():
    from fastapi import FastAPI, Form
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="Ozzu Face API (dev-01) v2", version="2.0.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.get("/health")
    async def health():
        qdrant_ok = False
        try:
            get_qdrant()
            qdrant_ok = True
        except Exception:
            pass
        return {"status": "ok", "qdrant": qdrant_ok, "node": "dev-01"}

    @app.get("/stats")
    async def stats():
        try:
            client = get_qdrant()
            info = client.get_collection(COLLECTION)
            uptime = time.time() - _stats["started_at"]
            rate = _stats["indexed"] / (uptime / 60) if uptime > 0 else 0
            return {
                "ok": True,
                "collection": COLLECTION,
                "points_count": info.points_count,
                "vectors_count": getattr(info, "vectors_count", None),
                "status": info.status.value if hasattr(info.status, "value") else str(info.status),
                "session": {
                    "indexed": _stats["indexed"],
                    "failed": _stats["failed"],
                    "skipped_dedup": _stats["skipped_dedup"],
                    "qdrant_batches": _stats["qdrant_batches"],
                    "rate_per_min": round(rate, 1),
                    "uptime_min": round(uptime / 60, 1),
                    "seen_urls": len(_seen_urls),
                    "queue_pending": len(_insert_queue),
                },
            }
        except Exception as e:
            return {"error": str(e)}

    @app.post("/embed")
    async def embed(base64_image: str = Form(None)):
        if not base64_image:
            return JSONResponse(status_code=400, content={"error": "Provide base64_image"})
        if "," in base64_image:
            base64_image = base64_image.split(",", 1)[1]
        data = base64.b64decode(base64_image)
        img_bgr = decode_image(data)
        faces = detect_and_embed(img_bgr)
        return {
            "faces": [{"embedding": f["embedding"], "bbox": f["bbox"], "det_score": f["det_score"]} for f in faces],
            "count": len(faces),
        }

    @app.post("/index")
    async def index(
        base64_image: str = Form(None),
        image_url: str = Form(None),
        label: str = Form(""),
        source_platform: str = Form(""),
        source_url: str = Form(""),
        profile_id: str = Form(""),
        face_id: str = Form(None),
    ):
        face = None
        if base64_image:
            if "," in base64_image:
                base64_image = base64_image.split(",", 1)[1]
            data = base64.b64decode(base64_image)
            img_bgr = decode_image(data)
            faces = detect_and_embed(img_bgr)
            face = faces[0] if faces else None
        elif image_url:
            face = download_and_embed(image_url)
        else:
            return JSONResponse(status_code=400, content={"error": "Provide base64_image or image_url"})

        if not face:
            return {"ok": False, "indexed": 0, "error": "No face detected"}

        fid = queue_for_insert(face["embedding"], {
            "label": label,
            "source_platform": source_platform,
            "source_url": source_url or image_url or "",
            "profile_id": profile_id,
            "face_id": face_id or f"sat-{uuid.uuid4().hex[:8]}",
            "bbox": face["bbox"],
            "det_score": face["det_score"],
        })
        return {"ok": True, "indexed": 1, "face_id": fid, "det_score": face["det_score"]}

    @app.post("/batch")
    async def batch_endpoint(batch: str = Form(...)):
        """Pipeline batch: download + embed + batch Qdrant insert.
        batch: JSON array of {url, label, source_platform}"""
        items = json.loads(batch)
        results = pipeline_process_urls(items)
        return results

    @app.post("/flush")
    async def flush_endpoint():
        """Force flush pending Qdrant inserts."""
        n = flush_queue()
        return {"flushed": n}

    return app


def main():
    port = PORT
    if "--port" in sys.argv:
        idx = sys.argv.index("--port")
        port = int(sys.argv[idx + 1])

    print(f"[face-api] Starting v2 on port {port}", flush=True)
    print(f"[face-api] Qdrant: {QDRANT_URL}", flush=True)
    print(f"[face-api] OMP_NUM_THREADS={os.environ.get('OMP_NUM_THREADS', '?')}", flush=True)
    print(f"[face-api] Batch size: {QDRANT_BATCH_SIZE}, flush interval: {QDRANT_FLUSH_INTERVAL}s", flush=True)

    # Pre-load
    get_face_app()
    get_qdrant()

    # Start batch flush background thread
    flusher = Thread(target=_flush_loop, daemon=True)
    flusher.start()
    print("[face-api] Batch flush thread started", flush=True)

    import uvicorn
    uvicorn.run(create_app(), host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    main()
