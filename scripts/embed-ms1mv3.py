#!/usr/bin/env python3
"""
MS1MV3 (MS1M-RetinaFace) → Qdrant pipeline.
WebDataset tar shards from HuggingFace: gaunernst/ms1mv3-wds
5.2M images, 93K identities, pre-aligned 112x112.
Each tar contains paired .jpg + .cls files.

Usage: python3 embed-ms1mv3.py [start_shard] [end_shard]
  Default: all 100 shards (0-99)
"""
import os, sys, uuid, time, io, tarfile, traceback
import numpy as np
import cv2
import onnxruntime as ort
from PIL import Image
from threading import Lock, Thread, Event
from collections import deque

QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
COLLECTION = "faces"
QDRANT_BATCH = 500
GPU_BATCH = 64
NUM_SHARDS = 100
HF_REPO = "gaunernst/ms1mv3-wds"

import warnings
warnings.filterwarnings("ignore")
os.environ["ONNXRUNTIME_LOG_LEVEL"] = "3"

stats = {"indexed": 0, "processed": 0, "failed": 0, "skipped": 0}
stats_lock = Lock()
start_time = time.time()
insert_queue = deque()
queue_lock = Lock()
_qdrant = None
running = Event()
running.set()

def log(msg):
    print(msg, flush=True)

def get_qdrant():
    global _qdrant
    if _qdrant is None:
        from qdrant_client import QdrantClient
        _qdrant = QdrantClient(url=QDRANT_URL, timeout=60)
        log(f"[qdrant] Connected to {QDRANT_URL}")
    return _qdrant

def load_rec_model():
    model_path = os.path.expanduser("~/.insightface/models/buffalo_l/w600k_r50.onnx")
    if not os.path.exists(model_path):
        from insightface.app import FaceAnalysis
        app = FaceAnalysis(name="buffalo_l", providers=["CUDAExecutionProvider"])
        app.prepare(ctx_id=0)
        del app

    sess_opts = ort.SessionOptions()
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_opts.log_severity_level = 3
    sess = ort.InferenceSession(model_path, sess_opts,
                                 providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    log(f"[gpu] Model loaded, providers: {sess.get_providers()}")

    dummy = np.random.randn(GPU_BATCH, 3, 112, 112).astype(np.float32)
    sess.run(None, {inp_name: dummy})
    log(f"[gpu] Warmup done (batch={GPU_BATCH})")
    return sess, inp_name

def preprocess(img_bgr):
    if img_bgr.shape[0] != 112 or img_bgr.shape[1] != 112:
        img_bgr = cv2.resize(img_bgr, (112, 112))
    img = (img_bgr.astype(np.float32) - 127.5) / 127.5
    return np.transpose(img, (2, 0, 1))

def batch_embed(sess, inp_name, tensors):
    batch = np.stack(tensors, axis=0)
    outs = sess.run(None, {inp_name: batch})[0]
    norms = np.linalg.norm(outs, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-10)
    return outs / norms

def flush_queue():
    with queue_lock:
        if not insert_queue:
            return 0
        batch = list(insert_queue)
        insert_queue.clear()

    from qdrant_client.models import PointStruct
    try:
        get_qdrant().upsert(collection_name=COLLECTION, points=batch, wait=False)
        with stats_lock:
            stats["indexed"] += len(batch)
        return len(batch)
    except Exception as e:
        log(f"[qdrant] Flush failed ({len(batch)}): {e}")
        with queue_lock:
            insert_queue.extend(batch)
        return 0

def flush_loop():
    log("[flush] Thread started")
    while running.is_set():
        try:
            time.sleep(3.0)
            flush_queue()
            elapsed = time.time() - start_time
            with stats_lock:
                idx = stats["indexed"]
                proc = stats["processed"]
                fail = stats["failed"]
                skip = stats["skipped"]
            if proc > 0:
                rate = idx / (elapsed / 60) if elapsed > 0 else 0
                qlen = len(insert_queue)
                log(f"[stats] indexed:{idx:,} processed:{proc:,} "
                    f"fail:{fail:,} queue:{qlen:,} "
                    f"rate:{rate:,.0f}/min {elapsed:.0f}s")
        except Exception as e:
            log(f"[flush error] {e}")
            traceback.print_exc()

def queue_point(embedding, label, img_name):
    from qdrant_client.models import PointStruct
    fid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"ms1mv3/{img_name}"))
    point = PointStruct(
        id=fid, vector=embedding.tolist(),
        payload={"source_url": f"ms1mv3/{img_name}",
                 "source_platform": "ms1mv3",
                 "label": str(label), "det_score": 1.0},
    )
    with queue_lock:
        insert_queue.append(point)
    if len(insert_queue) >= QDRANT_BATCH:
        flush_queue()

def download_shard(shard_num):
    from huggingface_hub import hf_hub_download
    fname = f"ms1mv3-{shard_num:04d}.tar"
    return hf_hub_download(
        repo_id=HF_REPO,
        filename=fname,
        repo_type="dataset",
        local_dir="/root/ms1mv3",
    )

def process_shard(tar_path, shard_num, sess, inp_name):
    shard_start = time.time()
    count = 0
    batch_tensors = []
    batch_names = []
    batch_labels = []

    # WebDataset format: paired .jpg + .cls files sharing same key
    # Read all members, pair them by key (filename without extension)
    pending_images = {}  # key -> (img_bytes, full_name)
    pending_labels = {}  # key -> label_str

    with tarfile.open(tar_path, "r") as tar:
        for member in tar:
            if not member.isfile():
                continue
            name = member.name
            basename = name.rsplit("/", 1)[-1] if "/" in name else name
            key, ext = os.path.splitext(basename)

            f = tar.extractfile(member)
            if f is None:
                continue
            data = f.read()

            if ext in (".jpg", ".jpeg", ".png"):
                pending_images[key] = (data, name)
            elif ext == ".cls":
                pending_labels[key] = data.decode("utf-8").strip()

            # Process when we have both image and label for a key
            if key in pending_images and key in pending_labels:
                img_bytes, img_name = pending_images.pop(key)
                label = pending_labels.pop(key)

                if len(img_bytes) < 100:
                    with stats_lock:
                        stats["skipped"] += 1
                    continue

                try:
                    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
                    arr = np.array(img)[:, :, ::-1].copy()  # RGB->BGR
                    tensor = preprocess(arr)

                    batch_tensors.append(tensor)
                    batch_names.append(img_name)
                    batch_labels.append(label)

                    with stats_lock:
                        stats["processed"] += 1
                    count += 1

                    if len(batch_tensors) >= GPU_BATCH:
                        embeddings = batch_embed(sess, inp_name, batch_tensors)
                        for emb, lbl, nm in zip(embeddings, batch_labels, batch_names):
                            queue_point(emb, lbl, nm)
                        batch_tensors.clear()
                        batch_names.clear()
                        batch_labels.clear()
                except Exception as e:
                    with stats_lock:
                        stats["failed"] += 1

    # Also process images without .cls (use key as label)
    for key, (img_bytes, img_name) in pending_images.items():
        label = pending_labels.get(key, key)
        if len(img_bytes) < 100:
            with stats_lock:
                stats["skipped"] += 1
            continue
        try:
            img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
            arr = np.array(img)[:, :, ::-1].copy()
            tensor = preprocess(arr)
            batch_tensors.append(tensor)
            batch_names.append(img_name)
            batch_labels.append(label)
            with stats_lock:
                stats["processed"] += 1
            count += 1
            if len(batch_tensors) >= GPU_BATCH:
                embeddings = batch_embed(sess, inp_name, batch_tensors)
                for emb, lbl, nm in zip(embeddings, batch_labels, batch_names):
                    queue_point(emb, lbl, nm)
                batch_tensors.clear()
                batch_names.clear()
                batch_labels.clear()
        except Exception:
            with stats_lock:
                stats["failed"] += 1

    # Remaining batch
    if batch_tensors:
        try:
            embeddings = batch_embed(sess, inp_name, batch_tensors)
            for emb, lbl, nm in zip(embeddings, batch_labels, batch_names):
                queue_point(emb, lbl, nm)
        except Exception as e:
            log(f"[error] Final batch shard {shard_num}: {e}")
            with stats_lock:
                stats["failed"] += len(batch_tensors)

    flush_queue()
    elapsed = time.time() - shard_start
    total_elapsed = time.time() - start_time
    with stats_lock:
        idx = stats["indexed"]
    rate = idx / (total_elapsed / 60) if total_elapsed > 0 else 0
    log(f"[shard {shard_num:04d}] {count:,} images in {elapsed:.0f}s | "
        f"total indexed:{idx:,} rate:{rate:,.0f}/min")

if __name__ == "__main__":
    start_shard = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    end_shard = int(sys.argv[2]) if len(sys.argv) > 2 else NUM_SHARDS

    log(f"[ms1mv3] Shards {start_shard}-{end_shard-1} ({end_shard-start_shard} shards)")
    log(f"[ms1mv3] Direct embed, GPU batch={GPU_BATCH}, Qdrant batch={QDRANT_BATCH}")
    log(f"[ms1mv3] HuggingFace repo: {HF_REPO}")

    sess, inp_name = load_rec_model()

    ft = Thread(target=flush_loop, daemon=True)
    ft.start()

    for i in range(start_shard, end_shard):
        tar_path = f"/root/ms1mv3/ms1mv3-{i:04d}.tar"

        if not os.path.exists(tar_path):
            log(f"[download] Shard {i:04d}...")
            try:
                tar_path = download_shard(i)
            except Exception as e:
                log(f"[error] Download shard {i} failed: {e}")
                continue
            log(f"[download] {tar_path} ({os.path.getsize(tar_path)/1e6:.0f}MB)")

        process_shard(tar_path, i, sess, inp_name)

        # Clean old shards (keep 2)
        if i >= start_shard + 2:
            old = f"/root/ms1mv3/ms1mv3-{i-2:04d}.tar"
            if os.path.exists(old):
                os.remove(old)
                log(f"[cleanup] Deleted shard {i-2:04d}")

    running.clear()
    flush_queue()
    elapsed = time.time() - start_time
    with stats_lock:
        idx = stats["indexed"]
        proc = stats["processed"]
        fail = stats["failed"]
    rate = idx / (elapsed / 60) if elapsed > 0 else 0
    log(f"\n{'='*60}")
    log(f"MS1MV3 COMPLETE (shards {start_shard}-{end_shard-1})")
    log(f"  Indexed:    {idx:,}")
    log(f"  Processed:  {proc:,}")
    log(f"  Failed:     {fail:,}")
    log(f"  Rate:       {rate:,.0f} faces/min")
    log(f"  Time:       {elapsed/3600:.1f}h")
    log(f"{'='*60}")
