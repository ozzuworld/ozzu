"use strict";

// /secop/* — browse & search Colombian public-procurement opportunities (SECOP II)
// ingested by secop/ingest.js. Read endpoints for the app + on-demand refresh.

const schema = require("../secop/schema");

module.exports = function secopRoutes(ctx) {
  const { sendJSON, parseBody, db, log } = ctx;

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
          relevant: q.get("relevant"),
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

    // POST /secop/licitaciones/:id/decision — Aceptar/Rechazar (rejected clears the queue)
    const decisionMatch = pathname.match(/^\/secop\/licitaciones\/(.+)\/decision$/);
    if (req.method === "POST" && decisionMatch) {
      try {
        const id = decodeURIComponent(decisionMatch[1]);
        const body = await parseBody(req);
        if (!["accepted", "rejected", "pending"].includes(body.decision)) {
          sendJSON(res, 400, { error: "decision must be accepted | rejected | pending" });
          return true;
        }
        await schema.setDecision(db, id, body.decision);
        sendJSON(res, 200, { ok: true, id, decision: body.decision });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /secop/licitaciones/:id/create-venture — spin up a Skyline venture (bid pipeline)
    const cvMatch = pathname.match(/^\/secop\/licitaciones\/(.+)\/create-venture$/);
    if (req.method === "POST" && cvMatch) {
      try {
        const id = decodeURIComponent(cvMatch[1]);
        const lic = await schema.getLicitacion(db, id);
        if (!lic) { sendJSON(res, 404, { error: "licitación not found" }); return true; }
        const { createVentureFromLicitacion } = require("../secop/venture");
        const result = await createVentureFromLicitacion(db, lic);
        sendJSON(res, result.created ? 201 : 200, { ok: true, secop_id: id, ...result });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /secop/licitaciones/:id/detail — structured tender detail (lazy-built, pollable)
    const detailMatch = pathname.match(/^\/secop\/licitaciones\/(.+)\/detail$/);
    if (req.method === "GET" && detailMatch) {
      try {
        const id = decodeURIComponent(detailMatch[1]);
        const existing = await schema.getTenderDetail(db, id);
        if (existing && existing.status === "ok") { sendJSON(res, 200, { status: "ready", detail: existing }); return true; }
        if (existing && existing.status === "building") { sendJSON(res, 200, { status: "building" }); return true; }
        const { buildTenderDetail } = require("../secop/detail-pipeline");
        buildTenderDetail(db, id)
          .then((r) => log?.info?.(`[secop] detail built ${id}: ${JSON.stringify(r)}`))
          .catch((e) => log?.error?.(`[secop] detail failed ${id}: ${e.message}`));
        sendJSON(res, existing && existing.status === "error" ? 200 : 202, { status: "building", previous_error: existing?.error || null });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /secop/licitaciones/:id/detail/rebuild — force re-extraction (background)
    const rebuildMatch = pathname.match(/^\/secop\/licitaciones\/(.+)\/detail\/rebuild$/);
    if (req.method === "POST" && rebuildMatch) {
      try {
        const id = decodeURIComponent(rebuildMatch[1]);
        const { buildTenderDetail } = require("../secop/detail-pipeline");
        buildTenderDetail(db, id)
          .then((r) => log?.info?.(`[secop] detail rebuilt ${id}`))
          .catch((e) => log?.error?.(`[secop] detail rebuild failed ${id}: ${e.message}`));
        sendJSON(res, 202, { status: "building" });
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

    // POST /secop/entity-stats/refresh — recompute per-entity competitiveness (background)
    if (req.method === "POST" && pathname === "/secop/entity-stats/refresh") {
      try {
        const { buildEntityStats } = require("../secop/entity-stats");
        buildEntityStats(db)
          .then((r) => log?.info?.(`[secop] entity-stats: ${JSON.stringify(r)}`))
          .catch((e) => log?.error?.(`[secop] entity-stats failed: ${e.message}`));
        sendJSON(res, 202, { ok: true, message: "entity-stats refresh started" });
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
