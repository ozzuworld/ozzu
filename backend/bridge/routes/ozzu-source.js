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
