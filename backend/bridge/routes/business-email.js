"use strict";

const nodemailer = require("nodemailer");

module.exports = function businessEmailRoutes(ctx) {
  const { sendJSON, parseBody, db, log: logObj } = ctx;
  const log = typeof logObj === "function" ? logObj : (...args) => (logObj?.bridge?.info?.(...args) || console.log(...args));

  // ── Gmail SMTP transporter (lazy init) ──
  let _transporter = null;
  function getTransporter() {
    if (_transporter) return _transporter;
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) return null;
    _transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
    return _transporter;
  }

  // ── DB: ensure emails table exists ──
  let _tableReady = false;
  async function ensureTable() {
    if (_tableReady) return;
    await db.query(`
      CREATE TABLE IF NOT EXISTS business_emails (
        id SERIAL PRIMARY KEY,
        direction TEXT NOT NULL DEFAULT 'outbound',
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        cc TEXT,
        bcc TEXT,
        subject TEXT NOT NULL,
        body_text TEXT,
        body_html TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        sent_at TIMESTAMPTZ,
        message_id TEXT,
        in_reply_to TEXT,
        thread_id TEXT,
        contact_id INTEGER REFERENCES business_contacts(id),
        directive_id TEXT,
        tags TEXT[] DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    _tableReady = true;
  }

  return async function (req, res, pathname) {
    // ── POST /business/email/send — Send an email ──
    if (req.method === "POST" && pathname === "/business/email/send") {
      try {
        await ensureTable();
        const body = await parseBody(req);
        const { to, subject, text, html, cc, bcc, replyTo, contactId, directiveId, tags } = body;

        if (!to || !subject) {
          sendJSON(res, 400, { error: "to and subject are required" });
          return true;
        }

        const transporter = getTransporter();
        if (!transporter) {
          sendJSON(res, 500, { error: "Email not configured — GMAIL_USER and GMAIL_APP_PASSWORD required in .env" });
          return true;
        }

        const from = `Skyline Capital <${process.env.GMAIL_USER}>`;
        const mailOpts = {
          from,
          to,
          subject,
          text: text || undefined,
          html: html || undefined,
          cc: cc || undefined,
          bcc: bcc || undefined,
          replyTo: replyTo || process.env.GMAIL_USER,
        };

        const info = await transporter.sendMail(mailOpts);
        log(`Email sent to ${to}: ${subject} (messageId: ${info.messageId})`);

        // Store in DB
        const result = await db.query(
          `INSERT INTO business_emails
            (direction, from_addr, to_addr, cc, bcc, subject, body_text, body_html, status, sent_at, message_id, contact_id, directive_id, tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11,$12,$13)
           RETURNING *`,
          ["outbound", process.env.GMAIL_USER, to, cc || null, bcc || null, subject,
           text || null, html || null, "sent", info.messageId,
           contactId || null, directiveId || null, tags || []]
        );

        sendJSON(res, 200, { ok: true, email: result.rows[0], messageId: info.messageId });
      } catch (err) {
        log(`Email send error: ${err.message}`);
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // ── POST /business/email/draft — Save a draft without sending ──
    if (req.method === "POST" && pathname === "/business/email/draft") {
      try {
        await ensureTable();
        const body = await parseBody(req);
        const { to, subject, text, html, cc, bcc, contactId, directiveId, tags } = body;

        if (!to || !subject) {
          sendJSON(res, 400, { error: "to and subject are required" });
          return true;
        }

        const result = await db.query(
          `INSERT INTO business_emails
            (direction, from_addr, to_addr, cc, bcc, subject, body_text, body_html, status, contact_id, directive_id, tags)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          ["outbound", process.env.GMAIL_USER || "eng.ozzu@gmail.com", to, cc || null, bcc || null,
           subject, text || null, html || null, "draft",
           contactId || null, directiveId || null, tags || []]
        );

        sendJSON(res, 201, { ok: true, email: result.rows[0] });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // ── POST /business/email/draft/:id/send — Send a saved draft ──
    const sendDraftMatch = pathname.match(/^\/business\/email\/draft\/(\d+)\/send$/);
    if (req.method === "POST" && sendDraftMatch) {
      try {
        await ensureTable();
        const id = parseInt(sendDraftMatch[1]);
        const draft = await db.query("SELECT * FROM business_emails WHERE id = $1 AND status = 'draft'", [id]);
        if (!draft.rows.length) { sendJSON(res, 404, { error: "Draft not found" }); return true; }

        const d = draft.rows[0];
        const transporter = getTransporter();
        if (!transporter) {
          sendJSON(res, 500, { error: "Email not configured" });
          return true;
        }

        const info = await transporter.sendMail({
          from: `Skyline Capital <${process.env.GMAIL_USER}>`,
          to: d.to_addr,
          subject: d.subject,
          text: d.body_text || undefined,
          html: d.body_html || undefined,
          cc: d.cc || undefined,
          bcc: d.bcc || undefined,
        });

        await db.query(
          "UPDATE business_emails SET status = 'sent', sent_at = NOW(), message_id = $1, updated_at = NOW() WHERE id = $2",
          [info.messageId, id]
        );

        log(`Draft ${id} sent to ${d.to_addr}: ${d.subject}`);
        sendJSON(res, 200, { ok: true, messageId: info.messageId });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // ── GET /business/emails — List sent emails + drafts ──
    if (req.method === "GET" && pathname === "/business/emails") {
      try {
        await ensureTable();
        const url = new URL(req.url, "http://localhost");
        const status = url.searchParams.get("status");
        const limit = parseInt(url.searchParams.get("limit") || "50");

        let query = "SELECT * FROM business_emails";
        const params = [];
        if (status) { query += " WHERE status = $1"; params.push(status); }
        query += " ORDER BY created_at DESC LIMIT $" + (params.length + 1);
        params.push(limit);

        const result = await db.query(query, params);
        sendJSON(res, 200, { emails: result.rows, total: result.rows.length });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // ── GET /business/emails/:id — Get single email ──
    const emailIdMatch = pathname.match(/^\/business\/emails\/(\d+)$/);
    if (req.method === "GET" && emailIdMatch) {
      try {
        await ensureTable();
        const result = await db.query("SELECT * FROM business_emails WHERE id = $1", [parseInt(emailIdMatch[1])]);
        if (!result.rows.length) { sendJSON(res, 404, { error: "Not found" }); return true; }
        sendJSON(res, 200, result.rows[0]);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // ── DELETE /business/emails/:id — Delete a draft ──
    if (req.method === "DELETE" && emailIdMatch) {
      try {
        await ensureTable();
        await db.query("DELETE FROM business_emails WHERE id = $1", [parseInt(emailIdMatch[1])]);
        sendJSON(res, 200, { ok: true });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // ── GET /business/email/status — Check email config status ──
    if (req.method === "GET" && pathname === "/business/email/status") {
      const transporter = getTransporter();
      if (!transporter) {
        sendJSON(res, 200, { configured: false, reason: "GMAIL_USER or GMAIL_APP_PASSWORD not set" });
        return true;
      }
      try {
        await transporter.verify();
        sendJSON(res, 200, { configured: true, user: process.env.GMAIL_USER });
      } catch (err) {
        sendJSON(res, 200, { configured: false, reason: err.message });
      }
      return true;
    }

    return false;
  };
};
