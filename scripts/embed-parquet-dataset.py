#!/usr/bin/env python3
"""
Parquet-based HuggingFace → Qdrant face embedding pipeline.
For datasets stored as parquet files (e.g., logasja/VGGFace2).

Usage:
  python3 embed-parquet-dataset.py vggface2 [start_shard] [end_shard]
  python3 embed-parquet-dataset.py --repo user/dataset --shards 518 --subdir "256" --source vggface2

Requires: pip install pyarrow
"""
import os, sys, uuid, time, io, json, argparse
import numpy as np
import cv2
import onnxruntime as ort
from PIL import Image
from threading import Lock, Thread, Event
from collections import deque

QDRANT_URL = os.environ.get("QDRANT_URL", "https://home.ozzu.world:443")
QDRANT_PREFIX = os.environ.get("QDRANT_PREFIX", "qdrant")
BRIDGE_URL = os.environ.get("BRIDGE_URL", "https://home.ozzu.world/bridge")
COLLECTION = "faces"
QDRANT_BATCH = 1500
GPU_BATCH = 512
HEARTBEAT_INTERVAL = 10

import warnings
warnings.filterwarnings("ignore")
os.environ["ONNXRUNTIME_LOG_LEVEL"] = "3"

DATASETS = {
    "vggface2": {
        "repo": "logasja/VGGFace2",
        "num_shards": 518,
        "subdir": "256",
        "prefix": "train-",
        "description": "VGGFace2 (3.3M faces, 9K identities)",
        "image_col": "image",
        "label_col": "label",
    },
    "casia": {
        "repo": "SaffalPoosh/casia_web_face",
        "num_shards": 20,
        "subdir": "data",
        "prefix": "train-",
        "description": "CASIA-WebFace (491K faces, 10K identities)",
        "image_col": "image",
        "label_col": "label",
    },
    "imdb_wiki": {
        "repo": "ljnlonoljpiljm/imdb_wiki_faces",
        "num_shards": 20,
        "subdir": "data",
        "prefix": "train-",
        "description": "IMDB-Wiki (512K faces with age/gender)",
        "image_col": "image",
        "label_col": "name",
    },
}

stats = {"indexed": 0, "processed": 0, "failed": 0, "skipped": 0,
         "current_shard": 0, "shards_done": 0, "errors": []}
stats_lock = Lock()
start_time = time.time()
insert_queue = deque()
queue_lock = Lock()
_qdrant = None
running = Event()
running.set()

def log(msg): print(msg, flush=True)

def add_error(msg):
    with stats_lock:
        stats["errors"].append({"time": time.time(), "msg": str(msg)[:200]})
        if len(stats["errors"]) > 20:
            stats["errors"] = stats["errors"][-10:]

def get_qdrant():
    global _qdrant
    if _qdrant is None:
        from qdrant_client import QdrantClient
        if QDRANT_PREFIX:
            _qdrant = QdrantClient(
                url=QDRANT_URL, port=443, https=True, prefix=QDRANT_PREFIX,
                timeout=300, grpc_port=None, prefer_grpc=False,
            )
        else:
            _qdrant = QdrantClient(url=QDRANT_URL, timeout=300)
        log(f"[qdrant] Connected to {QDRANT_URL}/{QDRANT_PREFIX}")
    return _qdrant

def load_model():
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

def flush_queue(source_name):
    with queue_lock:
        if not insert_queue: return 0
        batch = list(insert_queue)
        insert_queue.clear()
    try:
        get_qdrant().upsert(collection_name=COLLECTION, points=batch, wait=False)
        with stats_lock: stats["indexed"] += len(batch)
        return len(batch)
    except Exception as e:
        log(f"[qdrant] Flush failed ({len(batch)}): {e}")
        add_error(f"Qdrant flush: {e}")
        with queue_lock: insert_queue.extend(batch)
        return 0

def flush_loop(source_name):
    log("[flush] Thread started")
    while running.is_set() or insert_queue:
        try:
            time.sleep(2.0)
            flush_queue(source_name)
        except Exception as e:
            log(f"[flush error] {e}")
    for _ in range(3):
        if not insert_queue: break
        flush_queue(source_name)
        time.sleep(1)

def queue_point(embedding, label, img_name, source_name):
    from qdrant_client.models import PointStruct
    fid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{source_name}/{img_name}"))
    point = PointStruct(
        id=fid, vector=embedding.tolist(),
        payload={"source_url": f"{source_name}/{img_name}",
                 "source_platform": source_name,
                 "label": str(label), "det_score": 1.0},
    )
    with queue_lock: insert_queue.append(point)
    if len(insert_queue) >= QDRANT_BATCH:
        flush_queue(source_name)

def heartbeat_worker(source_name, total_shards, start_shard, end_shard):
    import urllib.request
    while running.is_set():
        time.sleep(HEARTBEAT_INTERVAL)
        try:
            elapsed = time.time() - start_time
            with stats_lock:
                s = dict(stats)
                s["errors"] = list(stats["errors"])
            rate = s["indexed"] / (elapsed / 60) if elapsed > 0 else 0
            payload = json.dumps({
                "dataset": source_name, "indexed": s["indexed"],
                "processed": s["processed"], "failed": s["failed"],
                "rate": round(rate), "gpuBatch": GPU_BATCH,
                "qdrantBatch": QDRANT_BATCH, "shardProgress": s["current_shard"],
                "shardsCompleted": s["shards_done"],
                "totalShards": end_shard - start_shard,
                "startShard": start_shard, "endShard": end_shard,
                "elapsedSec": round(elapsed), "errors": s["errors"][-5:],
                "timestamp": time.time(),
            }).encode("utf-8")
            req = urllib.request.Request(
                f"{BRIDGE_URL}/api/pipeline-state", data=payload,
                headers={"Content-Type": "application/json"}, method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception: pass

def stats_reporter():
    while running.is_set():
        time.sleep(5)
        elapsed = time.time() - start_time
        with stats_lock:
            idx, proc, fail = stats["indexed"], stats["processed"], stats["failed"]
        if proc > 0:
            rate = idx / (elapsed / 60) if elapsed > 0 else 0
            qlen = len(insert_queue)
            log(f"[stats] indexed:{idx:,} processed:{proc:,} "
                f"fail:{fail:,} queue:{qlen:,} "
                f"rate:{rate:,.0f}/min {elapsed:.0f}s")

def decode_image(args):
    """Decode a single image — runs in worker threads."""
    i, img_data, label, shard_num = args
    try:
        if isinstance(img_data, dict) and "bytes" in img_data:
            img_bytes = img_data["bytes"]
        elif isinstance(img_data, bytes):
            img_bytes = img_data
        else:
            return None
        if len(img_bytes) < 100:
            return None
        arr = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
        if arr is None:
            return None
        tensor = preprocess(arr)
        return (tensor, str(label), f"shard{shard_num:04d}/img{i}")
    except Exception:
        return None

def process_parquet_shard(parquet_path, shard_num, sess, inp_name, source_name, image_col, label_col):
    import pyarrow.parquet as pq
    from concurrent.futures import ThreadPoolExecutor
    shard_start = time.time()
    count = 0
    batch_tensors = []
    batch_names = []
    batch_labels = []
    num_workers = min(os.cpu_count() or 4, 16)

    try:
        table = pq.read_table(parquet_path)
        columns = table.column_names

        # Detect image and label columns
        img_col = image_col if image_col in columns else None
        lbl_col = label_col if label_col in columns else None

        if not img_col:
            for c in columns:
                if c.lower() in ("image", "img", "face", "photo"):
                    img_col = c; break
        if not lbl_col:
            for c in columns:
                if c.lower() in ("label", "class", "identity", "id", "name"):
                    lbl_col = c; break

        if not img_col:
            log(f"[error] Shard {shard_num}: no image column found in {columns}")
            return

        # Extract all data from pyarrow first (single-threaded, fast)
        n = len(table)
        img_column = table.column(img_col)
        lbl_column = table.column(lbl_col) if lbl_col else None
        work_items = []
        for i in range(n):
            img_data = img_column[i].as_py()
            label = lbl_column[i].as_py() if lbl_column else str(i)
            work_items.append((i, img_data, label, shard_num))

        # Decode images in parallel using thread pool
        with ThreadPoolExecutor(max_workers=num_workers) as pool:
            for result in pool.map(decode_image, work_items, chunksize=64):
                if result is None:
                    with stats_lock: stats["skipped"] += 1
                    continue

                tensor, label, name = result
                batch_tensors.append(tensor)
                batch_names.append(name)
                batch_labels.append(label)
                with stats_lock: stats["processed"] += 1
                count += 1

                if len(batch_tensors) >= GPU_BATCH:
                    embeddings = batch_embed(sess, inp_name, batch_tensors)
                    for emb, lbl, nm in zip(embeddings, batch_labels, batch_names):
                        queue_point(emb, lbl, nm, source_name)
                    batch_tensors.clear()
                    batch_names.clear()
                    batch_labels.clear()

    except Exception as e:
        log(f"[error] Shard {shard_num} read failed: {e}")
        add_error(f"Shard {shard_num} failed: {e}")
        return

    if batch_tensors:
        try:
            embeddings = batch_embed(sess, inp_name, batch_tensors)
            for emb, lbl, nm in zip(embeddings, batch_labels, batch_names):
                queue_point(emb, lbl, nm, source_name)
        except Exception as e:
            log(f"[error] Final batch shard {shard_num}: {e}")
            with stats_lock: stats["failed"] += len(batch_tensors)

    flush_queue(source_name)
    elapsed = time.time() - shard_start
    total_elapsed = time.time() - start_time
    with stats_lock:
        idx = stats["indexed"]
        stats["shards_done"] += 1
    rate = idx / (total_elapsed / 60) if total_elapsed > 0 else 0
    log(f"[shard {shard_num:04d}] {count:,} images in {elapsed:.0f}s | "
        f"total indexed:{idx:,} rate:{rate:,.0f}/min")

def main():
    parser = argparse.ArgumentParser(description="Parquet-based face embedding pipeline")
    parser.add_argument("dataset", nargs="?", help="Dataset name or use --repo")
    parser.add_argument("start_shard", nargs="?", type=int, default=0)
    parser.add_argument("end_shard", nargs="?", type=int, default=None)
    parser.add_argument("--repo", help="Custom HuggingFace repo ID")
    parser.add_argument("--shards", type=int, default=100)
    parser.add_argument("--subdir", default="", help="Subdirectory in repo (e.g., '256')")
    parser.add_argument("--prefix", default="train-", help="Shard filename prefix")
    parser.add_argument("--source", default=None)
    parser.add_argument("--image-col", default="image")
    parser.add_argument("--label-col", default="label")
    args = parser.parse_args()

    if args.repo:
        config = {
            "repo": args.repo, "num_shards": args.shards,
            "subdir": args.subdir, "prefix": args.prefix,
            "description": f"Custom ({args.repo})",
            "image_col": args.image_col, "label_col": args.label_col,
        }
        source_name = args.source or args.repo.split("/")[-1]
    elif args.dataset and args.dataset in DATASETS:
        config = DATASETS[args.dataset]
        source_name = args.dataset
    else:
        log(f"Available: {', '.join(DATASETS.keys())}  or use --repo")
        sys.exit(1)

    start_shard = args.start_shard
    end_shard = args.end_shard or config["num_shards"]
    subdir = config.get("subdir", "")
    image_col = config.get("image_col", "image")
    label_col = config.get("label_col", "label")

    log(f"{'='*60}")
    log(f"PARQUET PIPELINE: {config['description']}")
    log(f"  Repo: {config['repo']}")
    log(f"  Shards: {start_shard}-{end_shard-1} ({end_shard-start_shard} shards)")
    log(f"  Subdir: {subdir or '(root)'}")
    log(f"  GPU batch: {GPU_BATCH}, Qdrant batch: {QDRANT_BATCH}")
    log(f"{'='*60}")

    sess, inp_name = load_model()

    ft = Thread(target=flush_loop, args=(source_name,), daemon=True); ft.start()
    st = Thread(target=stats_reporter, daemon=True); st.start()
    ht = Thread(target=heartbeat_worker, args=(source_name, config["num_shards"], start_shard, end_shard), daemon=True); ht.start()

    from huggingface_hub import hf_hub_download
    from concurrent.futures import ThreadPoolExecutor, Future
    local_dir = f"/root/{source_name}"

    def download_shard(shard_idx):
        fname = f"{config['prefix']}{shard_idx:05d}-of-{end_shard:05d}.parquet"
        remote_path = f"{subdir}/{fname}" if subdir else fname
        local_path = os.path.join(local_dir, remote_path)
        if os.path.exists(local_path):
            return local_path
        log(f"[download] Shard {shard_idx:05d}...")
        try:
            local_path = hf_hub_download(
                repo_id=config["repo"], filename=remote_path,
                repo_type="dataset", local_dir=local_dir,
            )
            log(f"[download] {fname} ({os.path.getsize(local_path)/1e6:.0f}MB)")
            return local_path
        except Exception as e:
            log(f"[error] Download shard {shard_idx} failed: {e}")
            add_error(f"Download shard {shard_idx}: {e}")
            return None

    prefetch_pool = ThreadPoolExecutor(max_workers=2)
    # Prefetch first shard
    next_future = prefetch_pool.submit(download_shard, start_shard)

    for i in range(start_shard, end_shard):
        with stats_lock: stats["current_shard"] = i

        # Wait for current shard download
        local_path = next_future.result()

        # Prefetch next shard while processing current one
        if i + 1 < end_shard:
            next_future = prefetch_pool.submit(download_shard, i + 1)

        if local_path is None:
            continue

        process_parquet_shard(local_path, i, sess, inp_name, source_name, image_col, label_col)

        # Clean old shards (keep 2)
        if i >= start_shard + 2:
            old_fname = f"{config['prefix']}{i-2:05d}-of-{end_shard:05d}.parquet"
            old_path = os.path.join(local_dir, subdir, old_fname) if subdir else os.path.join(local_dir, old_fname)
            if os.path.exists(old_path):
                os.remove(old_path)

    prefetch_pool.shutdown(wait=False)

    running.clear()
    flush_queue(source_name)
    time.sleep(3)
    flush_queue(source_name)

    elapsed = time.time() - start_time
    with stats_lock: idx, proc, fail = stats["indexed"], stats["processed"], stats["failed"]
    rate = idx / (elapsed / 60) if elapsed > 0 else 0
    log(f"\n{'='*60}")
    log(f"{source_name.upper()} COMPLETE")
    log(f"  Indexed:    {idx:,}")
    log(f"  Processed:  {proc:,}")
    log(f"  Failed:     {fail:,}")
    log(f"  Rate:       {rate:,.0f} faces/min")
    log(f"  Time:       {elapsed/3600:.1f}h")
    log(f"{'='*60}")

if __name__ == "__main__":
    main()
