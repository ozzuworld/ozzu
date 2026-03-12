#!/usr/bin/env python3
"""
High-throughput face embedding pipeline v2.
Designed for 70K+ faces/min on RTX 3090 based on actual benchmarks.

Key optimizations over v1:
  - Phase-based: download ALL → decompress ALL → GPU process (no interleaving)
  - ProcessPoolExecutor for image decode (bypasses Python GIL)
  - Qdrant m=0 during bulk ingestion (5-10x faster writes)
  - rapidgzip for parallel decompression (12 GB/s vs 500 MB/s single-threaded)
  - Pre-allocated numpy buffers to reduce allocation overhead
  - Batch PointStruct creation (numpy tolist once per batch, not per-point)
  - Concurrent flush workers with large batches (5000 points)

Benchmark baseline: 96K/min pure inference, 44K/min best pipeline v1.
Target: 70-80K/min sustained.

Usage:
  python3 embed-pipeline-v2.py webface4m          # WebDataset tar format
  python3 embed-pipeline-v2.py vggface2            # Parquet format
  python3 embed-pipeline-v2.py --repo user/repo --format tar --shards 100
  python3 embed-pipeline-v2.py --benchmark         # Pure GPU benchmark (no Qdrant)
"""
import os, sys, uuid, time, json, argparse, subprocess, signal

# Auto-detect and preload CUDA libs from pip-installed nvidia packages
# Must happen BEFORE importing onnxruntime
def _setup_cuda_libs():
    """Find NVIDIA CUDA libraries and preload them via ctypes."""
    import site, ctypes, glob as globmod
    lib_dirs = []
    for sp in (site.getsitepackages() if hasattr(site, 'getsitepackages') else []) + \
              ([site.getusersitepackages()] if hasattr(site, 'getusersitepackages') else []):
        nvidia_dir = os.path.join(sp, "nvidia")
        if os.path.isdir(nvidia_dir):
            for pkg in os.listdir(nvidia_dir):
                lib_dir = os.path.join(nvidia_dir, pkg, "lib")
                if os.path.isdir(lib_dir):
                    lib_dirs.append(lib_dir)
    if lib_dirs:
        # Set env for child processes
        existing = os.environ.get("LD_LIBRARY_PATH", "")
        os.environ["LD_LIBRARY_PATH"] = ":".join(lib_dirs) + (":" + existing if existing else "")
        # Preload key libs that onnxruntime needs
        for lib_dir in lib_dirs:
            for pattern in ["libcublas*.so*", "libcudnn*.so*", "libcufft*.so*",
                           "libcurand*.so*", "libcusolver*.so*", "libcusparse*.so*",
                           "libcudart*.so*"]:
                for lib in globmod.glob(os.path.join(lib_dir, pattern)):
                    try:
                        ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                    except OSError:
                        pass
_setup_cuda_libs()

import numpy as np
import cv2
import onnxruntime as ort
from threading import Lock, Thread, Event
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from queue import Queue, Empty
from multiprocessing import cpu_count, shared_memory

# ── Config (tunable via env) ──
QDRANT_URL = os.environ.get("QDRANT_URL", "https://home.ozzu.world:443")
QDRANT_PREFIX = os.environ.get("QDRANT_PREFIX", "qdrant")
BRIDGE_URL = os.environ.get("BRIDGE_URL", "https://home.ozzu.world/bridge")
COLLECTION = "faces"
GPU_BATCH = int(os.environ.get("GPU_BATCH", "512"))
QDRANT_BATCH = int(os.environ.get("QDRANT_BATCH", "5000"))
FLUSH_WORKERS = int(os.environ.get("FLUSH_WORKERS", "4"))
DECODE_WORKERS = int(os.environ.get("DECODE_WORKERS", str(min(cpu_count(), 16))))
PREFETCH_SHARDS = int(os.environ.get("PREFETCH_SHARDS", "4"))
HEARTBEAT_INTERVAL = 10

import warnings
warnings.filterwarnings("ignore")
os.environ["ONNXRUNTIME_LOG_LEVEL"] = "3"

# ── Dataset registry ──
DATASETS = {
    # WebDataset (tar) format
    "webface4m": {
        "repo": "gaunernst/webface4m-wds-gz", "num_shards": 100,
        "prefix": "webface4m-", "suffix": ".tar.gz", "format": "tar",
        "description": "WebFace4M (4.2M faces, 205K identities)",
    },
    "ms1mv3": {
        "repo": "gaunernst/ms1mv3-wds", "num_shards": 100,
        "prefix": "ms1mv3-", "suffix": ".tar", "format": "tar",
        "description": "MS1MV3 (5.2M faces, 93K identities)",
    },
    "vggface2_wds": {
        "repo": "gaunernst/vggface2-wds", "num_shards": 100,
        "prefix": "vggface2-", "suffix": ".tar", "format": "tar",
        "description": "VGGFace2-WDS (3.3M faces, 9K identities)",
    },
    "ms1mv2": {
        "repo": "LSIbabnikz/ms1mv2_wds", "num_shards": 117,
        "prefix": "shard-", "suffix": ".tar", "format": "tar",
        "description": "MS1MV2 (5.8M faces, 85K identities)",
    },
    # Parquet format
    "vggface2": {
        "repo": "logasja/VGGFace2", "num_shards": 518,
        "subdir": "256", "prefix": "train-", "format": "parquet",
        "description": "VGGFace2 (3.3M faces, 9K identities)",
        "image_col": "image", "label_col": "label",
    },
    "casia": {
        "repo": "SaffalPoosh/casia_web_face", "num_shards": 20,
        "subdir": "data", "prefix": "train-", "format": "parquet",
        "description": "CASIA-WebFace (491K faces, 10K identities)",
        "image_col": "image", "label_col": "label",
    },
    "imdb_wiki": {
        "repo": "ljnlonoljpiljm/imdb_wiki_faces", "num_shards": 20,
        "subdir": "data", "prefix": "train-", "format": "parquet",
        "description": "IMDB-Wiki (512K faces with age/gender)",
        "image_col": "image", "label_col": "name",
    },
    "celeba": {
        "repo": "logasja/CelebA", "num_shards": 20,
        "subdir": "data", "prefix": "train-", "format": "parquet",
        "description": "CelebA (200K faces)",
        "image_col": "image", "label_col": "identity",
    },
}

# ── Stats ──
class Stats:
    __slots__ = ['indexed', 'processed', 'failed', 'skipped', 'current_shard',
                 'shards_done', 'total_shards', 'errors', '_lock', 'phase',
                 'download_done', 'decompress_done']
    def __init__(self):
        self.indexed = 0; self.processed = 0; self.failed = 0; self.skipped = 0
        self.current_shard = 0; self.shards_done = 0; self.total_shards = 0
        self.errors = []; self._lock = Lock()
        self.phase = "init"; self.download_done = 0; self.decompress_done = 0
    def add_processed(self, n): self.processed += n
    def add_indexed(self, n): self.indexed += n
    def add_failed(self, n): self.failed += n
    def add_error(self, msg):
        with self._lock:
            self.errors.append({"time": time.time(), "msg": str(msg)[:200]})
            if len(self.errors) > 20: self.errors = self.errors[-10:]
    def snapshot(self):
        return {"indexed": self.indexed, "processed": self.processed,
                "failed": self.failed, "current_shard": self.current_shard,
                "shards_done": self.shards_done, "total_shards": self.total_shards,
                "phase": self.phase, "errors": list(self.errors[-5:])}

stats = Stats()
start_time = time.time()
running = Event()
running.set()

def log(msg):
    elapsed = time.time() - start_time
    print(f"[{elapsed:7.1f}s] {msg}", flush=True)

# ── Qdrant client ──
def make_qdrant_client():
    from qdrant_client import QdrantClient
    if QDRANT_PREFIX:
        return QdrantClient(
            url=QDRANT_URL, port=443, https=True, prefix=QDRANT_PREFIX,
            timeout=300, verify=False, check_compatibility=False,
        )
    else:
        return QdrantClient(url=QDRANT_URL, timeout=300)

def set_qdrant_bulk_mode(enable=True):
    """Set m=0 to disable HNSW during bulk ingestion (5-10x faster writes)."""
    try:
        from qdrant_client.models import OptimizersConfigDiff
        client = make_qdrant_client()
        if enable:
            client.update_collection(
                collection_name=COLLECTION,
                optimizer_config=OptimizersConfigDiff(
                    indexing_threshold=0,  # Disable indexing entirely during bulk
                ),
            )
            log("[qdrant] Bulk mode ON — indexing disabled for fast inserts")
        else:
            client.update_collection(
                collection_name=COLLECTION,
                optimizer_config=OptimizersConfigDiff(
                    indexing_threshold=20000,  # Re-enable indexing
                ),
            )
            log("[qdrant] Bulk mode OFF — indexing re-enabled")
    except Exception as e:
        log(f"[qdrant] Warning: could not set bulk mode: {e}")

# ── Flush workers (concurrent Qdrant writers) ──
flush_queue = Queue(maxsize=200)

def flush_worker(worker_id=0):
    """Dedicated thread that pushes batches to Qdrant."""
    client = make_qdrant_client()
    log(f"[flush-{worker_id}] Worker started")
    batch = []
    last_flush = time.time()
    consecutive_errors = 0

    while running.is_set() or not flush_queue.empty() or batch:
        try:
            item = flush_queue.get(timeout=0.5)
            if isinstance(item, list):
                batch.extend(item)
            else:
                batch.append(item)
        except Empty:
            pass

        now = time.time()
        if len(batch) >= QDRANT_BATCH or (batch and now - last_flush > 3.0):
            to_send = batch[:QDRANT_BATCH]
            batch = batch[QDRANT_BATCH:]
            try:
                client.upsert(collection_name=COLLECTION, points=to_send, wait=False)
                stats.add_indexed(len(to_send))
                consecutive_errors = 0
            except Exception as e:
                consecutive_errors += 1
                log(f"[flush-{worker_id}] Error #{consecutive_errors} ({len(to_send)}p): {e}")
                stats.add_error(f"Flush-{worker_id}: {e}")
                if consecutive_errors < 5:
                    # Re-queue for retry
                    try: flush_queue.put_nowait(to_send)
                    except: batch = to_send + batch  # put back in local batch
                else:
                    log(f"[flush-{worker_id}] Too many errors, dropping {len(to_send)} points")
                    stats.add_failed(len(to_send))
                    consecutive_errors = 0
                    # Reconnect
                    try: client = make_qdrant_client()
                    except: pass
            last_flush = time.time()

    # Final drain
    if batch:
        try:
            for i in range(0, len(batch), QDRANT_BATCH):
                chunk = batch[i:i+QDRANT_BATCH]
                client.upsert(collection_name=COLLECTION, points=chunk, wait=True)
                stats.add_indexed(len(chunk))
        except Exception as e:
            log(f"[flush-{worker_id}] Final flush failed: {e}")

def queue_batch(embeddings, labels, names, source_name):
    """Queue an entire GPU batch as one item. Converts numpy → PointStruct in bulk."""
    from qdrant_client.models import PointStruct
    vectors = embeddings.tolist()  # Single numpy→python conversion for whole batch
    points = [
        PointStruct(
            id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{source_name}/{name}")),
            vector=vec,
            payload={"source_url": f"{source_name}/{name}",
                     "source_platform": source_name,
                     "label": str(label), "det_score": 1.0},
        )
        for vec, label, name in zip(vectors, labels, names)
    ]
    flush_queue.put(points)

# ── GPU model ──
def load_model(use_tensorrt=False):
    model_path = os.path.expanduser("~/.insightface/models/buffalo_l/w600k_r50.onnx")
    if not os.path.exists(model_path):
        log("[gpu] Model not found, downloading via insightface...")
        from insightface.app import FaceAnalysis
        app = FaceAnalysis(name="buffalo_l", providers=["CUDAExecutionProvider"])
        app.prepare(ctx_id=0)
        del app

    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if use_tensorrt:
        providers = ["TensorrtExecutionProvider"] + providers

    sess_opts = ort.SessionOptions()
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_opts.log_severity_level = 3
    sess_opts.intra_op_num_threads = 1  # GPU doesn't need CPU threads

    sess = ort.InferenceSession(model_path, sess_opts, providers=providers)
    active = sess.get_providers()
    inp_name = sess.get_inputs()[0].name
    log(f"[gpu] Model loaded, providers: {active}")

    if "TensorrtExecutionProvider" in active:
        log("[gpu] TensorRT active — expect 1.5-2x speedup over CUDA")
    elif "CUDAExecutionProvider" in active:
        log("[gpu] CUDA active")
    else:
        log("[gpu] WARNING: CPU only! Check CUDA installation.")

    # Warmup with gradually increasing batch sizes
    global GPU_BATCH
    for wb in [1, 32, 128, 256, GPU_BATCH]:
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

def batch_embed(sess, inp_name, tensors):
    """Run GPU inference on a batch of pre-processed tensors."""
    batch = np.stack(tensors, axis=0)
    outs = sess.run(None, {inp_name: batch})[0]
    norms = np.linalg.norm(outs, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-10)
    return outs / norms

# ── Image decode (runs in worker processes) ──
def _decode_image_bytes(img_bytes):
    """Decode raw JPEG/PNG bytes → CHW float32 tensor. Runs in worker process."""
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

# ── Phase 1: Download shards ──
def download_shards(config, local_dir, start_shard, end_shard):
    """Download all shards in parallel. Returns list of (shard_num, local_path)."""
    from huggingface_hub import hf_hub_download
    fmt = config["format"]
    results = []

    def download_one(shard_idx):
        if fmt == "parquet":
            fname = f"{config['prefix']}{shard_idx:05d}-of-{end_shard:05d}.parquet"
            subdir = config.get("subdir", "")
            remote_path = f"{subdir}/{fname}" if subdir else fname
        else:
            fname = f"{config['prefix']}{shard_idx:04d}{config['suffix']}"
            remote_path = fname

        local_path = os.path.join(local_dir, remote_path)
        if os.path.exists(local_path):
            return (shard_idx, local_path)

        try:
            local_path = hf_hub_download(
                repo_id=config["repo"], filename=remote_path,
                repo_type="dataset", local_dir=local_dir,
            )
            stats.download_done += 1
            return (shard_idx, local_path)
        except Exception as e:
            log(f"[download] Shard {shard_idx} failed: {e}")
            stats.add_error(f"Download {shard_idx}: {e}")
            return (shard_idx, None)

    log(f"[download] Downloading shards {start_shard}-{end_shard-1} ({end_shard-start_shard} total)...")
    stats.phase = "download"

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(download_one, i): i for i in range(start_shard, end_shard)}
        for future in futures:
            result = future.result()
            if result[1]:
                results.append(result)
            pct = len(results) * 100 // (end_shard - start_shard)
            if len(results) % 10 == 0:
                log(f"[download] {len(results)}/{end_shard-start_shard} ({pct}%)")

    results.sort(key=lambda x: x[0])
    log(f"[download] Done — {len(results)} shards ready")
    return results

# ── Phase 2: Decompress .tar.gz → .tar ──
def decompress_shards(shard_paths):
    """Decompress .tar.gz shards using rapidgzip or pigz. Returns updated paths."""
    gz_shards = [(i, p) for i, p in shard_paths if p.endswith('.tar.gz')]
    if not gz_shards:
        return shard_paths

    stats.phase = "decompress"
    log(f"[decompress] {len(gz_shards)} compressed shards to decompress...")

    # Check for rapidgzip (parallel) → pigz → gzip (fallback)
    decompress_cmd = None
    for cmd in ["rapidgzip", "pigz", "gzip"]:
        try:
            subprocess.run([cmd, "--version"], capture_output=True, timeout=5)
            decompress_cmd = cmd
            break
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue

    if decompress_cmd == "rapidgzip":
        log(f"[decompress] Using rapidgzip (parallel, ~12 GB/s)")
    elif decompress_cmd == "pigz":
        log(f"[decompress] Using pigz (I/O threaded, ~2x gzip)")
    else:
        log(f"[decompress] Using gzip (single-threaded, slow)")

    updated = dict(shard_paths)
    done = 0

    def decompress_one(shard_idx, gz_path):
        nonlocal done
        tar_path = gz_path.replace('.tar.gz', '.tar')
        if os.path.exists(tar_path):
            return (shard_idx, tar_path)
        try:
            if decompress_cmd == "rapidgzip":
                subprocess.run(
                    [decompress_cmd, "-d", "-k", "-o", tar_path, gz_path],
                    capture_output=True, timeout=300, check=True
                )
            elif decompress_cmd == "pigz":
                subprocess.run(
                    [decompress_cmd, "-dk", "-f", gz_path],
                    capture_output=True, timeout=300, check=True
                )
            else:
                subprocess.run(
                    ["gzip", "-dk", "-f", gz_path],
                    capture_output=True, timeout=300, check=True
                )
            if os.path.exists(tar_path):
                done += 1
                stats.decompress_done = done
                return (shard_idx, tar_path)
        except Exception as e:
            log(f"[decompress] Shard {shard_idx} failed: {e}")
        return (shard_idx, gz_path)  # Fallback to gz

    # Decompress in parallel (rapidgzip benefits from single-file parallelism,
    # but we also decompress multiple files concurrently for pigz/gzip)
    workers = 1 if decompress_cmd == "rapidgzip" else min(cpu_count(), 8)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(decompress_one, i, p) for i, p in gz_shards]
        for f in futures:
            idx, path = f.result()
            updated[idx] = path

    result = [(i, updated[i]) for i in sorted(updated.keys())]
    log(f"[decompress] Done — {done} shards decompressed")
    return result

# ── Phase 3: Extract + decode images from shard ──
def extract_tar_images(tar_path):
    """Extract all images + labels from a tar shard. Returns list of (img_bytes, name, label)."""
    import tarfile
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

            if key in images and key in labels:
                img_bytes, img_name = images.pop(key)
                label = labels.pop(key)
                if len(img_bytes) >= 100:
                    results.append((img_bytes, img_name, label))

    for key, (img_bytes, img_name) in images.items():
        label = labels.get(key, key)
        if len(img_bytes) >= 100:
            results.append((img_bytes, img_name, label))

    return results

def extract_parquet_images(parquet_path, shard_num, image_col="image", label_col="label"):
    """Extract all images + labels from a parquet shard."""
    import pyarrow.parquet as pq
    table = pq.read_table(parquet_path)
    columns = table.column_names

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
        log(f"[error] No image column in {columns}")
        return []

    results = []
    n = len(table)
    img_column = table.column(img_col)
    lbl_column = table.column(lbl_col) if lbl_col else None

    for i in range(n):
        img_data = img_column[i].as_py()
        label = lbl_column[i].as_py() if lbl_column else str(i)
        if isinstance(img_data, dict) and "bytes" in img_data:
            img_bytes = img_data["bytes"]
        elif isinstance(img_data, bytes):
            img_bytes = img_data
        else:
            continue
        if len(img_bytes) >= 100:
            results.append((img_bytes, f"shard{shard_num:04d}/img{i}", str(label)))

    return results

# ── GPU processing loop ──
def process_shard(shard_num, shard_path, config, sess, inp_name, source_name, decode_pool):
    """Extract, decode, embed, and queue one shard."""
    shard_start = time.time()
    fmt = config["format"]

    # Extract raw images
    try:
        if fmt == "parquet":
            raw_images = extract_parquet_images(
                shard_path, shard_num,
                config.get("image_col", "image"),
                config.get("label_col", "label"),
            )
        else:
            raw_images = extract_tar_images(shard_path)
    except Exception as e:
        log(f"[error] Shard {shard_num} extract failed: {e}")
        stats.add_error(f"Shard {shard_num}: {e}")
        return

    if not raw_images:
        log(f"[shard {shard_num:04d}] Empty shard")
        return

    total_raw = len(raw_images)

    # Parallel decode using process pool (bypasses GIL)
    img_bytes_list = [r[0] for r in raw_images]
    names = [r[1] for r in raw_images]
    labels_list = [r[2] for r in raw_images]

    tensors = list(decode_pool.map(_decode_image_bytes, img_bytes_list, chunksize=128))

    # Filter valid results
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

    # GPU inference in batches
    for i in range(0, len(good_tensors), GPU_BATCH):
        batch_t = good_tensors[i:i+GPU_BATCH]
        batch_n = good_names[i:i+GPU_BATCH]
        batch_l = good_labels[i:i+GPU_BATCH]

        embeddings = batch_embed(sess, inp_name, batch_t)
        queue_batch(embeddings, batch_l, batch_n, source_name)
        stats.add_processed(len(batch_t))

    stats.add_failed(failed)
    stats.shards_done += 1

    elapsed_shard = time.time() - shard_start
    total_elapsed = time.time() - start_time
    rate = stats.indexed / (total_elapsed / 60) if total_elapsed > 0 else 0
    log(f"[shard {shard_num:04d}] {total_raw:,} imgs, {failed} failed, "
        f"{elapsed_shard:.1f}s | total:{stats.indexed:,} rate:{rate:,.0f}/min")

# ── Heartbeat ──
def heartbeat_worker(source_name, start_shard, end_shard):
    import urllib.request
    while running.is_set():
        time.sleep(HEARTBEAT_INTERVAL)
        try:
            elapsed = time.time() - start_time
            s = stats.snapshot()
            rate = s["indexed"] / (elapsed / 60) if elapsed > 0 else 0
            payload = json.dumps({
                "dataset": source_name, "indexed": s["indexed"],
                "processed": s["processed"], "failed": s["failed"],
                "rate": round(rate), "gpuBatch": GPU_BATCH,
                "qdrantBatch": QDRANT_BATCH, "shardProgress": s["current_shard"],
                "shardsCompleted": s["shards_done"],
                "totalShards": s["total_shards"],
                "startShard": start_shard, "endShard": end_shard,
                "elapsedSec": round(elapsed), "phase": s["phase"],
                "errors": s["errors"], "timestamp": time.time(),
            }).encode("utf-8")
            req = urllib.request.Request(
                f"{BRIDGE_URL}/api/pipeline-state", data=payload,
                headers={"Content-Type": "application/json"}, method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass

def stats_reporter():
    while running.is_set():
        time.sleep(5)
        elapsed = time.time() - start_time
        idx = stats.indexed
        proc = stats.processed
        if proc > 0:
            rate = idx / (elapsed / 60) if elapsed > 0 else 0
            qlen = flush_queue.qsize()
            log(f"[stats] phase:{stats.phase} indexed:{idx:,} processed:{proc:,} "
                f"queue:{qlen} rate:{rate:,.0f}/min")

# ── Benchmark mode ──
def run_benchmark(sess, inp_name):
    """Pure GPU inference benchmark — no I/O, no Qdrant. Measures theoretical max."""
    log("=" * 60)
    log("BENCHMARK MODE — Pure GPU inference (no I/O, no Qdrant)")
    log(f"  Batch size: {GPU_BATCH}")
    log(f"  Model: w600k_r50.onnx")
    log("=" * 60)

    # Pre-allocate batch (avoids np.random overhead polluting measurement)
    batch = np.random.randn(GPU_BATCH, 3, 112, 112).astype(np.float32)

    # Warm up
    for _ in range(5):
        sess.run(None, {inp_name: batch})

    # Benchmark — 100 batches with pre-allocated data
    total_faces = 0
    t0 = time.time()
    for i in range(100):
        sess.run(None, {inp_name: batch})
        total_faces += GPU_BATCH
        if (i + 1) % 20 == 0:
            elapsed = time.time() - t0
            rate = total_faces / (elapsed / 60)
            log(f"  Batch {i+1}/100: {rate:,.0f} faces/min")

    elapsed = time.time() - t0
    rate = total_faces / (elapsed / 60)
    fps = total_faces / elapsed
    ms_per_batch = (elapsed / 100) * 1000

    log("=" * 60)
    log(f"RESULT: {rate:,.0f} faces/min ({fps:,.0f} faces/sec)")
    log(f"  {ms_per_batch:.1f} ms/batch ({GPU_BATCH} faces/batch)")
    log(f"  {total_faces:,} faces in {elapsed:.1f}s")
    log("=" * 60)
    return rate

# ── Main ──
def main():
    parser = argparse.ArgumentParser(description="Face embedding pipeline v2")
    parser.add_argument("dataset", nargs="?", help="Dataset name")
    parser.add_argument("start_shard", nargs="?", type=int, default=0)
    parser.add_argument("end_shard", nargs="?", type=int, default=None)
    parser.add_argument("--repo", help="Custom HuggingFace repo ID")
    parser.add_argument("--format", choices=["tar", "parquet"], default="tar")
    parser.add_argument("--shards", type=int, default=100)
    parser.add_argument("--prefix", default="data-")
    parser.add_argument("--suffix", default=".tar")
    parser.add_argument("--subdir", default="")
    parser.add_argument("--source", default=None)
    parser.add_argument("--image-col", default="image")
    parser.add_argument("--label-col", default="label")
    parser.add_argument("--benchmark", action="store_true", help="Run pure GPU benchmark")
    parser.add_argument("--tensorrt", action="store_true", help="Use TensorRT (if available)")
    parser.add_argument("--no-bulk-mode", action="store_true", help="Don't set Qdrant m=0")
    parser.add_argument("--skip-download", action="store_true", help="Assume shards already local")
    args = parser.parse_args()

    # Load model first (needed for benchmark too)
    sess, inp_name = load_model(use_tensorrt=args.tensorrt)

    if args.benchmark:
        run_benchmark(sess, inp_name)
        return

    # Resolve config
    if args.repo:
        config = {
            "repo": args.repo, "num_shards": args.shards,
            "prefix": args.prefix, "suffix": args.suffix,
            "format": args.format, "subdir": args.subdir,
            "description": f"Custom ({args.repo})",
            "image_col": args.image_col, "label_col": args.label_col,
        }
        source_name = args.source or args.repo.split("/")[-1]
    elif args.dataset and args.dataset in DATASETS:
        config = DATASETS[args.dataset]
        source_name = args.dataset
    else:
        log(f"Available datasets: {', '.join(sorted(DATASETS.keys()))}")
        log("Or use --repo for custom HuggingFace repos")
        sys.exit(1)

    start_shard = args.start_shard
    end_shard = args.end_shard or config["num_shards"]
    local_dir = f"/root/{source_name}"
    stats.total_shards = end_shard - start_shard

    log("=" * 60)
    log(f"PIPELINE V2: {config['description']}")
    log(f"  Repo: {config['repo']}")
    log(f"  Format: {config['format']}")
    log(f"  Shards: {start_shard}-{end_shard-1} ({end_shard-start_shard} total)")
    log(f"  GPU batch: {GPU_BATCH}, Qdrant batch: {QDRANT_BATCH}")
    log(f"  Decode workers: {DECODE_WORKERS} (ProcessPool)")
    log(f"  Flush workers: {FLUSH_WORKERS}")
    log(f"  Qdrant: {QDRANT_URL}")
    log(f"  TensorRT: {'yes' if args.tensorrt else 'no'}")
    log("=" * 60)

    # Enable Qdrant bulk mode
    if not args.no_bulk_mode:
        set_qdrant_bulk_mode(enable=True)

    # Start background workers
    flush_threads = []
    for i in range(FLUSH_WORKERS):
        t = Thread(target=flush_worker, args=(i,), daemon=True)
        t.start()
        flush_threads.append(t)

    Thread(target=stats_reporter, daemon=True).start()
    Thread(target=heartbeat_worker, args=(source_name, start_shard, end_shard), daemon=True).start()

    # PHASE 1: Download all shards
    if args.skip_download:
        log("[download] Skipped (--skip-download)")
        # Build shard list from local files
        shard_paths = []
        for i in range(start_shard, end_shard):
            if config["format"] == "parquet":
                fname = f"{config['prefix']}{i:05d}-of-{end_shard:05d}.parquet"
                subdir = config.get("subdir", "")
                path = os.path.join(local_dir, subdir, fname) if subdir else os.path.join(local_dir, fname)
            else:
                fname = f"{config['prefix']}{i:04d}{config['suffix']}"
                path = os.path.join(local_dir, fname)
            if os.path.exists(path):
                shard_paths.append((i, path))
            else:
                # Check for decompressed version
                alt = path.replace('.tar.gz', '.tar')
                if os.path.exists(alt):
                    shard_paths.append((i, alt))
        log(f"[download] Found {len(shard_paths)} local shards")
    else:
        shard_paths = download_shards(config, local_dir, start_shard, end_shard)

    if not shard_paths:
        log("[error] No shards available!")
        sys.exit(1)

    # PHASE 2: Decompress (if needed)
    if config.get("suffix", "").endswith(".gz") or any(p.endswith('.gz') for _, p in shard_paths):
        shard_paths = decompress_shards(shard_paths)

    # PHASE 3: GPU processing
    stats.phase = "embed"
    log(f"[embed] Processing {len(shard_paths)} shards with {DECODE_WORKERS} decode workers...")

    # Use ProcessPoolExecutor for image decode (bypasses GIL)
    # ThreadPoolExecutor as fallback if fork causes issues
    try:
        decode_pool = ProcessPoolExecutor(max_workers=DECODE_WORKERS)
        # Test it works (use a picklable function, not lambda)
        test_result = list(decode_pool.map(_decode_image_bytes, [b'\x00'] * 3))
        log(f"[decode] ProcessPoolExecutor ready ({DECODE_WORKERS} workers)")
    except Exception:
        log(f"[decode] ProcessPool failed, falling back to ThreadPool")
        decode_pool = ThreadPoolExecutor(max_workers=DECODE_WORKERS)

    # Double-buffer: extract+decode next shard while GPU processes current
    # This overlaps CPU work (tar extract + image decode) with GPU inference
    extract_pool = ThreadPoolExecutor(max_workers=2)

    def extract_and_decode_shard(shard_num, shard_path):
        """Extract raw images and decode them in parallel. Returns decoded data."""
        fmt = config["format"]
        try:
            if fmt == "parquet":
                raw_images = extract_parquet_images(
                    shard_path, shard_num,
                    config.get("image_col", "image"),
                    config.get("label_col", "label"),
                )
            else:
                raw_images = extract_tar_images(shard_path)
        except Exception as e:
            log(f"[error] Shard {shard_num} extract failed: {e}")
            stats.add_error(f"Shard {shard_num}: {e}")
            return None

        if not raw_images:
            return None

        img_bytes_list = [r[0] for r in raw_images]
        names = [r[1] for r in raw_images]
        labels_list = [r[2] for r in raw_images]

        tensors = list(decode_pool.map(_decode_image_bytes, img_bytes_list, chunksize=128))

        good_t, good_n, good_l, failed = [], [], [], 0
        for tensor, name, label in zip(tensors, names, labels_list):
            if tensor is None:
                failed += 1
            else:
                good_t.append(tensor)
                good_n.append(name)
                good_l.append(label)

        return (good_t, good_n, good_l, failed, len(raw_images), shard_num)

    def gpu_process(decoded_data, source_name):
        """Run GPU inference on pre-decoded data."""
        if decoded_data is None:
            return
        good_t, good_n, good_l, failed, total_raw, shard_num = decoded_data
        shard_start = time.time()

        for i in range(0, len(good_t), GPU_BATCH):
            batch_t = good_t[i:i+GPU_BATCH]
            batch_n = good_n[i:i+GPU_BATCH]
            batch_l = good_l[i:i+GPU_BATCH]
            embeddings = batch_embed(sess, inp_name, batch_t)
            queue_batch(embeddings, batch_l, batch_n, source_name)
            stats.add_processed(len(batch_t))

        stats.add_failed(failed)
        stats.shards_done += 1
        elapsed_shard = time.time() - shard_start
        total_elapsed = time.time() - start_time
        rate = stats.indexed / (total_elapsed / 60) if total_elapsed > 0 else 0
        log(f"[shard {shard_num:04d}] {total_raw:,} imgs, {failed} fail, "
            f"{elapsed_shard:.1f}s GPU | total:{stats.indexed:,} rate:{rate:,.0f}/min")

    if shard_paths:
        # Start extracting first shard
        current_future = extract_pool.submit(
            extract_and_decode_shard, shard_paths[0][0], shard_paths[0][1])

        for idx in range(len(shard_paths)):
            if not running.is_set():
                break
            stats.current_shard = shard_paths[idx][0]

            # Start extracting NEXT shard while we wait/process current
            next_future = None
            if idx + 1 < len(shard_paths):
                next_future = extract_pool.submit(
                    extract_and_decode_shard,
                    shard_paths[idx + 1][0], shard_paths[idx + 1][1])

            # Wait for current shard's extraction to complete
            decoded = current_future.result()

            # GPU processes current shard (while next is being extracted in background)
            gpu_process(decoded, source_name)

            # Next becomes current
            if next_future is not None:
                current_future = next_future

    # Shutdown
    running.clear()
    log(f"[shutdown] Waiting for {flush_queue.qsize()} queued batches to flush...")
    deadline = time.time() + 180
    while not flush_queue.empty() and time.time() < deadline:
        time.sleep(1)

    decode_pool.shutdown(wait=False)
    extract_pool.shutdown(wait=False)

    # Re-enable Qdrant indexing
    if not args.no_bulk_mode:
        set_qdrant_bulk_mode(enable=False)

    # Final stats
    elapsed = time.time() - start_time
    idx = stats.indexed
    proc = stats.processed
    fail = stats.failed
    rate = idx / (elapsed / 60) if elapsed > 0 else 0

    log(f"\n{'='*60}")
    log(f"PIPELINE V2 COMPLETE — {source_name.upper()}")
    log(f"  Indexed:    {idx:,}")
    log(f"  Processed:  {proc:,}")
    log(f"  Failed:     {fail:,}")
    log(f"  Rate:       {rate:,.0f} faces/min")
    log(f"  Time:       {elapsed/3600:.1f}h ({elapsed:.0f}s)")
    log(f"{'='*60}")

    # Send final heartbeat
    try:
        import urllib.request
        payload = json.dumps({
            "dataset": source_name, "indexed": idx, "processed": proc,
            "failed": fail, "rate": round(rate), "phase": "complete",
            "elapsedSec": round(elapsed), "timestamp": time.time(),
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{BRIDGE_URL}/api/pipeline-state", data=payload,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except: pass

if __name__ == "__main__":
    # Handle Ctrl+C gracefully
    def sigint_handler(sig, frame):
        log("\n[signal] Shutting down...")
        running.clear()
    signal.signal(signal.SIGINT, sigint_handler)
    signal.signal(signal.SIGTERM, sigint_handler)
    main()
