"use strict";

module.exports = function businessRoutes(ctx) {
  const { sendJSON, parseBody, db, CORS_HEADERS } = ctx;

  return async function (req, res, pathname, url) {
    // GET /business/projects — list all with task counts
    if (req.method === "GET" && pathname === "/business/projects") {
      try {
        const projects = await db.getBusinessProjects();
        sendJSON(res, 200, projects);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /business/projects — create project
    if (req.method === "POST" && pathname === "/business/projects") {
      try {
        const body = await parseBody(req);
        if (!body.name) {
          sendJSON(res, 400, { error: "name is required" });
          return true;
        }
        const project = await db.createBusinessProject(body);
        sendJSON(res, 201, { ok: true, project });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /business/projects/:id — get project + tasks
    const projectMatch = pathname.match(/^\/business\/projects\/(\d+)$/);
    if (req.method === "GET" && projectMatch) {
      try {
        const project = await db.getBusinessProject(parseInt(projectMatch[1]));
        if (!project) {
          sendJSON(res, 404, { error: "project not found" });
          return true;
        }
        sendJSON(res, 200, project);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /business/projects/:id — update project
    if (req.method === "PATCH" && projectMatch) {
      try {
        const body = await parseBody(req);
        const project = await db.updateBusinessProject(parseInt(projectMatch[1]), body);
        if (!project) {
          sendJSON(res, 404, { error: "project not found" });
          return true;
        }
        sendJSON(res, 200, { ok: true, project });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /business/projects/:id — archive (soft delete)
    if (req.method === "DELETE" && projectMatch) {
      try {
        const ok = await db.archiveBusinessProject(parseInt(projectMatch[1]));
        sendJSON(res, ok ? 200 : 404, { ok });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /business/projects/:id/tasks — create task
    const taskCreateMatch = pathname.match(/^\/business\/projects\/(\d+)\/tasks$/);
    if (req.method === "POST" && taskCreateMatch) {
      try {
        const body = await parseBody(req);
        if (!body.title) {
          sendJSON(res, 400, { error: "title is required" });
          return true;
        }
        body.project_id = parseInt(taskCreateMatch[1]);
        const task = await db.createBusinessTask(body);
        sendJSON(res, 201, { ok: true, task });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /business/tasks/:id — update task
    const taskMatch = pathname.match(/^\/business\/tasks\/(\d+)$/);
    if (req.method === "PATCH" && taskMatch) {
      try {
        const body = await parseBody(req);
        const task = await db.updateBusinessTask(parseInt(taskMatch[1]), body);
        if (!task) {
          sendJSON(res, 404, { error: "task not found" });
          return true;
        }
        sendJSON(res, 200, { ok: true, task });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /business/tasks/:id — delete task
    if (req.method === "DELETE" && taskMatch) {
      try {
        const ok = await db.deleteBusinessTask(parseInt(taskMatch[1]));
        sendJSON(res, ok ? 200 : 404, { ok });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /business/tasks/:id/status — quick toggle
    const statusMatch = pathname.match(/^\/business\/tasks\/(\d+)\/status$/);
    if (req.method === "PATCH" && statusMatch) {
      try {
        const task = await db.toggleBusinessTaskStatus(parseInt(statusMatch[1]));
        if (!task) {
          sendJSON(res, 404, { error: "task not found" });
          return true;
        }
        sendJSON(res, 200, { ok: true, task });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    return false;
  };
};
