"use strict";

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

    return false;
  };
};
