"use strict";

module.exports = function osintRoutes(ctx) {
  const { sendJSON, parseBody, db, log, osintEngine, osintMonitor, cliRunner } = ctx;

  return async function(req, res, pathname, url) {

    // ── OSINT Endpoints ──

    // POST /osint/profiles — create a profile to scan
    if (req.method === "POST" && pathname === "/osint/profiles") {
      try {
        const body = await parseBody(req);
        const { label, profileType, value, tags } = body;
        if (!label || !profileType || !value) {
          sendJSON(res, 400, { error: "Missing required fields: label, profileType, value" });
          return true;
        }
        if (!["email", "username", "password", "phone", "domain", "ip", "image", "cedula", "nit"].includes(profileType)) {
          sendJSON(res, 400, { error: "Invalid profile type" });
          return true;
        }
        const id = await db.createOsintProfile(label, profileType, value, tags || []);
        if (!id) { sendJSON(res, 500, { error: "Failed to create profile" }); return true; }
        const profile = await db.getOsintProfile(id);
        sendJSON(res, 201, { ok: true, profile });
      } catch (err) {
        if (err.message.includes("duplicate key")) {
          sendJSON(res, 409, { error: "A profile with this type and value already exists" });
        } else {
          log.bridge.error("OSINT create profile error:", err.message);
          sendJSON(res, 500, { error: err.message });
        }
      }
      return true;
    }

    // GET /osint/profiles — list active profiles (mask password values)
    if (req.method === "GET" && pathname === "/osint/profiles") {
      try {
        const profiles = await db.getOsintProfiles();
        const masked = profiles.map(p => ({
          ...p,
          value: p.profile_type === "password" ? p.value.substring(0, 5) + "..." : p.value,
        }));
        sendJSON(res, 200, masked);
      } catch (err) {
        log.bridge.error("OSINT list profiles error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /osint/profiles/:id — soft-delete profile
    const osintProfileDeleteMatch = pathname.match(/^\/osint\/profiles\/(\d+)$/);
    if (req.method === "DELETE" && osintProfileDeleteMatch) {
      try {
        const profileId = parseInt(osintProfileDeleteMatch[1], 10);
        await db.deleteOsintProfile(profileId);
        sendJSON(res, 200, { ok: true });
      } catch (err) {
        log.bridge.error("OSINT delete profile error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── OSINT Image Upload/Serve ──

    // POST /osint/images/upload — upload image, create profile + osint_images record
    if (req.method === "POST" && pathname === "/osint/images/upload") {
      try {
        const data = await parseBody(req);
        if (!data.base64 || !data.label) {
          sendJSON(res, 400, { error: "Required: base64 (image data), label" });
          return true;
        }
        const crypto = require("crypto");
        const sharp = require("sharp");
        const fs = require("fs");
        const path = require("path");

        // Decode base64
        const buf = Buffer.from(data.base64, "base64");
        if (buf.length > 15 * 1024 * 1024) {
          sendJSON(res, 400, { error: "Image too large (max 15MB)" });
          return true;
        }

        const hash = crypto.createHash("sha256").update(buf).digest("hex");
        const imgDir = "/tmp/ozzu-bridge/osint-images";
        fs.mkdirSync(imgDir, { recursive: true });

        // Detect format and get dimensions via sharp
        const meta = await sharp(buf).metadata();
        const ext = meta.format || "jpg";
        const filePath = path.join(imgDir, `${hash}.${ext}`);
        const thumbPath = path.join(imgDir, `thumb-${hash}.jpg`);

        // Write full image
        fs.writeFileSync(filePath, buf);

        // Generate 256px thumbnail
        await sharp(buf).resize(256, 256, { fit: "cover" }).jpeg({ quality: 80 }).toFile(thumbPath);

        // Create profile (value = hash for dedup)
        const profileId = await db.createOsintProfile(data.label, "image", hash, data.tags || []);
        if (!profileId) {
          sendJSON(res, 500, { error: "Failed to create image profile" });
          return true;
        }

        // Create osint_images record
        const imageRecord = await db.createOsintImage({
          profile_id: profileId,
          file_hash: hash,
          file_path: filePath,
          original_filename: data.filename || null,
          mime_type: `image/${ext}`,
          file_size: buf.length,
          width: meta.width,
          height: meta.height,
          thumbnail_path: thumbPath,
        });

        const profile = await db.getOsintProfile(profileId);
        sendJSON(res, 201, { ok: true, profile, image: imageRecord });
      } catch (err) {
        if (err.message.includes("duplicate key")) {
          sendJSON(res, 409, { error: "An image profile with this hash already exists" });
        } else {
          log.bridge.error("OSINT image upload error:", err.message);
          sendJSON(res, 500, { error: err.message });
        }
      }
      return true;
    }

    // GET /osint/images/:profileId — serve stored image
    if (req.method === "GET" && pathname.match(/^\/osint\/images\/(\d+)$/)) {
      try {
        const profileId = parseInt(RegExp.$1, 10);
        const image = await db.getOsintImageByProfile(profileId);
        if (!image) { sendJSON(res, 404, { error: "Image not found" }); return true; }
        const fs = require("fs");
        if (!fs.existsSync(image.file_path)) { sendJSON(res, 404, { error: "Image file missing from disk" }); return true; }
        res.writeHead(200, { "Content-Type": image.mime_type || "image/jpeg", "Cache-Control": "public, max-age=3600" });
        fs.createReadStream(image.file_path).pipe(res);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/images/:profileId/thumbnail — serve thumbnail
    if (req.method === "GET" && pathname.match(/^\/osint\/images\/(\d+)\/thumbnail$/)) {
      try {
        const profileId = parseInt(RegExp.$1, 10);
        const image = await db.getOsintImageByProfile(profileId);
        if (!image || !image.thumbnail_path) { sendJSON(res, 404, { error: "Thumbnail not found" }); return true; }
        const fs = require("fs");
        if (!fs.existsSync(image.thumbnail_path)) { sendJSON(res, 404, { error: "Thumbnail file missing" }); return true; }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" });
        fs.createReadStream(image.thumbnail_path).pipe(res);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/scan — trigger a scan for a profile
    if (req.method === "POST" && pathname === "/osint/scan") {
      try {
        const body = await parseBody(req);
        const { profileId, scanType } = body;
        if (!profileId) {
          sendJSON(res, 400, { error: "Missing required field: profileId" });
          return true;
        }
        const result = await osintEngine.runScan(profileId, scanType || "full");
        sendJSON(res, 202, { ok: true, ...result });
      } catch (err) {
        log.bridge.error("OSINT scan error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/scan/:id — get scan status + findings
    const osintScanMatch = pathname.match(/^\/osint\/scan\/(\d+)$/);
    if (req.method === "GET" && osintScanMatch) {
      try {
        const scanId = parseInt(osintScanMatch[1], 10);
        const scan = await db.getOsintScan(scanId);
        if (!scan) { sendJSON(res, 404, { error: "Scan not found" }); return true; }
        const findings = await db.getOsintFindings({ scanId });
        sendJSON(res, 200, { scan, findings });
      } catch (err) {
        log.bridge.error("OSINT get scan error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/findings — list findings with filters
    if (req.method === "GET" && pathname === "/osint/findings") {
      try {
        const filters = {
          severity: url.searchParams.get("severity") || undefined,
          category: url.searchParams.get("category") || undefined,
          status: url.searchParams.get("status") || undefined,
          profileId: url.searchParams.get("profileId") ? parseInt(url.searchParams.get("profileId"), 10) : undefined,
          limit: url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit"), 10) : undefined,
          offset: url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset"), 10) : undefined,
        };
        const findings = await db.getOsintFindings(filters);
        sendJSON(res, 200, findings);
      } catch (err) {
        log.bridge.error("OSINT list findings error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /osint/findings/bulk — bulk update finding statuses
    if (req.method === "PATCH" && pathname === "/osint/findings/bulk") {
      try {
        const body = await parseBody(req);
        const validStatuses = ["new", "acknowledged", "remediated", "false_positive"];
        if (!body.status || !validStatuses.includes(body.status)) {
          sendJSON(res, 400, { error: "Invalid status. Must be: new, acknowledged, remediated, false_positive" });
          return true;
        }
        const updated = await db.bulkUpdateOsintFindings(body.status, {
          findingIds: body.findingIds,
          severity: body.severity,
          module: body.module,
          currentStatus: body.currentStatus,
        });
        sendJSON(res, 200, { ok: true, updated });
      } catch (err) {
        log.bridge.error("OSINT bulk update findings error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /osint/findings/:id — update finding status
    const osintFindingMatch = pathname.match(/^\/osint\/findings\/(\d+)$/);
    if (req.method === "PATCH" && osintFindingMatch) {
      try {
        const findingId = parseInt(osintFindingMatch[1], 10);
        const body = await parseBody(req);
        if (!body.status || !["new", "acknowledged", "remediated", "false_positive"].includes(body.status)) {
          sendJSON(res, 400, { error: "Invalid status. Must be: new, acknowledged, remediated, false_positive" });
          return true;
        }
        const finding = await db.updateOsintFinding(findingId, body.status);
        if (!finding) { sendJSON(res, 404, { error: "Finding not found" }); return true; }
        sendJSON(res, 200, { ok: true, finding });
      } catch (err) {
        log.bridge.error("OSINT update finding error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/score — exposure score
    if (req.method === "GET" && pathname === "/osint/score") {
      try {
        const score = await osintEngine.calculateExposureScore();
        sendJSON(res, 200, score);
      } catch (err) {
        log.bridge.error("OSINT score error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/scan-all — scan all active profiles
    if (req.method === "POST" && pathname === "/osint/scan-all") {
      try {
        const result = await osintEngine.runScanAll();
        setTimeout(() => osintEngine.recordScoreSnapshot(), 30000);
        sendJSON(res, 202, { ok: true, ...result });
      } catch (err) {
        log.bridge.error("OSINT scan-all error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/score/history — score trend over time
    if (req.method === "GET" && pathname === "/osint/score/history") {
      try {
        const days = url.searchParams.get("days") ? parseInt(url.searchParams.get("days"), 10) : 30;
        const history = await db.getOsintScoreHistory(days);
        sendJSON(res, 200, history);
      } catch (err) {
        log.bridge.error("OSINT score history error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/score/snapshot — manually record a score snapshot
    if (req.method === "POST" && pathname === "/osint/score/snapshot") {
      try {
        const result = await osintEngine.recordScoreSnapshot();
        sendJSON(res, 200, { ok: true, ...result });
      } catch (err) {
        log.bridge.error("OSINT score snapshot error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/schedule — configure scheduled scans
    if (req.method === "POST" && pathname === "/osint/schedule") {
      try {
        const body = await parseBody(req);
        const { intervalHours } = body;
        if (intervalHours === 0 || intervalHours === null) {
          osintEngine.stopScheduledScans();
          sendJSON(res, 200, { ok: true, message: "Scheduled scans disabled", schedule: osintEngine.getScheduleStatus() });
        } else if (intervalHours > 0) {
          osintEngine.startScheduledScans(intervalHours);
          sendJSON(res, 200, { ok: true, message: `Scheduled scans set to every ${intervalHours}h`, schedule: osintEngine.getScheduleStatus() });
        } else {
          sendJSON(res, 400, { error: "intervalHours must be a positive number or 0 to disable" });
        }
      } catch (err) {
        log.bridge.error("OSINT schedule error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/schedule — get schedule status
    if (req.method === "GET" && pathname === "/osint/schedule") {
      try {
        const schedule = osintEngine.getScheduleStatus();
        const lastScan = await db.getLastOsintScanTime();
        sendJSON(res, 200, { ...schedule, lastScanAt: lastScan });
      } catch (err) {
        log.bridge.error("OSINT schedule status error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── OSINT Persons (Family Grouping) ──

    // POST /osint/persons — create person
    if (req.method === "POST" && pathname === "/osint/persons") {
      try {
        const body = await parseBody(req);
        if (!body.name) { sendJSON(res, 400, { error: "name is required" }); return true; }
        const person = await db.createOsintPerson(body);
        sendJSON(res, 201, { ok: true, person });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/persons — list persons
    if (req.method === "GET" && pathname === "/osint/persons") {
      try {
        const persons = await db.getOsintPersons();
        sendJSON(res, 200, { ok: true, persons });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /osint/persons/:id — update person
    const personPatchMatch = pathname.match(/^\/osint\/persons\/(\d+)$/);
    if (req.method === "PATCH" && personPatchMatch) {
      try {
        const body = await parseBody(req);
        const person = await db.updateOsintPerson(parseInt(personPatchMatch[1], 10), body);
        sendJSON(res, 200, { ok: true, person });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/profiles/:id/assign-person — link profile to person
    const assignPersonMatch = pathname.match(/^\/osint\/profiles\/(\d+)\/assign-person$/);
    if (req.method === "POST" && assignPersonMatch) {
      try {
        const body = await parseBody(req);
        const profile = await db.assignProfileToPerson(parseInt(assignPersonMatch[1], 10), body.personId);
        sendJSON(res, 200, { ok: true, profile });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── OSINT Alerts ──

    // POST /osint/alerts/read-all — mark all as read (before /:id/read to avoid route conflict)
    if (req.method === "POST" && pathname === "/osint/alerts/read-all") {
      try {
        await db.markAllOsintAlertsRead();
        sendJSON(res, 200, { ok: true });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/alerts/count — unread count
    if (req.method === "GET" && pathname === "/osint/alerts/count") {
      try {
        const count = await db.getOsintAlertCount();
        sendJSON(res, 200, { ok: true, unreadCount: count });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/alerts — list alerts
    if (req.method === "GET" && pathname === "/osint/alerts") {
      try {
        const unreadOnly = url.searchParams.get("unread") === "true";
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const alerts = await db.getOsintAlerts({ unreadOnly, limit });
        const unreadCount = await db.getOsintAlertCount();
        sendJSON(res, 200, { ok: true, alerts, unreadCount });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/alerts/:id/read — mark alert as read
    const alertReadMatch = pathname.match(/^\/osint\/alerts\/(\d+)\/read$/);
    if (req.method === "POST" && alertReadMatch) {
      try {
        await db.markOsintAlertRead(parseInt(alertReadMatch[1], 10));
        sendJSON(res, 200, { ok: true });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── OSINT Entity/Graph Endpoints ──

    // GET /osint/entities/:id/neighbors — connected entities (before /entities to avoid conflict)
    const entityNeighborMatch = pathname.match(/^\/osint\/entities\/(\d+)\/neighbors$/);
    if (req.method === "GET" && entityNeighborMatch) {
      try {
        const entityId = parseInt(entityNeighborMatch[1], 10);
        const entity = await db.getOsintEntity(entityId);
        if (!entity) { sendJSON(res, 404, { error: "Entity not found" }); return true; }
        const relationships = await db.getOsintRelationships(entityId);
        sendJSON(res, 200, { ok: true, entity, relationships });
      } catch (err) {
        log.bridge.error("OSINT entity neighbors error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/entities — list entities (optional ?type= filter)
    if (req.method === "GET" && pathname === "/osint/entities") {
      try {
        const type = url.searchParams.get("type");
        const profileId = url.searchParams.get("profileId");
        const limit = parseInt(url.searchParams.get("limit") || "200", 10);
        const entities = await db.getOsintEntities({ type, profileId: profileId ? parseInt(profileId, 10) : null, limit });
        sendJSON(res, 200, { ok: true, entities });
      } catch (err) {
        log.bridge.error("OSINT entities error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/graph/:profileId — graph for one profile (before /graph to avoid conflict)
    const graphProfileMatch = pathname.match(/^\/osint\/graph\/(\d+)$/);
    if (req.method === "GET" && graphProfileMatch) {
      try {
        const profileId = parseInt(graphProfileMatch[1], 10);
        const graph = await db.getOsintEntityGraph(profileId);
        const summary = await db.getOsintCorrelationSummary();
        sendJSON(res, 200, { ok: true, ...graph, summary });
      } catch (err) {
        log.bridge.error("OSINT profile graph error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/graph — full entity graph + summary
    if (req.method === "GET" && pathname === "/osint/graph") {
      try {
        const graph = await db.getOsintEntityGraph();
        const summary = await db.getOsintCorrelationSummary();
        sendJSON(res, 200, { ok: true, ...graph, summary });
      } catch (err) {
        log.bridge.error("OSINT graph error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/report/:profileId — report for one profile (before /report to avoid conflict)
    const reportProfileMatch = pathname.match(/^\/osint\/report\/(\d+)$/);
    if (req.method === "GET" && reportProfileMatch) {
      try {
        const osintReport = require("./osint-report");
        const profileId = parseInt(reportProfileMatch[1], 10);
        const report = await osintReport.generateReport(profileId);
        sendJSON(res, 200, { ok: true, report });
      } catch (err) {
        log.bridge.error("OSINT profile report error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/report — combined report across all profiles
    if (req.method === "GET" && pathname === "/osint/report") {
      try {
        const osintReport = require("./osint-report");
        const report = await osintReport.generateCombinedReport();
        sendJSON(res, 200, { ok: true, report });
      } catch (err) {
        log.bridge.error("OSINT combined report error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/correlate — run cross-profile correlation engine
    if (req.method === "POST" && pathname === "/osint/correlate") {
      try {
        const correlationEngine = require("./correlation-engine");
        // Run async — respond immediately
        sendJSON(res, 200, { ok: true, message: "Correlation started" });
        correlationEngine.runCorrelation().then((result) => {
          log.bridge.info(`[osint] Correlation complete: ${result.correlationsFound} correlations found`);
        }).catch((err) => {
          log.bridge.error("[osint] Correlation error:", err.message);
        });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/correlations — list cross-profile correlations
    if (req.method === "GET" && pathname === "/osint/correlations") {
      try {
        const filters = {};
        if (url.searchParams.get("minConfidence")) filters.minConfidence = parseFloat(url.searchParams.get("minConfidence"));
        if (url.searchParams.get("type")) filters.correlationType = url.searchParams.get("type");
        if (url.searchParams.get("profileId")) filters.profileId = parseInt(url.searchParams.get("profileId"), 10);
        if (url.searchParams.get("limit")) filters.limit = parseInt(url.searchParams.get("limit"), 10);
        const correlations = await db.getOsintCorrelations(filters);
        sendJSON(res, 200, { ok: true, correlations });
      } catch (err) {
        log.bridge.error("OSINT correlations error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/reports — generate and store a report
    if (req.method === "POST" && pathname === "/osint/reports") {
      try {
        const body = await parseBody(req);
        const { title, type, profileIds } = body;
        const osintReport = require("./osint-report");
        let report;
        if (profileIds && profileIds.length === 1) {
          report = await osintReport.generateReport(profileIds[0]);
        } else {
          report = await osintReport.generateCombinedReport();
        }
        // Get current score
        const scoreData = await db.getOsintFindingCounts();
        const totalFindings = scoreData.reduce((sum, row) => sum + parseInt(row.count, 10), 0);
        const profiles = await db.getOsintProfiles();
        const stored = await db.createOsintReport(
          title || `OSINT Report — ${new Date().toISOString().split("T")[0]}`,
          type || "full",
          report,
          profileIds || profiles.map((p) => p.id),
          totalFindings,
          (report.json?.summary?.critical || 0) * 10 + (report.json?.summary?.high || 0) * 5 + (report.json?.summary?.medium || 0) * 2 + (report.json?.summary?.low || 0)
        );
        sendJSON(res, 200, { ok: true, report: stored });
      } catch (err) {
        log.bridge.error("OSINT report generation error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/reports/:id — get full stored report (before /reports to avoid conflict)
    const reportsMatch = pathname.match(/^\/osint\/reports\/(\d+)$/);
    if (req.method === "GET" && reportsMatch) {
      try {
        const reportId = parseInt(reportsMatch[1], 10);
        const report = await db.getOsintReportById(reportId);
        if (!report) return sendJSON(res, 404, { error: "Report not found" });
        sendJSON(res, 200, { ok: true, report });
      } catch (err) {
        log.bridge.error("OSINT report detail error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/reports — list stored reports (summary only)
    if (req.method === "GET" && pathname === "/osint/reports") {
      try {
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);
        const reports = await db.getOsintReports(limit);
        sendJSON(res, 200, { ok: true, reports });
      } catch (err) {
        log.bridge.error("OSINT reports list error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/metrics/timeline — time-series for charts (before /metrics to avoid conflict)
    if (req.method === "GET" && pathname === "/osint/metrics/timeline") {
      try {
        const days = parseInt(url.searchParams.get("days") || "30", 10);
        const metricType = url.searchParams.get("type") || "scan_timing";
        const metrics = await db.getOsintMetrics({ metric_type: metricType, days, limit: 500 });
        sendJSON(res, 200, { ok: true, metrics, metricType, days });
      } catch (err) {
        log.bridge.error("OSINT metrics timeline error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/metrics/modules — per-module performance breakdown (before /metrics to avoid conflict)
    if (req.method === "GET" && pathname === "/osint/metrics/modules") {
      try {
        const days = parseInt(url.searchParams.get("days") || "30", 10);
        const metrics = await db.getOsintMetrics({ metric_type: "module_perf", days, limit: 1000 });
        // Aggregate by module name
        const byModule = {};
        for (const m of metrics) {
          const name = m.metadata?.module || "unknown";
          if (!byModule[name]) byModule[name] = { scans: 0, totalDuration: 0, totalFindings: 0, errors: 0 };
          byModule[name].scans++;
          byModule[name].totalDuration += m.value;
          byModule[name].totalFindings += m.metadata?.findings || 0;
          if (!m.metadata?.success) byModule[name].errors++;
        }
        const modules = Object.entries(byModule).map(([name, stats]) => ({
          name,
          scans: stats.scans,
          avgDuration: Math.round(stats.totalDuration / stats.scans),
          totalFindings: stats.totalFindings,
          successRate: stats.scans > 0 ? (stats.scans - stats.errors) / stats.scans : 0,
          errors: stats.errors,
        })).sort((a, b) => b.scans - a.scans);
        sendJSON(res, 200, { ok: true, modules });
      } catch (err) {
        log.bridge.error("OSINT module metrics error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/metrics — aggregated metrics summary
    if (req.method === "GET" && pathname === "/osint/metrics") {
      try {
        const days = parseInt(url.searchParams.get("days") || "30", 10);
        const summary = await db.getOsintMetricsSummary(days);

        // Time-to-lockdown: time from first profile to all profiles having at least one completed scan
        const profiles = await db.getOsintProfiles();
        let timeToLockdown = null;
        if (profiles.length > 0) {
          const earliest = profiles.reduce((min, p) => {
            const t = new Date(p.created_at).getTime();
            return t < min ? t : min;
          }, Infinity);
          const scanRes = await db.query(
            `SELECT profile_id, MAX(completed_at) as last_completed FROM osint_scans
             WHERE status = 'completed' GROUP BY profile_id`
          );
          const scannedProfiles = new Set(scanRes.rows.map((r) => r.profile_id));
          const allScanned = profiles.every((p) => scannedProfiles.has(p.id));
          if (allScanned && scanRes.rows.length > 0) {
            const latest = scanRes.rows.reduce((max, r) => {
              const t = new Date(r.last_completed).getTime();
              return t > max ? t : max;
            }, 0);
            timeToLockdown = latest - earliest;
          }
        }

        // Coverage metrics
        const correlations = await db.getOsintCorrelations();
        const profilesWithCorrelation = new Set();
        for (const c of correlations) {
          if (c.confidence >= 0.5) {
            profilesWithCorrelation.add(c.source_profile_id);
            profilesWithCorrelation.add(c.target_profile_id);
          }
        }
        const locations = await db.getOsintLocations({});
        const profilesWithLocation = new Set(locations.map((l) => l.profile_id));

        sendJSON(res, 200, {
          ok: true,
          summary,
          timeToLockdown,
          coverage: {
            totalProfiles: profiles.length,
            correlationCoverage: profiles.length > 0 ? profilesWithCorrelation.size / profiles.length : 0,
            locationCoverage: profiles.length > 0 ? profilesWithLocation.size / profiles.length : 0,
            profilesWithCorrelation: profilesWithCorrelation.size,
            profilesWithLocation: profilesWithLocation.size,
          },
        });
      } catch (err) {
        log.bridge.error("OSINT metrics error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/locations/:profileId — per-profile location signals (before /locations to avoid conflict)
    const locationProfileMatch = pathname.match(/^\/osint\/locations\/(\d+)$/);
    if (req.method === "GET" && locationProfileMatch) {
      try {
        const profileId = parseInt(locationProfileMatch[1], 10);
        const locations = await db.getOsintLocations({ profile_id: profileId });
        sendJSON(res, 200, { ok: true, locations });
      } catch (err) {
        log.bridge.error("OSINT profile locations error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/locations — all location signals with clustering
    if (req.method === "GET" && pathname === "/osint/locations") {
      try {
        const locations = await db.getOsintLocations({});
        // Cluster by proximity (50km) and text similarity
        const clusters = [];
        const used = new Set();
        for (let i = 0; i < locations.length; i++) {
          if (used.has(i)) continue;
          const cluster = { locations: [locations[i]], confidence: locations[i].confidence };
          used.add(i);
          for (let j = i + 1; j < locations.length; j++) {
            if (used.has(j)) continue;
            const a = locations[i];
            const b = locations[j];
            let match = false;
            // GPS proximity (within ~50km)
            if (a.latitude && b.latitude && a.longitude && b.longitude) {
              const dlat = Math.abs(a.latitude - b.latitude);
              const dlon = Math.abs(a.longitude - b.longitude);
              if (dlat < 0.45 && dlon < 0.45) match = true;
            }
            // Text similarity (case-insensitive containment)
            if (a.location_text && b.location_text) {
              const ta = a.location_text.toLowerCase();
              const tb = b.location_text.toLowerCase();
              if (ta.includes(tb) || tb.includes(ta)) match = true;
            }
            if (match) {
              cluster.locations.push(locations[j]);
              cluster.confidence = Math.max(cluster.confidence, locations[j].confidence);
              used.add(j);
            }
          }
          cluster.label = cluster.locations[0].location_text;
          cluster.sources = cluster.locations.length;
          clusters.push(cluster);
        }
        clusters.sort((a, b) => b.confidence - a.confidence);
        sendJSON(res, 200, { ok: true, locations, clusters });
      } catch (err) {
        log.bridge.error("OSINT locations error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/readiness — composite OSINT readiness score
    if (req.method === "GET" && pathname === "/osint/readiness") {
      try {
        const profiles = await db.getOsintProfiles();
        if (profiles.length === 0) {
          sendJSON(res, 200, { ok: true, readiness: 0, components: {}, message: "No profiles" });
          return true;
        }

        // 1. Exposure score (0-100)
        const { score: exposureScore } = await osintEngine.calculateExposureScore();

        // 2. Correlation coverage (0-100)
        const correlations = await db.getOsintCorrelations();
        const profilesWithCorr = new Set();
        for (const c of correlations) {
          if (c.confidence >= 0.5) {
            profilesWithCorr.add(c.source_profile_id);
            profilesWithCorr.add(c.target_profile_id);
          }
        }
        const correlationCoverage = (profilesWithCorr.size / profiles.length) * 100;

        // 3. Location coverage (0-100)
        const locations = await db.getOsintLocations({});
        const profilesWithLoc = new Set(locations.map((l) => l.profile_id));
        const locationCoverage = (profilesWithLoc.size / profiles.length) * 100;

        // 4. Scan freshness — % profiles scanned in last 24h (0-100)
        const scanRes = await db.query(
          `SELECT DISTINCT profile_id FROM osint_scans WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '24 hours'`
        );
        const recentlyScanned = scanRes.rows.length;
        const scanFreshness = (recentlyScanned / profiles.length) * 100;

        // 5. Module success rate — from recent metrics (0-100)
        const moduleMetrics = await db.getOsintMetrics({ metric_type: "module_perf", days: 7, limit: 500 });
        let moduleSuccessRate = 100;
        if (moduleMetrics.length > 0) {
          const successes = moduleMetrics.filter((m) => m.metadata?.success).length;
          moduleSuccessRate = (successes / moduleMetrics.length) * 100;
        }

        // Composite score
        const readiness = Math.round(
          exposureScore * 0.3 +
          correlationCoverage * 0.25 +
          locationCoverage * 0.15 +
          scanFreshness * 0.15 +
          moduleSuccessRate * 0.15
        );

        sendJSON(res, 200, {
          ok: true,
          readiness: Math.min(100, readiness),
          components: {
            exposure: Math.round(exposureScore),
            correlation: Math.round(correlationCoverage),
            location: Math.round(locationCoverage),
            freshness: Math.round(scanFreshness),
            moduleHealth: Math.round(moduleSuccessRate),
          },
        });
      } catch (err) {
        log.bridge.error("OSINT readiness error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── OSINT Remediations (Epic 7) ──

    // GET /osint/remediations/:profileId/stats — remediation progress stats (before /:id to avoid conflict)
    const remStatsMatch = pathname.match(/^\/osint\/remediations\/(\d+)\/stats$/);
    if (req.method === "GET" && remStatsMatch) {
      try {
        const profileId = parseInt(remStatsMatch[1]);
        const stats = await db.getOsintRemediationStats(profileId);
        sendJSON(res, 200, { ok: true, stats });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/remediations/:profileId/generate — auto-generate remediations from findings (before /:id to avoid conflict)
    const remGenMatch = pathname.match(/^\/osint\/remediations\/(\d+)\/generate$/);
    if (req.method === "POST" && remGenMatch) {
      try {
        const profileId = parseInt(remGenMatch[1]);
        const remEngine = require("./osint-remediation-engine");
        const created = await remEngine.generateForProfile(profileId);
        sendJSON(res, 200, { ok: true, generated: created.length, remediations: created });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/remediations/:profileId — list remediations for a profile
    const remListMatch = pathname.match(/^\/osint\/remediations\/(\d+)$/);
    if (req.method === "GET" && remListMatch) {
      try {
        const profileId = parseInt(remListMatch[1]);
        const status = url.searchParams.get("status") || undefined;
        const remediations = await db.getOsintRemediations(profileId, { status });
        sendJSON(res, 200, { ok: true, remediations });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /osint/remediations/item/:id — update a remediation (complete/dismiss)
    const remUpdateMatch = pathname.match(/^\/osint\/remediations\/item\/(\d+)$/);
    if (req.method === "PATCH" && remUpdateMatch) {
      try {
        const id = parseInt(remUpdateMatch[1]);
        const body = await parseBody(req);
        const updated = await db.updateOsintRemediation(id, body);
        if (!updated) {
          sendJSON(res, 404, { error: "Remediation not found" });
          return true;
        }
        sendJSON(res, 200, { ok: true, remediation: updated });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/remediations/stats — global remediation stats (before /remediations to avoid conflict)
    if (req.method === "GET" && pathname === "/osint/remediations/stats") {
      try {
        const profileId = url.searchParams.get("profileId") ? parseInt(url.searchParams.get("profileId")) : undefined;
        const stats = await db.getOsintRemediationStats(profileId);
        sendJSON(res, 200, { ok: true, stats });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/remediations/generate — generate for ALL profiles (before /remediations to avoid conflict)
    if (req.method === "POST" && pathname === "/osint/remediations/generate") {
      try {
        const remEngine = require("./osint-remediation-engine");
        const totalCreated = await remEngine.generateAll();
        sendJSON(res, 200, { ok: true, generated: totalCreated });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/remediations — list ALL remediations (global, filterable)
    if (req.method === "GET" && pathname === "/osint/remediations") {
      try {
        const status = url.searchParams.get("status") || undefined;
        const priority = url.searchParams.get("priority") ? parseInt(url.searchParams.get("priority")) : undefined;
        const profileId = url.searchParams.get("profileId") ? parseInt(url.searchParams.get("profileId")) : undefined;
        const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")) : 100;
        const remediations = await db.getOsintRemediations(profileId, { status, priority, limit });
        sendJSON(res, 200, { ok: true, remediations });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── OSINT SOC Incidents (Compliance) ──

    // GET /osint/incidents/stats — SOC dashboard stats (before /incidents to avoid conflict)
    if (req.method === "GET" && pathname === "/osint/incidents/stats") {
      try {
        const stats = await db.getOsintIncidentStats();
        sendJSON(res, 200, { ok: true, stats });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/incidents/generate — auto-create incidents from high/critical findings (before /incidents to avoid conflict)
    if (req.method === "POST" && pathname === "/osint/incidents/generate") {
      try {
        const profiles = await db.getOsintProfiles();
        let created = 0;
        for (const profile of profiles) {
          const findings = await db.getOsintFindings({ profileId: profile.id });
          const critical = findings.filter((f) => f.severity === "critical" || f.severity === "high");
          if (critical.length === 0) continue;

          // Group by module to create one incident per module with high/critical findings
          const byModule = {};
          for (const f of critical) {
            if (!byModule[f.module]) byModule[f.module] = [];
            byModule[f.module].push(f);
          }

          for (const [mod, modFindings] of Object.entries(byModule)) {
            const worstSev = modFindings.some((f) => f.severity === "critical") ? "critical" : "high";
            const incidentId = `INC-${profile.id}-${mod}-${Date.now().toString(36)}`.toUpperCase();

            // Map modules to NIST categories
            const nistMap = {
              "hibp-email": { classification: "data_breach", attackVector: "credential_compromise", nistPhase: "identification" },
              "hibp-password": { classification: "data_breach", attackVector: "credential_compromise", nistPhase: "containment" },
              "h8mail-cli": { classification: "data_breach", attackVector: "credential_compromise", nistPhase: "identification" },
              "leak-search": { classification: "data_breach", attackVector: "dark_web_exposure", nistPhase: "identification" },
              "darkweb-search": { classification: "exposure", attackVector: "dark_web_mention", nistPhase: "identification" },
              "dnstwist-scan": { classification: "phishing", attackVector: "typosquatting", nistPhase: "identification" },
              "crtsh-monitor": { classification: "infrastructure", attackVector: "certificate_abuse", nistPhase: "identification" },
              "domain-recon": { classification: "exposure", attackVector: "dns_reconnaissance", nistPhase: "identification" },
              "paste-monitor": { classification: "exposure", attackVector: "paste_site_leak", nistPhase: "identification" },
              "data-broker": { classification: "privacy", attackVector: "data_aggregation", nistPhase: "identification" },
              "ghunt-email": { classification: "privacy", attackVector: "google_profile_exposure", nistPhase: "identification" },
            };

            const nist = nistMap[mod] || { classification: "exposure", attackVector: "unknown", nistPhase: "identification" };

            const incident = await db.createOsintIncident({
              incidentId,
              title: `[${worstSev.toUpperCase()}] ${mod}: ${modFindings.length} finding(s) for ${profile.label || profile.value}`,
              description: modFindings.map((f) => `- ${f.title}`).join("\n"),
              severity: worstSev,
              category: modFindings[0].category || "exposure",
              profileId: profile.id,
              findingIds: modFindings.map((f) => f.id),
              classification: nist.classification,
              affectedAssets: [profile.value],
              attackVector: nist.attackVector,
              indicators: { module: mod, findingCount: modFindings.length, profileType: profile.profile_type },
            });
            if (incident) created++;
          }
        }
        sendJSON(res, 200, { ok: true, generated: created });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/incidents — list incidents (filterable by status, severity, profileId)
    if (req.method === "GET" && pathname === "/osint/incidents") {
      try {
        const incidents = await db.getOsintIncidents({
          status: url.searchParams.get("status") || undefined,
          severity: url.searchParams.get("severity") || undefined,
          profileId: url.searchParams.get("profileId") ? parseInt(url.searchParams.get("profileId")) : undefined,
        });
        sendJSON(res, 200, { ok: true, incidents });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/incidents — create an incident
    if (req.method === "POST" && pathname === "/osint/incidents") {
      try {
        const body = await parseBody(req);
        if (!body.title || !body.category) {
          sendJSON(res, 400, { error: "Required: title, category" });
          return true;
        }
        const incidentId = "INC-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).substring(2, 6).toUpperCase();
        const incident = await db.createOsintIncident({ incidentId, ...body });
        sendJSON(res, 201, { ok: true, incident });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/incidents/:id/timeline — add timeline event (before /:id to avoid conflict)
    const incTimelineMatch = pathname.match(/^\/osint\/incidents\/(\d+)\/timeline$/);
    if (req.method === "POST" && incTimelineMatch) {
      try {
        const id = parseInt(incTimelineMatch[1]);
        const body = await parseBody(req);
        const updated = await db.addIncidentTimelineEvent(id, body.action, body.actor || "cipher", body.details);
        if (!updated) { sendJSON(res, 404, { error: "Incident not found" }); return true; }
        sendJSON(res, 200, { ok: true, incident: updated });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /osint/incidents/:id — update incident status/severity/assignment
    const incUpdateMatch = pathname.match(/^\/osint\/incidents\/(\d+)$/);
    if (req.method === "PATCH" && incUpdateMatch) {
      try {
        const id = parseInt(incUpdateMatch[1]);
        const body = await parseBody(req);
        const updated = await db.updateOsintIncident(id, body);
        if (!updated) { sendJSON(res, 404, { error: "Incident not found" }); return true; }
        if (body.timelineAction) {
          await db.addIncidentTimelineEvent(id, body.timelineAction, body.actor || "cipher", body.timelineDetails);
        }
        sendJSON(res, 200, { ok: true, incident: updated });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/compliance/report — full SOC compliance report (NIST SP 800-61 format)
    if (req.method === "GET" && pathname === "/osint/compliance/report") {
      try {
        const incidents = await db.getOsintIncidents({});
        const profiles = await db.getOsintProfiles();
        const incidentStats = await db.getOsintIncidentStats();

        // Build NIST-aligned report
        const report = {
          reportId: "RPT-" + Date.now().toString(36).toUpperCase(),
          generatedAt: new Date().toISOString(),
          framework: "NIST SP 800-61 Rev. 2 (Incident Handling)",
          organization: "OZZU Security Operations",

          executiveSummary: {
            totalIncidents: incidentStats.total,
            openIncidents: incidentStats.open || 0,
            investigating: incidentStats.investigating || 0,
            contained: incidentStats.contained || 0,
            resolved: incidentStats.resolved || 0,
            criticalCount: incidentStats.bySeverity?.critical || 0,
            highCount: incidentStats.bySeverity?.high || 0,
            mediumCount: incidentStats.bySeverity?.medium || 0,
            lowCount: incidentStats.bySeverity?.low || 0,
            profilesCovered: profiles.length,
          },

          incidentCategories: {
            data_breach: incidents.filter((i) => i.classification === "data_breach").length,
            exposure: incidents.filter((i) => i.classification === "exposure").length,
            phishing: incidents.filter((i) => i.classification === "phishing").length,
            infrastructure: incidents.filter((i) => i.classification === "infrastructure").length,
            privacy: incidents.filter((i) => i.classification === "privacy").length,
          },

          nistPhaseDistribution: {
            preparation: incidents.filter((i) => i.nist_phase === "preparation").length,
            identification: incidents.filter((i) => i.nist_phase === "identification").length,
            containment: incidents.filter((i) => i.nist_phase === "containment").length,
            eradication: incidents.filter((i) => i.nist_phase === "eradication").length,
            recovery: incidents.filter((i) => i.nist_phase === "recovery").length,
            lessons_learned: incidents.filter((i) => i.nist_phase === "lessons_learned").length,
          },

          incidents: incidents.map((i) => ({
            incidentId: i.incident_id,
            title: i.title,
            severity: i.severity,
            status: i.status,
            classification: i.classification,
            nistPhase: i.nist_phase,
            attackVector: i.attack_vector,
            affectedAssets: i.affected_assets,
            profileLabel: i.profile_label,
            profileType: i.profile_type,
            createdAt: i.created_at,
            resolvedAt: i.resolved_at,
            timeline: i.timeline,
          })),

          assetsMonitored: profiles.map((p) => ({
            id: p.id,
            type: p.profile_type,
            value: p.value || p.label,
            incidentCount: incidents.filter((i) => i.profile_id === p.id).length,
          })),
        };

        sendJSON(res, 200, { ok: true, report });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── OSINT Per-Profile Scheduling (Epic 6) ──

    // GET /osint/schedule/:profileId — get per-profile schedule (before POST to check method)
    const schedProfileMatch = pathname.match(/^\/osint\/schedule\/(\d+)$/);
    if (req.method === "GET" && schedProfileMatch) {
      try {
        const profileId = parseInt(schedProfileMatch[1]);
        const schedules = await db.getOsintSchedules();
        const schedule = schedules.find((s) => s.profile_id === profileId);
        sendJSON(res, 200, { ok: true, schedule: schedule || null });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/schedule/:profileId — set per-profile schedule
    if (req.method === "POST" && schedProfileMatch) {
      try {
        const profileId = parseInt(schedProfileMatch[1]);
        const body = await parseBody(req);
        const intervalHours = body.intervalHours || 24;

        if (intervalHours <= 0) {
          await osintMonitor.removeSchedule(profileId);
          sendJSON(res, 200, { ok: true, message: "Schedule disabled" });
        } else {
          const sched = await osintMonitor.addSchedule(profileId, intervalHours, osintEngine.runScan);
          sendJSON(res, 200, { ok: true, schedule: sched });
        }
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── OSINT Groups API (Epic 6) ──

    // GET /osint/groups/:id/score — aggregate exposure score for group (before /:id to avoid conflict)
    const groupScoreMatch = pathname.match(/^\/osint\/groups\/(\d+)\/score$/);
    if (req.method === "GET" && groupScoreMatch) {
      try {
        const groupId = parseInt(groupScoreMatch[1]);
        const counts = await db.getOsintGroupScore(groupId);
        const WEIGHTS = { critical: 10, high: 5, medium: 2, low: 1, info: 0 };
        let rawScore = 0;
        let totalFindings = 0;
        const breakdown = {};
        for (const row of counts) {
          const weight = WEIGHTS[row.severity] || 0;
          const count = parseInt(row.count, 10);
          rawScore += weight * count;
          totalFindings += count;
          breakdown[row.severity] = count;
        }
        const score = rawScore === 0 ? 0 : Math.min(100, Math.round(Math.log(rawScore + 1) * 20));
        sendJSON(res, 200, { ok: true, score, breakdown, totalFindings });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/groups/:id/findings — all findings across group members (before /:id to avoid conflict)
    const groupFindingsMatch = pathname.match(/^\/osint\/groups\/(\d+)\/findings$/);
    if (req.method === "GET" && groupFindingsMatch) {
      try {
        const groupId = parseInt(groupFindingsMatch[1]);
        const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")) : 100;
        const findings = await db.getOsintGroupFindings(groupId, limit);
        sendJSON(res, 200, { ok: true, findings });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /osint/groups/:id — update group
    const groupPatchMatch = pathname.match(/^\/osint\/groups\/(\d+)$/);
    if (req.method === "PATCH" && groupPatchMatch) {
      try {
        const body = await parseBody(req);
        const group = await db.updateOsintGroup(parseInt(groupPatchMatch[1]), body);
        sendJSON(res, 200, { ok: true, group });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /osint/groups/:id — delete group
    const groupDeleteMatch = pathname.match(/^\/osint\/groups\/(\d+)$/);
    if (req.method === "DELETE" && groupDeleteMatch) {
      try {
        await db.deleteOsintGroup(parseInt(groupDeleteMatch[1]));
        sendJSON(res, 200, { ok: true });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /osint/groups — create group
    if (req.method === "POST" && pathname === "/osint/groups") {
      try {
        const body = await parseBody(req);
        const group = await db.createOsintGroup(body);
        sendJSON(res, 200, { ok: true, group });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/groups — list groups with member count + aggregate score
    if (req.method === "GET" && pathname === "/osint/groups") {
      try {
        const groups = await db.getOsintGroups();
        sendJSON(res, 200, { ok: true, groups });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /osint/profiles/:id/group — assign profile to group
    const profileGroupMatch = pathname.match(/^\/osint\/profiles\/(\d+)\/group$/);
    if (req.method === "PATCH" && profileGroupMatch) {
      try {
        const body = await parseBody(req);
        const profile = await db.assignProfileToGroup(parseInt(profileGroupMatch[1]), body.groupId || null);
        sendJSON(res, 200, { ok: true, profile });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── OSINT Tools Status (Epic 6) ──

    // GET /osint/tools/status — CLI tool health check
    if (req.method === "GET" && pathname === "/osint/tools/status") {
      try {
        const status = await cliRunner.healthCheck();
        sendJSON(res, 200, { ok: true, ...status });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── Identity Clusters (Hardening Epic) ──

    // GET /osint/identity-clusters — list identity clusters
    if (req.method === "GET" && pathname === "/osint/identity-clusters") {
      try {
        const minConfidence = parseInt(url.searchParams.get("minConfidence") || "0", 10);
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const clusters = await db.getIdentityClusters({ minConfidence, limit });
        sendJSON(res, 200, { ok: true, clusters });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/timeline — activity timeline (scans, findings, alerts)
    if (req.method === "GET" && pathname === "/osint/timeline") {
      try {
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const profileId = url.searchParams.get("profileId");
        const events = [];

        // Get recent scans
        const scans = await db.getOsintScans(profileId ? parseInt(profileId, 10) : undefined);
        for (const s of (scans || []).slice(0, limit)) {
          events.push({
            type: "scan",
            timestamp: s.created_at,
            title: `Scan ${s.status} — ${s.findings_count || 0} findings`,
            severity: s.status === "failed" ? "high" : "info",
            data: { scanId: s.id, status: s.status, modules: s.modules, findingsCount: s.findings_count },
          });
        }

        // Get recent findings (new ones)
        const findingFilters = { limit, sortBy: "created_at" };
        if (profileId) findingFilters.profileId = parseInt(profileId, 10);
        const findings = await db.getOsintFindings(findingFilters);
        for (const f of (findings || []).slice(0, limit)) {
          events.push({
            type: "finding",
            timestamp: f.first_seen_at || f.created_at,
            title: f.title,
            severity: f.severity,
            data: { findingId: f.id, module: f.module, category: f.category, status: f.status },
          });
        }

        // Get recent alerts
        const alerts = await db.getOsintAlerts({ limit });
        for (const a of (alerts || []).slice(0, limit)) {
          events.push({
            type: "alert",
            timestamp: a.created_at,
            title: a.title,
            severity: a.severity,
            data: { alertId: a.id, alertType: a.alert_type, read: a.read },
          });
        }

        // Sort by timestamp descending
        events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        sendJSON(res, 200, { ok: true, events: events.slice(0, limit) });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/dossier — generate dossier (combined or per-profile)
    // GET /osint/dossier/:profileId?days=30
    const dossierMatch = pathname.match(/^\/osint\/dossier(?:\/(\d+))?$/);
    if (req.method === "GET" && dossierMatch) {
      try {
        const { generateDossier, dossierToMarkdown } = require("../osint-dossier-generator");
        const profileId = dossierMatch[1] ? parseInt(dossierMatch[1]) : null;
        const days = parseInt(url.searchParams.get("days") || "30");
        const format = url.searchParams.get("format") || "json";
        const dossier = await generateDossier(profileId, days);

        if (format === "markdown") {
          const md = dossierToMarkdown(dossier);
          res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
          res.end(md);
        } else {
          sendJSON(res, 200, { ok: true, dossier });
        }
      } catch (err) {
        log.bridge.error("Dossier generation error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── Investigation Endpoints ──

    // POST /osint/investigations — create investigation from image profile
    if (req.method === "POST" && pathname === "/osint/investigations") {
      try {
        const body = await parseBody(req);
        const pivotEngine = require("../osint-pivot-engine");
        const inv = await pivotEngine.createInvestigation(body.seedProfileId, body.name, body.config);
        if (!inv) { sendJSON(res, 500, { error: "Failed to create investigation" }); return true; }
        // Link seed profile to investigation
        if (body.seedProfileId) {
          await db.updateOsintProfilePivot(body.seedProfileId, { investigation_id: inv.id, pivot_depth: 0 });
        }
        sendJSON(res, 201, { ok: true, investigation: inv });
      } catch (err) {
        log.bridge.error("Investigation create error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/investigations — list all investigations
    if (req.method === "GET" && pathname === "/osint/investigations") {
      try {
        const pivotEngine = require("../osint-pivot-engine");
        const investigations = await pivotEngine.getInvestigations();
        sendJSON(res, 200, investigations);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /osint/investigations/:id — get investigation details
    const invMatch = pathname.match(/^\/osint\/investigations\/(\d+)$/);
    if (req.method === "GET" && invMatch) {
      try {
        const pivotEngine = require("../osint-pivot-engine");
        const inv = await pivotEngine.getInvestigation(parseInt(invMatch[1]));
        if (!inv) { sendJSON(res, 404, { error: "Investigation not found" }); return true; }
        // Get linked profiles
        const profiles = await db.getOsintProfiles();
        const linked = profiles.filter(p => p.investigation_id === inv.id);
        sendJSON(res, 200, { investigation: inv, profiles: linked });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── EKF Endpoints ──

    // GET /osint/ekf/:profileId — get EKF state for a profile
    const ekfMatch = pathname.match(/^\/osint\/ekf\/(\d+)$/);
    if (req.method === "GET" && ekfMatch) {
      try {
        const ekfEngine = require("../osint-ekf-engine");
        const profileId = parseInt(ekfMatch[1]);
        const ekfState = await db.getOsintEkfState(profileId);
        if (!ekfState) {
          sendJSON(res, 200, { state: null, summary: null });
          return true;
        }
        const state = {
          x: ekfState.state_vector,
          P: ekfState.covariance_matrix,
          observationCount: ekfState.observation_count,
        };
        const summary = ekfEngine.getStateSummary(state);
        sendJSON(res, 200, { state: ekfState, summary });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    return false;
  };
};
