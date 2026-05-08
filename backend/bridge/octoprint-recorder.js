// octoprint-recorder.js — record the print camera MJPEG to MP4 via dev-01 ffmpeg
// Directive: dir_1778273179581
//
// dev-01 has ffmpeg + a fast disk. Bridge spawns ffmpeg there to pull the
// MJPEG stream from the tablet (http://10.9.0.7:5001/mjpeg), encode H.264
// MP4, and write to /tmp/ozzu-rec/. On stop, the MP4 is rsync'd back to the
// bridge's FILES_DIR and registered in the files DB under the
// "3D Prints" folder.

"use strict";

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SSH_HOST = process.env.OCTOPRINT_SLICE_HOST || "dev-01";
const SSH_KEY = process.env.OCTOPRINT_SLICE_SSH_KEY || "/root/.ssh/dev01_key";
const REMOTE_DIR = process.env.OCTOPRINT_REC_REMOTE_DIR || "/tmp/ozzu-rec";
const MJPEG_URL = process.env.OCTOPRINT_MJPEG_URL || "http://10.9.0.7:5001/mjpeg";
const FOLDER_NAME = process.env.OCTOPRINT_REC_FOLDER || "3D Prints";
const FILES_DIR = "/home/gcp/ozzu/data/files";

let _state = null; // { jobName, remotePath, localPath, sshPid, startedAt, directiveId }

function sshArgs() {
  const userHost = SSH_HOST.includes("@") ? SSH_HOST : `hadmin@${SSH_HOST}`;
  return [
    "-i", SSH_KEY,
    "-o", "StrictHostKeyChecking=no",
    "-o", "IdentitiesOnly=yes",
    userHost,
  ];
}

function sshSync(cmd) {
  return execSync(
    `ssh ${sshArgs().join(" ")} '${cmd.replace(/'/g, "'\\''")}'`,
    { encoding: "utf8" },
  );
}

function startRecording(opts = {}) {
  if (_state && _state.sshPid) {
    return { ok: false, reason: "already_recording", state: _state };
  }
  const jobName = (opts.jobName || `print-${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, "_");
  const remotePath = `${REMOTE_DIR}/${jobName}.mp4`;

  // Make remote dir + start ffmpeg in background. Keep stderr to a logfile.
  sshSync(`mkdir -p ${REMOTE_DIR}`);

  // ffmpeg flags:
  // -re : read at native rate
  // -f mjpeg : format hint (server identifies as multipart, ffmpeg auto-detects too,
  //            but giving a hint avoids probing delays)
  // -i URL : MJPEG stream
  // -c:v libx264 -preset veryfast : H.264 fast encode for social media
  // -pix_fmt yuv420p : QuickTime/iOS compatibility
  // -movflags +faststart : web playback
  const fps = parseInt(opts.fps || "10", 10); // 10 fps is plenty for a print timelapse
  const ffmpegCmd = [
    "ffmpeg -y",
    `-r ${fps}`,
    `-i '${MJPEG_URL}'`,
    "-c:v libx264 -preset veryfast -crf 23",
    "-pix_fmt yuv420p -movflags +faststart",
    `'${remotePath}' > ${REMOTE_DIR}/${jobName}.log 2>&1 &`,
    `echo $!`,
  ].join(" ");

  const pidOut = sshSync(`bash -c "${ffmpegCmd.replace(/"/g, '\\"')}"`);
  const remotePid = parseInt(pidOut.trim().split("\n").pop(), 10) || null;

  _state = {
    jobName,
    remotePath,
    localPath: null,
    remotePid,
    startedAt: Date.now(),
    directiveId: opts.directiveId || null,
  };
  return { ok: true, state: _state };
}

async function stopRecording(opts = {}) {
  if (!_state || !_state.remotePid) {
    return { ok: false, reason: "not_recording" };
  }

  const { jobName, remotePath, remotePid, directiveId } = _state;

  // Send SIGINT so ffmpeg flushes the moov atom and closes the file cleanly.
  try {
    sshSync(`kill -INT ${remotePid} 2>/dev/null || true; sleep 2; kill -TERM ${remotePid} 2>/dev/null || true`);
  } catch (_) {}

  // Verify file exists + has size
  let remoteStatRaw = "";
  try {
    remoteStatRaw = sshSync(`stat -c '%s' ${remotePath} 2>/dev/null || echo 0`);
  } catch (_) {}
  const sizeBytes = parseInt(remoteStatRaw.trim(), 10) || 0;
  if (sizeBytes < 1024) {
    _state = null;
    return { ok: false, reason: "empty_recording", remotePath };
  }

  // Pull file to bridge
  const dateDir = new Date().toISOString().slice(0, 10);
  const folderId = await ensureFolderId(opts.db);
  // Save under the 3D Prints folder. Files API expects FILES_DIR/<category>/<date>/<filename>.
  const localDir = path.join(FILES_DIR, "3d-prints", dateDir);
  fs.mkdirSync(localDir, { recursive: true });
  const localFile = `${Date.now()}_${jobName}.mp4`;
  const localPath = path.join(localDir, localFile);
  execSync(
    `scp -i ${SSH_KEY} -o StrictHostKeyChecking=no -o IdentitiesOnly=yes ${SSH_HOST.includes("@") ? SSH_HOST : `hadmin@${SSH_HOST}`}:${remotePath} ${localPath}`,
    { encoding: "utf8" },
  );

  // Remote cleanup
  try { sshSync(`rm -f ${remotePath} ${REMOTE_DIR}/${jobName}.log`); } catch (_) {}

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
