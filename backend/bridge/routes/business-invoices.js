"use strict";

module.exports = function businessInvoiceRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  return async function (req, res, pathname) {
    // GET /business/invoices?status=sent
    if (req.method === "GET" && pathname === "/business/invoices") {
      try {
        const url = new URL(req.url, "http://localhost");
        const filterStatus = url.searchParams.get("status") || null;
        const invoices = await db.getBusinessInvoices(filterStatus);
        sendJSON(res, 200, invoices);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /business/invoices
    if (req.method === "POST" && pathname === "/business/invoices") {
      try {
        const body = await parseBody(req);
        if (!body.amount) { sendJSON(res, 400, { error: "amount is required" }); return true; }
        const invoice = await db.createBusinessInvoice(body);
        sendJSON(res, 201, { ok: true, invoice });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /business/invoices/:id
    const idMatch = pathname.match(/^\/business\/invoices\/(\d+)$/);
    if (req.method === "GET" && idMatch) {
      try {
        const invoice = await db.getBusinessInvoice(parseInt(idMatch[1]));
        if (!invoice) { sendJSON(res, 404, { error: "invoice not found" }); return true; }
        sendJSON(res, 200, invoice);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // PATCH /business/invoices/:id
    if (req.method === "PATCH" && idMatch) {
      try {
        const body = await parseBody(req);
        const invoice = await db.updateBusinessInvoice(parseInt(idMatch[1]), body);
        if (!invoice) { sendJSON(res, 404, { error: "invoice not found" }); return true; }
        sendJSON(res, 200, { ok: true, invoice });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // DELETE /business/invoices/:id
    if (req.method === "DELETE" && idMatch) {
      try {
        const ok = await db.deleteBusinessInvoice(parseInt(idMatch[1]));
        sendJSON(res, ok ? 200 : 404, { ok });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    return false;
  };
};
