// routes/influence.js — Social media account management & content scheduling
// Manages real accounts from consenting users via Dolphin Anty + Decodo proxies
//
// Directive: dir_1775926142812

"use strict";

const { encrypt, decrypt, createDolphinProfile, listDolphinProfiles, deleteDolphinProfile, getCapSolverBalance, loadEnv } = require("../influence");

const PLATFORMS = ["x", "instagram", "tiktok", "youtube", "linkedin", "reddit", "facebook"];

module.exports = function influenceRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  return async function handleInfluenceRoutes(req, res, pathname, url) {

    // ── Accounts ──

    // GET /api/influence/accounts — list all managed accounts
    if (req.method === "GET" && pathname === "/api/influence/accounts") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      try {
        const r = await db.query(`
          SELECT id, owner_name, owner_email, platform, username, display_name,
                 dolphin_profile_id, proxy_port, status, warming_day, last_active, created_at
          FROM influence_accounts ORDER BY created_at DESC
        `);
        sendJSON(res, 200, { ok: true, accounts: r.rows });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // POST /api/influence/accounts — register a real account
    if (req.method === "POST" && pathname === "/api/influence/accounts") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const body = await parseBody(req);
      const { ownerName, ownerEmail, platform, username, displayName, password, proxyPort } = body;

      if (!ownerName || !platform || !username || !password) {
        sendJSON(res, 400, { ok: false, error: "ownerName, platform, username, password required" });
        return true;
      }
      if (!PLATFORMS.includes(platform)) {
        sendJSON(res, 400, { ok: false, error: `Invalid platform. Use: ${PLATFORMS.join(", ")}` });
        return true;
      }

      try {
        // Encrypt the password
        const encryptedPassword = encrypt(password);
        const port = proxyPort || (10001 + Math.floor(Math.random() * 500));

        // Create Dolphin Anty profile for this account
        let dolphinProfileId = null;
        try {
          const profileName = `${platform}-${username}`;
          const dolphinResult = await createDolphinProfile(profileName, port);
          dolphinProfileId = dolphinResult.browserProfileId || dolphinResult.id || null;
        } catch (err) {
          console.error("[influence] Dolphin profile creation failed:", err.message);
          // Continue — profile can be created later
        }

        const r = await db.query(`
          INSERT INTO influence_accounts
            (owner_name, owner_email, platform, username, display_name, encrypted_password, dolphin_profile_id, proxy_port, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
          RETURNING id, owner_name, platform, username, display_name, dolphin_profile_id, proxy_port, status, created_at
        `, [ownerName, ownerEmail || null, platform, username, displayName || username, encryptedPassword, dolphinProfileId, port]);

        sendJSON(res, 201, { ok: true, account: r.rows[0] });
        return true;
      } catch (err) {
        if (err.code === "23505") {
          sendJSON(res, 409, { ok: false, error: "Account already exists for this platform+username" });
        } else {
          sendJSON(res, 500, { ok: false, error: err.message });
        }
        return true;
      }
    }

    // DELETE /api/influence/accounts/:id
    if (req.method === "DELETE" && pathname.match(/^\/api\/influence\/accounts\/\d+$/)) {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const id = pathname.split("/").pop();
      try {
        const r = await db.query(`SELECT dolphin_profile_id FROM influence_accounts WHERE id = $1`, [id]);
        if (r.rows.length === 0) { sendJSON(res, 404, { ok: false, error: "Not found" }); return true; }

        // Delete Dolphin profile if exists
        if (r.rows[0].dolphin_profile_id) {
          try { await deleteDolphinProfile(r.rows[0].dolphin_profile_id); } catch {}
        }

        await db.query(`DELETE FROM influence_accounts WHERE id = $1`, [id]);
        sendJSON(res, 200, { ok: true });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // ── Content Posts ──

    // GET /api/influence/posts — list scheduled/posted content
    if (req.method === "GET" && pathname === "/api/influence/posts") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      try {
        const status = url.searchParams.get("status"); // scheduled, posted, failed
        const limit = parseInt(url.searchParams.get("limit") || "50");
        let query = `
          SELECT p.*,
            COALESCE(json_agg(json_build_object('account_id', pa.account_id, 'status', pa.status, 'posted_at', pa.posted_at))
              FILTER (WHERE pa.account_id IS NOT NULL), '[]') as targets
          FROM influence_posts p
          LEFT JOIN influence_post_accounts pa ON p.id = pa.post_id
        `;
        const params = [];
        if (status) {
          query += ` WHERE p.status = $1`;
          params.push(status);
        }
        query += ` GROUP BY p.id ORDER BY p.scheduled_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const r = await db.query(query, params);
        sendJSON(res, 200, { ok: true, posts: r.rows });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // POST /api/influence/posts — schedule a content post
    if (req.method === "POST" && pathname === "/api/influence/posts") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const body = await parseBody(req);
      const { text, mediaUrls, hashtags, accountIds, scheduledAt, campaignId } = body;

      if (!text && (!mediaUrls || mediaUrls.length === 0)) {
        sendJSON(res, 400, { ok: false, error: "text or mediaUrls required" });
        return true;
      }
      if (!accountIds || accountIds.length === 0) {
        sendJSON(res, 400, { ok: false, error: "accountIds required — which accounts should post this" });
        return true;
      }

      try {
        const r = await db.query(`
          INSERT INTO influence_posts (text_content, media_urls, hashtags, scheduled_at, campaign_id, status)
          VALUES ($1, $2, $3, $4, $5, 'scheduled')
          RETURNING *
        `, [text || null, mediaUrls || null, hashtags || null, scheduledAt || new Date().toISOString(), campaignId || null]);

        const post = r.rows[0];

        // Link accounts to this post
        for (const accountId of accountIds) {
          await db.query(`
            INSERT INTO influence_post_accounts (post_id, account_id, status)
            VALUES ($1, $2, 'pending')
          `, [post.id, accountId]);
        }

        sendJSON(res, 201, { ok: true, post });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // DELETE /api/influence/posts/:id
    if (req.method === "DELETE" && pathname.match(/^\/api\/influence\/posts\/\d+$/)) {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const id = pathname.split("/").pop();
      try {
        await db.query(`DELETE FROM influence_post_accounts WHERE post_id = $1`, [id]);
        await db.query(`DELETE FROM influence_posts WHERE id = $1`, [id]);
        sendJSON(res, 200, { ok: true });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // ── Campaigns ──

    // GET /api/influence/campaigns
    if (req.method === "GET" && pathname === "/api/influence/campaigns") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      try {
        const r = await db.query(`
          SELECT c.*,
            (SELECT count(*) FROM influence_posts WHERE campaign_id = c.id) as post_count,
            (SELECT count(*) FROM influence_posts WHERE campaign_id = c.id AND status = 'posted') as posted_count
          FROM influence_campaigns c ORDER BY created_at DESC
        `);
        sendJSON(res, 200, { ok: true, campaigns: r.rows });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // POST /api/influence/campaigns
    if (req.method === "POST" && pathname === "/api/influence/campaigns") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const body = await parseBody(req);
      const { name, description } = body;
      if (!name) { sendJSON(res, 400, { ok: false, error: "name required" }); return true; }

      try {
        const r = await db.query(`
          INSERT INTO influence_campaigns (name, description, status)
          VALUES ($1, $2, 'active')
          RETURNING *
        `, [name, description || null]);
        sendJSON(res, 201, { ok: true, campaign: r.rows[0] });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // ── Service Status ──

    // GET /api/influence/status — check all service connections
    if (req.method === "GET" && pathname === "/api/influence/status") {
      const results = {};

      // Dolphin Anty
      try {
        const profiles = await listDolphinProfiles();
        results.dolphinAnty = { ok: true, profiles: profiles.data?.length || 0 };
      } catch (err) {
        results.dolphinAnty = { ok: false, error: err.message };
      }

      // CapSolver balance
      try {
        const balance = await getCapSolverBalance();
        results.capSolver = { ok: true, balance };
      } catch (err) {
        results.capSolver = { ok: false, error: err.message };
      }

      // Decodo proxy test
      const env = loadEnv();
      results.decodo = {
        ok: !!env.DECODO_PROXY_USER,
        configured: !!env.DECODO_PROXY_USER,
      };

      // TextVerified
      results.textVerified = {
        ok: !!env.TEXTVERIFIED_API_KEY,
        configured: !!env.TEXTVERIFIED_API_KEY,
      };

      // DB accounts count
      if (db) {
        try {
          const r = await db.query(`SELECT count(*) as total, count(*) FILTER (WHERE status = 'active') as active FROM influence_accounts`);
          results.accounts = { total: parseInt(r.rows[0].total), active: parseInt(r.rows[0].active) };
        } catch {
          results.accounts = { total: 0, active: 0 };
        }
      }

      sendJSON(res, 200, { ok: true, services: results });
      return true;
    }

    return false;
  };
};
