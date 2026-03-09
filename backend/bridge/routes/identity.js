// Identity Resolution API — Phase 6 of Identity Resolution Engine
// Upload face → get full profile + relationship network + timeline

module.exports = function identityRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  const FACE_API = process.env.FACE_API_URL || "http://127.0.0.1:5555";
  const QDRANT_URL = "http://localhost:6333";

  return async function (req, res, pathname, url) {
    // POST /api/face/identify — upload a photo, find matching identity
    if (req.method === "POST" && pathname === "/api/face/identify") {
      try {
        const body = await parseBody(req);
        const { imageUrl, base64Image, topK = 5, threshold = 0.55 } = body || {};

        if (!imageUrl && !base64Image) {
          sendJSON(res, 400, { error: "Provide imageUrl or base64Image" });
          return true;
        }

        // Step 1: Get face embedding
        const form = new FormData();
        if (base64Image) {
          form.append("base64_image", base64Image);
        } else {
          form.append("image_url", imageUrl);
        }

        const embedRes = await fetch(`${FACE_API}/embed`, {
          method: "POST", body: form,
          signal: AbortSignal.timeout(15000),
        });
        if (!embedRes.ok) { sendJSON(res, 500, { error: "Face detection failed" }); return true; }
        const embedData = await embedRes.json();
        if (!embedData.faces?.length) { sendJSON(res, 200, { error: "No face detected", identities: [] }); return true; }

        const embedding = embedData.faces[0].embedding;

        // Step 2: Search Qdrant
        const searchRes = await fetch(`${QDRANT_URL}/collections/faces/points/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vector: embedding, limit: topK * 10, score_threshold: threshold,
            with_payload: ["cluster_id", "label", "source_url", "source_platform", "page_title", "domain"],
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!searchRes.ok) { sendJSON(res, 500, { error: "Vector search failed" }); return true; }
        const matches = (await searchRes.json()).result || [];

        if (!matches.length) { sendJSON(res, 200, { identities: [], total_matches: 0 }); return true; }

        // Step 3: Group by cluster
        const clusterMap = {};
        for (const m of matches) {
          const cid = m.payload?.cluster_id;
          if (!cid) continue;
          if (!clusterMap[cid]) clusterMap[cid] = { score: 0, count: 0, matches: [] };
          clusterMap[cid].score = Math.max(clusterMap[cid].score, m.score);
          clusterMap[cid].count++;
          if (clusterMap[cid].matches.length < 5) {
            clusterMap[cid].matches.push({
              score: m.score, source_url: m.payload?.source_url,
              label: m.payload?.label, platform: m.payload?.source_platform,
              page_title: m.payload?.page_title, domain: m.payload?.domain,
            });
          }
        }

        // Step 4: Look up identities
        const sorted = Object.entries(clusterMap).sort((a, b) => b[1].score - a[1].score).slice(0, topK);
        const identities = [];
        for (const [clusterId, cd] of sorted) {
          try {
            const idRes = await db.query(
              `SELECT id, primary_name, alternate_names, organizations, locations, occupations,
                      confidence, source_count, domain_count, metadata
               FROM face_identities WHERE cluster_id = $1`, [clusterId]);
            if (idRes.rows.length > 0) {
              const id = idRes.rows[0];
              identities.push({
                identity_id: id.id, cluster_id: clusterId, match_score: cd.score, match_count: cd.count,
                primary_name: id.primary_name, alternate_names: id.alternate_names,
                organizations: id.organizations, locations: id.locations, occupations: id.occupations,
                confidence: id.confidence, source_count: id.source_count, domain_count: id.domain_count,
                top_matches: cd.matches,
              });
            } else {
              identities.push({
                identity_id: null, cluster_id: clusterId, match_score: cd.score, match_count: cd.count,
                primary_name: cd.matches[0]?.label || "Unknown", top_matches: cd.matches,
              });
            }
          } catch {}
        }

        sendJSON(res, 200, { identities, total_matches: matches.length, clusters_found: Object.keys(clusterMap).length });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /api/face/identity/:id
    if (req.method === "GET" && pathname.startsWith("/api/face/identity/") && !pathname.includes("/network") && !pathname.includes("/timeline")) {
      const id = pathname.split("/api/face/identity/")[1];
      if (!id) { sendJSON(res, 400, { error: "Provide identity ID" }); return true; }

      try {
        const r = await db.query(
          `SELECT fi.*, fc.cluster_size, fc.representative_label
           FROM face_identities fi LEFT JOIN face_clusters fc ON fi.cluster_id = fc.id
           WHERE fi.id = $1`, [id]);
        if (!r.rows.length) { sendJSON(res, 404, { error: "Identity not found" }); return true; }

        const identity = r.rows[0];
        let appearances = [];
        if (identity.cluster_id) {
          try {
            const sr = await fetch(`${QDRANT_URL}/collections/faces/points/scroll`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                filter: { must: [{ key: "cluster_id", match: { value: String(identity.cluster_id) } }] },
                limit: 50, with_payload: ["source_url", "source_platform", "page_title", "domain", "label", "alt_text"], with_vector: false,
              }),
              signal: AbortSignal.timeout(10000),
            });
            if (sr.ok) appearances = ((await sr.json()).result?.points || []).map(p => p.payload);
          } catch {}
        }

        sendJSON(res, 200, { identity, appearances, appearance_count: identity.source_count || appearances.length });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /api/face/identity/:id/network
    if (req.method === "GET" && pathname.match(/^\/api\/face\/identity\/[^/]+\/network$/)) {
      const id = pathname.split("/")[4];
      try {
        const r = await db.query(
          `SELECT fr.*, fi_a.primary_name as name_a, fi_b.primary_name as name_b
           FROM face_relationships fr
           JOIN face_identities fi_a ON fr.identity_a = fi_a.id
           JOIN face_identities fi_b ON fr.identity_b = fi_b.id
           WHERE fr.identity_a = $1 OR fr.identity_b = $1
           ORDER BY fr.weight DESC LIMIT 50`, [id]);

        const nodes = new Map();
        const edges = [];
        for (const row of r.rows) {
          nodes.set(String(row.identity_a), { id: row.identity_a, name: row.name_a });
          nodes.set(String(row.identity_b), { id: row.identity_b, name: row.name_b });
          edges.push({ from: row.identity_a, to: row.identity_b, weight: row.weight, type: row.relationship_type, evidence_count: row.evidence_count });
        }

        sendJSON(res, 200, { nodes: Array.from(nodes.values()), edges, center: id });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /api/face/identity/:id/timeline
    if (req.method === "GET" && pathname.match(/^\/api\/face\/identity\/[^/]+\/timeline$/)) {
      const id = pathname.split("/")[4];
      try {
        const idRes = await db.query("SELECT cluster_id FROM face_identities WHERE id = $1", [id]);
        if (!idRes.rows.length) { sendJSON(res, 404, { error: "Not found" }); return true; }
        const clusterId = String(idRes.rows[0].cluster_id);

        const sr = await fetch(`${QDRANT_URL}/collections/faces/points/scroll`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filter: { must: [{ key: "cluster_id", match: { value: clusterId } }] },
            limit: 200, with_payload: ["source_url", "source_platform", "page_title", "domain", "label"], with_vector: false,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!sr.ok) { sendJSON(res, 500, { error: "Qdrant error" }); return true; }
        const points = (await sr.json()).result?.points || [];

        const byDomain = {}, byPlatform = {};
        for (const p of points) {
          const d = p.payload?.domain || "unknown";
          const pl = p.payload?.source_platform || "unknown";
          if (!byDomain[d]) byDomain[d] = [];
          byDomain[d].push({ url: p.payload?.source_url, title: p.payload?.page_title });
          byPlatform[pl] = (byPlatform[pl] || 0) + 1;
        }

        sendJSON(res, 200, {
          total_appearances: points.length, domains: Object.keys(byDomain).length,
          by_domain: Object.fromEntries(Object.entries(byDomain).sort((a, b) => b[1].length - a[1].length).slice(0, 20)),
          by_platform: byPlatform,
        });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /api/face/identities — list all
    if (req.method === "GET" && pathname === "/api/face/identities") {
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const offset = parseInt(url.searchParams.get("offset") || "0");
      const search = url.searchParams.get("q") || "";

      try {
        let query, params;
        if (search) {
          query = `SELECT id, primary_name, confidence, source_count, domain_count, organizations, locations
                   FROM face_identities WHERE primary_name ILIKE $1
                   ORDER BY confidence DESC LIMIT $2 OFFSET $3`;
          params = [`%${search}%`, limit, offset];
        } else {
          query = `SELECT id, primary_name, confidence, source_count, domain_count, organizations, locations
                   FROM face_identities WHERE primary_name IS NOT NULL AND primary_name != ''
                   ORDER BY confidence DESC LIMIT $1 OFFSET $2`;
          params = [limit, offset];
        }
        const r = await db.query(query, params);
        const cnt = await db.query("SELECT COUNT(*) FROM face_identities WHERE primary_name IS NOT NULL AND primary_name != ''");
        sendJSON(res, 200, { identities: r.rows, total: parseInt(cnt.rows[0].count), limit, offset });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    // GET /api/face/resolution/stats
    if (req.method === "GET" && pathname === "/api/face/resolution/stats") {
      try {
        const [clusters, identities, relationships] = await Promise.all([
          db.query("SELECT COUNT(*), COALESCE(SUM(cluster_size),0) FROM face_clusters"),
          db.query(`SELECT COUNT(*), COALESCE(AVG(confidence),0), COUNT(*) FILTER (WHERE confidence > 0.8) FROM face_identities WHERE primary_name IS NOT NULL`),
          db.query("SELECT COUNT(*), COALESCE(AVG(weight),0) FROM face_relationships"),
        ]);

        let vectors = 0;
        try {
          const qr = await fetch(`${QDRANT_URL}/collections/faces`, { signal: AbortSignal.timeout(5000) });
          if (qr.ok) vectors = (await qr.json()).result?.points_count || 0;
        } catch {}

        sendJSON(res, 200, {
          vectors,
          clusters: parseInt(clusters.rows[0].count),
          total_clustered: parseInt(clusters.rows[0].coalesce),
          identities: parseInt(identities.rows[0].count),
          avg_confidence: parseFloat(identities.rows[0].coalesce),
          high_confidence: parseInt(identities.rows[0].count_1 || identities.rows[0].count),
          relationships: parseInt(relationships.rows[0].count),
          avg_relationship_weight: parseFloat(relationships.rows[0].coalesce),
        });
      } catch (err) {
        sendJSON(res, 500, { error: err.message });
      }
      return true;
    }

    return false;
  };
};
