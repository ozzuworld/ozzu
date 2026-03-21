"""
AgroVisión — Crop disease detection microservice.
Directive: dir_1774099821063

Endpoints:
  POST /plant/search    — Upload leaf photo → get disease matches from Qdrant
  POST /plant/index     — Add new disease reference image to Qdrant
  POST /plant/embed     — Get raw embedding for an image
  GET  /plant/diseases  — List all known diseases with metadata
  GET  /plant/stats     — Collection stats
  GET  /plant/health    — Health check
"""

import io
import os
import json
import uuid
import numpy as np
from pathlib import Path
from PIL import Image
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
COLLECTION = "plant_diseases"
EMBEDDING_DIM = 512
MODEL_PATH = os.environ.get("AGROVISION_MODEL", "/models/agrovision_embed.onnx")
METADATA_PATH = os.environ.get("AGROVISION_METADATA",
    str(Path(__file__).parent / "disease_metadata.json"))

# ImageNet normalization (DINOv2)
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
IMG_SIZE = 224

app = FastAPI(title="AgroVisión — Crop Disease Detection", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Lazy-loaded globals ──
_ort_session = None
_qdrant = None
_metadata = None


def get_model():
    global _ort_session
    if _ort_session is None:
        import onnxruntime as ort
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        _ort_session = ort.InferenceSession(MODEL_PATH, providers=providers)
        print(f"[agrovision] Model loaded: {MODEL_PATH}")
    return _ort_session


def get_qdrant():
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
            print(f"[qdrant] Created '{COLLECTION}'")
    return _qdrant


def get_metadata():
    global _metadata
    if _metadata is None:
        if Path(METADATA_PATH).exists():
            with open(METADATA_PATH) as f:
                _metadata = json.load(f)
        else:
            _metadata = {"diseases": {}}
    return _metadata


def preprocess_image(img: Image.Image) -> np.ndarray:
    """Preprocess PIL image for DINOv2: resize, center crop, normalize."""
    w, h = img.size
    scale = IMG_SIZE / min(w, h)
    img = img.resize((int(w * scale), int(h * scale)), Image.BILINEAR)
    w, h = img.size
    left = (w - IMG_SIZE) // 2
    top = (h - IMG_SIZE) // 2
    img = img.crop((left, top, left + IMG_SIZE, top + IMG_SIZE))

    arr = np.array(img, dtype=np.float32) / 255.0
    arr = (arr - MEAN) / STD
    arr = arr.transpose(2, 0, 1)  # HWC → CHW
    return arr[np.newaxis]  # Add batch dim


def decode_upload(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data)).convert("RGB")


def decode_base64(b64: str) -> Image.Image:
    import base64
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    data = base64.b64decode(b64)
    return decode_upload(data)


def extract_embedding(img: Image.Image) -> np.ndarray:
    """Extract 512-D embedding from PIL image."""
    sess = get_model()
    inp = preprocess_image(img)
    emb = sess.run(None, {sess.get_inputs()[0].name: inp})[0]  # [1, 512]
    # L2 normalize
    norm = np.linalg.norm(emb, axis=1, keepdims=True)
    if norm[0, 0] > 0:
        emb = emb / norm
    return emb[0]  # [512]


# ═══════════════════════════════════════════════════════════════════
# Endpoints
# ═══════════════════════════════════════════════════════════════════

@app.get("/plant/health")
async def health():
    model_ok = Path(MODEL_PATH).exists()
    qdrant_ok = False
    points = 0
    try:
        info = get_qdrant().get_collection(COLLECTION)
        qdrant_ok = True
        points = info.points_count
    except Exception:
        pass
    return {"status": "ok" if model_ok and qdrant_ok else "degraded",
            "model": model_ok, "qdrant": qdrant_ok, "points": points}


@app.post("/plant/search")
async def search_disease(
    image: UploadFile | None = File(None),
    base64_image: str | None = Form(None),
    top_k: int = Form(10),
    threshold: float = Form(0.3),
):
    """Upload a leaf photo → get disease matches with treatment info."""
    if image:
        img = decode_upload(await image.read())
    elif base64_image:
        img = decode_base64(base64_image)
    else:
        return JSONResponse(status_code=400, content={"error": "Provide image or base64_image"})

    # Extract embedding
    emb = extract_embedding(img)

    # Search Qdrant
    client = get_qdrant()
    results = client.search(
        collection_name=COLLECTION,
        query_vector=emb.tolist(),
        limit=top_k * 3,  # Over-fetch to aggregate by disease
        score_threshold=threshold,
    )

    # Aggregate by disease — take average score per disease
    disease_scores = {}
    for r in results:
        disease_id = r.payload.get("disease_id", "unknown")
        if disease_id not in disease_scores:
            disease_scores[disease_id] = {
                "scores": [],
                "payload": r.payload,
            }
        disease_scores[disease_id]["scores"].append(r.score)

    # Build response — ranked by average similarity
    md = get_metadata()
    matches = []
    for disease_id, data in disease_scores.items():
        avg_score = sum(data["scores"]) / len(data["scores"])
        max_score = max(data["scores"])
        hit_count = len(data["scores"])

        # Enrich with metadata
        disease_info = md.get("diseases", {}).get(disease_id, {})
        payload = data["payload"]

        matches.append({
            "disease_id": disease_id,
            "disease_name": disease_info.get("name", payload.get("disease_name", disease_id)),
            "scientific_name": disease_info.get("scientific", payload.get("scientific_name", "")),
            "crop": disease_info.get("crop", payload.get("crop", "")),
            "severity": disease_info.get("severity", payload.get("severity", "")),
            "treatment": disease_info.get("treatment", payload.get("treatment", "")),
            "prevention": disease_info.get("prevention", payload.get("prevention", "")),
            "confidence": round(max_score, 4),
            "avg_similarity": round(avg_score, 4),
            "reference_count": hit_count,
        })

    # Sort by max confidence
    matches.sort(key=lambda x: x["confidence"], reverse=True)
    matches = matches[:top_k]

    # Top prediction
    top = matches[0] if matches else None

    return {
        "prediction": {
            "disease": top["disease_name"] if top else "Unknown",
            "confidence": top["confidence"] if top else 0,
            "severity": top["severity"] if top else "unknown",
            "crop": top["crop"] if top else "Unknown",
        } if top else None,
        "matches": matches,
        "total_matches": len(matches),
    }


@app.post("/plant/index")
async def index_disease(
    image: UploadFile | None = File(None),
    base64_image: str | None = Form(None),
    disease_id: str = Form(...),
    disease_name: str | None = Form(None),
    crop: str | None = Form(None),
    severity: str | None = Form(None),
    notes: str | None = Form(None),
):
    """Add a new disease reference image to the collection.
    This is the 'no retraining' killer feature — just upload reference photos."""
    if image:
        img = decode_upload(await image.read())
    elif base64_image:
        img = decode_base64(base64_image)
    else:
        return JSONResponse(status_code=400, content={"error": "Provide image or base64_image"})

    emb = extract_embedding(img)

    from qdrant_client.models import PointStruct

    point_id = str(uuid.uuid4())
    client = get_qdrant()
    client.upsert(
        collection_name=COLLECTION,
        points=[PointStruct(
            id=point_id,
            vector=emb.tolist(),
            payload={
                "disease_id": disease_id,
                "disease_name": disease_name or disease_id,
                "crop": crop or "",
                "severity": severity or "unknown",
                "source_dataset": "user_upload",
                "notes": notes or "",
            },
        )],
    )

    return {
        "indexed": True,
        "point_id": point_id,
        "disease_id": disease_id,
        "message": f"Reference image added for '{disease_name or disease_id}'. No retraining needed.",
    }


@app.post("/plant/embed")
async def embed_image(
    image: UploadFile | None = File(None),
    base64_image: str | None = Form(None),
):
    """Extract raw 512-D embedding from a leaf image."""
    if image:
        img = decode_upload(await image.read())
    elif base64_image:
        img = decode_base64(base64_image)
    else:
        return JSONResponse(status_code=400, content={"error": "Provide image or base64_image"})

    emb = extract_embedding(img)
    return {"embedding": emb.tolist(), "dim": len(emb)}


@app.get("/plant/diseases")
async def list_diseases():
    """List all known diseases with metadata."""
    md = get_metadata()
    diseases = md.get("diseases", {})

    # Get counts from Qdrant per disease
    client = get_qdrant()
    try:
        info = client.get_collection(COLLECTION)
        total_points = info.points_count
    except Exception:
        total_points = 0

    result = []
    for disease_id, info in diseases.items():
        result.append({
            "id": disease_id,
            "name": info.get("name", disease_id),
            "scientific_name": info.get("scientific", ""),
            "crop": info.get("crop", ""),
            "severity": info.get("severity", ""),
        })

    return {"diseases": result, "total_count": len(result), "indexed_images": total_points}


@app.get("/plant/stats")
async def stats():
    """Collection stats."""
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
