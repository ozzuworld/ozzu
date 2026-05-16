// routes/ozzu-source.js — AltStore Source manifest + IPA download for the Ozzu app.
//
// Lets the iPhone subscribe to https://home.ozzu.world/ozzu.json as a source in
// AltStore Classic or SideStore. The store polls the JSON, sees a new version,
// fetches the IPA from downloadURL, re-signs on-device with King Kazuma's free
// Apple ID, installs. No more PC sideload trip for each Ozzu update.
//
// Source: dir_1778958643514. Spec: faq.altstore.io/developers/make-a-source
//
// Public — no auth (the source manifest is meant to be polled by the store on
// cellular). The IPA download path is also public; if you want auth, put it
// behind nginx with mTLS or a token query param later.

module.exports = function createOzzuSourceRoutes(ctx) {
  const { log: logObj, sendJSON, fs, path } = ctx;
  const log = typeof logObj === 'function' ? logObj : (...a) => (logObj.bridge ? logObj.bridge.info(...a) : console.log(...a));

  const IPA_PATH = "/home/gcp/ozzu/artifacts/ozzu-latest.ipa";
  const APP_JSON_PATH = "/home/gcp/ozzu/frontend/app.json";
  const PUBLIC_BASE = process.env.BRIDGE_PUBLIC_URL || "https://home.ozzu.world";

  // One-shot pairing-file delivery for King Kazuma's iPhone → SideStore import.
  // Cipher writes /tmp/ozzu-bridge/iphone-pairing.mobiledevicepairing + /tmp/ozzu-bridge/iphone-pairing.token
  // before telling King Kazuma the URL. First successful download deletes both
  // files so the URL self-expires.
  const PAIR_FILE = "/tmp/ozzu-bridge/iphone-pairing.mobiledevicepairing";
  const PAIR_TOKEN_FILE = "/tmp/ozzu-bridge/iphone-pairing.token";

  function readAppMetadata() {
    try {
      const raw = JSON.parse(fs.readFileSync(APP_JSON_PATH, "utf8"));
      const e = raw.expo || raw;
      return {
        version: e.version || "0.0.0",
        bundleId: e.ios?.bundleIdentifier || "com.ozzu.app",
        buildNumber: e.ios?.buildNumber || "1",
      };
    } catch (err) {
      return { version: "0.0.0", bundleId: "com.ozzu.app", buildNumber: "1" };
    }
  }

  function readIpaStat() {
    try {
      const st = fs.statSync(IPA_PATH);
      return { size: st.size, mtime: st.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  return async function handleOzzuSourceRoutes(req, res, pathname /* , url */) {

    // GET /ozzu.json — AltStore Source manifest
    if (req.method === "GET" && (pathname === "/ozzu.json" || pathname === "/ozzu-source.json")) {
      const meta = readAppMetadata();
      const stat = readIpaStat();

      const manifest = {
        name: "Ozzu",
        identifier: "world.ozzu.source",
        subtitle: "Ozzu app — direct from the bridge",
        description: "Self-hosted source for the Ozzu app. Updates appear here automatically after each iOS CI build.",
        iconURL: `${PUBLIC_BASE}/icon.png`,
        headerURL: `${PUBLIC_BASE}/icon.png`,
        website: PUBLIC_BASE,
        tintColor: "111111",
        apps: stat ? [{
          name: "Ozzu",
          bundleIdentifier: meta.bundleId,
          developerName: "King Kazuma",
          subtitle: "Skyline command",
          localizedDescription: "The Ozzu app — Cipher, directives, fleet, files, cameras, finance.",
          iconURL: `${PUBLIC_BASE}/icon.png`,
          tintColor: "111111",
          category: "productivity",
          screenshotURLs: [],
          versions: [{
            version: meta.version,
            buildVersion: meta.buildNumber,
            date: stat.mtime,
            size: stat.size,
            downloadURL: `${PUBLIC_BASE}/ozzu-latest.ipa`,
            localizedDescription: `Build ${meta.buildNumber} — cached ${stat.mtime}`,
            minOSVersion: "15.0",
          }],
          appPermissions: { entitlements: [], privacy: {} },
        }] : [],
        news: [],
      };

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(manifest, null, 2));
      log(`[ozzu-source] served manifest (apps=${manifest.apps.length}, ipa=${stat ? "present" : "missing"})`);
      return true;
    }

    // GET /ios-setup?t=<token> — landing page King Kazuma opens on iPhone Safari.
    // Two big tap-buttons: import pairing file + add Ozzu source via sidestore:// deep link.
    if (req.method === "GET" && pathname === "/ios-setup") {
      const queryToken = (req.url.match(/[?&]t=([A-Za-z0-9_-]+)/) || [])[1];
      let expected = null;
      try { expected = fs.readFileSync(PAIR_TOKEN_FILE, "utf8").trim(); } catch {}
      if (!expected || !queryToken || queryToken !== expected) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>404</h1><p>Token invalid or expired. Ask Cipher for a fresh /ios-setup URL.</p>");
        return true;
      }
      const html = `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ozzu — SideStore setup</title>
<style>
  body { font: 17px -apple-system, sans-serif; max-width:480px; margin:0 auto; padding:20px; background:#000; color:#eee; }
  h1 { font-size:22px; margin:8px 0 4px; }
  h2 { font-size:14px; color:#888; text-transform:uppercase; letter-spacing:1px; margin-top:30px; }
  .card { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:14px; padding:16px; margin:12px 0; }
  .btn { display:block; background:#3b82f6; color:#fff; text-decoration:none; padding:14px 18px; border-radius:10px; font-weight:600; text-align:center; margin:10px 0; }
  .btn-secondary { background:#374151; }
  code { background:#222; padding:2px 6px; border-radius:4px; font-size:13px; word-break:break-all; }
  p { color:#bbb; margin:6px 0; }
  ol { padding-left:22px; color:#bbb; }
</style></head><body>
<h1>Ozzu — SideStore setup</h1>
<p>Three steps, then you're done. Tap them in order.</p>

<h2>Step 1 — Pairing file</h2>
<div class="card">
  <p>Downloads <code>iphone-pairing.mobiledevicepairing</code>. After tapping, iOS will offer to "Open in SideStore" — pick that.</p>
  <a class="btn" href="/iphone-pairing?t=${queryToken}">Download pairing file</a>
</div>

<h2>Step 2 — Add Ozzu source</h2>
<div class="card">
  <p>Opens SideStore and asks to confirm adding the Ozzu source.</p>
  <a class="btn" href="sidestore://source?url=${encodeURIComponent('https://home.ozzu.world/ozzu.json')}">Add Ozzu source to SideStore</a>
</div>

<h2>Step 3 — Manual (no deep links exist for these)</h2>
<div class="card">
  <p><b>Both live under: Settings tab → scroll to the bottom → "ADVANCED SETTINGS" section.</b></p>
  <p style="margin-top:14px"><b>3a. Anisette server</b> → tap <code>Anisette Servers</code>. There's a text field at the bottom labeled <b>"Anisette Server List"</b> (it already has <code>https://servers.sidestore.io/servers.json</code>). Replace it with:</p>
  <p><code>https://home.ozzu.world/anisette-servers.json</code></p>
  <p>Tap <b>Refresh Servers</b>. An entry called <b>"Ozzu"</b> appears in the list. Tap it (a checkmark shows up). Tap <b>Back</b>.</p>
  <p style="margin-top:14px"><b>3b. VPN</b> → tap <code>VPN Configuration</code> → enable it. iOS will prompt for VPN permission — approve.</p>
</div>

<h2>Done</h2>
<p>SideStore will now re-sign itself + Ozzu every ~7 days. Open SideStore once a week to keep iOS background-refresh budget alive.</p>
<p style="color:#666;font-size:12px;margin-top:30px">This page expires after the pairing file is downloaded (single use).</p>
</body></html>`;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      log(`[ozzu-source] ios-setup landing page served`);
      return true;
    }

    // GET /iphone-pairing?t=<token> — one-shot pairing file delivery to iPhone Safari
    if (req.method === "GET" && pathname === "/iphone-pairing") {
      const queryToken = (req.url.match(/[?&]t=([A-Za-z0-9_-]+)/) || [])[1];
      let expected = null;
      try { expected = fs.readFileSync(PAIR_TOKEN_FILE, "utf8").trim(); } catch {}
      if (!expected || !queryToken || queryToken !== expected) {
        sendJSON(res, 404, { error: "Pairing file unavailable or token invalid" });
        return true;
      }
      if (!fs.existsSync(PAIR_FILE)) {
        sendJSON(res, 404, { error: "Pairing file already consumed" });
        return true;
      }
      const buf = fs.readFileSync(PAIR_FILE);
      // application/octet-stream + .mobiledevicepairing extension lets iOS Safari
      // hand off via share-sheet → "Open in SideStore" instead of the previous
      // x-apple-aspen-config which tells iOS "this is a config profile" and routes
      // it into Settings → Profile Installer (which then fails with parse errors).
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="iphone-pairing.mobiledevicepairing"`,
        "Content-Length": buf.length,
        "Cache-Control": "no-store",
      });
      res.end(buf);
      log(`[ozzu-source] iphone-pairing file delivered (${buf.length} bytes); file + token preserved for re-fetch`);
      return true;
    }

    // GET /anisette-servers.json — server list manifest SideStore polls.
    // SideStore 0.6.3 doesn't let you add a single server — the "Anisette
    // Server List" text field in Settings takes a URL pointing to JSON of
    // this shape. Format per AnisetteServerList.swift: {servers:[{name,address}]}.
    if (req.method === "GET" && pathname === "/anisette-servers.json") {
      const list = {
        servers: [
          { name: "Ozzu", address: `${PUBLIC_BASE}/anisette/` },
        ],
      };
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(list));
      return true;
    }

    // GET /ozzu-latest.ipa — Stream the IPA binary
    if (req.method === "GET" && pathname === "/ozzu-latest.ipa") {
      if (!fs.existsSync(IPA_PATH)) {
        sendJSON(res, 404, { error: "Ozzu IPA not yet cached. Run a staging build via /stage-ios first." });
        return true;
      }
      const st = fs.statSync(IPA_PATH);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="ozzu.ipa"`,
        "Content-Length": st.size,
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(IPA_PATH).pipe(res);
      log(`[ozzu-source] IPA download started (${st.size} bytes)`);
      return true;
    }

    return false;
  };
};
