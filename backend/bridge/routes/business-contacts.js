"use strict";

module.exports = function businessContactRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  return async function (req, res, pathname) {
    // GET /business/contacts?type=buyer
    if (req.method === "GET" && pathname === "/business/contacts") {
      try {
        const url = new URL(req.url, "http://localhost");
        const filterType = url.searchParams.get("type") || null;
        const contacts = await db.getBusinessContacts(filterType);
        sendJSON(res, 200, contacts);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /business/contacts
    if (req.method === "POST" && pathname === "/business/contacts") {
      try {
        const body = await parseBody(req);
        if (!body.name) { sendJSON(res, 400, { error: "name is required" }); return true; }
        const contact = await db.createBusinessContact(body);
        sendJSON(res, 201, { ok: true, contact });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /business/contacts/:id
    const idMatch = pathname.match(/^\/business\/contacts\/(\d+)$/);
    if (req.method === "GET" && idMatch) {
      try {
        const contact = await db.getBusinessContact(parseInt(idMatch[1]));
        if (!contact) { sendJSON(res, 404, { error: "contact not found" }); return true; }
        sendJSON(res, 200, contact);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // PATCH /business/contacts/:id
    if (req.method === "PATCH" && idMatch) {
      try {
        const body = await parseBody(req);
        const contact = await db.updateBusinessContact(parseInt(idMatch[1]), body);
        if (!contact) { sendJSON(res, 404, { error: "contact not found" }); return true; }
        sendJSON(res, 200, { ok: true, contact });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // DELETE /business/contacts/:id
    if (req.method === "DELETE" && idMatch) {
      try {
        const ok = await db.deleteBusinessContact(parseInt(idMatch[1]));
        sendJSON(res, ok ? 200 : 404, { ok });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    return false;
  };
};
