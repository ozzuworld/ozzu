"""ArcFace face recognition model wrapper using InsightFace buffalo_l."""

import os
import numpy as np
from insightface.app import FaceAnalysis

_app = None

def get_app():
    """Lazy-load the InsightFace face analysis app (downloads model on first run)."""
    global _app
    if _app is None:
        model_dir = os.environ.get("MODEL_DIR", "/models")
        os.makedirs(model_dir, exist_ok=True)
        _app = FaceAnalysis(
            name="buffalo_l",
            root=model_dir,
            providers=["CPUExecutionProvider"],
        )
        # det_size controls detection resolution — 640x640 is good balance
        _app.prepare(ctx_id=0, det_size=(640, 640))
    return _app


def detect_and_embed(img_bgr: np.ndarray):
    """
    Detect all faces in a BGR image and return their embeddings + bounding boxes.

    Returns list of dicts:
      [{ "bbox": [x1,y1,x2,y2], "embedding": [512 floats], "det_score": float }]
    """
    app = get_app()
    faces = app.get(img_bgr)
    results = []
    for face in faces:
        results.append({
            "bbox": face.bbox.tolist(),
            "embedding": (face.normed_embedding).tolist(),
            "det_score": float(face.det_score),
        })
    return results


def cosine_similarity(emb1, emb2):
    """Compute cosine similarity between two embedding vectors."""
    a = np.array(emb1, dtype=np.float32)
    b = np.array(emb2, dtype=np.float32)
    dot = np.dot(a, b)
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    if norm == 0:
        return 0.0
    return float(dot / norm)
