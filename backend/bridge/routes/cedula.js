"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function cedulaRoutes(ctx) {
  const {
    sendJSON,
    parseBody,
    db,
    log,
    cosineSimilarity,
    osintEngine,
  } = ctx;

  const FACE_SERVICE_URL = "http://127.0.0.1:5555";

  return async function(req, res, pathname, url) {

    // ── Cédula Face DB Endpoints ──

    // POST /cedula-db/import — bulk import cédulas with photos
    if (req.method === "POST" && pathname === "/cedula-db/import") {
      try {
        const body = await parseBody(req);
        const records = body.records || [body]; // single or array
        const results = [];
        for (const rec of records) {
          if (!rec.cedula) { results.push({ cedula: null, error: "missing cedula" }); continue; }
          let embedding = null;
          let photoPath = null;
          // Get face embedding from photo
          if (rec.photoBase64) {
            try {
              const embedRes = await fetch(`${FACE_SERVICE_URL}/embed`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ base64_image: rec.photoBase64 }),
                signal: AbortSignal.timeout(30000),
              });
              const embedData = await embedRes.json();
              if (embedData.faces && embedData.faces.length > 0) {
                embedding = embedData.faces[0].embedding;
              }
            } catch (e) {
              log.bridge.warn(`Face embed failed for cedula ${rec.cedula}:`, e.message);
            }
            // Save photo to disk
            const photoDir = "/tmp/osint-data/cedula-photos";
            fs.mkdirSync(photoDir, { recursive: true });
            photoPath = path.join(photoDir, `${rec.cedula}.jpg`);
            fs.writeFileSync(photoPath, Buffer.from(rec.photoBase64, "base64"));
          }
          const row = await db.upsertCedulaFace(rec.cedula, rec.fullName || null, photoPath, embedding, rec.metadata || {});
          results.push({ cedula: rec.cedula, id: row?.id, hasEmbedding: !!embedding });
        }
        sendJSON(res, 200, { ok: true, imported: results.length, results });
      } catch (err) {
        log.bridge.error("Cédula import error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /cedula-db/list — paginated list
    if (req.method === "GET" && pathname === "/cedula-db/list") {
      try {
        const limit = parseInt(url.searchParams.get("limit") || "100");
        const offset = parseInt(url.searchParams.get("offset") || "0");
        const rows = await db.getCedulaFaces(limit, offset);
        sendJSON(res, 200, { ok: true, count: rows.length, records: rows });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /cedula-db/:cedula — get single record
    // DELETE /cedula-db/:cedula — remove record
    const cedulaGetMatch = pathname.match(/^\/cedula-db\/(\d+)$/);

    if (req.method === "GET" && cedulaGetMatch) {
      try {
        const row = await db.getCedulaFace(cedulaGetMatch[1]);
        if (!row) { sendJSON(res, 404, { error: "Not found" }); return true; }
        sendJSON(res, 200, row);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    if (req.method === "DELETE" && cedulaGetMatch) {
      try {
        const deleted = await db.deleteCedulaFace(cedulaGetMatch[1]);
        sendJSON(res, 200, { ok: deleted });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /cedula-db/search-face — upload face photo, find matching cédula
    if (req.method === "POST" && pathname === "/cedula-db/search-face") {
      try {
        const body = await parseBody(req);
        if (!body.photoBase64) {
          sendJSON(res, 400, { error: "Missing photoBase64" });
          return true;
        }
        // Get face embedding from the search photo
        const embedRes = await fetch(`${FACE_SERVICE_URL}/detect-and-embed`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ base64_image: body.photoBase64 }),
          signal: AbortSignal.timeout(15000),
        });
        const embedData = await embedRes.json();
        if (!embedData.faces || embedData.faces.length === 0) {
          sendJSON(res, 200, { matches: [], message: "No face detected in photo" });
          return true;
        }
        const searchEmb = embedData.faces[0].embedding;
        // Brute-force cosine search against all stored embeddings
        const allFaces = await db.getAllCedulaEmbeddings();
        const threshold = parseFloat(body.threshold || "0.4");
        const matches = [];
        for (const face of allFaces) {
          if (!face.embedding || face.embedding.length !== 512) continue;
          const sim = cosineSimilarity(searchEmb, face.embedding);
          if (sim >= threshold) {
            matches.push({
              cedula: face.cedula,
              fullName: face.full_name,
              similarity: Math.round(sim * 10000) / 10000,
              id: face.id,
            });
          }
        }
        matches.sort((a, b) => b.similarity - a.similarity);
        sendJSON(res, 200, {
          matches: matches.slice(0, 10),
          totalSearched: allFaces.length,
          facesDetected: embedData.faces.length,
        });
      } catch (err) {
        log.bridge.error("Cédula face search error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /cedula-db/scan-match — search face + auto-trigger OSINT scan
    if (req.method === "POST" && pathname === "/cedula-db/scan-match") {
      try {
        const body = await parseBody(req);
        if (!body.photoBase64) {
          sendJSON(res, 400, { error: "Missing photoBase64" });
          return true;
        }
        // Search face
        const embedRes = await fetch(`${FACE_SERVICE_URL}/detect-and-embed`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ base64_image: body.photoBase64 }),
          signal: AbortSignal.timeout(15000),
        });
        const embedData = await embedRes.json();
        if (!embedData.faces || embedData.faces.length === 0) {
          sendJSON(res, 200, { match: null, message: "No face detected" });
          return true;
        }
        const searchEmb = embedData.faces[0].embedding;
        const allFaces = await db.getAllCedulaEmbeddings();
        const threshold = parseFloat(body.threshold || "0.4");
        let bestMatch = null;
        let bestSim = 0;
        for (const face of allFaces) {
          if (!face.embedding || face.embedding.length !== 512) continue;
          const sim = cosineSimilarity(searchEmb, face.embedding);
          if (sim >= threshold && sim > bestSim) {
            bestSim = sim;
            bestMatch = face;
          }
        }
        if (!bestMatch) {
          sendJSON(res, 200, { match: null, message: "No matching cédula found" });
          return true;
        }
        // Auto-create cédula profile if not exists
        let profileId;
        try {
          profileId = await db.createOsintProfile(bestMatch.full_name || bestMatch.cedula, "cedula", bestMatch.cedula, ["face-match"]);
        } catch (e) {
          // Profile already exists — find it
          const profiles = await db.getOsintProfiles();
          const existing = profiles.find(p => p.profile_type === "cedula" && p.value === bestMatch.cedula);
          profileId = existing?.id;
        }
        // Trigger full scan
        let scanId = null;
        if (profileId) {
          try {
            const scanResult = await osintEngine.runScan(profileId, "full");
            scanId = scanResult?.scanId || null;
          } catch (e) {
            log.bridge.warn("Auto-scan failed for matched cédula:", e.message);
          }
        }
        sendJSON(res, 200, {
          match: {
            cedula: bestMatch.cedula,
            fullName: bestMatch.full_name,
            similarity: Math.round(bestSim * 10000) / 10000,
          },
          profileId,
          scanId,
          message: scanId ? "Match found — OSINT scan started" : "Match found — scan skipped",
        });
      } catch (err) {
        log.bridge.error("Cédula scan-match error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    return false;
  };
};
