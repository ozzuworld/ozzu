// routes/vault.js — Personal identity vault (Face ID gated in app)
// Stores owner's personal info, passport, travel history, document images

"use strict";

const fs = require("fs");
const path = require("path");

const DOCS_DIR = "/home/gcp/ozzu/data/identity/documents";
const OWNER_KEY = "kazuma";

module.exports = function vaultRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  return async function handleVaultRoutes(req, res, pathname, url) {

    // GET /api/vault/profile — full identity profile
    if (req.method === "GET" && pathname === "/api/vault/profile") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      try {
        const r = await db.query(`SELECT * FROM identity_profile WHERE owner_key = $1`, [OWNER_KEY]);
        const profile = r.rows[0] || null;
        const travel = await db.query(
          `SELECT * FROM identity_travel_history WHERE owner_key = $1 ORDER BY event_date DESC`,
          [OWNER_KEY]
        );
        const docs = await db.query(
          `SELECT id, doc_type, label, filename, created_at FROM identity_documents WHERE owner_key = $1 ORDER BY created_at`,
          [OWNER_KEY]
        );
        sendJSON(res, 200, {
          ok: true,
          profile,
          travelHistory: travel.rows,
          documents: docs.rows,
        });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // PUT /api/vault/profile — upsert identity profile
    if (req.method === "PUT" && pathname === "/api/vault/profile") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const body = await parseBody(req);
      try {
        await db.query(`
          INSERT INTO identity_profile (owner_key, full_name, date_of_birth, place_of_birth, nationality,
            cedula, passport_number, passport_issued, passport_expires, passport_issuing_authority,
            visas, emergency_contact, extra, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
          ON CONFLICT (owner_key) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            date_of_birth = EXCLUDED.date_of_birth,
            place_of_birth = EXCLUDED.place_of_birth,
            nationality = EXCLUDED.nationality,
            cedula = EXCLUDED.cedula,
            passport_number = EXCLUDED.passport_number,
            passport_issued = EXCLUDED.passport_issued,
            passport_expires = EXCLUDED.passport_expires,
            passport_issuing_authority = EXCLUDED.passport_issuing_authority,
            visas = EXCLUDED.visas,
            emergency_contact = EXCLUDED.emergency_contact,
            extra = EXCLUDED.extra,
            updated_at = NOW()
        `, [
          OWNER_KEY,
          body.full_name || null,
          body.date_of_birth || null,
          body.place_of_birth || null,
          body.nationality || null,
          body.cedula || null,
          body.passport_number || null,
          body.passport_issued || null,
          body.passport_expires || null,
          body.passport_issuing_authority || null,
          JSON.stringify(body.visas || []),
          JSON.stringify(body.emergency_contact || {}),
          JSON.stringify(body.extra || {}),
        ]);
        sendJSON(res, 200, { ok: true });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // GET /api/vault/travel — travel history
    if (req.method === "GET" && pathname === "/api/vault/travel") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      try {
        const r = await db.query(
          `SELECT * FROM identity_travel_history WHERE owner_key = $1 ORDER BY event_date DESC`,
          [OWNER_KEY]
        );
        sendJSON(res, 200, { ok: true, history: r.rows });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // POST /api/vault/travel — add travel entry
    if (req.method === "POST" && pathname === "/api/vault/travel") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const body = await parseBody(req);
      try {
        await db.query(
          `INSERT INTO identity_travel_history (owner_key, event_date, country, city, port, direction, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [OWNER_KEY, body.event_date, body.country, body.city || null, body.port || null, body.direction || "stamp", body.notes || null]
        );
        sendJSON(res, 200, { ok: true });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // DELETE /api/vault/travel/:id
    if (req.method === "DELETE" && pathname.startsWith("/api/vault/travel/")) {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const id = pathname.split("/").pop();
      await db.query(`DELETE FROM identity_travel_history WHERE id=$1 AND owner_key=$2`, [id, OWNER_KEY]);
      sendJSON(res, 200, { ok: true });
      return true;
    }

    // GET /api/vault/documents — list documents
    if (req.method === "GET" && pathname === "/api/vault/documents") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      try {
        const r = await db.query(
          `SELECT id, doc_type, label, filename, created_at FROM identity_documents WHERE owner_key=$1 ORDER BY created_at`,
          [OWNER_KEY]
        );
        sendJSON(res, 200, { ok: true, documents: r.rows });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // GET /api/vault/documents/:id/image — serve document image
    if (req.method === "GET" && pathname.match(/^\/api\/vault\/documents\/\d+\/image$/)) {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const id = pathname.split("/")[4];
      try {
        const r = await db.query(`SELECT filepath FROM identity_documents WHERE id=$1 AND owner_key=$2`, [id, OWNER_KEY]);
        if (!r.rows[0]) { sendJSON(res, 404, { ok: false, error: "Not found" }); return true; }
        const fp = r.rows[0].filepath;
        if (!fs.existsSync(fp)) { sendJSON(res, 404, { ok: false, error: "File missing" }); return true; }
        const data = fs.readFileSync(fp);
        res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": data.length, "Cache-Control": "private, max-age=3600" });
        res.end(data);
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    return false;
  };
};
