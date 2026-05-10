// octoprint-recorder.js — record the print camera MJPEG to MP4 LOCALLY on the bridge
// Directive: dir_1778273179581 (original), dir_1778450259617 (dev-01 removal 2026-05-10)
//
// ffmpeg runs in the bridge container (apt package). It pulls the MJPEG stream
// from the tablet (http://10.9.0.7:5001/mjpeg) over WG, encodes H.264 MP4, and
// writes to /tmp/ozzu-rec/. On stop, the MP4 is moved into FILES_DIR/3d-prints/
// and registered in the postgres files table under the "3D Prints" folder.
//
// dev-01 is no longer in the recorder path — King Kazuma's standing rule that
// dev-01 must NOT be in the print pipeline applies here too. This was the same
// anti-pattern as the slicer fix (dir_1778425211161 / commit da077176).

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const LOCAL_REC_DIR = process.env.OCTOPRINT_REC_LOCAL_DIR || "/tmp/ozzu-rec";
const MJPEG_URL = process.env.OCTOPRINT_MJPEG_URL || "http://10.9.0.7:5001/mjpeg";
const FOLDER_NAME = process.env.OCTOPRINT_REC_FOLDER || "3D Prints";
const FILES_DIR = "/home/gcp/ozzu/data/files";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

let _state = null; // { jobName, tmpPath, pid, startedAt, directiveId, ffmpegLogPath }

function startRecording(opts = {}) {
  if (_state && _state.pid) {
    return { ok: false, reason: "already_recording", state: _state };
  }
  const jobName = (opts.jobName || `print-${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const tmpPath = path.join(LOCAL_REC_DIR, `${jobName}.mp4`);
  const logPath = path.join(LOCAL_REC_DIR, `${jobName}.log`);

  fs.mkdirSync(LOCAL_REC_DIR, { recursive: true });

  // Open log file before spawn so ffmpeg's stderr is captured
  const logFd = fs.openSync(logPath, "a");

  // ffmpeg flags:
  // -r N : capture at N fps (timelapse-friendly)
  // -i URL : MJPEG stream
  // -c:v libx264 -preset veryfast -crf 23 : H.264 fast encode for social media
  // -pix_fmt yuv420p -movflags +faststart : iOS/web compatibility
  // -y : overwrite existing file (in case of retry)
  const fps = parseInt(opts.fps || "10", 10);
  const args = [
    "-y",
    "-r", String(fps),
    "-i", MJPEG_URL,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    tmpPath,
  ];

  const child = spawn(FFMPEG_BIN, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  // Detach so ffmpeg keeps running if bridge restarts (parent disowns the child)
  child.unref();

  _state = {
    jobName,
    tmpPath,
    pid: child.pid,
    startedAt: Date.now(),
    directiveId: opts.directiveId || null,
    ffmpegLogPath: logPath,
  };
  return { ok: true, state: _state };
}

async function stopRecording(opts = {}) {
  if (!_state) {
    return { ok: false, reason: "not_recording" };
  }

  const { jobName, tmpPath, pid, directiveId } = _state;

  // Send SIGINT so ffmpeg flushes the moov atom and closes the file cleanly.
  // Then SIGTERM after 2s if still alive.
  try {
    if (pid) {
      try { process.kill(pid, "SIGINT"); } catch (_) {}
      await new Promise(r => setTimeout(r, 2000));
      try { process.kill(pid, "SIGTERM"); } catch (_) {}
    }
  } catch (_) {}

  // Verify file exists + has size
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(tmpPath).size;
  } catch (_) {}

  if (sizeBytes < 1024) {
    _state = null;
    // Best-effort cleanup of empty/tiny file
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return { ok: false, reason: "empty_recording", tmpPath };
  }

  // Move file into FILES_DIR/3d-prints/<date>/<timestamp>_<jobName>.mp4
  const dateDir = new Date().toISOString().slice(0, 10);
  const folderId = await ensureFolderId(opts.db);
  const localDir = path.join(FILES_DIR, "3d-prints", dateDir);
  fs.mkdirSync(localDir, { recursive: true });
  const localFile = `${Date.now()}_${jobName}.mp4`;
  const localPath = path.join(localDir, localFile);

  // Try rename (fast if same filesystem); fall back to copy+unlink across mounts
  try {
    fs.renameSync(tmpPath, localPath);
  } catch (e) {
    fs.copyFileSync(tmpPath, localPath);
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }

  // Cleanup ffmpeg log
  try { fs.unlinkSync(_state.ffmpegLogPath); } catch (_) {}

  // Register in files DB
  let dbRow = null;
  if (opts.db) {
    try {
      const r = await opts.db.query(
        `INSERT INTO files (filename, mime_type, size_bytes, source, category, storage_path, folder_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          `${jobName}.mp4`,
          "video/mp4",
          sizeBytes,
          "octoprint",
          "3d-prints",
          localPath,
          folderId,
          JSON.stringify({ jobName, directiveId, startedAt: _state.startedAt, durationSec: Math.round((Date.now() - _state.startedAt) / 1000) }),
        ],
      );
      dbRow = r.rows[0];
    } catch (e) {
      // Non-fatal — file is on disk
    }
  }

  const result = {
    ok: true,
    jobName,
    localPath,
    sizeBytes,
    file: dbRow,
    durationSec: Math.round((Date.now() - _state.startedAt) / 1000),
    directiveId,
  };
  _state = null;
  return result;
}

async function ensureFolderId(db) {
  if (!db) return null;
  try {
    const r = await db.query(
      `SELECT id FROM file_folders WHERE name = $1 AND parent_id IS NULL LIMIT 1`,
      [FOLDER_NAME],
    );
    if (r.rows.length > 0) return r.rows[0].id;
    const ins = await db.query(
      `INSERT INTO file_folders (name, parent_id) VALUES ($1, NULL) RETURNING id`,
      [FOLDER_NAME],
    );
    return ins.rows[0].id;
  } catch (_) {
    return null;
  }
}

function status() {
  if (!_state) return { recording: false };
  return {
    recording: true,
    jobName: _state.jobName,
    startedAt: _state.startedAt,
    durationSec: Math.round((Date.now() - _state.startedAt) / 1000),
    directiveId: _state.directiveId,
  };
}

module.exports = { startRecording, stopRecording, status };
