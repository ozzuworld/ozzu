"use strict";

module.exports = function businessShipmentRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  return async function (req, res, pathname) {
    // GET /business/shipments?status=in_transit
    if (req.method === "GET" && pathname === "/business/shipments") {
      try {
        const url = new URL(req.url, "http://localhost");
        const filterStatus = url.searchParams.get("status") || null;
        const shipments = await db.getBusinessShipments(filterStatus);
        sendJSON(res, 200, shipments);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // POST /business/shipments
    if (req.method === "POST" && pathname === "/business/shipments") {
      try {
        const body = await parseBody(req);
        const shipment = await db.createBusinessShipment(body);
        sendJSON(res, 201, { ok: true, shipment });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // GET /business/shipments/:id
    const idMatch = pathname.match(/^\/business\/shipments\/(\d+)$/);
    if (req.method === "GET" && idMatch) {
      try {
        const shipment = await db.getBusinessShipment(parseInt(idMatch[1]));
        if (!shipment) { sendJSON(res, 404, { error: "shipment not found" }); return true; }
        sendJSON(res, 200, shipment);
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // PATCH /business/shipments/:id
    if (req.method === "PATCH" && idMatch) {
      try {
        const body = await parseBody(req);
        const shipment = await db.updateBusinessShipment(parseInt(idMatch[1]), body);
        if (!shipment) { sendJSON(res, 404, { error: "shipment not found" }); return true; }
        sendJSON(res, 200, { ok: true, shipment });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // PATCH /business/shipments/:id/status — quick status transition
    const statusMatch = pathname.match(/^\/business\/shipments\/(\d+)\/status$/);
    if (req.method === "PATCH" && statusMatch) {
      try {
        const body = await parseBody(req);
        if (!body.status) { sendJSON(res, 400, { error: "status is required" }); return true; }
        const shipment = await db.updateBusinessShipment(parseInt(statusMatch[1]), { status: body.status });
        if (!shipment) { sendJSON(res, 404, { error: "shipment not found" }); return true; }
        sendJSON(res, 200, { ok: true, shipment });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    // DELETE /business/shipments/:id
    if (req.method === "DELETE" && idMatch) {
      try {
        const ok = await db.deleteBusinessShipment(parseInt(idMatch[1]));
        sendJSON(res, ok ? 200 : 404, { ok });
      } catch (err) { sendJSON(res, 500, { error: err.message }); }
      return true;
    }

    return false;
  };
};
