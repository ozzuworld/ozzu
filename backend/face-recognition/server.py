"""Face embedding microservice — ArcFace via InsightFace on CPU."""

import io
import base64
import numpy as np
from PIL import Image
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from model import detect_and_embed, cosine_similarity

app = FastAPI(title="Ozzu Face Recognition", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def decode_image(data: bytes) -> np.ndarray:
    """Decode image bytes to BGR numpy array for OpenCV/InsightFace."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    arr = np.array(img)
    # RGB -> BGR for InsightFace
    return arr[:, :, ::-1].copy()


def decode_base64_image(b64: str) -> np.ndarray:
    """Decode a base64 string (with or without data URI prefix) to BGR numpy."""
    # Strip data URI prefix if present
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    data = base64.b64decode(b64)
    return decode_image(data)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/embed")
async def embed(
    image: UploadFile | None = File(None),
    base64_image: str | None = Form(None),
):
    """Extract face embeddings from an image. Accepts multipart file or base64 form field."""
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
    """Compare two images — returns cosine similarity of the first detected face in each."""
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
    """Detect all faces in an image and return embeddings + bounding boxes."""
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
