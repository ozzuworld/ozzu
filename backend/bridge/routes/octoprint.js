// routes/octoprint.js — OctoPrint integration HTTP routes
// Directive: dir_1778272304525
"use strict";

const fs = require("fs");
const octoprint = require("../octoprint-client");
const pipeline = require("../octoprint-pipeline");

module.exports = function octoprintRoutes(ctx) {
  const { sendJSON, parseBody, requireAuth, db, log } = ctx;
  const getDirectives = ctx.getDirectives;
  const saveDirectives = ctx.saveDirectives;

  return async function handleOctoprintRoutes(req, res, pathname, url) {
    if (!pathname.startsWith("/octoprint")) return false;

    // GET /octoprint/status — printer + job + connection state
    if (req.method === "GET" && pathname === "/octoprint/status") {
      try {
        const s = await octoprint.getStatus();
        sendJSON(res, 200, s);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return true;
    }

    // POST /octoprint/connect — connect to printer
    if (req.method === "POST" && pathname === "/octoprint/connect") {
      if (!requireAuth(req, res)) return true;
      try {
        const r = await octoprint.connectPrinter();
        sendJSON(res, r.ok ? 200 : 500, r);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return true;
    }

    // POST /octoprint/print — slice an STL and start a print
    // body: { stl_path: "/path/to/file.stl", directive_id?: "dir_xxx", slicer?: {...}, dry_run?: bool }
    if (req.method === "POST" && pathname === "/octoprint/print") {
      if (!requireAuth(req, res)) return true;
      try {
        const body = await parseBody(req);
        if (!body.stl_path) {
          sendJSON(res, 400, { error: "stl_path required" });
          return true;
        }
        if (!fs.existsSync(body.stl_path)) {
          sendJSON(res, 404, { error: `STL not found: ${body.stl_path}` });
          return true;
        }
        const result = await pipeline.printSTL(body.stl_path, {
          directiveId: body.directive_id,
          slicer: body.slicer || {},
          dryRun: body.dry_run === true,
          connectIfNeeded: body.connect_if_needed !== false,
        });
        // If linked to a directive, log start
        if (body.directive_id && getDirectives && saveDirectives) {
          const ds = getDirectives();
          const d = ds.find(x => x.id === body.directive_id);
          if (d) {
            d.activity_log = d.activity_log || [];
            d.activity_log.push({
              timestamp: Date.now(),
              type: "octoprint",
              actor: "bridge",
              message: `Print started: ${result.upload?.files?.local?.name || "?"}`,
            });
            saveDirectives(ds);
          }
        }
        sendJSON(res, 200, result);
      } catch (e) {
        log("error", "octoprint print failed", e.message);
        sendJSON(res, 500, { error: e.message, stack: e.stack?.split("\n").slice(0, 5).join("\n") });
      }
      return true;
    }

    // POST /octoprint/cancel — cancel current print
    if (req.method === "POST" && pathname === "/octoprint/cancel") {
      if (!requireAuth(req, res)) return true;
      try {
        const r = await octoprint.cancelPrint();
        sendJSON(res, r.ok ? 200 : 500, r);
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return true;
    }

    // POST /octoprint/webhook — OctoPrint Webhooks plugin posts events here
    // Event payload: { topic, message, currentTime, deviceIdentifier, extra }
    if (req.method === "POST" && pathname === "/octoprint/webhook") {
      try {
        const body = await parseBody(req);
        const topic = body.topic || body.event || "?";
        const message = body.message || body.payload?.name || "";
        log("info", "[octoprint webhook]", topic, message);
        // Persist as a generic event row if db has an events table; otherwise skip silently
        if (db && db.query) {
          try {
            await db.query(
              `INSERT INTO octoprint_events (topic, payload, received_at)
               VALUES ($1, $2, NOW())`,
              [topic, JSON.stringify(body)],
            );
          } catch (_) { /* table may not exist yet */ }
        }
        // Update linked directive if directive_id is in payload extras
        const directiveId = body.extra?.directive_id || body.directive_id;
        if (directiveId && getDirectives && saveDirectives) {
          const ds = getDirectives();
          const d = ds.find(x => x.id === directiveId);
          if (d) {
            d.activity_log = d.activity_log || [];
            d.activity_log.push({
              timestamp: Date.now(),
              type: "octoprint_event",
              actor: "octoprint",
              message: `${topic}: ${message}`,
            });
            // Update working_state on key milestones
            if (/PrintDone|PrintFailed|PrintCancelled/.test(topic)) {
              d.working_state = `Print ${topic.replace("Print", "").toLowerCase()}: ${message}`;
            }
            saveDirectives(ds);
          }
        }
        sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
      return true;
    }

    return false;
  };
};
