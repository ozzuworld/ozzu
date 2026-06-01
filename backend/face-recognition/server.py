"""Face embedding microservice — ArcFace via InsightFace on CPU + Qdrant vector search."""

import io
import os
import base64
import uuid
import numpy as np
from PIL import Image
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from model import detect_and_embed, cosine_similarity

QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY") or None  # Phase 0.1: qdrant now requires a key
COLLECTION = "faces"
EMBEDDING_DIM = 512

app = FastAPI(title="Ozzu Face Recognition", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Qdrant helpers ---

_qdrant = None

def get_qdrant():
    global _qdrant
    if _qdrant is None:
        from qdrant_client import QdrantClient
        _qdrant = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY, timeout=10)
        _ensure_collection()
    return _qdrant

def _ensure_collection():
    from qdrant_client.models import Distance, VectorParams
    client = _qdrant
    collections = [c.name for c in client.get_collections().collections]
    if COLLECTION not in collections:
        client.create_collection(
            collection_name=COLLECTION,
            vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
        )
        print(f"[qdrant] Created collection '{COLLECTION}'")


def decode_image(data: bytes) -> np.ndarray:
    img = Image.open(io.BytesIO(data)).convert("RGB")
    arr = np.array(img)
    return arr[:, :, ::-1].copy()


def decode_base64_image(b64: str) -> np.ndarray:
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    data = base64.b64decode(b64)
    return decode_image(data)


# --- Existing endpoints ---

@app.get("/health")
async def health():
    qdrant_ok = False
    try:
        get_qdrant()
        qdrant_ok = True
    except Exception:
        pass
    return {"status": "ok", "qdrant": qdrant_ok}


@app.post("/embed")
async def embed(
    image: UploadFile | None = File(None),
    base64_image: str | None = Form(None),
):
    """Extract face embeddings from an image."""
    if image:
        data = await image.read()
        img_bgr = decode_image(data)
    elif base64_image:
        img_bgr = decode_base64_image(base64_image)
    else:
        return JSONResponse(status_code=400, content={"error": "Provide image file or base64_image"})

    faces = detect_and_embed(img_bgr)
    if not faces:
        return JSONResponse(status_code=200, content={"faces": [], "count": 0})

    return {
        "faces": [{"embedding": f["embedding"], "bbox": f["bbox"], "det_score": f["det_score"]} for f in faces],
        "count": len(faces),
    }


@app.post("/compare")
async def compare(
    image1: UploadFile | None = File(None),
    image2: UploadFile | None = File(None),
    base64_image1: str | None = Form(None),
    base64_image2: str | None = Form(None),
):
    """Compare two images — returns cosine similarity."""
    if image1 and image2:
        img1 = decode_image(await image1.read())
        img2 = decode_image(await image2.read())
    elif base64_image1 and base64_image2:
        img1 = decode_base64_image(base64_image1)
        img2 = decode_base64_image(base64_image2)
    else:
        return JSONResponse(status_code=400, content={"error": "Provide both images"})

    faces1 = detect_and_embed(img1)
    faces2 = detect_and_embed(img2)

    if not faces1:
        return JSONResponse(status_code=200, content={"error": "No face detected in image 1", "similarity": 0.0})
    if not faces2:
        return JSONResponse(status_code=200, content={"error": "No face detected in image 2", "similarity": 0.0})

    sim = cosine_similarity(faces1[0]["embedding"], faces2[0]["embedding"])
    return {
        "similarity": round(sim, 4),
        "is_match": sim >= 0.4,
        "threshold": 0.4,
    }


@app.post("/detect-and-embed")
async def detect_and_embed_endpoint(
    image: UploadFile | None = File(None),
    base64_image: str | None = Form(None),
):
    """Detect all faces and return embeddings + bounding boxes."""
    if image:
        data = await image.read()
        img_bgr = decode_image(data)
    elif base64_image:
        img_bgr = decode_base64_image(base64_image)
    else:
        return JSONResponse(status_code=400, content={"error": "Provide image file or base64_image"})

    faces = detect_and_embed(img_bgr)
    return {
        "faces": faces,
        "count": len(faces),
        "image_size": {"width": img_bgr.shape[1], "height": img_bgr.shape[0]},
    }


# --- NEW: Qdrant-backed vector search endpoints ---

@app.post("/index")
async def index_face(
    image: UploadFile | None = File(None),
    base64_image: str | None = Form(None),
    profile_id: str | None = Form(None),
    source_url: str | None = Form(None),
    source_platform: str | None = Form(None),
    label: str | None = Form(None),
    face_id: str | None = Form(None),
):
    """Detect face in image, generate embedding, store in Qdrant.
    Returns the face_id (point ID) for later retrieval."""
    if image:
        data = await image.read()
        img_bgr = decode_image(data)
    elif base64_image:
        img_bgr = decode_base64_image(base64_image)
    else:
        return JSONResponse(status_code=400, content={"error": "Provide image file or base64_image"})

    faces = detect_and_embed(img_bgr)
    if not faces:
        return JSONResponse(status_code=200, content={"indexed": 0, "error": "No face detected"})

    from qdrant_client.models import PointStruct

    client = get_qdrant()
    points = []
    indexed_ids = []

    for face in faces:
        # Qdrant requires UUID or unsigned int as point ID
        fid = str(uuid.uuid5(uuid.NAMESPACE_URL, face_id)) if face_id else str(uuid.uuid4())
        payload = {
            "profile_id": profile_id or "",
            "source_url": source_url or "",
            "source_platform": source_platform or "",
            "label": label or "",
            "bbox": face["bbox"],
            "det_score": face["det_score"],
        }
        points.append(PointStruct(
            id=fid,
            vector=face["embedding"],
            payload=payload,
        ))
        indexed_ids.append(fid)
        # Only index the first (largest/most prominent) face per image
        break

    client.upsert(collection_name=COLLECTION, points=points)

    return {
        "indexed": len(points),
        "face_ids": indexed_ids,
        "det_score": faces[0]["det_score"],
    }


@app.post("/search")
async def search_face(
    image: UploadFile | None = File(None),
    base64_image: str | None = Form(None),
    embedding: str | None = Form(None),
    top_k: int = Form(20),
    threshold: float = Form(0.4),
    exclude_profile: str | None = Form(None),
):
    """Search Qdrant for faces matching the query.
    Accepts image (will detect+embed) or pre-computed embedding JSON array."""
    query_vector = None

    if image:
        data = await image.read()
        img_bgr = decode_image(data)
        faces = detect_and_embed(img_bgr)
        if not faces:
            return JSONResponse(status_code=200, content={"matches": [], "error": "No face detected in query image"})
        query_vector = faces[0]["embedding"]
    elif base64_image:
        img_bgr = decode_base64_image(base64_image)
        faces = detect_and_embed(img_bgr)
        if not faces:
            return JSONResponse(status_code=200, content={"matches": [], "error": "No face detected in query image"})
        query_vector = faces[0]["embedding"]
    elif embedding:
        import json
        query_vector = json.loads(embedding)
    else:
        return JSONResponse(status_code=400, content={"error": "Provide image, base64_image, or embedding"})

    from qdrant_client.models import Filter, FieldCondition, MatchValue

    client = get_qdrant()

    # Build filter to exclude the query profile's own faces
    search_filter = None
    if exclude_profile:
        search_filter = Filter(
            must_not=[FieldCondition(key="profile_id", match=MatchValue(value=exclude_profile))]
        )

    results = client.search(
        collection_name=COLLECTION,
        query_vector=query_vector,
        limit=top_k,
        score_threshold=threshold,
        query_filter=search_filter,
    )

    matches = []
    for r in results:
        matches.append({
            "face_id": r.id,
            "similarity": round(r.score, 4),
            "profile_id": r.payload.get("profile_id", ""),
            "source_url": r.payload.get("source_url", ""),
            "source_platform": r.payload.get("source_platform", ""),
            "label": r.payload.get("label", ""),
            "bbox": r.payload.get("bbox"),
            "det_score": r.payload.get("det_score"),
        })

    return {"matches": matches, "count": len(matches)}


@app.post("/batch-index")
async def batch_index(
    embeddings: str = Form(...),
):
    """Index multiple pre-computed embeddings at once.
    embeddings: JSON array of {embedding: [...], profile_id, source_url, source_platform, label}"""
    import json
    from qdrant_client.models import PointStruct

    items = json.loads(embeddings)
    client = get_qdrant()
    points = []
    ids = []

    for item in items:
        raw_id = item.get("face_id")
        fid = str(uuid.uuid5(uuid.NAMESPACE_URL, raw_id)) if raw_id else str(uuid.uuid4())
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
        ids.append(fid)

    if points:
        client.upsert(collection_name=COLLECTION, points=points, wait=True)

    return {"indexed": len(points), "face_ids": ids}


@app.get("/stats")
async def stats():
    """Get collection stats — how many faces indexed."""
    try:
        client = get_qdrant()
        info = client.get_collection(COLLECTION)
        return {
            "collection": COLLECTION,
            "points_count": info.points_count,
            "vectors_count": info.vectors_count,
            "status": info.status.value,
        }
    except Exception as e:
        return {"error": str(e)}


@app.delete("/collection")
async def delete_collection():
    """Delete all indexed faces (reset)."""
    try:
        client = get_qdrant()
        client.delete_collection(COLLECTION)
        _ensure_collection()
        return {"ok": True, "message": "Collection reset"}
    except Exception as e:
        return {"error": str(e)}
