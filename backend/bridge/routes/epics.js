"use strict";

module.exports = function epicsRoutes(ctx) {
  const {
    sendJSON,
    parseBody,
    log,
    getEpics,
    saveEpics,
    deriveEpicStatus,
    getEpicProgress,
    updateEpicProgress,
    getNextEpicPhase,
    getDirectives,
  } = ctx;

  // ctx._epics — the mutable epics array
  return async function(req, res, pathname, url) {

    // ── Epic/Project Endpoints ──

    // POST /epics — create a multi-phase epic
    if (req.method === "POST" && pathname === "/epics") {
      try {
        const data = await parseBody(req);
        if (!data.title || !data.phases || !Array.isArray(data.phases) || data.phases.length === 0) {
          sendJSON(res, 400, { error: "Required: title, phases (array of {title, description})" });
          return true;
        }
        const epic = {
          id: `epic_${Date.now()}`,
          title: data.title,
          description: data.description || "",
          emoji: data.emoji || "📦",
          status: "pending",
          phases: data.phases.map((p, i) => ({
            phase: i + 1,
            title: p.title,
            description: p.description || "",
            directiveId: null,
            status: "pending",
          })),
          progress: 0,
          createdBy: data.createdBy || "cipher",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          completedAt: null,
        };
        ctx._epics.push(epic);
        saveEpics(ctx._epics);
        sendJSON(res, 201, { ok: true, epic });
      } catch (err) {
        log.bridge.error("Create epic error:", err.message);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /epics — list all epics
    if (req.method === "GET" && pathname === "/epics") {
      const statusFilter = url.searchParams.get("status");
      let epics = getEpics();
      // Refresh progress from directive statuses
      for (const epic of epics) updateEpicProgress(epic.id);
      if (statusFilter) epics = epics.filter(e => e.status === statusFilter);
      sendJSON(res, 200, epics);
      return true;
    }

    // GET /epics/:id — single epic with phase details
    // PATCH /epics/:id — update epic (title, description, status)
    const epicGetMatch = pathname.match(/^\/epics\/([^/]+)$/);

    if (req.method === "GET" && epicGetMatch) {
      const id = epicGetMatch[1];
      const epic = ctx._epics.find(e => e.id === id);
      if (!epic) { sendJSON(res, 404, { error: "Epic not found" }); return true; }
      updateEpicProgress(id);
      // Enrich phases with directive details
      const directives = getDirectives();
      const enrichedPhases = epic.phases.map(p => {
        const dir = p.directiveId ? directives.find(d => d.id === p.directiveId) : null;
        return { ...p, directive: dir || null };
      });
      sendJSON(res, 200, { ...epic, phases: enrichedPhases });
      return true;
    }

    if (req.method === "PATCH" && epicGetMatch) {
      try {
        const id = epicGetMatch[1];
        const data = await parseBody(req);
        const epic = ctx._epics.find(e => e.id === id);
        if (!epic) { sendJSON(res, 404, { error: "Epic not found" }); return true; }
        if (data.title) epic.title = data.title;
        if (data.description !== undefined) epic.description = data.description;
        if (data.status) epic.status = data.status;
        if (data.emoji) epic.emoji = data.emoji;
        epic.updatedAt = Date.now();
        saveEpics(ctx._epics);
        sendJSON(res, 200, { ok: true, epic });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /epics/:id/link-phase — link a directive to an epic phase
    const epicLinkMatch = pathname.match(/^\/epics\/([^/]+)\/link-phase$/);
    if (req.method === "POST" && epicLinkMatch) {
      try {
        const epicId = epicLinkMatch[1];
        const data = await parseBody(req);
        const epic = ctx._epics.find(e => e.id === epicId);
        if (!epic) { sendJSON(res, 404, { error: "Epic not found" }); return true; }
        const phase = epic.phases.find(p => p.phase === data.phase);
        if (!phase) { sendJSON(res, 400, { error: `Phase ${data.phase} not found` }); return true; }
        if (!data.directiveId) { sendJSON(res, 400, { error: "directiveId required" }); return true; }
        phase.directiveId = data.directiveId;
        updateEpicProgress(epicId);
        sendJSON(res, 200, { ok: true, epic });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /epics/:id/next — get the next pending phase (for Cipher to know what to work on)
    const epicNextMatch = pathname.match(/^\/epics\/([^/]+)\/next$/);
    if (req.method === "GET" && epicNextMatch) {
      const epicId = epicNextMatch[1];
      const epic = ctx._epics.find(e => e.id === epicId);
      if (!epic) { sendJSON(res, 404, { error: "Epic not found" }); return true; }
      updateEpicProgress(epicId);
      const next = getNextEpicPhase(epicId);
      sendJSON(res, 200, { epic: { id: epic.id, title: epic.title, progress: epic.progress }, nextPhase: next });
      return true;
    }

    return false;
  };
};
