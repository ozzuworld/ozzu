"use strict";

// /jobs/* — browse & triage remote software-engineering listings (dir_1785424018953)
// ingested by jobs/ingest.js from Himalayas + RemoteOK. Read endpoints for the app,
// triage decisions (save/dismiss/applied), on-demand refresh + rescore. Independent of SECOP.

const schema = require("../jobs/schema");

const DECISIONS = ["pending", "saved", "dismissed", "applied"];

module.exports = function jobsRoutes(ctx) {
  const { sendJSON, parseBody, db, log } = ctx;

  return async function (req, res, pathname, url) {
    // GET /jobs/stats — inbox summary + last ingest
    if (req.method === "GET" && pathname === "/jobs/stats") {
      try { sendJSON(res, 200, await schema.getStats(db)); }
      catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /jobs/worker — refresh-worker state
    if (req.method === "GET" && pathname === "/jobs/worker") {
      try {
        const st = await schema.getWorkerState(db);
        sendJSON(res, 200, {
          enabled: !!st.enabled,
          hard_off: process.env.JOBS_WORKER === "off",
          tick_ms: parseInt(process.env.JOBS_WORKER_TICK_MS) || 60 * 60 * 1000,
          updated_at: st.updated_at || null,
          updated_by: st.updated_by || null,
        });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /jobs/worker {enabled:bool} — play/pause the refresh worker (no restart)
    if (req.method === "POST" && pathname === "/jobs/worker") {
      try {
        const body = await parseBody(req);
        if (typeof body.enabled !== "boolean") { sendJSON(res, 400, { error: "enabled must be boolean" }); return true; }
        const st = await schema.setWorkerState(db, body.enabled, typeof body.by === "string" ? body.by : "app");
        log?.info?.(`[jobs] worker ${body.enabled ? "STARTED" : "PAUSED"} via app`);
        sendJSON(res, 200, { ok: true, enabled: !!st.enabled, hard_off: process.env.JOBS_WORKER === "off", updated_at: st.updated_at, updated_by: st.updated_by });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /jobs — filtered/searched/scored list
    if (req.method === "GET" && pathname === "/jobs") {
      try {
        const q = url.searchParams;
        sendJSON(res, 200, await schema.listJobs(db, {
          all: q.get("all"),
          relevant: q.get("relevant"),
          inbox: q.get("inbox"),
          latam: q.get("latam"),
          decision: q.get("decision"),
          source: q.get("source"),
          tag: q.get("tag"),
          company: q.get("company"),
          min_salary: q.get("min_salary"),
          q: q.get("q"),
          sort: q.get("sort"),
          limit: q.get("limit"),
          offset: q.get("offset"),
        }));
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /jobs/ingest — refresh from the feeds (background, 202)
    if (req.method === "POST" && pathname === "/jobs/ingest") {
      try {
        const { runIngest } = require("../jobs/ingest");
        runIngest(db)
          .then((r) => log?.info?.(`[jobs] ingest done: ${JSON.stringify(r)}`))
          .catch((e) => log?.error?.(`[jobs] ingest failed: ${e.message}`));
        sendJSON(res, 202, { ok: true, message: "jobs ingest started in background" });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /jobs/rescore — re-apply scope.json to stored rows (background, 202)
    if (req.method === "POST" && pathname === "/jobs/rescore") {
      try {
        schema.rescoreAll(db)
          .then((r) => log?.info?.(`[jobs] rescore done: ${JSON.stringify(r)}`))
          .catch((e) => log?.error?.(`[jobs] rescore failed: ${e.message}`));
        sendJSON(res, 202, { ok: true, message: "jobs rescore started in background" });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /jobs/:id/decision {decision, note?} — triage (save/dismiss/applied)
    const decisionMatch = pathname.match(/^\/jobs\/(.+)\/decision$/);
    if (req.method === "POST" && decisionMatch) {
      try {
        const id = decodeURIComponent(decisionMatch[1]);
        const body = await parseBody(req);
        if (!DECISIONS.includes(body.decision)) { sendJSON(res, 400, { error: `decision must be one of ${DECISIONS.join(" | ")}` }); return true; }
        const row = await schema.setDecision(db, id, body.decision, typeof body.note === "string" ? body.note : null);
        sendJSON(res, 200, { ok: true, id, ...row });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /jobs/:id — full record (id may contain a colon, e.g. remoteok:12345)
    const idMatch = pathname.match(/^\/jobs\/(.+)$/);
    if (req.method === "GET" && idMatch) {
      try {
        const id = decodeURIComponent(idMatch[1]);
        const row = await schema.getJob(db, id);
        if (!row) { sendJSON(res, 404, { error: "job not found" }); return true; }
        sendJSON(res, 200, row);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    return false;
  };
};
