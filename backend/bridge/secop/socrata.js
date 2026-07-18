"use strict";

// Shared request headers for datos.gov.co (Socrata). Prefers the API Key via HTTP
// Basic Auth (SOCRATA_KEY_ID + SOCRATA_KEY_SECRET) — verified 2026-07-18 as the method
// this portal accepts (Key-ID-as-app-token gets 403). Falls back to the classic
// X-App-Token, then anonymous. Authenticated requests avoid the 503 rate-limit.
function socrataHeaders(extra) {
  const h = { "User-Agent": "ozzu-secop/1.0", Accept: "application/json", ...(extra || {}) };
  const id = process.env.SOCRATA_KEY_ID;
  const secret = process.env.SOCRATA_KEY_SECRET;
  if (id && secret) {
    h["Authorization"] = "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
  } else if (process.env.SOCRATA_APP_TOKEN) {
    h["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;
  }
  return h;
}

module.exports = { socrataHeaders };
