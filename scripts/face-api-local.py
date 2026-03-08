#!/usr/bin/env python3
"""
Local Face API for dev-01 — ArcFace embedding + direct Qdrant insert.

Runs on dev-01 alongside the satellite crawler. Downloads images,
detects faces, generates 512-D ArcFace embeddings, and inserts
vectors directly into GCP's Qdrant over VPN.

This eliminates the GCP CPU bottleneck — face detection/embedding
happens on dev-01's 8 cores instead of GCP's 6.

Endpoints:
  POST /embed     — detect + embed faces in an image
  POST /index     — detect + embed + store in Qdrant
  POST /batch     — batch index from URLs (used by satellite crawler)
  GET  /stats     — Qdrant collection stats
  GET  /health    — health check

Usage:
  python3 face-api-local.py              # Start on port 5555
  python3 face-api-local.py --port 5556  # Custom port
"""

import io
import os
import sys
import json
import uuid
import base64
import urllib.request
import numpy as np
from PIL import Image

# Lazy-loaded globals
_app = None
_qdrant = None

QDRANT_URL = os.environ.get("QDRANT_URL", "http://10.8.0.1:6333")  # GCP Qdrant via VPN
COLLECTION = "faces"
EMBEDDING_DIM = 512
MODEL_DIR = os.path.expanduser("~/.insightface")
PORT = 5555


def get_face_app():
    """Lazy-load InsightFace (downloads 600MB model on first run)."""
    global _app
    if _app is None:
        from insightface.app import FaceAnalysis
        os.makedirs(MODEL_DIR, exist_ok=True)
        print(f"[face-api] Loading InsightFace buffalo_l from {MODEL_DIR}...")
        _app = FaceAnalysis(
            name="buffalo_l",
            root=MODEL_DIR,
            providers=["CPUExecutionProvider"],
        )
        _app.prepare(ctx_id=0, det_size=(640, 640))
        print("[face-api] Model loaded")
    return _app


def get_qdrant():
    """Lazy-connect to GCP Qdrant via VPN."""
    global _qdrant
    if _qdrant is None:
        from qdrant_client import QdrantClient
        from qdrant_client.models import Distance, VectorParams
        _qdrant = QdrantClient(url=QDRANT_URL, timeout=10)
        # Ensure collection exists
        collections = [c.name for c in _qdrant.get_collections().collections]
        if COLLECTION not in collections:
            _qdrant.create_collection(
                collection_name=COLLECTION,
                vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
            )
            print(f"[qdrant] Created collection '{COLLECTION}'")
        print(f"[qdrant] Connected to {QDRANT_URL}")
    return _qdrant


def decode_image(data):
    """Decode image bytes to BGR numpy array."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    arr = np.array(img)
    return arr[:, :, ::-1].copy()


def detect_and_embed(img_bgr):
    """Detect faces and return embeddings."""
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


def download_and_embed(url, timeout=10):
    """Download image from URL, detect face, return embedding or None."""
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        })
        resp = urllib.request.urlopen(req, timeout=timeout)
        data = resp.read()
        if len(data) < 1000:
            return None
        img_bgr = decode_image(data)
        faces = detect_and_embed(img_bgr)
        if not faces:
            return None
        return faces[0]  # Return first/largest face
    except Exception:
        return None


def index_to_qdrant(embedding, metadata):
    """Insert a single face vector into Qdrant."""
    from qdrant_client.models import PointStruct
    client = get_qdrant()
    face_id = metadata.get("face_id") or str(uuid.uuid4())
    fid = str(uuid.uuid5(uuid.NAMESPACE_URL, face_id)) if face_id else str(uuid.uuid4())
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
    client.upsert(collection_name=COLLECTION, points=[point])
    return fid


def batch_index_to_qdrant(points_data):
    """Insert multiple face vectors into Qdrant at once."""
    from qdrant_client.models import PointStruct
    client = get_qdrant()
    points = []
    for item in points_data:
        face_id = item.get("face_id") or str(uuid.uuid4())
        fid = str(uuid.uuid5(uuid.NAMESPACE_URL, face_id)) if face_id else str(uuid.uuid4())
        points.append(PointStruct(
            id=fid,
            vector=item["embedding"],
            payload={
                "profile_id": item.get("profile_id", ""),
                "source_url": item.get("source_url", ""),
                "source_platform": item.get("source_platform", ""),
                "label": item.get("label", ""),
                "bbox": item.get("bbox", []),
                "det_score": item.get("det_score", 0),
            },
        ))
    if points:
        client.upsert(collection_name=COLLECTION, points=points, wait=False)
    return len(points)


# ── FastAPI server ──

def create_app():
    from fastapi import FastAPI, Form
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="Ozzu Face API (dev-01)", version="1.0.0")
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
            return {
                "ok": True,
                "collection": COLLECTION,
                "points_count": info.points_count,
                "vectors_count": getattr(info, "vectors_count", None),
                "status": info.status.value if hasattr(info.status, "value") else str(info.status),
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
        """Detect face, embed, store in GCP Qdrant."""
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

        fid = index_to_qdrant(face["embedding"], {
            "label": label,
            "source_platform": source_platform,
            "source_url": source_url,
            "profile_id": profile_id,
            "face_id": face_id or f"sat-{uuid.uuid4().hex[:8]}",
            "bbox": face["bbox"],
            "det_score": face["det_score"],
        })
        return {"ok": True, "indexed": 1, "face_id": fid, "det_score": face["det_score"]}

    @app.post("/batch")
    async def batch_index_endpoint(batch: str = Form(...)):
        """Batch: download images, embed locally, index to Qdrant.
        batch: JSON array of {url, label, source_platform}"""
        items = json.loads(batch)
        results = {"indexed": 0, "failed": 0, "total": len(items)}

        # Process in chunks to batch Qdrant inserts
        CHUNK = 20
        for i in range(0, len(items), CHUNK):
            chunk = items[i:i + CHUNK]
            points = []
            for item in chunk:
                face = download_and_embed(item.get("url", ""))
                if face:
                    points.append({
                        "embedding": face["embedding"],
                        "label": item.get("label", ""),
                        "source_platform": item.get("source_platform", ""),
                        "source_url": item.get("url", ""),
                        "face_id": f"sat-{uuid.uuid4().hex[:8]}",
                        "bbox": face["bbox"],
                        "det_score": face["det_score"],
                    })
                else:
                    results["failed"] += 1
            if points:
                n = batch_index_to_qdrant(points)
                results["indexed"] += n
        return results

    return app


def main():
    port = PORT
    if "--port" in sys.argv:
        idx = sys.argv.index("--port")
        port = int(sys.argv[idx + 1])

    # Pre-load model
    print(f"[face-api] Starting on port {port}")
    print(f"[face-api] Qdrant: {QDRANT_URL}")
    get_face_app()
    get_qdrant()

    import uvicorn
    uvicorn.run(create_app(), host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    main()
