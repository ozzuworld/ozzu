"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

const ATTACHMENTS_DIR = "/tmp/ozzu-bridge/business-attachments";

// ── Gemini Document Verification ──

async function verifyDocumentWithGemini(apiKey, fileBuffer, mimeType, task, requirements) {
  const base64Data = fileBuffer.toString("base64");
  const reqList = requirements && requirements.length > 0
    ? requirements.map((r) => `- [${r.id}] ${r.label}: ${r.description || ""}`).join("\n")
    : "(No specific requirements defined for this task)";

  const prompt = `You are a document verification assistant for a Colombian business project.

Task: "${task.title}"
${task.description ? `Description: ${task.description}` : ""}
${task.phase ? `Phase: ${task.phase}` : ""}

Requirements to verify against:
${reqList}

Analyze this uploaded document and determine:
1. What type of document this is
2. A brief summary of its contents
3. Which requirements (if any) it fulfills — match by requirement ID
4. Any issues or concerns with the document
5. Suggestions for next steps

${requirements && requirements.length > 0
    ? "For each requirement, assess whether this document meets it (met: true/false), your confidence (0-1), and a brief explanation."
    : "Since no specific requirements are defined, suggest what this document could fulfill and what requirements it might satisfy."}

Respond ONLY with valid JSON in this exact format:
{
  "documentType": "string",
  "summary": "string",
  "matchedRequirements": ["req_id1"],
  "details": [
    { "requirementId": "req_id", "met": true, "confidence": 0.95, "explanation": "string" }
  ],
  "issues": ["string"],
  "suggestions": ["string"]
}`;

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { inlineData: { mimeType, data: base64Data } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
  });

  return new Promise((resolve, reject) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 30000,
    };

    const httpReq = https.request(reqOpts, (httpRes) => {
      let data = "";
      httpRes.on("data", (chunk) => { data += chunk; });
      httpRes.on("end", () => {
        try {
          const json = JSON.parse(data);
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
          // Extract JSON from possible markdown fences
          const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
          const parsed = JSON.parse(jsonMatch[1].trim());
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Gemini parse error: ${e.message}`));
        }
      });
    });

    httpReq.on("error", (e) => reject(new Error(`Gemini request error: ${e.message}`)));
    httpReq.on("timeout", () => { httpReq.destroy(); reject(new Error("Gemini request timeout (30s)")); });
    httpReq.write(payload);
    httpReq.end();
  });
}

// ── Gemini Receipt/Invoice Extraction ──

async function extractReceiptWithGemini(apiKey, fileBuffer, mimeType) {
  const base64Data = fileBuffer.toString("base64");
  const prompt = `You are a receipt/invoice data extraction assistant for Colombian businesses.

Analyze this document and determine if it is a receipt, invoice, factura, or similar financial document.

If it IS a receipt/invoice/factura:
- Extract all financial data
- All amounts should be in COP (Colombian Pesos) if visible, or the currency shown
- IVA in Colombia is 19%

Respond ONLY with valid JSON:
{
  "isReceipt": true,
  "amount": 0,
  "subtotal": 0,
  "iva": 0,
  "vendor": "string",
  "date": "YYYY-MM-DD",
  "lineItems": [{ "description": "string", "quantity": 1, "unitPrice": 0, "total": 0 }],
  "paymentMethod": "cash|card|transfer|other",
  "documentNumber": "string or null",
  "rawText": "brief summary of document content"
}

If it is NOT a receipt/invoice, respond with:
{ "isReceipt": false }`;

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { inlineData: { mimeType, data: base64Data } },
        { text: prompt },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
  });

  return new Promise((resolve, reject) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 30000,
    };

    const httpReq = https.request(reqOpts, (httpRes) => {
      let data = "";
      httpRes.on("data", (chunk) => { data += chunk; });
      httpRes.on("end", () => {
        try {
          const json = JSON.parse(data);
          const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
          const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
          const parsed = JSON.parse(jsonMatch[1].trim());
          resolve(parsed.isReceipt ? parsed : null);
        } catch (e) {
          reject(new Error(`Gemini receipt parse error: ${e.message}`));
        }
      });
    });

    httpReq.on("error", (e) => reject(new Error(`Gemini receipt request error: ${e.message}`)));
    httpReq.on("timeout", () => { httpReq.destroy(); reject(new Error("Gemini receipt request timeout (30s)")); });
    httpReq.write(payload);
    httpReq.end();
  });
}

async function extractReceiptWithClaude(apiKey, fileBuffer, mimeType) {
  const base64Data = fileBuffer.toString("base64");
  const mediaType = mimeType || "image/jpeg";
  const prompt = `You are a receipt/invoice data extraction assistant for Colombian businesses.

Analyze this document and determine if it is a receipt, invoice, factura, or similar financial document.

If it IS a receipt/invoice/factura:
- Extract all financial data
- All amounts should be in COP (Colombian Pesos) if visible, or the currency shown
- IVA in Colombia is 19%

Respond ONLY with valid JSON:
{
  "isReceipt": true,
  "amount": 0,
  "total": 0,
  "subtotal": 0,
  "iva": 0,
  "vendor": "string",
  "date": "YYYY-MM-DD",
  "lineItems": [{ "description": "string", "quantity": 1, "unitPrice": 0, "total": 0 }],
  "paymentMethod": "cash|card|transfer|other",
  "documentNumber": "string or null",
  "rawText": "brief summary of document content"
}

If it is NOT a receipt/invoice, respond with:
{ "isReceipt": false }`;

  const payload = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
        { type: "text", text: prompt },
      ],
    }],
  });

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 30000,
    };

    const httpReq = https.request(reqOpts, (httpRes) => {
      let data = "";
      httpRes.on("data", (chunk) => { data += chunk; });
      httpRes.on("end", () => {
        try {
          const json = JSON.parse(data);
          const text = json.content?.[0]?.text || "";
          const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
          const parsed = JSON.parse(jsonMatch[1].trim());
          resolve(parsed.isReceipt ? parsed : null);
        } catch (e) {
          reject(new Error(`Claude receipt parse error: ${e.message}`));
        }
      });
    });

    httpReq.on("error", (e) => reject(new Error(`Claude receipt request error: ${e.message}`)));
    httpReq.on("timeout", () => { httpReq.destroy(); reject(new Error("Claude receipt request timeout (30s)")); });
    httpReq.write(payload);
    httpReq.end();
  });
}

module.exports = function businessRoutes(ctx) {
  const { sendJSON, parseBody, db, CORS_HEADERS } = ctx;
  const GEMINI_API_KEY = ctx.GEMINI_API_KEY || "";
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

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

    // ── Task Requirements ──

    // GET /business/tasks/:id/requirements — requirements + verification status
    const reqMatch = pathname.match(/^\/business\/tasks\/(\d+)\/requirements$/);
    if (req.method === "GET" && reqMatch) {
      try {
        const taskId = parseInt(reqMatch[1]);
        const task = await db.query(`SELECT requirements FROM business_tasks WHERE id = $1`, [taskId]);
        if (task.rows.length === 0) { sendJSON(res, 404, { error: "task not found" }); return true; }
        const requirements = task.rows[0].requirements || [];
        const fulfilled = requirements.filter((r) => r.fulfilled).length;
        sendJSON(res, 200, { requirements, fulfilled, total: requirements.length, status: fulfilled === 0 ? "unverified" : fulfilled >= requirements.length ? "verified" : "partial" });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PUT /business/tasks/:id/requirements — set requirements array
    if (req.method === "PUT" && reqMatch) {
      try {
        const taskId = parseInt(reqMatch[1]);
        const body = await parseBody(req);
        if (!Array.isArray(body.requirements)) { sendJSON(res, 400, { error: "requirements array is required" }); return true; }
        const task = await db.updateBusinessTask(taskId, { requirements: JSON.stringify(body.requirements) });
        if (!task) { sendJSON(res, 404, { error: "task not found" }); return true; }
        sendJSON(res, 200, { ok: true, requirements: task.requirements });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /business/tasks/:id/attachments — upload file with auto-verification
    const attachUploadMatch = pathname.match(/^\/business\/tasks\/(\d+)\/attachments$/);
    if (req.method === "POST" && attachUploadMatch) {
      try {
        const taskId = parseInt(attachUploadMatch[1]);
        const body = await parseBody(req, 20 * 1024 * 1024); // 20MB for file uploads
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

        // Auto-verify with Gemini if API key available
        let verification = null;
        let receiptData = null;
        let autoExpense = null;
        if (GEMINI_API_KEY) {
          try {
            const taskRow = await db.query(`SELECT * FROM business_tasks WHERE id = $1`, [taskId]);
            const task = taskRow.rows[0];
            const requirements = task?.requirements || [];
            const geminiResult = await verifyDocumentWithGemini(GEMINI_API_KEY, buf, mimeType, task, requirements);

            const matchedReqs = geminiResult.matchedRequirements || [];
            const allMet = (geminiResult.details || []).every((d) => d.met);
            const anyMet = (geminiResult.details || []).some((d) => d.met);

            verification = {
              status: matchedReqs.length === 0 ? "unverified" : allMet ? "verified" : anyMet ? "partial" : "rejected",
              verifiedAt: new Date().toISOString(),
              summary: geminiResult.summary || "",
              documentType: geminiResult.documentType || "",
              matchedRequirements: matchedReqs,
              details: geminiResult.details || [],
              issues: geminiResult.issues || [],
              suggestions: geminiResult.suggestions || [],
            };

            await db.updateBusinessAttachmentVerification(attachment.id, verification);

            // Update task requirements fulfilled status
            if (requirements.length > 0 && matchedReqs.length > 0) {
              const updated = requirements.map((r) => {
                if (matchedReqs.includes(r.id)) {
                  const detail = (geminiResult.details || []).find((d) => d.requirementId === r.id);
                  if (detail && detail.met) {
                    return { ...r, fulfilled: true, fulfilledBy: attachment.id };
                  }
                }
                return r;
              });
              await db.updateBusinessTask(taskId, { requirements: JSON.stringify(updated) });
            }
          } catch (verifyErr) {
            console.error("[business] Gemini verification error:", verifyErr.message);
          }

          // Receipt detection — run in parallel with verification
          try {
            receiptData = await extractReceiptWithGemini(GEMINI_API_KEY, buf, mimeType);
            if (receiptData) {
              await db.updateBusinessAttachmentReceiptData(attachment.id, receiptData);
              // Auto-create expense from receipt
              autoExpense = await db.createBusinessExpense({
                task_id: taskId,
                attachment_id: attachment.id,
                amount: receiptData.amount || 0,
                iva_amount: receiptData.iva || 0,
                category: 'other',
                vendor: receiptData.vendor || '',
                description: `Auto-extracted from ${body.fileName}`,
                payment_status: 'paid',
                payment_method: receiptData.paymentMethod || null,
                expense_date: receiptData.date || new Date().toISOString().split('T')[0],
                receipt_data: receiptData,
              });
            }
          } catch (receiptErr) {
            console.error("[business] Receipt extraction error:", receiptErr.message);
          }
        }

        sendJSON(res, 201, { ok: true, attachment: { ...attachment, verification, receipt_data: receiptData }, autoExpense });
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

    // POST /business/attachments/:id/reverify — re-run Gemini verification
    const reverifyMatch = pathname.match(/^\/business\/attachments\/(\d+)\/reverify$/);
    if (req.method === "POST" && reverifyMatch) {
      try {
        if (!GEMINI_API_KEY) { sendJSON(res, 500, { error: "GEMINI_API_KEY not configured" }); return true; }
        const attId = parseInt(reverifyMatch[1]);
        const attachment = await db.getBusinessAttachment(attId);
        if (!attachment) { sendJSON(res, 404, { error: "Attachment not found" }); return true; }
        if (!fs.existsSync(attachment.file_path)) { sendJSON(res, 404, { error: "File not found on disk" }); return true; }

        const buf = fs.readFileSync(attachment.file_path);
        const taskRow = await db.query(`SELECT * FROM business_tasks WHERE id = $1`, [attachment.task_id]);
        const task = taskRow.rows[0];
        const requirements = task?.requirements || [];

        const geminiResult = await verifyDocumentWithGemini(GEMINI_API_KEY, buf, attachment.mime_type, task, requirements);
        const matchedReqs = geminiResult.matchedRequirements || [];
        const allMet = (geminiResult.details || []).every((d) => d.met);
        const anyMet = (geminiResult.details || []).some((d) => d.met);

        const verification = {
          status: matchedReqs.length === 0 ? "unverified" : allMet ? "verified" : anyMet ? "partial" : "rejected",
          verifiedAt: new Date().toISOString(),
          summary: geminiResult.summary || "",
          documentType: geminiResult.documentType || "",
          matchedRequirements: matchedReqs,
          details: geminiResult.details || [],
          issues: geminiResult.issues || [],
          suggestions: geminiResult.suggestions || [],
        };

        await db.updateBusinessAttachmentVerification(attId, verification);

        // Update task requirements
        if (requirements.length > 0 && matchedReqs.length > 0) {
          const updated = requirements.map((r) => {
            if (matchedReqs.includes(r.id)) {
              const detail = (geminiResult.details || []).find((d) => d.requirementId === r.id);
              if (detail && detail.met) return { ...r, fulfilled: true, fulfilledBy: attId };
            }
            return r;
          });
          await db.updateBusinessTask(attachment.task_id, { requirements: JSON.stringify(updated) });
        }

        sendJSON(res, 200, { ok: true, verification });
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

    // ── Expenses CRUD ──

    // POST /business/tasks/:id/expenses — create expense
    const expenseCreateMatch = pathname.match(/^\/business\/tasks\/(\d+)\/expenses$/);
    if (req.method === "POST" && expenseCreateMatch) {
      try {
        const taskId = parseInt(expenseCreateMatch[1]);
        const body = await parseBody(req);
        if (!body.amount || !body.category) {
          sendJSON(res, 400, { error: "amount and category are required" });
          return true;
        }
        const expense = await db.createBusinessExpense({
          task_id: taskId,
          attachment_id: body.attachment_id,
          amount: body.amount,
          iva_amount: body.iva_amount,
          category: body.category,
          vendor: body.vendor,
          description: body.description,
          payment_status: body.payment_status,
          payment_method: body.payment_method,
          expense_date: body.expense_date,
          receipt_data: body.receipt_data,
        });
        sendJSON(res, 201, { ok: true, expense });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /business/tasks/:id/expenses — list expenses for task
    if (req.method === "GET" && expenseCreateMatch) {
      try {
        const taskId = parseInt(expenseCreateMatch[1]);
        const expenses = await db.getBusinessExpenses(taskId);
        sendJSON(res, 200, expenses);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PATCH /business/expenses/:id — update expense
    const expenseMatch = pathname.match(/^\/business\/expenses\/(\d+)$/);
    if (req.method === "PATCH" && expenseMatch) {
      try {
        const body = await parseBody(req);
        const expense = await db.updateBusinessExpense(parseInt(expenseMatch[1]), body);
        if (!expense) {
          sendJSON(res, 404, { error: "expense not found" });
          return true;
        }
        sendJSON(res, 200, { ok: true, expense });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // DELETE /business/expenses/:id — delete expense
    if (req.method === "DELETE" && expenseMatch) {
      try {
        const ok = await db.deleteBusinessExpense(parseInt(expenseMatch[1]));
        sendJSON(res, ok ? 200 : 404, { ok });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /business/projects/:id/expenses — list project-level expenses
    const projectExpensesMatch = pathname.match(/^\/business\/projects\/(\d+)\/expenses$/);
    if (req.method === "GET" && projectExpensesMatch) {
      try {
        const expenses = await db.getProjectExpenses(parseInt(projectExpensesMatch[1]));
        sendJSON(res, 200, expenses);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /business/projects/:id/expenses — create project-level expense
    if (req.method === "POST" && projectExpensesMatch) {
      try {
        const projectId = parseInt(projectExpensesMatch[1]);
        const body = await parseBody(req);
        if (!body.amount || !body.category) {
          sendJSON(res, 400, { error: "amount and category are required" });
          return true;
        }
        const expense = await db.createBusinessExpense({
          project_id: projectId,
          task_id: body.task_id || null,
          amount: body.amount,
          iva_amount: body.iva_amount,
          category: body.category,
          vendor: body.vendor,
          description: body.description,
          payment_status: body.payment_status,
          payment_method: body.payment_method,
          expense_date: body.expense_date,
        });
        sendJSON(res, 201, { ok: true, expense });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /business/projects/:id/financials — financial summary
    const financialsMatch = pathname.match(/^\/business\/projects\/(\d+)\/financials$/);
    if (req.method === "GET" && financialsMatch) {
      try {
        const financials = await db.getProjectFinancials(parseInt(financialsMatch[1]));
        if (!financials) {
          sendJSON(res, 404, { error: "project not found" });
          return true;
        }
        sendJSON(res, 200, financials);
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // POST /business/attachments/:id/extract-receipt — manual receipt extraction
    const extractReceiptMatch = pathname.match(/^\/business\/attachments\/(\d+)\/extract-receipt$/);
    if (req.method === "POST" && extractReceiptMatch) {
      try {
        if (!ANTHROPIC_API_KEY && !GEMINI_API_KEY) { sendJSON(res, 500, { error: "No AI API key configured (ANTHROPIC_API_KEY or GEMINI_API_KEY)" }); return true; }
        const attId = parseInt(extractReceiptMatch[1]);
        const attachment = await db.getBusinessAttachment(attId);
        if (!attachment) { sendJSON(res, 404, { error: "Attachment not found" }); return true; }
        if (!fs.existsSync(attachment.file_path)) { sendJSON(res, 404, { error: "File not found on disk" }); return true; }

        const buf = fs.readFileSync(attachment.file_path);
        const receiptData = ANTHROPIC_API_KEY
          ? await extractReceiptWithClaude(ANTHROPIC_API_KEY, buf, attachment.mime_type)
          : await extractReceiptWithGemini(GEMINI_API_KEY, buf, attachment.mime_type);
        if (!receiptData) {
          sendJSON(res, 200, { ok: false, message: "No receipt data detected" });
          return true;
        }
        await db.updateBusinessAttachmentReceiptData(attId, receiptData);
        sendJSON(res, 200, { ok: true, receiptData });
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

    // GET /business/dashboard?period=month|quarter|year|all
    if (req.method === "GET" && pathname === "/business/dashboard") {
      try {
        const u = new URL(req.url, "http://localhost");
        const period = u.searchParams.get("period") || "all";
        const metrics = await db.getDashboardMetrics(period);
        if (!metrics) { sendJSON(res, 500, { error: "Could not compute metrics" }); return true; }
        sendJSON(res, 200, metrics);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    return false;
  };
};
