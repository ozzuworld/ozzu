#!/usr/bin/env python3
"""
Glint360K → Qdrant pipeline (optimized async architecture).
Public mirror: gaunernst/glint360k-wds-gz — NO HF token needed.
17.1M images, 360K identities, pre-aligned 112x112.

Architecture: 4-stage async pipeline
  [Prefetch Downloads] → [Decompress+Decode Workers] → [GPU Batch Inference] → [Qdrant Insert Pool]
  Each stage runs independently via queues, GPU never waits.

Usage: python3 embed-glint360k.py [start_shard] [end_shard]
"""
import os, sys, uuid, time, io, tarfile, traceback, subprocess
import numpy as np
import cv2
import onnxruntime as ort
from PIL import Image
from threading import Lock, Thread, Event
from collections import deque
from queue import Queue, Empty
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen, Request

QDRANT_URL = os.environ.get("QDRANT_URL", "http://34.135.158.92:6333")
COLLECTION = "faces"
QDRANT_BATCH = 2000
GPU_BATCH = 256
NUM_SHARDS = 1385
HF_BASE = "https://huggingface.co/datasets/gaunernst/glint360k-wds-gz/resolve/main"
PREFETCH_SHARDS = 4
DECODE_WORKERS = 8  # CPU threads for image decode + preprocess
QDRANT_WORKERS = 4  # Parallel insert threads

import warnings
warnings.filterwarnings("ignore")
os.environ["ONNXRUNTIME_LOG_LEVEL"] = "3"

stats = {"indexed": 0, "processed": 0, "failed": 0, "skipped": 0}
stats_lock = Lock()
start_time = time.time()
running = Event()
running.set()

# Queues between stages
tensor_queue = Queue(maxsize=GPU_BATCH * 16)  # (tensor, label, name) tuples
embed_queue = Queue(maxsize=QDRANT_BATCH * 4)  # (embedding, label, name) tuples
_qdrant = None

def log(msg):
    print(msg, flush=True)

def get_qdrant():
    global _qdrant
    if _qdrant is None:
        from qdrant_client import QdrantClient
        _qdrant = QdrantClient(url=QDRANT_URL, timeout=120)
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
    sess_opts.intra_op_num_threads = 2  # Less CPU contention with decode workers
    sess = ort.InferenceSession(model_path, sess_opts,
                                 providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    log(f"[gpu] Model loaded, providers: {sess.get_providers()}")

    dummy = np.random.randn(GPU_BATCH, 3, 112, 112).astype(np.float32)
    sess.run(None, {inp_name: dummy})
    log(f"[gpu] Warmup done (batch={GPU_BATCH})")
    return sess, inp_name

def preprocess(img_bytes):
    """Decode JPEG + normalize. Returns CHW float32 tensor."""
    arr = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)  # BGR
    if img is None:
        return None
    if img.shape[0] != 112 or img.shape[1] != 112:
        img = cv2.resize(img, (112, 112))
    img = (img.astype(np.float32) - 127.5) / 127.5
    return np.transpose(img, (2, 0, 1))

# ── Stage 1: Download shards ──

def download_shard(shard_num):
    fname = f"glint360k-{shard_num:04d}.tar.gz"
    url = f"{HF_BASE}/{fname}"
    out_path = f"/root/glint360k/{fname}"
    os.makedirs("/root/glint360k", exist_ok=True)
    if os.path.exists(out_path) and os.path.getsize(out_path) > 1000:
        return out_path
    for attempt in range(3):
        try:
            req = Request(url, headers={"User-Agent": "ozzu-embedder/1.0"})
            resp = urlopen(req, timeout=120)
            with open(out_path, "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
            return out_path
        except Exception as e:
            log(f"[download] Attempt {attempt+1} failed for shard {shard_num}: {e}")
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"Failed to download shard {shard_num} after 3 attempts")

def prefetch_worker(shard_queue, ready_queue, stop_event):
    while not stop_event.is_set():
        try:
            shard_num = shard_queue.get(timeout=1)
        except Empty:
            continue
        gz_path = f"/root/glint360k/glint360k-{shard_num:04d}.tar.gz"
        if not os.path.exists(gz_path) or os.path.getsize(gz_path) < 1000:
            try:
                gz_path = download_shard(shard_num)
                log(f"[prefetch] Shard {shard_num:04d} ready ({os.path.getsize(gz_path)/1e6:.1f}MB)")
            except Exception as e:
                log(f"[prefetch] Shard {shard_num} failed: {e}")
                ready_queue.put((shard_num, None))
                continue
        ready_queue.put((shard_num, gz_path))

# ── Stage 2: Decompress + decode → tensor_queue ──

def decode_image(args):
    """Decode single image, return (tensor, label, name) or None."""
    img_bytes, label, img_name = args
    if len(img_bytes) < 100:
        return None
    tensor = preprocess(img_bytes)
    if tensor is None:
        return None
    return (tensor, label, img_name)

def shard_reader(gz_path, shard_num):
    """Read a shard, decode images in parallel, push tensors to queue."""
    # Decompress with pigz if available
    tar_path = gz_path.replace(".tar.gz", ".tar")
    use_plain_tar = False
    try:
        subprocess.run(["pigz", "-dkc", gz_path], stdout=open(tar_path, "wb"),
                       check=True, timeout=60)
        use_plain_tar = True
    except Exception:
        pass

    actual_path = tar_path if use_plain_tar else gz_path
    tar_mode = "r" if use_plain_tar else "r:gz"

    pending_images = {}
    pending_labels = {}
    decode_tasks = []

    with tarfile.open(actual_path, tar_mode) as tar:
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

            if key in pending_images and key in pending_labels:
                img_bytes, img_name = pending_images.pop(key)
                label = pending_labels.pop(key)
                decode_tasks.append((img_bytes, label, img_name))

    # Also unpaired images
    for key, (img_bytes, img_name) in pending_images.items():
        label = pending_labels.get(key, key)
        decode_tasks.append((img_bytes, label, img_name))

    # Clean decompressed tar
    if use_plain_tar and os.path.exists(tar_path):
        os.remove(tar_path)

    # Parallel decode
    count = 0
    with ThreadPoolExecutor(max_workers=DECODE_WORKERS) as pool:
        for result in pool.map(decode_image, decode_tasks):
            if result is not None:
                tensor_queue.put(result)
                count += 1
                with stats_lock:
                    stats["processed"] += 1
            else:
                with stats_lock:
                    stats["skipped"] += 1

    return count

# ── Stage 3: GPU inference (batches from tensor_queue → embed_queue) ──

def gpu_worker(sess, inp_name, stop_event):
    """Continuously batch tensors and run GPU inference."""
    while not stop_event.is_set() or not tensor_queue.empty():
        batch_tensors = []
        batch_meta = []  # (label, name) pairs

        # Collect a full batch (with timeout to avoid deadlock)
        while len(batch_tensors) < GPU_BATCH:
            try:
                tensor, label, name = tensor_queue.get(timeout=0.5)
                batch_tensors.append(tensor)
                batch_meta.append((label, name))
            except Empty:
                break

        if not batch_tensors:
            continue

        try:
            batch = np.stack(batch_tensors, axis=0)
            outs = sess.run(None, {inp_name: batch})[0]
            norms = np.linalg.norm(outs, axis=1, keepdims=True)
            norms = np.maximum(norms, 1e-10)
            embeddings = outs / norms

            for emb, (label, name) in zip(embeddings, batch_meta):
                embed_queue.put((emb, label, name))
        except Exception as e:
            log(f"[gpu] Batch error: {e}")
            with stats_lock:
                stats["failed"] += len(batch_tensors)

# ── Stage 4: Qdrant insert (batches from embed_queue) ──

def qdrant_worker(stop_event):
    """Continuously drain embed_queue and insert into Qdrant."""
    from qdrant_client.models import PointStruct
    buffer = []

    while not stop_event.is_set() or not embed_queue.empty():
        try:
            emb, label, name = embed_queue.get(timeout=0.5)
            fid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"glint360k/{name}"))
            point = PointStruct(
                id=fid, vector=emb.tolist(),
                payload={"source_url": f"glint360k/{name}",
                         "source_platform": "glint360k",
                         "label": str(label), "det_score": 1.0},
            )
            buffer.append(point)

            if len(buffer) >= QDRANT_BATCH:
                try:
                    get_qdrant().upsert(collection_name=COLLECTION, points=buffer, wait=False)
                    with stats_lock:
                        stats["indexed"] += len(buffer)
                    buffer = []
                except Exception as e:
                    log(f"[qdrant] Insert failed ({len(buffer)}): {e}")
                    time.sleep(2)
        except Empty:
            # Flush partial buffer on timeout
            if buffer:
                try:
                    get_qdrant().upsert(collection_name=COLLECTION, points=buffer, wait=False)
                    with stats_lock:
                        stats["indexed"] += len(buffer)
                    buffer = []
                except Exception as e:
                    log(f"[qdrant] Partial flush failed: {e}")

def push_pipeline_state(rate, shard_num=None, total_shards=None):
    """Push pipeline state to bridge for dashboard display."""
    try:
        import json
        state = {
            "dataset": "glint360k",
            "datasetLabel": "Glint360K (17.1M)",
            "model": "ArcFace w600k_r50",
            "dimensions": 512,
            "gpuBatch": GPU_BATCH,
            "workers": DECODE_WORKERS,
            "qdrantBatch": QDRANT_BATCH,
            "qdrantWorkers": QDRANT_WORKERS,
            "rate": round(rate),
            "shardProgress": shard_num,
            "totalShards": total_shards or NUM_SHARDS,
            "updatedAt": int(time.time() * 1000),
        }
        # Write to /tmp for bridge to read
        with open("/tmp/pipeline-state.json", "w") as f:
            json.dump(state, f)
        # Also try to POST to bridge (fire-and-forget)
        try:
            data = json.dumps(state).encode()
            req = Request(f"{QDRANT_URL.rsplit(':', 1)[0]}:3333/api/pipeline-state",
                          data=data, headers={"Content-Type": "application/json"}, method="POST")
            urlopen(req, timeout=3)
        except Exception:
            pass
    except Exception:
        pass

def stats_reporter(stop_event):
    while not stop_event.is_set():
        time.sleep(3)
        elapsed = time.time() - start_time
        with stats_lock:
            idx = stats["indexed"]
            proc = stats["processed"]
            fail = stats["failed"]
        if proc > 0:
            rate = idx / (elapsed / 60) if elapsed > 0 else 0
            tq = tensor_queue.qsize()
            eq = embed_queue.qsize()
            log(f"[stats] indexed:{idx:,} processed:{proc:,} "
                f"fail:{fail:,} tq:{tq} eq:{eq} "
                f"rate:{rate:,.0f}/min {elapsed:.0f}s")
            push_pipeline_state(rate)

if __name__ == "__main__":
    start_shard = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    end_shard = int(sys.argv[2]) if len(sys.argv) > 2 else NUM_SHARDS

    log(f"[glint360k] Shards {start_shard}-{end_shard-1} ({end_shard-start_shard} shards)")
    log(f"[glint360k] GPU batch={GPU_BATCH}, Qdrant batch={QDRANT_BATCH}")
    log(f"[glint360k] Decode workers={DECODE_WORKERS}, Qdrant workers={QDRANT_WORKERS}")
    log(f"[glint360k] Qdrant: {QDRANT_URL}")

    sess, inp_name = load_rec_model()

    stop_event = Event()

    # Start GPU inference thread
    gpu_thread = Thread(target=gpu_worker, args=(sess, inp_name, stop_event), daemon=True)
    gpu_thread.start()

    # Start Qdrant insert workers
    qdrant_threads = []
    for i in range(QDRANT_WORKERS):
        t = Thread(target=qdrant_worker, args=(stop_event,), daemon=True)
        t.start()
        qdrant_threads.append(t)

    # Start stats reporter
    stats_thread = Thread(target=stats_reporter, args=(stop_event,), daemon=True)
    stats_thread.start()

    # Start prefetch workers
    shard_queue = Queue()
    ready_queue = Queue()
    stop_prefetch = Event()
    for _ in range(2):
        t = Thread(target=prefetch_worker, args=(shard_queue, ready_queue, stop_prefetch), daemon=True)
        t.start()

    # Seed prefetch
    prefetch_end = min(start_shard + PREFETCH_SHARDS, end_shard)
    for s in range(start_shard, prefetch_end):
        shard_queue.put(s)
    next_to_queue = prefetch_end

    for i in range(start_shard, end_shard):
        shard_num, gz_path = ready_queue.get()
        if gz_path is None:
            log(f"[skip] Shard {shard_num} download failed")
            if next_to_queue < end_shard:
                shard_queue.put(next_to_queue)
                next_to_queue += 1
            continue

        if next_to_queue < end_shard:
            shard_queue.put(next_to_queue)
            next_to_queue += 1

        shard_start = time.time()
        count = shard_reader(gz_path, shard_num)
        elapsed = time.time() - shard_start
        with stats_lock:
            idx = stats["indexed"]
        log(f"[shard {shard_num:04d}] {count:,} decoded in {elapsed:.0f}s | total indexed:{idx:,}")

        # Cleanup old shards
        if i >= start_shard + 4:
            old = f"/root/glint360k/glint360k-{i-4:04d}.tar.gz"
            if os.path.exists(old):
                os.remove(old)

    # Signal all workers to stop after queues drain
    log("[main] All shards read, waiting for queues to drain...")
    while not tensor_queue.empty() or not embed_queue.empty():
        time.sleep(1)
    stop_event.set()
    stop_prefetch.set()

    # Wait for workers
    gpu_thread.join(timeout=30)
    for t in qdrant_threads:
        t.join(timeout=30)

    elapsed = time.time() - start_time
    with stats_lock:
        idx = stats["indexed"]
        proc = stats["processed"]
        fail = stats["failed"]
    rate = idx / (elapsed / 60) if elapsed > 0 else 0
    log(f"\n{'='*60}")
    log(f"GLINT360K COMPLETE (shards {start_shard}-{end_shard-1})")
    log(f"  Indexed:    {idx:,}")
    log(f"  Processed:  {proc:,}")
    log(f"  Failed:     {fail:,}")
    log(f"  Rate:       {rate:,.0f} faces/min")
    log(f"  Time:       {elapsed/3600:.1f}h")
    log(f"{'='*60}")
