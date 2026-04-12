"use strict";

const COLLECTOR_URL = process.env.COLLECTOR_URL || "http://172.17.0.1:3335";

module.exports = function knowledgeGraphRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  return async function(req, res, pathname, url) {

    // ── Subjects ──

    // POST /kg/subjects — create or upsert a subject
    if (req.method === "POST" && pathname === "/kg/subjects") {
      try {
        const body = await parseBody(req);
        if (!body.name) { sendJSON(res, 400, { error: "name is required" }); return true; }
        const subject = await db.kgCreateSubject(body);
        sendJSON(res, 201, { ok: true, subject });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /kg/subjects — list subjects
    if (req.method === "GET" && pathname === "/kg/subjects") {
      try {
        const filters = {};
        if (url.searchParams.get("type")) filters.subject_type = url.searchParams.get("type");
        if (url.searchParams.get("status")) filters.status = url.searchParams.get("status");
        if (url.searchParams.get("q")) filters.search = url.searchParams.get("q");
        const subjects = await db.kgGetSubjects(filters);
        sendJSON(res, 200, subjects);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /kg/subjects/:id — get subject detail
    const subjectMatch = pathname.match(/^\/kg\/subjects\/(\d+)$/);
    if (req.method === "GET" && subjectMatch) {
      try {
        const subject = await db.kgGetSubject(parseInt(subjectMatch[1]));
        if (!subject) { sendJSON(res, 404, { error: "Subject not found" }); return true; }
        sendJSON(res, 200, subject);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PUT /kg/subjects/:id — update subject
    if (req.method === "PUT" && subjectMatch) {
      try {
        const body = await parseBody(req);
        const subject = await db.kgUpdateSubject(parseInt(subjectMatch[1]), body);
        if (!subject) { sendJSON(res, 404, { error: "Subject not found" }); return true; }
        sendJSON(res, 200, { ok: true, subject });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /kg/subjects/:id — delete subject and all related data
    if (req.method === "DELETE" && subjectMatch) {
      try {
        const deleted = await db.kgDeleteSubject(parseInt(subjectMatch[1]));
        sendJSON(res, deleted ? 200 : 404, { ok: deleted });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /kg/subjects/:id/dossier — full intelligence dossier
    const dossierMatch = pathname.match(/^\/kg\/subjects\/(\d+)\/dossier$/);
    if (req.method === "GET" && dossierMatch) {
      try {
        const dossier = await db.kgGetDossier(parseInt(dossierMatch[1]));
        if (!dossier) { sendJSON(res, 404, { error: "Subject not found" }); return true; }
        sendJSON(res, 200, dossier);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── Anchors ──

    // POST /kg/subjects/:id/anchors — add anchor to subject
    const anchorPostMatch = pathname.match(/^\/kg\/subjects\/(\d+)\/anchors$/);
    if (req.method === "POST" && anchorPostMatch) {
      try {
        const body = await parseBody(req);
        body.subject_id = parseInt(anchorPostMatch[1]);
        if (!body.anchor_type || !body.value) {
          sendJSON(res, 400, { error: "anchor_type and value are required" }); return true;
        }
        const anchor = await db.kgAddAnchor(body);
        sendJSON(res, 201, { ok: true, anchor });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /kg/subjects/:id/anchors — list anchors for subject
    if (req.method === "GET" && anchorPostMatch) {
      try {
        const anchors = await db.kgGetAnchors(parseInt(anchorPostMatch[1]));
        sendJSON(res, 200, anchors);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /kg/anchors/:id — delete anchor
    const anchorDeleteMatch = pathname.match(/^\/kg\/anchors\/(\d+)$/);
    if (req.method === "DELETE" && anchorDeleteMatch) {
      try {
        const deleted = await db.kgDeleteAnchor(parseInt(anchorDeleteMatch[1]));
        sendJSON(res, deleted ? 200 : 404, { ok: deleted });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── Facts ──

    // POST /kg/subjects/:id/facts — add fact
    const factPostMatch = pathname.match(/^\/kg\/subjects\/(\d+)\/facts$/);
    if (req.method === "POST" && factPostMatch) {
      try {
        const body = await parseBody(req);
        body.subject_id = parseInt(factPostMatch[1]);
        if (!body.category || !body.key || !body.value) {
          sendJSON(res, 400, { error: "category, key, and value are required" }); return true;
        }
        const fact = await db.kgAddFact(body);
        sendJSON(res, 201, { ok: true, fact });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /kg/subjects/:id/facts — list facts
    if (req.method === "GET" && factPostMatch) {
      try {
        const category = url.searchParams.get("category");
        const facts = await db.kgGetFacts(parseInt(factPostMatch[1]), category);
        sendJSON(res, 200, facts);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PUT /kg/facts/:id — update fact
    const factUpdateMatch = pathname.match(/^\/kg\/facts\/(\d+)$/);
    if (req.method === "PUT" && factUpdateMatch) {
      try {
        const body = await parseBody(req);
        const fact = await db.kgUpdateFact(parseInt(factUpdateMatch[1]), body);
        if (!fact) { sendJSON(res, 404, { error: "Fact not found" }); return true; }
        sendJSON(res, 200, { ok: true, fact });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /kg/facts/:id — delete fact
    if (req.method === "DELETE" && factUpdateMatch) {
      try {
        const deleted = await db.kgDeleteFact(parseInt(factUpdateMatch[1]));
        sendJSON(res, deleted ? 200 : 404, { ok: deleted });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── Timeline ──

    // POST /kg/subjects/:id/timeline — add event
    const timelineMatch = pathname.match(/^\/kg\/subjects\/(\d+)\/timeline$/);
    if (req.method === "POST" && timelineMatch) {
      try {
        const body = await parseBody(req);
        body.subject_id = parseInt(timelineMatch[1]);
        if (!body.event_type || !body.title) {
          sendJSON(res, 400, { error: "event_type and title are required" }); return true;
        }
        const event = await db.kgAddEvent(body);
        sendJSON(res, 201, { ok: true, event });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /kg/subjects/:id/timeline — list events
    if (req.method === "GET" && timelineMatch) {
      try {
        const eventType = url.searchParams.get("type");
        const events = await db.kgGetTimeline(parseInt(timelineMatch[1]), eventType);
        sendJSON(res, 200, events);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /kg/timeline/:id — delete event
    const timelineDeleteMatch = pathname.match(/^\/kg\/timeline\/(\d+)$/);
    if (req.method === "DELETE" && timelineDeleteMatch) {
      try {
        const deleted = await db.kgDeleteEvent(parseInt(timelineDeleteMatch[1]));
        sendJSON(res, deleted ? 200 : 404, { ok: deleted });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── Connections ──

    // POST /kg/connections — create connection between subjects
    if (req.method === "POST" && pathname === "/kg/connections") {
      try {
        const body = await parseBody(req);
        if (!body.source_id || !body.target_id || !body.relationship) {
          sendJSON(res, 400, { error: "source_id, target_id, and relationship are required" }); return true;
        }
        const conn = await db.kgAddConnection(body);
        sendJSON(res, 201, { ok: true, connection: conn });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /kg/subjects/:id/connections — list connections for subject
    const connMatch = pathname.match(/^\/kg\/subjects\/(\d+)\/connections$/);
    if (req.method === "GET" && connMatch) {
      try {
        const connections = await db.kgGetConnections(parseInt(connMatch[1]));
        sendJSON(res, 200, connections);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /kg/connections/:id — delete connection
    const connDeleteMatch = pathname.match(/^\/kg\/connections\/(\d+)$/);
    if (req.method === "DELETE" && connDeleteMatch) {
      try {
        const deleted = await db.kgDeleteConnection(parseInt(connDeleteMatch[1]));
        sendJSON(res, deleted ? 200 : 404, { ok: deleted });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── Observations ──

    // POST /kg/subjects/:id/observations — add observation
    const obsMatch = pathname.match(/^\/kg\/subjects\/(\d+)\/observations$/);
    if (req.method === "POST" && obsMatch) {
      try {
        const body = await parseBody(req);
        body.subject_id = parseInt(obsMatch[1]);
        if (!body.platform || !body.observation_type) {
          sendJSON(res, 400, { error: "platform and observation_type are required" }); return true;
        }
        const obs = await db.kgAddObservation(body);
        sendJSON(res, 201, { ok: true, observation: obs });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /kg/subjects/:id/observations — list observations
    if (req.method === "GET" && obsMatch) {
      try {
        const filters = {};
        if (url.searchParams.get("platform")) filters.platform = url.searchParams.get("platform");
        if (url.searchParams.get("type")) filters.observation_type = url.searchParams.get("type");
        if (url.searchParams.get("limit")) filters.limit = parseInt(url.searchParams.get("limit"));
        const observations = await db.kgGetObservations(parseInt(obsMatch[1]), filters);
        sendJSON(res, 200, observations);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── ANALYZE stage — query, search, diffs, stats ──

    // GET /kg/stats — pipeline statistics
    if (req.method === "GET" && pathname === "/kg/stats") {
      try {
        const stats = await db.kgGetStats();
        sendJSON(res, 200, stats);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /kg/query — natural language search across the KG
    if (req.method === "POST" && pathname === "/kg/query") {
      try {
        const body = await parseBody(req);
        if (!body.q) { sendJSON(res, 400, { error: "q is required" }); return true; }

        // Search observations, subjects, and facts
        const [observations, subjects, facts] = await Promise.all([
          db.kgSearchObservations(body.q, { platform: body.platform, subject_id: body.subject_id }),
          db.kgGetSubjects({ search: body.q }),
          db.query(
            `SELECT f.*, s.name as subject_name FROM kg_facts f
             JOIN kg_subjects s ON f.subject_id = s.id
             WHERE f.value ILIKE $1 OR f.key ILIKE $1 LIMIT 20`,
            [`%${body.q}%`]
          ).then(r => r.rows).catch(() => []),
        ]);

        sendJSON(res, 200, {
          query: body.q,
          results: {
            subjects: subjects.slice(0, 10),
            observations: observations.slice(0, 20),
            facts,
          },
          total: subjects.length + observations.length + facts.length,
        });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /kg/subjects/:id/diffs — profile change detection
    const diffsMatch = pathname.match(/^\/kg\/subjects\/(\d+)\/diffs$/);
    if (req.method === "GET" && diffsMatch) {
      try {
        const subjectId = parseInt(diffsMatch[1]);
        const platform = url.searchParams.get("platform") || "twitter";
        const diffs = await db.kgGetObservationDiffs(subjectId, platform);
        sendJSON(res, 200, { subject_id: subjectId, platform, diffs });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /kg/enrich-now — manually trigger NLP enrichment for pending observations
    if (req.method === "POST" && pathname === "/kg/enrich-now") {
      try {
        const unenriched = await db.kgGetUnenrichedObservations(5);
        if (unenriched.length === 0) {
          sendJSON(res, 200, { ok: true, message: "No observations pending enrichment" });
          return true;
        }
        // Return immediately, enrichment happens on next KAIROS tick
        sendJSON(res, 202, {
          ok: true,
          message: `${unenriched.length} observation(s) pending — will be enriched on next KAIROS tick (15 min)`,
          pending: unenriched.map(o => ({ id: o.id, subject: o.subject_name, platform: o.platform })),
        });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── Collector (proxied to host collector service) ──

    // POST /kg/auto-discover — run full automated discovery pipeline on a subject
    if (req.method === "POST" && pathname === "/kg/auto-discover") {
      try {
        const body = await parseBody(req);
        if (!body.subject_id) {
          sendJSON(res, 400, { error: "subject_id is required" }); return true;
        }

        // Proxy to collector service
        fetch(`${COLLECTOR_URL}/auto-discover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject_id: body.subject_id,
            skipHolehe: body.skip_holehe || false,
            skipCollect: body.skip_collect || false,
            skipDiscover: body.skip_discover || false,
          }),
          signal: AbortSignal.timeout(10000),
        })
          .then(r => r.json())
          .then(result => {
            console.log(`[kg] Auto-discover started for subject ${body.subject_id}`);
          })
          .catch(err => {
            console.error(`[kg] Auto-discover trigger failed:`, err.message);
          });

        sendJSON(res, 202, { ok: true, message: "Auto-discovery pipeline started (full OSINT suite)" });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /kg/osint-tool — run a specific OSINT tool on a subject
    if (req.method === "POST" && pathname === "/kg/osint-tool") {
      try {
        const body = await parseBody(req);
        if (!body.tool || !body.target) {
          sendJSON(res, 400, { error: "tool and target are required" }); return true;
        }

        const { runSherlock, runMaigret, runH8mail, runPhoneInfoga, runTheHarvester, runSocidExtractor } = require("../influence/auto-discover");

        let result;
        switch (body.tool) {
          case "sherlock": result = await runSherlock(body.target); break;
          case "maigret": result = await runMaigret(body.target); break;
          case "h8mail": result = await runH8mail(body.target); break;
          case "phoneinfoga": result = await runPhoneInfoga(body.target); break;
          case "theHarvester": result = await runTheHarvester(body.target); break;
          case "socid_extractor": result = await runSocidExtractor(body.target); break;
          default: sendJSON(res, 400, { error: `Unknown tool: ${body.tool}. Available: sherlock, maigret, h8mail, phoneinfoga, theHarvester, socid_extractor` }); return true;
        }

        sendJSON(res, 200, { ok: true, tool: body.tool, target: body.target, result });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /kg/osint-health — check OSINT tool availability
    if (req.method === "GET" && pathname === "/kg/osint-health") {
      try {
        const cliRunner = require("../osint-cli-runner");
        const health = await cliRunner.healthCheck();
        sendJSON(res, 200, health);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /kg/discover — trigger network discovery from a subject
    if (req.method === "POST" && pathname === "/kg/discover") {
      try {
        const body = await parseBody(req);
        if (!body.subject_id) {
          sendJSON(res, 400, { error: "subject_id is required" }); return true;
        }

        // Get Twitter anchor for the subject
        const anchors = await db.kgGetAnchors(body.subject_id);
        const twitterAnchor = anchors.find(a =>
          a.anchor_type === "social_handle" && (a.platform === "twitter" || a.platform === "x")
        );
        if (!twitterAnchor) {
          sendJSON(res, 400, { error: "Subject has no Twitter anchor" }); return true;
        }

        // Proxy to collector service
        fetch(`${COLLECTOR_URL}/discover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subject_id: body.subject_id,
            handle: twitterAnchor.value,
            list_type: body.list_type || "following",
            max: body.max || 50,
            scroll_passes: body.scroll_passes || 10,
            auto_collect: body.auto_collect || false,
          }),
        })
          .then(r => r.json())
          .then(result => {
            console.log(`[kg] Discovery from subject ${body.subject_id}:`, result.ok ? `${result.discovered} new` : result.error);
          })
          .catch(err => {
            console.error(`[kg] Discovery failed:`, err.message);
          });

        sendJSON(res, 202, { ok: true, message: `Discovery started from @${twitterAnchor.value}` });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /kg/collect — trigger a collection job
    if (req.method === "POST" && pathname === "/kg/collect") {
      try {
        const body = await parseBody(req);
        if (!body.platform || !body.action || !body.subject_id) {
          sendJSON(res, 400, { error: "platform, action, and subject_id are required" }); return true;
        }

        // Track the collection
        const coll = await db.kgCreateCollection({
          subject_id: body.subject_id,
          platform: body.platform,
          collection_type: body.action,
        });

        // Proxy to collector service (runs on host with ADB access)
        fetch(`${COLLECTOR_URL}/collect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
          .then((r) => r.json())
          .then(async (result) => {
            await db.kgCompleteCollection(coll.id, result.result?.items || 1, result.ok ? null : result.error);
            console.log(`[kg] Collection ${coll.id} completed:`, result.ok ? "success" : result.error);
          })
          .catch(async (err) => {
            await db.kgCompleteCollection(coll.id, 0, err.message);
            console.error(`[kg] Collection ${coll.id} failed:`, err.message);
          });

        sendJSON(res, 202, { ok: true, collection_id: coll.id, message: "Collection started" });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /kg/device — get current Redroid device state
    if (req.method === "GET" && pathname === "/kg/device") {
      try {
        const resp = await fetch(`${COLLECTOR_URL}/device`);
        const state = await resp.json();
        sendJSON(res, 200, state);
      } catch (err) {
        sendJSON(res, 200, { foreground_app: null, adb_connected: false, error: err.message });
      }
      return true;
    }

    // POST /kg/solve-captcha — detect and solve CAPTCHA on current WebView
    if (req.method === "POST" && pathname === "/kg/solve-captcha") {
      try {
        const body = await parseBody(req);
        const resp = await fetch(`${COLLECTOR_URL}/solve-captcha`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = await resp.json();
        sendJSON(res, 200, result);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    return false;
  };
};
