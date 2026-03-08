#!/usr/bin/env python3
"""
MS1MV2 (MS1M-ArcFace) → Qdrant pipeline.
MXNet RecordIO format: train.rec + train.idx + property
5.8M images, 85K identities, pre-aligned 112x112.

Download from: https://huggingface.co/datasets/gaunernst/ms1mv3-recordio
  (or Kaggle: https://www.kaggle.com/datasets/rookie11/ms1m-arcface)

Usage: python3 embed-ms1mv2.py /path/to/ms1mv2/
  The directory should contain: train.rec, train.idx, property
"""
import os, sys, uuid, time, io, traceback, struct
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
            if proc > 0:
                rate = idx / (elapsed / 60) if elapsed > 0 else 0
                qlen = len(insert_queue)
                log(f"[stats] indexed:{idx:,} processed:{proc:,} "
                    f"fail:{fail:,} queue:{qlen:,} "
                    f"rate:{rate:,.0f}/min {elapsed:.0f}s")
        except Exception as e:
            log(f"[flush error] {e}")
            traceback.print_exc()

def queue_point(embedding, label, idx_num):
    from qdrant_client.models import PointStruct
    fid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"ms1mv2/{idx_num}"))
    point = PointStruct(
        id=fid, vector=embedding.tolist(),
        payload={"source_url": f"ms1mv2/img_{idx_num}",
                 "source_platform": "ms1mv2",
                 "label": str(label), "det_score": 1.0},
    )
    with queue_lock:
        insert_queue.append(point)
    if len(insert_queue) >= QDRANT_BATCH:
        flush_queue()

# ---- Pure-Python RecordIO reader (no mxnet dependency) ----
# RecordIO format: 4-byte magic + 4-byte length/flag, then data
# Header inside each record: flag(4) + label(float32 or float64) + id(4) + id2(4)

RECORDIO_MAGIC = 0xced7230a

def read_idx_file(idx_path):
    """Read .idx file → list of (index, offset) pairs."""
    indices = []
    with open(idx_path, "r") as f:
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) == 2:
                indices.append((int(parts[0]), int(parts[1])))
    return indices

def read_record(rec_file, offset):
    """Read a single record from .rec file at given offset."""
    rec_file.seek(offset)
    # Read 8-byte header: magic(4) + lrecord(4)
    header = rec_file.read(8)
    if len(header) < 8:
        return None, None
    magic, lrecord = struct.unpack("<II", header)

    # Handle multi-part records
    cflag = (lrecord >> 29) & 7
    length = lrecord & ((1 << 29) - 1)

    if cflag == 0:
        # Normal record
        data = rec_file.read(length)
    elif cflag == 1:
        # Start of multi-part
        parts = [rec_file.read(length)]
        while True:
            pad = (4 - (length % 4)) % 4
            rec_file.seek(pad, 1)
            h2 = rec_file.read(8)
            if len(h2) < 8:
                break
            _, l2 = struct.unpack("<II", h2)
            cf2 = (l2 >> 29) & 7
            ln2 = l2 & ((1 << 29) - 1)
            parts.append(rec_file.read(ln2))
            if cf2 == 2:  # End of multi-part
                break
        data = b"".join(parts)
    else:
        return None, None

    # Parse IRHeader: flag(4) + label(float32) + id(4) + id2(4) = 16 bytes min
    # But MXNet uses: flag(4) + float32_or_float64 label + id(4) + id2(4)
    # Standard: struct IRHeader { uint32 flag; float label; uint32 id; uint32 id2; }
    if len(data) < 16:
        return None, None

    flag = struct.unpack("<I", data[0:4])[0]
    # flag==0: single float32 label, flag==2: two float64 labels
    if flag == 0:
        label = struct.unpack("<f", data[4:8])[0]
        img_data = data[16:]  # skip 16 byte header
    else:
        # flag indicates how many float64 labels follow
        # Common: flag=2 means 2 x float64 = 16 bytes of labels
        n_labels = flag
        label_bytes = n_labels * 8
        header_size = 4 + label_bytes + 8  # flag + labels + id + id2
        if len(data) < header_size:
            return None, None
        label = struct.unpack("<d", data[4:12])[0]  # first label
        img_data = data[header_size:]

    return int(label), img_data

def process_recordio(data_dir, sess, inp_name, start_idx=0, end_idx=None):
    """Process RecordIO dataset."""
    idx_path = os.path.join(data_dir, "train.idx")
    rec_path = os.path.join(data_dir, "train.rec")
    prop_path = os.path.join(data_dir, "property")

    if not os.path.exists(rec_path):
        log(f"[error] {rec_path} not found")
        return

    # Read property file
    if os.path.exists(prop_path):
        with open(prop_path) as f:
            prop = f.read().strip()
        log(f"[ms1mv2] Property: {prop}")

    # Read index
    indices = read_idx_file(idx_path)
    log(f"[ms1mv2] Index entries: {len(indices):,}")

    # Index 0 is the header record — skip it
    # The header contains: label[0]=total_images+1, label[1]=total_images+n_classes
    # Actual images start from index 1

    if end_idx is None:
        end_idx = len(indices)
    end_idx = min(end_idx, len(indices))

    # Skip header (index 0)
    actual_start = max(start_idx, 1)
    total = end_idx - actual_start
    log(f"[ms1mv2] Processing indices {actual_start}-{end_idx-1} ({total:,} records)")

    batch_tensors = []
    batch_labels = []
    batch_idxs = []
    processed_in_batch = 0

    with open(rec_path, "rb") as rec_file:
        for i in range(actual_start, end_idx):
            rec_idx, offset = indices[i]

            try:
                label, img_data = read_record(rec_file, offset)
                if label is None or img_data is None or len(img_data) < 100:
                    with stats_lock:
                        stats["skipped"] += 1
                    continue

                img = Image.open(io.BytesIO(img_data)).convert("RGB")
                arr = np.array(img)[:, :, ::-1].copy()  # RGB->BGR
                tensor = preprocess(arr)

                batch_tensors.append(tensor)
                batch_labels.append(label)
                batch_idxs.append(rec_idx)

                with stats_lock:
                    stats["processed"] += 1

                if len(batch_tensors) >= GPU_BATCH:
                    embeddings = batch_embed(sess, inp_name, batch_tensors)
                    for emb, lbl, idx_n in zip(embeddings, batch_labels, batch_idxs):
                        queue_point(emb, lbl, idx_n)
                    batch_tensors.clear()
                    batch_labels.clear()
                    batch_idxs.clear()

                processed_in_batch += 1
                if processed_in_batch % 100000 == 0:
                    elapsed = time.time() - start_time
                    with stats_lock:
                        idx = stats["indexed"]
                    rate = idx / (elapsed / 60) if elapsed > 0 else 0
                    log(f"[progress] {processed_in_batch:,}/{total:,} "
                        f"indexed:{idx:,} rate:{rate:,.0f}/min")

            except Exception as e:
                with stats_lock:
                    stats["failed"] += 1

    # Remaining batch
    if batch_tensors:
        try:
            embeddings = batch_embed(sess, inp_name, batch_tensors)
            for emb, lbl, idx_n in zip(embeddings, batch_labels, batch_idxs):
                queue_point(emb, lbl, idx_n)
        except Exception as e:
            log(f"[error] Final batch: {e}")
            with stats_lock:
                stats["failed"] += len(batch_tensors)

    flush_queue()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        log("Usage: python3 embed-ms1mv2.py /path/to/ms1mv2/ [start_idx] [end_idx]")
        log("  Directory should contain: train.rec, train.idx, property")
        sys.exit(1)

    data_dir = sys.argv[1]
    start_idx = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    end_idx = int(sys.argv[3]) if len(sys.argv) > 3 else None

    log(f"[ms1mv2] Data dir: {data_dir}")
    log(f"[ms1mv2] Direct embed, GPU batch={GPU_BATCH}, Qdrant batch={QDRANT_BATCH}")

    sess, inp_name = load_rec_model()

    ft = Thread(target=flush_loop, daemon=True)
    ft.start()

    process_recordio(data_dir, sess, inp_name, start_idx, end_idx)

    running.clear()
    flush_queue()
    elapsed = time.time() - start_time
    with stats_lock:
        idx = stats["indexed"]
        proc = stats["processed"]
        fail = stats["failed"]
    rate = idx / (elapsed / 60) if elapsed > 0 else 0
    log(f"\n{'='*60}")
    log(f"MS1MV2 COMPLETE")
    log(f"  Indexed:    {idx:,}")
    log(f"  Processed:  {proc:,}")
    log(f"  Failed:     {fail:,}")
    log(f"  Rate:       {rate:,.0f} faces/min")
    log(f"  Time:       {elapsed/3600:.1f}h")
    log(f"{'='*60}")
