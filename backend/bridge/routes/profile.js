// Owner profile — personal details, address, phone, timezone
// Single-row table (id=1). Used for shipping, billing, HA config, scheduler timezone.

module.exports = function profileRoutes(ctx) {
  const { sendJSON, parseBody, db, CORS_HEADERS } = ctx;

  return async function (req, res, pathname) {
    if (pathname !== "/profile") return false;

    // GET /profile — fetch owner profile
    if (req.method === "GET") {
      try {
        const result = await db.query(`SELECT * FROM owner_profile WHERE id = 1`);
        if (result.rows.length === 0) {
          sendJSON(res, 200, { profile: null });
          return true;
        }
        sendJSON(res, 200, { profile: result.rows[0] });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // PUT /profile — upsert owner profile
    if (req.method === "PUT" || req.method === "POST" || req.method === "PATCH") {
      try {
        const body = await parseBody(req);
        const fields = [
          "full_name", "phone", "email", "timezone",
          "address_line1", "address_line2", "city", "state", "country", "postal_code",
          "shipping_same_as_billing",
          "shipping_address_line1", "shipping_address_line2",
          "shipping_city", "shipping_state", "shipping_country", "shipping_postal_code",
          "extra",
        ];

        const setClauses = [];
        const values = [];
        let idx = 1;
        for (const f of fields) {
          if (body[f] !== undefined) {
            setClauses.push(`${f} = $${idx++}`);
            values.push(f === "extra" ? JSON.stringify(body[f]) : body[f]);
          }
        }

        if (setClauses.length === 0) {
          sendJSON(res, 400, { error: "No fields to update" });
          return true;
        }

        setClauses.push("updated_at = NOW()");

        const result = await db.query(
          `INSERT INTO owner_profile (id, ${fields.filter(f => body[f] !== undefined).join(", ")})
           VALUES (1, ${values.map((_, i) => `$${i + 1}`).join(", ")})
           ON CONFLICT (id) DO UPDATE SET ${setClauses.join(", ")}
           RETURNING *`,
          values
        );
        sendJSON(res, 200, { profile: result.rows[0] });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    return false;
  };
};
