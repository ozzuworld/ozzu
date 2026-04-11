// routes/influence.js — Social media account management & content scheduling
// Manages real accounts from consenting users via Dolphin Anty + Decodo proxies
//
// Directive: dir_1775926142812

"use strict";

const { encrypt, decrypt, createDolphinProfile, listDolphinProfiles, deleteDolphinProfile, getCapSolverBalance, loadEnv } = require("../influence");
const { executePost, loginGoogleSSO } = require("../influence/posting-engine");

const PLATFORMS = ["x", "instagram", "tiktok", "youtube", "linkedin", "reddit", "facebook"];

module.exports = function influenceRoutes(ctx) {
  const { sendJSON, parseBody, db } = ctx;

  return async function handleInfluenceRoutes(req, res, pathname, url) {

    // ── Members (one per real person) ──

    // GET /api/influence/members
    if (req.method === "GET" && pathname === "/api/influence/members") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      try {
        const r = await db.query(`
          SELECT m.*,
            COALESCE(json_agg(json_build_object('id', a.id, 'platform', a.platform, 'username', a.username, 'status', a.status))
              FILTER (WHERE a.id IS NOT NULL), '[]') as accounts
          FROM influence_members m
          LEFT JOIN influence_accounts a ON a.member_id = m.id
          GROUP BY m.id ORDER BY m.created_at DESC
        `);
        sendJSON(res, 200, { ok: true, members: r.rows });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // POST /api/influence/members — add a friend/family member
    if (req.method === "POST" && pathname === "/api/influence/members") {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const body = await parseBody(req);
      const { name, googleEmail, googlePassword, proxyPort } = body;

      if (!name || !googleEmail) {
        sendJSON(res, 400, { ok: false, error: "name and googleEmail required" });
        return true;
      }

      try {
        const port = proxyPort || (10001 + Math.floor(Math.random() * 500));
        const encPw = googlePassword ? encrypt(googlePassword) : null;

        // Create one Dolphin profile for this person
        let dolphinProfileId = null;
        try {
          const dolphinResult = await createDolphinProfile(`member-${name.toLowerCase().replace(/\s+/g, "-")}`, port);
          dolphinProfileId = String(dolphinResult.browserProfileId || dolphinResult.id || "");
        } catch (err) {
          console.error("[influence] Dolphin profile creation failed:", err.message);
        }

        const r = await db.query(`
          INSERT INTO influence_members (name, google_email, encrypted_google_pw, dolphin_profile_id, proxy_port)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id, name, google_email, dolphin_profile_id, proxy_port, status, created_at
        `, [name, googleEmail, encPw, dolphinProfileId, port]);

        sendJSON(res, 201, { ok: true, member: r.rows[0] });
        return true;
      } catch (err) {
        if (err.code === "23505") {
          sendJSON(res, 409, { ok: false, error: "Member with this Google email already exists" });
        } else {
          sendJSON(res, 500, { ok: false, error: err.message });
        }
        return true;
      }
    }

    // POST /api/influence/members/:id/login-google — SSO login for this member
    if (req.method === "POST" && pathname.match(/^\/api\/influence\/members\/\d+\/login-google$/)) {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const id = pathname.split("/")[4];
      try {
        const r = await db.query(`SELECT * FROM influence_members WHERE id = $1`, [id]);
        if (r.rows.length === 0) { sendJSON(res, 404, { ok: false, error: "Member not found" }); return true; }
        const member = r.rows[0];

        if (!member.encrypted_google_pw) {
          sendJSON(res, 400, { ok: false, error: "No Google password stored for this member" });
          return true;
        }

        const password = decrypt(member.encrypted_google_pw);
        const result = await loginGoogleSSO(member.proxy_port, member.google_email, password);

        if (result.success) {
          await db.query(`UPDATE influence_members SET status = 'logged_in' WHERE id = $1`, [id]);
        }

        sendJSON(res, 200, { ok: true, result });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

    // DELETE /api/influence/members/:id
    if (req.method === "DELETE" && pathname.match(/^\/api\/influence\/members\/\d+$/)) {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const id = pathname.split("/").pop();
      try {
        const r = await db.query(`SELECT dolphin_profile_id FROM influence_members WHERE id = $1`, [id]);
        if (r.rows.length === 0) { sendJSON(res, 404, { ok: false, error: "Not found" }); return true; }
        if (r.rows[0].dolphin_profile_id) {
          try { await deleteDolphinProfile(r.rows[0].dolphin_profile_id); } catch {}
        }
        await db.query(`DELETE FROM influence_accounts WHERE member_id = $1`, [id]);
        await db.query(`DELETE FROM influence_members WHERE id = $1`, [id]);
        sendJSON(res, 200, { ok: true });
        return true;
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: err.message });
        return true;
      }
    }

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

    // POST /api/influence/posts/:id/execute — run the post now on all target accounts
    if (req.method === "POST" && pathname.match(/^\/api\/influence\/posts\/\d+\/execute$/)) {
      if (!db) { sendJSON(res, 503, { ok: false, error: "DB unavailable" }); return true; }
      const postId = pathname.split("/")[4];
      try {
        const postR = await db.query(`SELECT * FROM influence_posts WHERE id = $1`, [postId]);
        if (postR.rows.length === 0) { sendJSON(res, 404, { ok: false, error: "Post not found" }); return true; }
        const post = postR.rows[0];

        const targetsR = await db.query(`
          SELECT pa.*, a.platform, a.username, a.proxy_port, a.member_id
          FROM influence_post_accounts pa
          JOIN influence_accounts a ON a.id = pa.account_id
          WHERE pa.post_id = $1 AND pa.status = 'pending'
        `, [postId]);

        if (targetsR.rows.length === 0) {
          sendJSON(res, 400, { ok: false, error: "No pending accounts to post to" });
          return true;
        }

        // Execute posts sequentially with delays between them
        const results = [];
        for (const target of targetsR.rows) {
          try {
            const result = await executePost(target, {
              text: post.text_content,
              mediaUrls: post.media_urls,
              hashtags: post.hashtags,
            });
            results.push({ accountId: target.account_id, ...result });

            // Update post_account status
            await db.query(`
              UPDATE influence_post_accounts SET status = $1, posted_at = NOW(), error_message = $2
              WHERE post_id = $3 AND account_id = $4
            `, [result.success ? "posted" : "failed", result.error || null, postId, target.account_id]);

            // Update account last_active
            if (result.success) {
              await db.query(`UPDATE influence_accounts SET last_active = NOW() WHERE id = $1`, [target.account_id]);
            }

            // Human-like delay between accounts
            if (targetsR.rows.indexOf(target) < targetsR.rows.length - 1) {
              await new Promise((r) => setTimeout(r, 15000 + Math.random() * 30000));
            }
          } catch (err) {
            results.push({ accountId: target.account_id, success: false, error: err.message });
            await db.query(`
              UPDATE influence_post_accounts SET status = 'failed', error_message = $1
              WHERE post_id = $2 AND account_id = $3
            `, [err.message, postId, target.account_id]);
          }
        }

        // Update overall post status
        const allPosted = results.every((r) => r.success);
        const anyPosted = results.some((r) => r.success);
        const newStatus = allPosted ? "posted" : anyPosted ? "partial" : "failed";
        await db.query(`UPDATE influence_posts SET status = $1 WHERE id = $2`, [newStatus, postId]);

        sendJSON(res, 200, { ok: true, status: newStatus, results });
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
