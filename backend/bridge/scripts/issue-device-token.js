#!/usr/bin/env node
// issue-device-token.js — mint (or rotate) a per-device fleet-telemetry bearer token.
//
//   docker exec bridge node scripts/issue-device-token.js <device_id> [label]
//
// Prints ONLY the plaintext token to stdout (it is shown ONCE — the DB stores only
// its sha256). Re-running for the same device_id ROTATES the token (ON CONFLICT).
// This is the onboarding token path (there is deliberately no network-exposed
// token-minting endpoint — minting stays local to the bridge host). db.js holds the
// single source of truth for the token logic; we just prime the connection here.
"use strict";
const db = require("../db");

(async () => {
  const deviceId = process.argv[2];
  const label = process.argv[3] || null;
  if (!deviceId) {
    process.stderr.write("usage: issue-device-token.js <device_id> [label]\n");
    process.exit(2);
  }
  // Silence db.init()'s migration chatter so stdout carries only the token.
  const origLog = console.log, origErr = console.error, origWarn = console.warn;
  console.log = console.error = console.warn = () => {};
  try {
    await db.init();
    const res = await db.issueDeviceToken(deviceId, { scopes: ["heartbeat:write"], label });
    console.log = origLog; console.error = origErr; console.warn = origWarn;
    if (!res || !res.token) {
      process.stderr.write("failed to issue token (db not connected?)\n");
      process.exit(1);
    }
    process.stdout.write(res.token + "\n");
    process.exit(0);
  } catch (e) {
    console.log = origLog; console.error = origErr; console.warn = origWarn;
    process.stderr.write("error: " + (e && e.message ? e.message : e) + "\n");
    process.exit(1);
  }
})();
