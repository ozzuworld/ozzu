// routes/files.js — Personal file storage (Dropbox-style) + bridge temp share

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const FILES_DIR = "/home/gcp/ozzu/data/files";
const TEMP_DIR = "/tmp/ozzu-bridge/shared";

module.exports = function createFileRoutes(ctx) {
  const { log, sendJSON, parseBody, db } = ctx;

  // Ensure dirs exist
  for (const dir of [FILES_DIR, TEMP_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  return async function handleFileRoutes(req, res, pathname, url) {

    // POST /files — Upload a file to personal storage
    if (req.method === "POST" && pathname === "/files") {
      try {
        const body = await parseBody(req);
        const { data, filename, mime_type, source, category, metadata } = body;
        if (!data) return sendJSON(res, 400, { error: "Missing data (base64)" });

        const fname = filename || `file_${Date.now()}.jpg`;
        const mime = mime_type || "image/jpeg";
        const cat = category || "photos";
        const src = source || "upload";

        // Save to disk
        const dateDir = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const saveDir = path.join(FILES_DIR, cat, dateDir);
        fs.mkdirSync(saveDir, { recursive: true });
        const savePath = path.join(saveDir, `${Date.now()}_${fname}`);
        const buf = Buffer.from(data, "base64");
        fs.writeFileSync(savePath, buf);

        // Insert into DB
        const result = await db.query(
          `INSERT INTO files (filename, mime_type, size_bytes, source, category, storage_path, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [fname, mime, buf.length, src, cat, savePath, JSON.stringify(metadata || {})]
        );

        log.bridge.info(`File saved: ${savePath} (${buf.length} bytes, ${cat}/${src})`);
        return sendJSON(res, 201, { ok: true, file: result.rows[0] });
      } catch (e) {
        log.bridge.error(`File upload error: ${e.message}`);
        return sendJSON(res, 500, { error: e.message });
      }
    }

    // GET /files — List files with optional filters
    if (req.method === "GET" && pathname === "/files") {
      try {
        const cat = url.searchParams.get("category");
        const src = url.searchParams.get("source");
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const offset = parseInt(url.searchParams.get("offset") || "0");

        let query = "SELECT id, filename, mime_type, size_bytes, source, category, metadata, is_temp, created_at FROM files WHERE 1=1";
        const params = [];
        let idx = 1;

        if (cat) { query += ` AND category = $${idx++}`; params.push(cat); }
        if (src) { query += ` AND source = $${idx++}`; params.push(src); }
        query += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
        params.push(limit, offset);

        const result = await db.query(query, params);
        const countResult = await db.query("SELECT COUNT(*) FROM files");

        return sendJSON(res, 200, {
          files: result.rows,
          total: parseInt(countResult.rows[0].count),
        });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }

    // GET /files/:id — Get file metadata
    if (req.method === "GET" && pathname.match(/^\/files\/(\d+)$/)) {
      const id = pathname.split("/")[2];
      try {
        const result = await db.query("SELECT * FROM files WHERE id = $1", [id]);
        if (result.rows.length === 0) return sendJSON(res, 404, { error: "File not found" });
        return sendJSON(res, 200, { file: result.rows[0] });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }

    // GET /files/:id/data — Serve the actual file
    if (req.method === "GET" && pathname.match(/^\/files\/(\d+)\/data$/)) {
      const id = pathname.split("/")[2];
      try {
        const result = await db.query("SELECT storage_path, mime_type, filename FROM files WHERE id = $1", [id]);
        if (result.rows.length === 0) return sendJSON(res, 404, { error: "File not found" });

        const { storage_path, mime_type, filename } = result.rows[0];
        if (!fs.existsSync(storage_path)) return sendJSON(res, 404, { error: "File data missing" });

        const stat = fs.statSync(storage_path);
        res.writeHead(200, {
          "Content-Type": mime_type,
          "Content-Length": stat.size,
          "Content-Disposition": `inline; filename="${filename}"`,
          "Cache-Control": "max-age=3600",
          ...ctx.CORS_HEADERS,
        });
        fs.createReadStream(storage_path).pipe(res);
        return true;
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }

    // DELETE /files/:id — Delete a file
    if (req.method === "DELETE" && pathname.match(/^\/files\/(\d+)$/)) {
      const id = pathname.split("/")[2];
      try {
        const result = await db.query("SELECT storage_path FROM files WHERE id = $1", [id]);
        if (result.rows.length === 0) return sendJSON(res, 404, { error: "File not found" });

        // Delete from disk
        const { storage_path } = result.rows[0];
        if (fs.existsSync(storage_path)) fs.unlinkSync(storage_path);

        // Delete from DB
        await db.query("DELETE FROM files WHERE id = $1", [id]);
        return sendJSON(res, 200, { ok: true });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }

    // POST /files/bridge-share — Temporary share (auto-expires in 24h)
    if (req.method === "POST" && pathname === "/files/bridge-share") {
      try {
        const body = await parseBody(req);
        const { data, filename } = body;
        if (!data) return sendJSON(res, 400, { error: "Missing data (base64)" });

        const token = crypto.randomBytes(8).toString("hex");
        const fname = filename || `share_${Date.now()}.jpg`;
        const savePath = path.join(TEMP_DIR, `${token}_${fname}`);
        const buf = Buffer.from(data, "base64");
        fs.writeFileSync(savePath, buf);

        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const result = await db.query(
          `INSERT INTO files (filename, mime_type, size_bytes, source, category, storage_path, is_temp, expires_at)
           VALUES ($1, $2, $3, 'bridge', 'temp', $4, true, $5) RETURNING id`,
          [fname, "image/jpeg", buf.length, savePath, expiresAt]
        );

        const shareUrl = `/files/${result.rows[0].id}/data`;
        log.bridge.info(`Bridge share created: ${shareUrl} (expires ${expiresAt.toISOString()})`);
        return sendJSON(res, 201, { ok: true, shareUrl, fileId: result.rows[0].id, expiresAt });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }

    // POST /files/send-to-intel — Upload photo for VIP face identification
    if (req.method === "POST" && pathname === "/files/send-to-intel") {
      try {
        const body = await parseBody(req);
        const { data, label } = body;
        if (!data) return sendJSON(res, 400, { error: "Missing data (base64)" });

        // Save to files DB as intel category
        const fname = `intel_${Date.now()}.jpg`;
        const saveDir = path.join(FILES_DIR, "intel");
        fs.mkdirSync(saveDir, { recursive: true });
        const savePath = path.join(saveDir, fname);
        const buf = Buffer.from(data, "base64");
        fs.writeFileSync(savePath, buf);

        await db.query(
          `INSERT INTO files (filename, mime_type, size_bytes, source, category, storage_path, metadata)
           VALUES ($1, 'image/jpeg', $2, 'glasses', 'intel', $3, $4)`,
          [fname, buf.length, savePath, JSON.stringify({ label: label || "unknown", status: "pending" })]
        );

        // Trigger OSINT face scan — upload to OSINT profiles + start scan
        let scanResult = null;
        try {
          // Upload as OSINT profile image
          const osint = ctx.osintEngine;
          if (osint && typeof osint.uploadImage === "function") {
            const profile = await osint.uploadImage(label || "VIP Capture", data, fname);
            if (profile && profile.id) {
              scanResult = await osint.triggerScan(profile.id, "face-search");
            }
          }
        } catch (osintErr) {
          log.bridge.warn(`Intel OSINT scan failed: ${osintErr.message}`);
        }

        // Also try direct face search via Qdrant
        let faceMatches = [];
        try {
          const faceApiUrl = "http://127.0.0.1:5555";
          const FormData = require("form-data");
          const formData = new FormData();
          formData.append("image", buf, { filename: fname, contentType: "image/jpeg" });
          formData.append("threshold", "0.5");
          formData.append("limit", "10");

          const http = require("http");
          const searchResult = await new Promise((resolve, reject) => {
            const options = {
              hostname: "127.0.0.1",
              port: 5555,
              path: "/search",
              method: "POST",
              headers: formData.getHeaders(),
              timeout: 15000,
            };
            const req = http.request(options, (res) => {
              let data = "";
              res.on("data", (c) => data += c);
              res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
            });
            req.on("error", () => resolve(null));
            req.on("timeout", () => { req.destroy(); resolve(null); });
            formData.pipe(req);
          });

          if (searchResult && searchResult.results) {
            faceMatches = searchResult.results.slice(0, 10);
          }
        } catch (faceErr) {
          log.bridge.warn(`Direct face search failed: ${faceErr.message}`);
        }

        log.bridge.info(`Intel scan: ${faceMatches.length} face matches found`);
        return sendJSON(res, 200, {
          ok: true,
          matches: faceMatches,
          osintScan: scanResult,
          message: faceMatches.length > 0
            ? `Found ${faceMatches.length} potential matches`
            : "No matches found — face saved for future identification",
        });
      } catch (e) {
        log.bridge.error(`Intel upload error: ${e.message}`);
        return sendJSON(res, 500, { error: e.message });
      }
    }

    return false; // not handled
  };
};
