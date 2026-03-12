#!/usr/bin/env python3
"""
High-throughput HuggingFace WebDataset → Qdrant face embedding pipeline.
Optimized for maximum GPU utilization on RTX 4070 Ti.

Architecture:
  - Prefetch thread: downloads next shard while current processes
  - Multiprocess preprocessing: decode + resize across CPU cores
  - Large GPU batches (512) to saturate CUDA cores
  - Async Qdrant flushes with large batches (1000)
  - Minimal lock contention

Usage: python3 embed-hf-dataset.py <dataset_name> [start_shard] [end_shard]
"""
import os, sys, uuid, time, io, tarfile, traceback, json, argparse
import numpy as np
import cv2
import onnxruntime as ort
from PIL import Image
from threading import Lock, Thread, Event
from collections import deque
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from queue import Queue, Empty
from multiprocessing import cpu_count

QDRANT_URL = os.environ.get("QDRANT_URL", "https://home.ozzu.world:443")
QDRANT_PREFIX = os.environ.get("QDRANT_PREFIX", "qdrant")
BRIDGE_URL = os.environ.get("BRIDGE_URL", "https://home.ozzu.world/bridge")
COLLECTION = "faces"
QDRANT_BATCH = 1500
GPU_BATCH = 512
PREFETCH_SHARDS = 3
NUM_DECODE_WORKERS = min(cpu_count(), 8)
HEARTBEAT_INTERVAL = 10
FLUSH_WORKERS = 6

import warnings
warnings.filterwarnings("ignore")
os.environ["ONNXRUNTIME_LOG_LEVEL"] = "3"

# ── Dataset configs ──
DATASETS = {
    "webface4m": {
        "repo": "gaunernst/webface4m-wds-gz",
        "num_shards": 100,
        "prefix": "webface4m-",
        "suffix": ".tar.gz",
        "description": "WebFace4M (4.2M faces, 205K identities)",
    },
    "ms1mv3": {
        "repo": "gaunernst/ms1mv3-wds",
        "num_shards": 100,
        "prefix": "ms1mv3-",
        "suffix": ".tar",
        "description": "MS1MV3 (5.2M faces, 93K identities)",
    },
    "vggface2": {
        "repo": "gaunernst/vggface2-wds",
        "num_shards": 100,
        "prefix": "vggface2-",
        "suffix": ".tar",
        "description": "VGGFace2 (3.3M faces, 9K identities)",
    },
    "ms1mv2": {
        "repo": "LSIbabnikz/ms1mv2_wds",
        "num_shards": 117,
        "prefix": "shard-",
        "suffix": ".tar",
        "description": "MS1MV2 (5.8M faces, 85K identities)",
    },
}

# ── State (minimized lock contention) ──
class Stats:
    __slots__ = ['indexed', 'processed', 'failed', 'skipped', 'current_shard', 'shards_done', 'errors', '_lock']
    def __init__(self):
        self.indexed = 0
        self.processed = 0
        self.failed = 0
        self.skipped = 0
        self.current_shard = 0
        self.shards_done = 0
        self.errors = []
        self._lock = Lock()

    def add_processed(self, n):
        self.processed += n  # atomic-enough for stats

    def add_indexed(self, n):
        self.indexed += n

    def add_failed(self, n):
        self.failed += n

    def add_error(self, msg):
        with self._lock:
            self.errors.append({"time": time.time(), "msg": str(msg)[:200]})
            if len(self.errors) > 20:
                self.errors = self.errors[-10:]

    def snapshot(self):
        return {
            "indexed": self.indexed, "processed": self.processed,
            "failed": self.failed, "current_shard": self.current_shard,
            "shards_done": self.shards_done, "errors": list(self.errors[-5:])
        }

stats = Stats()
start_time = time.time()
_qdrant = None
running = Event()
running.set()

def log(msg):
    print(msg, flush=True)

# ── Qdrant ──
def make_qdrant_client():
    """Create a Qdrant client — supports both direct and nginx-proxied connections."""
    from qdrant_client import QdrantClient
    if QDRANT_PREFIX:
        return QdrantClient(
            url=QDRANT_URL, port=443, https=True, prefix=QDRANT_PREFIX,
            timeout=300, verify=False, check_compatibility=False,
        )
    else:
        return QdrantClient(url=QDRANT_URL, timeout=300)

def get_qdrant():
    global _qdrant
    if _qdrant is None:
        _qdrant = make_qdrant_client()
        log(f"[qdrant] Connected to {QDRANT_URL}/{QDRANT_PREFIX}")
    return _qdrant

# ── Qdrant flush with concurrent writers ──
flush_queue = Queue(maxsize=100)  # each item is a batch of ~512 points — cap to limit memory

def flush_worker(worker_id=0):
    """Dedicated thread that pushes batches to Qdrant."""
    client = make_qdrant_client()
    log(f"[flush-{worker_id}] Worker started")

    batch = []
    last_flush = time.time()
    while running.is_set() or not flush_queue.empty() or batch:
        try:
            item = flush_queue.get(timeout=0.5)
            # item is either a list of points (from queue_batch) or a single point
            if isinstance(item, list):
                batch.extend(item)
            else:
                batch.append(item)
        except Empty:
            pass

        now = time.time()
        if len(batch) >= QDRANT_BATCH or (batch and now - last_flush > 2.0):
            to_send = batch[:QDRANT_BATCH]
            batch = batch[QDRANT_BATCH:]
            try:
                client.upsert(collection_name=COLLECTION, points=to_send, wait=False)
                stats.add_indexed(len(to_send))
            except Exception as e:
                log(f"[flush-{worker_id}] Failed ({len(to_send)}): {e}")
                stats.add_error(f"Flush-{worker_id}: {e}")
                # Re-queue as a batch
                try:
                    flush_queue.put_nowait(to_send)
                except:
                    pass
            last_flush = time.time()

    # Final drain
    if batch:
        try:
            client.upsert(collection_name=COLLECTION, points=batch, wait=False)
            stats.add_indexed(len(batch))
        except Exception as e:
            log(f"[flush-{worker_id}] Final flush failed: {e}")

def queue_batch(embeddings, labels, names, source_name):
    """Queue an entire batch at once — sends whole batch to flush queue as one item."""
    from qdrant_client.models import PointStruct
    vectors = embeddings.tolist()  # batch tolist is faster than per-item
    points = []
    for vec, label, name in zip(vectors, labels, names):
        fid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{source_name}/{name}"))
        points.append(PointStruct(
            id=fid, vector=vec,
            payload={"source_url": f"{source_name}/{name}",
                     "source_platform": source_name,
                     "label": str(label), "det_score": 1.0},
        ))
    # Put entire batch as one queue item — avoids 512 individual put() calls
    flush_queue.put(points)

# ── GPU Model ──
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
    sess_opts.intra_op_num_threads = 1  # GPU doesn't need CPU parallelism here
    sess = ort.InferenceSession(model_path, sess_opts,
                                 providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    inp_name = sess.get_inputs()[0].name
    log(f"[gpu] Model loaded, providers: {sess.get_providers()}")

    # Warmup — gradually increase batch to let CUDA allocator warm up
    global GPU_BATCH
    for wb in [1, 32, 128, GPU_BATCH]:
        try:
            dummy = np.random.randn(wb, 3, 112, 112).astype(np.float32)
            sess.run(None, {inp_name: dummy})
            del dummy
        except Exception as e:
            log(f"[gpu] OOM at batch={wb}, capping at {wb // 2}")
            GPU_BATCH = max(wb // 2, 64)
            break
    log(f"[gpu] Warmup done (effective batch={GPU_BATCH})")
    return sess, inp_name

def preprocess_single(img_bytes):
    """Decode + resize + normalize a single image. Runs in thread pool."""
    try:
        buf = np.frombuffer(img_bytes, dtype=np.uint8)
        img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if img is None:
            return None
        if img.shape[0] != 112 or img.shape[1] != 112:
            img = cv2.resize(img, (112, 112))
        img = (img.astype(np.float32) - 127.5) / 127.5
        return np.transpose(img, (2, 0, 1))
    except:
        return None

def batch_embed(sess, inp_name, tensors):
    batch = np.stack(tensors, axis=0)
    outs = sess.run(None, {inp_name: batch})[0]
    norms = np.linalg.norm(outs, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-10)
    return outs / norms

# ── Shard prefetcher ──
class ShardPrefetcher:
    """Downloads shards ahead of time so GPU never waits on I/O."""
    def __init__(self, config, local_dir, start_shard, end_shard):
        self.config = config
        self.local_dir = local_dir
        self.start_shard = start_shard
        self.end_shard = end_shard
        self.ready_queue = Queue(maxsize=PREFETCH_SHARDS + 1)
        self._thread = Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        from huggingface_hub import hf_hub_download
        import subprocess
        cfg = self.config
        for i in range(self.start_shard, self.end_shard):
            shard_file = f"{cfg['prefix']}{i:04d}{cfg['suffix']}"
            tar_path = os.path.join(self.local_dir, shard_file)

            # Check for pre-decompressed .tar (faster — no gzip overhead)
            if cfg['suffix'].endswith('.gz'):
                uncompressed = tar_path.replace('.tar.gz', '.tar')
                if os.path.exists(uncompressed):
                    self.ready_queue.put((i, uncompressed))
                    continue

            if not os.path.exists(tar_path):
                try:
                    tar_path = hf_hub_download(
                        repo_id=cfg["repo"], filename=shard_file,
                        repo_type="dataset", local_dir=self.local_dir,
                    )
                    log(f"[prefetch] Shard {i:04d} downloaded ({os.path.getsize(tar_path)/1e6:.0f}MB)")
                except Exception as e:
                    log(f"[prefetch] Shard {i} download failed: {e}")
                    self.ready_queue.put((i, None))
                    continue

            # Auto-decompress .tar.gz → .tar with pigz if available
            if tar_path.endswith('.tar.gz'):
                uncompressed = tar_path.replace('.tar.gz', '.tar')
                try:
                    subprocess.run(['pigz', '-dk', '-f', tar_path],
                                   capture_output=True, timeout=120)
                    if os.path.exists(uncompressed):
                        log(f"[prefetch] Shard {i:04d} decompressed ({os.path.getsize(uncompressed)/1e6:.0f}MB)")
                        tar_path = uncompressed
                except (FileNotFoundError, subprocess.TimeoutExpired):
                    pass  # pigz not available, use .tar.gz as-is

            self.ready_queue.put((i, tar_path))
        self.ready_queue.put((-1, None))  # sentinel

    def next(self):
        return self.ready_queue.get()

# ── Extract shard images into memory (threaded tar reading) ──
def extract_shard_images(tar_path):
    """Extract all images + labels from a tar in one pass. Returns list of (img_bytes, name, label)."""
    open_mode = "r:gz" if tar_path.endswith(".gz") else "r"
    images = {}
    labels = {}
    results = []

    with tarfile.open(tar_path, open_mode) as tar:
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
                images[key] = (data, name)
            elif ext == ".cls":
                labels[key] = data.decode("utf-8").strip()

            # Pair up as we go
            if key in images and key in labels:
                img_bytes, img_name = images.pop(key)
                label = labels.pop(key)
                if len(img_bytes) >= 100:
                    results.append((img_bytes, img_name, label))

    # Remaining unpaired images
    for key, (img_bytes, img_name) in images.items():
        label = labels.get(key, key)
        if len(img_bytes) >= 100:
            results.append((img_bytes, img_name, label))

    return results

# ── Process shard (with overlapped extraction) ──
def extract_and_decode(tar_path, shard_num, decode_pool):
    """Extract tar + parallel decode. Returns (tensors, names, labels, failed_count) or None."""
    try:
        raw_images = extract_shard_images(tar_path)
    except Exception as e:
        log(f"[error] Shard {shard_num} tar failed: {e}")
        stats.add_error(f"Shard {shard_num}: {e}")
        return None

    if not raw_images:
        return None

    img_bytes_list = [r[0] for r in raw_images]
    names = [r[1] for r in raw_images]
    labels_list = [r[2] for r in raw_images]

    tensors = list(decode_pool.map(preprocess_single, img_bytes_list, chunksize=64))

    # Filter
    good_tensors = []
    good_names = []
    good_labels = []
    failed = 0
    for tensor, name, label in zip(tensors, names, labels_list):
        if tensor is None:
            failed += 1
        else:
            good_tensors.append(tensor)
            good_names.append(name)
            good_labels.append(label)

    return (good_tensors, good_names, good_labels, failed, len(raw_images))

def process_decoded(tensors, names, labels, failed, total_raw, shard_num, sess, inp_name, source_name):
    """Run GPU inference on pre-decoded tensors."""
    shard_start = time.time()
    batch_tensors = []
    batch_names = []
    batch_labels = []

    for tensor, name, label in zip(tensors, names, labels):
        batch_tensors.append(tensor)
        batch_names.append(name)
        batch_labels.append(label)

        if len(batch_tensors) >= GPU_BATCH:
            embeddings = batch_embed(sess, inp_name, batch_tensors)
            queue_batch(embeddings, batch_labels, batch_names, source_name)
            stats.add_processed(len(batch_tensors))
            batch_tensors.clear()
            batch_names.clear()
            batch_labels.clear()

    if batch_tensors:
        embeddings = batch_embed(sess, inp_name, batch_tensors)
        queue_batch(embeddings, batch_labels, batch_names, source_name)
        stats.add_processed(len(batch_tensors))

    stats.add_failed(failed)
    stats.shards_done += 1

    elapsed = time.time() - shard_start
    total_elapsed = time.time() - start_time
    rate = stats.indexed / (total_elapsed / 60) if total_elapsed > 0 else 0
    log(f"[shard {shard_num:04d}] {total_raw:,} images in {elapsed:.1f}s | "
        f"total indexed:{stats.indexed:,} rate:{rate:,.0f}/min")

# ── Heartbeat ──
def heartbeat_worker(source_name, total_shards, start_shard, end_shard):
    import urllib.request
    while running.is_set():
        time.sleep(HEARTBEAT_INTERVAL)
        try:
            elapsed = time.time() - start_time
            s = stats.snapshot()
            rate = s["indexed"] / (elapsed / 60) if elapsed > 0 else 0
            payload = json.dumps({
                "dataset": source_name,
                "indexed": s["indexed"],
                "processed": s["processed"],
                "failed": s["failed"],
                "rate": round(rate),
                "gpuBatch": GPU_BATCH,
                "qdrantBatch": QDRANT_BATCH,
                "shardProgress": s["current_shard"],
                "shardsCompleted": s["shards_done"],
                "totalShards": end_shard - start_shard,
                "startShard": start_shard,
                "endShard": end_shard,
                "elapsedSec": round(elapsed),
                "errors": s["errors"],
                "timestamp": time.time(),
            }).encode("utf-8")
            req = urllib.request.Request(
                f"{BRIDGE_URL}/api/pipeline-state",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass

# ── Stats reporter ──
def stats_reporter():
    while running.is_set():
        time.sleep(5)
        elapsed = time.time() - start_time
        idx = stats.indexed
        proc = stats.processed
        fail = stats.failed
        if proc > 0:
            rate = idx / (elapsed / 60) if elapsed > 0 else 0
            qlen = flush_queue.qsize()  # batches in flush queue
            log(f"[stats] indexed:{idx:,} processed:{proc:,} "
                f"fail:{fail:,} queue:{qlen:,} "
                f"rate:{rate:,.0f}/min {elapsed:.0f}s")

# ── Main ──
def main():
    parser = argparse.ArgumentParser(description="High-throughput HF face embedding pipeline")
    parser.add_argument("dataset", nargs="?", help="Dataset name (webface4m, ms1mv3, vggface2) or use --repo")
    parser.add_argument("start_shard", nargs="?", type=int, default=0)
    parser.add_argument("end_shard", nargs="?", type=int, default=None)
    parser.add_argument("--repo", help="Custom HuggingFace repo ID")
    parser.add_argument("--shards", type=int, default=100, help="Number of shards")
    parser.add_argument("--prefix", default="data-", help="Shard filename prefix")
    parser.add_argument("--suffix", default=".tar", help="Shard filename suffix")
    parser.add_argument("--source", default=None, help="Source name for Qdrant payload")
    args = parser.parse_args()

    if args.repo:
        config = {
            "repo": args.repo,
            "num_shards": args.shards,
            "prefix": args.prefix,
            "suffix": args.suffix,
            "description": f"Custom ({args.repo})",
        }
        source_name = args.source or args.repo.split("/")[-1]
    elif args.dataset and args.dataset in DATASETS:
        config = DATASETS[args.dataset]
        source_name = args.dataset
    else:
        log(f"Available datasets: {', '.join(DATASETS.keys())}")
        log("Or use --repo to specify a custom HuggingFace repo")
        sys.exit(1)

    start_shard = args.start_shard
    end_shard = args.end_shard or config["num_shards"]
    local_dir = f"/root/{source_name}"

    log(f"{'='*60}")
    log(f"EMBEDDING PIPELINE: {config['description']}")
    log(f"  Repo: {config['repo']}")
    log(f"  Shards: {start_shard}-{end_shard-1} ({end_shard-start_shard} shards)")
    log(f"  GPU batch: {GPU_BATCH}, Qdrant batch: {QDRANT_BATCH}")
    log(f"  Decode workers: {NUM_DECODE_WORKERS}, Flush workers: {FLUSH_WORKERS}")
    log(f"  Prefetch shards: {PREFETCH_SHARDS}")
    log(f"  Qdrant: {QDRANT_URL}")
    log(f"  Bridge: {BRIDGE_URL}")
    log(f"{'='*60}")

    sess, inp_name = load_model()

    # Start flush workers — parallel Qdrant writers
    flush_threads = []
    for i in range(FLUSH_WORKERS):
        t = Thread(target=flush_worker, args=(i,), daemon=True)
        t.start()
        flush_threads.append(t)

    st = Thread(target=stats_reporter, daemon=True)
    st.start()
    ht = Thread(target=heartbeat_worker, args=(source_name, config["num_shards"], start_shard, end_shard), daemon=True)
    ht.start()

    # Start prefetcher (downloads shards ahead)
    prefetcher = ShardPrefetcher(config, local_dir, start_shard, end_shard)

    # Thread pool for parallel image decoding
    decode_pool = ThreadPoolExecutor(max_workers=NUM_DECODE_WORKERS)

    # Double-buffer: extract next shard while GPU processes current
    # This overlaps the main bottleneck (gzip decompression) with GPU work
    next_decoded = None
    next_shard_num = None
    extract_executor = ThreadPoolExecutor(max_workers=1)
    extract_future = None

    def start_next_extract():
        """Kick off extraction of next shard in background."""
        nonlocal extract_future, next_shard_num
        sn, tp = prefetcher.next()
        if sn == -1:
            extract_future = None
            next_shard_num = -1
            return
        if tp is None:
            extract_future = None
            next_shard_num = None
            return
        next_shard_num = sn
        extract_future = extract_executor.submit(extract_and_decode, tp, sn, decode_pool)

    # Start first extraction
    shard_num, tar_path = prefetcher.next()
    if shard_num != -1 and tar_path:
        # Extract first shard synchronously
        current = extract_and_decode(tar_path, shard_num, decode_pool)
        current_shard = shard_num
        current_tar = tar_path
        # Start extracting second shard in background
        start_next_extract()

        while True:
            stats.current_shard = current_shard

            if current:
                tensors, names, labels, failed, total_raw = current
                process_decoded(tensors, names, labels, failed, total_raw,
                              current_shard, sess, inp_name, source_name)

            # Clean old shards
            if current_tar and current_shard >= start_shard + 3:
                old_file = f"{config['prefix']}{current_shard-3:04d}{config['suffix']}"
                old_path = os.path.join(local_dir, old_file)
                if os.path.exists(old_path):
                    try: os.remove(old_path)
                    except: pass

            # Get next extracted shard (should be ready or nearly ready)
            if extract_future is not None:
                current = extract_future.result()
                current_shard = next_shard_num
                # Start next extraction immediately
                start_next_extract()
            elif next_shard_num == -1:
                break
            else:
                # Edge case: prefetcher returned None path, try again
                start_next_extract()
                if extract_future is not None:
                    current = extract_future.result()
                    current_shard = next_shard_num
                    start_next_extract()
                else:
                    break

    extract_executor.shutdown(wait=False)
    decode_pool.shutdown(wait=False)
    running.clear()

    # Wait for flush queue to drain
    log(f"[shutdown] Waiting for {flush_queue.qsize()} queued points to flush...")
    deadline = time.time() + 120
    while not flush_queue.empty() and time.time() < deadline:
        time.sleep(1)

    elapsed = time.time() - start_time
    idx = stats.indexed
    proc = stats.processed
    fail = stats.failed
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
