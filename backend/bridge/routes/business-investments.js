"use strict";

module.exports = function businessInvestmentRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  return async function (req, res, pathname) {
    // GET /business/investments
    if (req.method === "GET" && pathname === "/business/investments") {
      try {
        const investments = await db.getBusinessInvestments();
        sendJSON(res, 200, investments);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /business/investments
    if (req.method === "POST" && pathname === "/business/investments") {
      try {
        const body = await parseBody(req);
        if (!body.title || !body.amount) { sendJSON(res, 400, { error: "title and amount are required" }); return true; }
        const investment = await db.createBusinessInvestment(body);
        sendJSON(res, 201, { ok: true, investment });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /business/investments/:id
    const idMatch = pathname.match(/^\/business\/investments\/(\d+)$/);
    if (req.method === "GET" && idMatch) {
      try {
        const investment = await db.getBusinessInvestment(parseInt(idMatch[1]));
        if (!investment) { sendJSON(res, 404, { error: "investment not found" }); return true; }
        sendJSON(res, 200, investment);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // PATCH /business/investments/:id
    if (req.method === "PATCH" && idMatch) {
      try {
        const body = await parseBody(req);
        const investment = await db.updateBusinessInvestment(parseInt(idMatch[1]), body);
        if (!investment) { sendJSON(res, 404, { error: "investment not found" }); return true; }
        sendJSON(res, 200, { ok: true, investment });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // DELETE /business/investments/:id
    if (req.method === "DELETE" && idMatch) {
      try {
        const ok = await db.deleteBusinessInvestment(parseInt(idMatch[1]));
        sendJSON(res, ok ? 200 : 404, { ok });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    return false;
  };
};
