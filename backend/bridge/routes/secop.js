"use strict";

// /secop/* — browse & search Colombian public-procurement opportunities (SECOP II)
// ingested by secop/ingest.js. Read endpoints for the app + on-demand refresh.

const schema = require("../secop/schema");

module.exports = function secopRoutes(ctx) {
  const { sendJSON, db, log } = ctx;

  return async function (req, res, pathname, url) {
    // GET /secop/stats — summary: open count, total value, by-department, last ingest
    if (req.method === "GET" && pathname === "/secop/stats") {
      try { sendJSON(res, 200, await schema.getStats(db)); }
      catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /secop/categories[?all=true] — UNSPSC segments + overlay tags, with counts
    if (req.method === "GET" && pathname === "/secop/categories") {
      try {
        const openOnly = url.searchParams.get("all") !== "true";
        sendJSON(res, 200, await schema.browseCategories(db, openOnly));
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /secop/licitaciones — filtered/searched list
    if (req.method === "GET" && pathname === "/secop/licitaciones") {
      try {
        const q = url.searchParams;
        const result = await schema.listLicitaciones(db, {
          all: q.get("all"),
          segment: q.get("segment"),
          overlay: q.get("overlay"),
          modalidad: q.get("modalidad"),
          departamento: q.get("departamento"),
          entidad: q.get("entidad"),
          q: q.get("q"),
          min_value: q.get("min_value"),
          max_value: q.get("max_value"),
          sort: q.get("sort"),
          limit: q.get("limit"),
          offset: q.get("offset"),
        });
        sendJSON(res, 200, result);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /secop/licitaciones/:id — full record (id may contain dots, e.g. CO1.REQ.123)
    const idMatch = pathname.match(/^\/secop\/licitaciones\/(.+)$/);
    if (req.method === "GET" && idMatch) {
      try {
        const id = decodeURIComponent(idMatch[1]);
        const row = await schema.getLicitacion(db, id);
        if (!row) { sendJSON(res, 404, { error: "licitación not found" }); return true; }
        sendJSON(res, 200, row);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /secop/ingest — refresh from SECOP II (runs in background, returns 202)
    if (req.method === "POST" && pathname === "/secop/ingest") {
      try {
        const { runIngest } = require("../secop/ingest");
        runIngest(db)
          .then((r) => log && log.info && log.info(`[secop] ingest done: ${JSON.stringify(r)}`))
          .catch((e) => log && log.error && log.error(`[secop] ingest failed: ${e.message}`));
        sendJSON(res, 202, { ok: true, message: "SECOP ingest started in background" });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /secop/recategorize — re-apply overlay.json/unspsc.json (background, 202)
    if (req.method === "POST" && pathname === "/secop/recategorize") {
      try {
        const { recategorize } = require("../secop/ingest");
        recategorize(db)
          .then((r) => log && log.info && log.info(`[secop] recategorize done: ${JSON.stringify(r)}`))
          .catch((e) => log && log.error && log.error(`[secop] recategorize failed: ${e.message}`));
        sendJSON(res, 202, { ok: true, message: "SECOP recategorize started in background" });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    return false;
  };
};
