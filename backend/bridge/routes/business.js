"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ATTACHMENTS_DIR = "/tmp/ozzu-bridge/business-attachments";

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

    // POST /business/tasks/:id/attachments — upload file (base64 JSON body)
    const attachUploadMatch = pathname.match(/^\/business\/tasks\/(\d+)\/attachments$/);
    if (req.method === "POST" && attachUploadMatch) {
      try {
        const taskId = parseInt(attachUploadMatch[1]);
        const body = await parseBody(req);
        if (!body.base64 || !body.fileName) {
          sendJSON(res, 400, { error: "base64 and fileName are required" });
          return true;
        }
        const buf = Buffer.from(body.base64, "base64");
        if (buf.length > 15 * 1024 * 1024) {
          sendJSON(res, 400, { error: "File too large (max 15MB)" });
          return true;
        }
        const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
        const ext = path.extname(body.fileName) || ".bin";
        const fileName = `${hash}${ext}`;
        fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
        const filePath = path.join(ATTACHMENTS_DIR, fileName);
        fs.writeFileSync(filePath, buf);

        let thumbnailPath = null;
        const fileType = body.fileType || (ext.match(/\.pdf$/i) ? "document" : "image");
        const mimeType = body.mimeType || (fileType === "document" ? "application/pdf" : "image/jpeg");

        if (fileType === "image") {
          try {
            const sharp = require("sharp");
            thumbnailPath = path.join(ATTACHMENTS_DIR, `thumb-${hash}.jpg`);
            await sharp(buf).resize(256, 256, { fit: "cover" }).jpeg({ quality: 80 }).toFile(thumbnailPath);
          } catch (e) {
            thumbnailPath = null;
          }
        }

        const attachment = await db.createBusinessAttachment({
          task_id: taskId,
          file_name: body.fileName,
          file_path: filePath,
          thumbnail_path: thumbnailPath,
          file_type: fileType,
          mime_type: mimeType,
          file_size: buf.length,
        });
        sendJSON(res, 201, { ok: true, attachment });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /business/tasks/:id/attachments — list attachments
    if (req.method === "GET" && attachUploadMatch) {
      try {
        const taskId = parseInt(attachUploadMatch[1]);
        const attachments = await db.getBusinessAttachments(taskId);
        sendJSON(res, 200, attachments);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /business/attachments/:id/file — serve file (supports ?thumb=1)
    const attachFileMatch = pathname.match(/^\/business\/attachments\/(\d+)\/file$/);
    if (req.method === "GET" && attachFileMatch) {
      try {
        const attachment = await db.getBusinessAttachment(parseInt(attachFileMatch[1]));
        if (!attachment) { sendJSON(res, 404, { error: "Attachment not found" }); return true; }
        const thumb = url.searchParams?.get("thumb") === "1" || pathname.includes("thumb=1");
        const servePath = thumb && attachment.thumbnail_path ? attachment.thumbnail_path : attachment.file_path;
        if (!fs.existsSync(servePath)) { sendJSON(res, 404, { error: "File not found on disk" }); return true; }
        const contentType = thumb ? "image/jpeg" : (attachment.mime_type || "application/octet-stream");
        res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" });
        fs.createReadStream(servePath).pipe(res);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /business/attachments/:id — delete attachment + files
    const attachDeleteMatch = pathname.match(/^\/business\/attachments\/(\d+)$/);
    if (req.method === "DELETE" && attachDeleteMatch) {
      try {
        const deleted = await db.deleteBusinessAttachment(parseInt(attachDeleteMatch[1]));
        if (!deleted) { sendJSON(res, 404, { error: "Attachment not found" }); return true; }
        try { if (deleted.file_path) fs.unlinkSync(deleted.file_path); } catch {}
        try { if (deleted.thumbnail_path) fs.unlinkSync(deleted.thumbnail_path); } catch {}
        sendJSON(res, 200, { ok: true });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    return false;
  };
};
