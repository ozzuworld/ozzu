/**
 * Auto-Discovery Engine — given minimal seed data, discover everything
 *
 * Full pipeline using ALL available OSINT tools:
 *   Phase 1:   holehe — email → platform detection
 *   Phase 1.5: sherlock + maigret — username enumeration (resolves handles)
 *   Phase 1.6: h8mail — email breach intelligence
 *   Phase 1.7: phoneinfoga — phone number OSINT
 *   Phase 1.8: theHarvester — domain/email harvesting
 *   Phase 1.9: socid_extractor — social profile ID extraction
 *   Phase 2:   ADB collector — profile scraping
 *   Phase 3:   KAIROS NLP enrichment (automatic)
 *   Phase 4:   Network spider — connection discovery
 *
 * Directive: dir_1775984764121, dir_1775985939315
 */

"use strict";

const { execSync } = require("child_process");
const cliRunner = require("../osint-cli-runner");
const crypto = require("crypto");

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:3333";
const COLLECTOR_URL = process.env.COLLECTOR_URL || "http://localhost:3335";
const OSINT_CONTAINER = "osint-tools";

// ── Platform Resolution ──

/**
 * Use holehe to find which platforms an email is registered on.
 * Runs inside the osint-tools Docker container.
 *
 * @param {string} email
 * @returns {Promise<string[]>} List of platform names (e.g. ["twitter.com", "spotify.com"])
 */
async function resolveEmailToPlatforms(email) {
  try {
    const available = await cliRunner.isToolAvailable("holehe");
    if (!available) {
      console.error(`[auto-discover] holehe not available in container`);
      return [];
    }

    const result = await cliRunner.runTool("holehe", [
      "--only-used", "--no-clear", "--no-color", email,
    ], { timeout: 120000, parseJson: false });

    const output = result.stdout || "";
    const platforms = [];
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/^\[.\]\s+(.+)$/);
      if (match && match[1].includes(".")) {
        platforms.push(match[1].trim().toLowerCase());
      }
    }

    console.log(`[auto-discover] holehe: ${email} → ${platforms.length} platforms: ${platforms.join(", ")}`);
    return platforms;
  } catch (err) {
    console.error(`[auto-discover] holehe failed for ${email}: ${err.message}`);
    return [];
  }
}

/**
 * Map holehe platform names to our collector platform names
 */
function mapPlatform(holehePlatform) {
  const map = {
    "twitter.com": "twitter",
    "instagram.com": "instagram",
    "linkedin.com": "linkedin",
    "tiktok.com": "tiktok",
    "reddit.com": "reddit",
    "facebook.com": "facebook",
    "github.com": "github",
    "spotify.com": "spotify",
    "amazon.com": "amazon",
    "office365.com": "microsoft",
    "pinterest.com": "pinterest",
    "tumblr.com": "tumblr",
    "flickr.com": "flickr",
  };
  return map[holehePlatform] || null;
}

// ── OSINT Tool Runners ──
// All tools run via osint-cli-runner → docker exec osint-tools

/**
 * Sherlock: username search across 400+ sites.
 * Given a username guess (e.g. from name), finds which platforms have that account.
 * @returns {{ sites: Array<{site: string, url: string}>, total: number }}
 */
async function runSherlock(username) {
  const available = await cliRunner.isToolAvailable("sherlock");
  if (!available) return { sites: [], total: 0, error: "tool_unavailable" };

  try {
    const result = await cliRunner.runTool("sherlock", [
      username, "--print-found", "--timeout", "15",
    ], { timeout: 180000, parseJson: false });

    // Parse stdout: "[+] SiteName: https://..."
    const sites = [];
    for (const line of (result.stdout || "").split("\n")) {
      const match = line.match(/^\[\+\]\s+(.+?):\s+(https?:\/\/.+)$/);
      if (match) {
        sites.push({ site: match[1].trim(), url: match[2].trim() });
      }
    }
    console.log(`[auto-discover] sherlock: "${username}" → ${sites.length} accounts`);
    return { sites, total: sites.length };
  } catch (err) {
    console.error(`[auto-discover] sherlock failed for "${username}": ${err.message}`);
    return { sites: [], total: 0, error: err.message };
  }
}

/**
 * Maigret: deep username search across 2500+ sites with PII extraction.
 * @returns {{ sites: Array<{site: string, url: string, tags?: string[]}>, pii: object, total: number }}
 */
async function runMaigret(username) {
  const available = await cliRunner.isToolAvailable("maigret");
  if (!available) return { sites: [], pii: {}, total: 0, error: "tool_unavailable" };

  try {
    const result = await cliRunner.runTool("maigret", [
      username, "--timeout", "10", "--top-sites", "500",
    ], { timeout: 180000, parseJson: false });

    // Parse stdout: "[+] SiteName: https://..."
    const sites = [];
    for (const line of (result.stdout || "").split("\n")) {
      // Maigret output: "on NN: [+] SiteName: https://..." or just "[+] SiteName: https://..."
      const match = line.match(/\[\+\]\s+(.+?):\s+(https?:\/\/.+)/);
      if (match) {
        sites.push({ site: match[1].trim(), url: match[2].trim() });
      }
    }

    // Parse "Extracted IDs: {...}" line for PII
    const pii = {};
    const idsMatch = (result.stdout || "").match(/Extracted IDs:\s*(\{.+\})/);
    if (idsMatch) {
      try {
        const ids = JSON.parse(idsMatch[1]);
        for (const [k, v] of Object.entries(ids)) {
          if (v && String(v).length > 0) pii[k] = [String(v)];
        }
      } catch { /* parse failed */ }
    }

    console.log(`[auto-discover] maigret: "${username}" → ${sites.length} accounts, ${Object.keys(pii).length} PII fields`);
    return { sites, pii, total: sites.length };
  } catch (err) {
    console.error(`[auto-discover] maigret failed for "${username}": ${err.message}`);
    return { sites: [], pii: {}, total: 0, error: err.message };
  }
}

/**
 * h8mail: email breach data aggregation.
 * @returns {{ breaches: string[], passwords: number, total: number }}
 */
async function runH8mail(email) {
  const available = await cliRunner.isToolAvailable("h8mail");
  if (!available) return { breaches: [], passwords: 0, total: 0, error: "tool_unavailable" };

  const outputFile = `/tmp/osint-data/h8mail-${crypto.randomBytes(4).toString("hex")}.json`;

  try {
    const result = await cliRunner.runTool("h8mail", [
      "-t", email, "-j", outputFile,
    ], { timeout: 90000 });

    let output = null;
    try {
      const fileResult = await cliRunner.runTool("cat", [outputFile], { timeout: 5000 });
      output = fileResult.parsed;
    } catch { /* file may not exist */ }
    cliRunner.runTool("rm", ["-f", outputFile], { timeout: 5000 }).catch(() => {});

    if (output) {
      const targets = Array.isArray(output) ? output : (output.targets || [output]);
      let allBreaches = [];
      let passwordCount = 0;
      for (const target of targets) {
        const breaches = target.data || target.breaches || [];
        allBreaches = allBreaches.concat(breaches.map(b => typeof b === "string" ? b : (b.source || b.name || "Unknown")));
        passwordCount += (target.passwords || []).length;
      }
      console.log(`[auto-discover] h8mail: ${email} → ${allBreaches.length} breaches, ${passwordCount} passwords`);
      return { breaches: allBreaches, passwords: passwordCount, total: allBreaches.length };
    }

    // Fallback: parse stdout (strip ANSI)
    const clean = (result.stdout || "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\[0m/g, "");
    const breachLines = clean.split("\n").filter(l => {
      const lower = l.toLowerCase();
      return (lower.includes("breach") || lower.includes("leak") || lower.includes("dump")) &&
        !lower.includes("no results") && !lower.includes("not found") && l.trim().length > 10;
    });
    return { breaches: breachLines, passwords: 0, total: breachLines.length };
  } catch (err) {
    console.error(`[auto-discover] h8mail failed for ${email}: ${err.message}`);
    return { breaches: [], passwords: 0, total: 0, error: err.message };
  }
}

/**
 * PhoneInfoga: phone number OSINT (carrier, country, Google dorks).
 * @returns {{ carrier: string|null, country: string|null, lineType: string|null, dorks: number }}
 */
async function runPhoneInfoga(phone) {
  const available = await cliRunner.isToolAvailable("phoneinfoga");
  if (!available) return { carrier: null, country: null, lineType: null, dorks: 0, error: "tool_unavailable" };

  try {
    const result = await cliRunner.runTool("phoneinfoga", [
      "scan", "-n", phone,
    ], { timeout: 60000 });

    const parsed = result.parsed;
    if (parsed) {
      const data = Array.isArray(parsed) ? parsed[0] : parsed;
      console.log(`[auto-discover] phoneinfoga: ${phone} → carrier=${data?.carrier || "?"}, country=${data?.country || "?"}`);
      return {
        carrier: data?.carrier || null,
        country: data?.country || null,
        lineType: data?.line_type || null,
        dorks: (data?.dorks || []).length,
        raw: data,
      };
    }

    // Text fallback
    const lines = (result.stdout || "").split("\n").filter(l => l.trim().length > 0);
    console.log(`[auto-discover] phoneinfoga: ${phone} → ${lines.length} output lines`);
    return { carrier: null, country: null, lineType: null, dorks: 0, output: lines };
  } catch (err) {
    console.error(`[auto-discover] phoneinfoga failed for ${phone}: ${err.message}`);
    return { carrier: null, country: null, lineType: null, dorks: 0, error: err.message };
  }
}

/**
 * theHarvester: email/subdomain/host harvesting for a domain.
 * @returns {{ emails: string[], hosts: string[], total: number }}
 */
async function runTheHarvester(domain) {
  const available = await cliRunner.isToolAvailable("theHarvester");
  if (!available) return { emails: [], hosts: [], total: 0, error: "tool_unavailable" };

  try {
    const result = await cliRunner.runTool("theHarvester", [
      "-d", domain, "-b", "anubis,crtsh,dnsdumpster,hackertarget,rapiddns,urlscan",
      "-l", "200",
    ], { timeout: 120000, parseJson: false });

    const stdout = result.stdout || "";
    const emails = [];
    const hosts = [];

    // Parse theHarvester text output
    let section = null;
    for (const line of stdout.split("\n")) {
      if (line.includes("[*] Emails found:")) { section = "emails"; continue; }
      if (line.includes("[*] Hosts found:")) { section = "hosts"; continue; }
      if (line.startsWith("[*]") && section) { section = null; continue; }

      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("-")) continue;

      if (section === "emails" && trimmed.includes("@")) emails.push(trimmed);
      if (section === "hosts" && trimmed.includes(".")) hosts.push(trimmed.split(":")[0]);
    }

    console.log(`[auto-discover] theHarvester: ${domain} → ${emails.length} emails, ${hosts.length} hosts`);
    return { emails, hosts, total: emails.length + hosts.length };
  } catch (err) {
    console.error(`[auto-discover] theHarvester failed for ${domain}: ${err.message}`);
    return { emails: [], hosts: [], total: 0, error: err.message };
  }
}

/**
 * socid_extractor: extract social IDs from profile URLs.
 * @returns {{ ids: object }}
 */
async function runSocidExtractor(url) {
  const available = await cliRunner.isToolAvailable("socid_extractor");
  if (!available) return { ids: {}, error: "tool_unavailable" };

  try {
    const result = await cliRunner.runTool("socid_extractor", [
      "--url", url,
    ], { timeout: 30000, parseJson: false });

    const ids = {};
    const stdout = result.stdout || "";
    for (const line of stdout.split("\n")) {
      const match = line.match(/^(.+?):\s+(.+)$/);
      if (match) ids[match[1].trim()] = match[2].trim();
    }

    console.log(`[auto-discover] socid_extractor: ${url} → ${Object.keys(ids).length} IDs`);
    return { ids };
  } catch (err) {
    console.error(`[auto-discover] socid_extractor failed for ${url}: ${err.message}`);
    return { ids: {}, error: err.message };
  }
}

/**
 * Map sherlock/maigret site names to our platform names for anchor creation.
 */
function mapSiteToPlat(siteName) {
  const s = siteName.toLowerCase();
  if (s.includes("twitter") || s.includes("x.com")) return "twitter";
  if (s.includes("instagram")) return "instagram";
  if (s.includes("linkedin")) return "linkedin";
  if (s.includes("tiktok")) return "tiktok";
  if (s.includes("reddit")) return "reddit";
  if (s.includes("facebook")) return "facebook";
  if (s.includes("github")) return "github";
  if (s.includes("youtube")) return "youtube";
  if (s.includes("pinterest")) return "pinterest";
  if (s.includes("tumblr")) return "tumblr";
  if (s.includes("spotify")) return "spotify";
  if (s.includes("telegram")) return "telegram";
  if (s.includes("discord")) return "discord";
  if (s.includes("mastodon")) return "mastodon";
  if (s.includes("bluesky") || s.includes("bsky")) return "bluesky";
  return null;
}

/**
 * Extract username from a profile URL.
 */
function extractUsernameFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // Most social sites: /{username} or /in/{username} (LinkedIn)
    if (parts.length > 0) {
      let last = parts[parts.length - 1];
      if (last && last.length > 0 && last.length < 50 && !last.includes(".")) {
        // Strip leading @ (TikTok, Mastodon URLs use /@username)
        return last.replace(/^@+/, "");
      }
    }
  } catch { /* invalid URL */ }
  return null;
}

// ── KG Helpers ──

async function getSubject(subjectId) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}`);
  return resp.json();
}

async function getAnchors(subjectId) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/anchors`);
  return resp.json();
}

async function addAnchor(subjectId, anchor) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/anchors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(anchor),
  });
  return resp.json();
}

async function addFact(subjectId, fact) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/facts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fact),
  });
  return resp.json();
}

async function addTimeline(subjectId, event) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects/${subjectId}/timeline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  return resp.json();
}

async function collectProfile(subjectId, platform, handle) {
  const resp = await fetch(`${COLLECTOR_URL}/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform,
      action: "profile",
      subject_id: subjectId,
      params: { handle },
    }),
    signal: AbortSignal.timeout(60000),
  });
  return resp.json();
}

async function discoverConnections(subjectId, handle, listType = "following") {
  const resp = await fetch(`${COLLECTOR_URL}/discover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subject_id: subjectId,
      handle,
      list_type: listType,
      max: 50,
      scroll_passes: 8,
      auto_collect: false,
    }),
    signal: AbortSignal.timeout(120000),
  });
  return resp.json();
}

// ── Auto-Discovery Pipeline ──

/**
 * Run full auto-discovery on a KG subject using ALL available OSINT tools.
 *
 * Phase 1:   Email → Platform detection (holehe)
 * Phase 1.5: Username enumeration (sherlock + maigret) → resolves handles
 * Phase 1.6: Email breach intelligence (h8mail)
 * Phase 1.7: Phone intelligence (phoneinfoga)
 * Phase 1.8: Domain/email harvesting (theHarvester)
 * Phase 1.9: Social ID extraction (socid_extractor)
 * Phase 2:   Profile collection (ADB collector)
 * Phase 3:   NLP enrichment (KAIROS automatic)
 * Phase 4:   Network spider (connection discovery)
 *
 * @param {number} subjectId
 * @param {object} opts - { skipHolehe, skipOsint, skipCollect, skipDiscover, skipBreaches, skipPhone, skipHarvester }
 */
async function autoDiscover(subjectId, opts = {}) {
  const results = {
    subjectId,
    phases: {},
    platforms_found: [],
    usernames_found: [],
    handles_resolved: [],
    breaches_found: [],
    profiles_collected: [],
    connections_discovered: 0,
    errors: [],
    started_at: new Date().toISOString(),
  };

  try {
    // Get subject and anchors
    const subject = await getSubject(subjectId);
    const anchors = await getAnchors(subjectId);

    const emails = anchors.filter(a => a.anchor_type === "email").map(a => a.value);
    const phones = anchors.filter(a => a.anchor_type === "phone").map(a => a.value);
    let existingHandles = anchors.filter(a => a.anchor_type === "social_handle");

    console.log(`[auto-discover] Starting for "${subject.name}" (${emails.length} emails, ${phones.length} phones, ${existingHandles.length} handles)`);

    // ── Phase 1: Email → Platform detection (holehe) ──
    if (!opts.skipHolehe && emails.length > 0) {
      console.log(`[auto-discover] Phase 1: holehe — resolving ${emails.length} email(s)...`);
      const allPlatforms = new Set();

      for (const email of emails) {
        const platforms = await resolveEmailToPlatforms(email);
        for (const p of platforms) {
          allPlatforms.add(p);
          const mapped = mapPlatform(p);
          if (mapped) {
            await addFact(subjectId, {
              category: "digital_footprint",
              key: `email_registered_${mapped}`,
              value: `${email} → ${p}`,
              source: "holehe",
              confidence: 90,
            });
          }
        }
      }

      results.platforms_found = Array.from(allPlatforms);
      results.phases.holehe = { emails_checked: emails.length, platforms_found: results.platforms_found.length };

      await addTimeline(subjectId, {
        event_type: "discovery",
        title: `holehe: ${results.platforms_found.length} platforms found`,
        description: `Platforms: ${results.platforms_found.join(", ")}`,
        source: "auto-discover:holehe",
      });

      console.log(`[auto-discover] Phase 1 done: ${results.platforms_found.length} platforms`);
    }

    // ── Phase 1.5: Username Enumeration (sherlock + maigret) ──
    // This resolves the "email on platform but no handle" problem
    if (!opts.skipOsint) {
      // Generate username candidates from the subject's name
      const nameParts = subject.name.toLowerCase().split(/\s+/);
      const candidates = new Set();
      if (nameParts.length >= 2) {
        candidates.add(nameParts.join(""));           // hebertsuarez
        candidates.add(nameParts.join("_"));           // hebert_suarez
        candidates.add(nameParts.join("."));           // hebert.suarez
        candidates.add(nameParts[0] + nameParts[1][0]); // heberts
        candidates.add(nameParts[0][0] + nameParts[1]); // hsuarez
        candidates.add(nameParts[0]);                  // hebert
      }
      // Also extract usernames from email local parts
      for (const email of emails) {
        const local = email.split("@")[0];
        if (local) candidates.add(local.toLowerCase());
      }
      // Add existing handles as candidates (to search other platforms)
      for (const h of existingHandles) {
        candidates.add(h.value.replace("@", "").toLowerCase());
      }

      if (candidates.size > 0) {
        console.log(`[auto-discover] Phase 1.5: Username enumeration — ${candidates.size} candidates: ${[...candidates].join(", ")}`);

        const allSites = new Map(); // site → { url, username }
        const allPii = {};

        for (const username of candidates) {
          // Run sherlock first (faster, 400+ sites)
          const shResult = await runSherlock(username);
          for (const s of shResult.sites) {
            const key = `${s.site}-${username}`;
            if (!allSites.has(key)) allSites.set(key, { ...s, username });
          }

          // Run maigret (deeper, 2500+ sites, extracts PII)
          const mgResult = await runMaigret(username);
          for (const s of mgResult.sites) {
            const key = `${s.site}-${username}`;
            if (!allSites.has(key)) allSites.set(key, { ...s, username });
          }
          // Merge PII
          for (const [k, v] of Object.entries(mgResult.pii)) {
            if (!allPii[k]) allPii[k] = new Set();
            for (const val of v) allPii[k].add(val);
          }

          // Small delay between candidates
          await new Promise(r => setTimeout(r, 2000));
        }

        // Process results: add discovered handles as anchors
        const newHandles = new Map(); // platform → { username, url }
        for (const [, entry] of allSites) {
          const platform = mapSiteToPlat(entry.site);
          if (platform && !existingHandles.some(h => h.platform === platform)) {
            if (!newHandles.has(platform)) {
              const handle = extractUsernameFromUrl(entry.url) || entry.username;
              newHandles.set(platform, { username: handle, url: entry.url });
            }
          }
        }

        // Add new social_handle anchors
        for (const [platform, { username, url }] of newHandles) {
          console.log(`[auto-discover] Resolved handle: ${platform} → @${username} (${url})`);
          await addAnchor(subjectId, {
            anchor_type: "social_handle",
            value: username,
            platform,
          });
          results.handles_resolved.push({ platform, username, url });
        }

        // Store PII as facts
        const piiClean = {};
        for (const [k, v] of Object.entries(allPii)) piiClean[k] = [...v];
        if (Object.keys(piiClean).length > 0) {
          await addFact(subjectId, {
            category: "pii_exposure",
            key: "maigret_pii",
            value: JSON.stringify(piiClean),
            source: "maigret",
            confidence: 70,
          });
        }

        // Store total account footprint as fact
        await addFact(subjectId, {
          category: "digital_footprint",
          key: "username_enumeration_total",
          value: `${allSites.size} accounts found across sherlock+maigret`,
          source: "sherlock+maigret",
          confidence: 80,
        });

        results.phases.username_enum = {
          candidates: candidates.size,
          accounts_found: allSites.size,
          handles_resolved: newHandles.size,
          pii_fields: Object.keys(piiClean).length,
        };

        await addTimeline(subjectId, {
          event_type: "discovery",
          title: `Username enum: ${allSites.size} accounts, ${newHandles.size} handles resolved`,
          description: `Candidates: ${[...candidates].join(", ")}. Resolved: ${[...newHandles.entries()].map(([p, h]) => `${p}:@${h.username}`).join(", ")}`,
          source: "auto-discover:sherlock+maigret",
        });

        // Refresh handles list with newly discovered ones
        const freshAnchors = await getAnchors(subjectId);
        existingHandles = freshAnchors.filter(a => a.anchor_type === "social_handle");
      }
    }

    // ── Phase 1.6: Email Breach Intelligence (h8mail) ──
    if (!opts.skipBreaches && emails.length > 0) {
      console.log(`[auto-discover] Phase 1.6: h8mail — checking ${emails.length} email(s) for breaches...`);

      for (const email of emails) {
        const breachResult = await runH8mail(email);
        if (breachResult.total > 0) {
          results.breaches_found.push({ email, count: breachResult.total });
          await addFact(subjectId, {
            category: "security",
            key: `breach_${email.replace(/[@.]/g, "_")}`,
            value: `${breachResult.total} breach sources: ${breachResult.breaches.slice(0, 10).join(", ")}`,
            source: "h8mail",
            confidence: 85,
          });
          if (breachResult.passwords > 0) {
            await addFact(subjectId, {
              category: "security",
              key: `breach_passwords_${email.replace(/[@.]/g, "_")}`,
              value: `${breachResult.passwords} password(s) found in breach databases`,
              source: "h8mail",
              confidence: 95,
            });
          }
        }
      }

      results.phases.h8mail = {
        emails_checked: emails.length,
        breaches: results.breaches_found.reduce((sum, b) => sum + b.count, 0),
      };

      if (results.breaches_found.length > 0) {
        await addTimeline(subjectId, {
          event_type: "discovery",
          title: `h8mail: ${results.breaches_found.reduce((sum, b) => sum + b.count, 0)} breaches found`,
          description: results.breaches_found.map(b => `${b.email}: ${b.count} sources`).join(", "),
          source: "auto-discover:h8mail",
        });
      }
    }

    // ── Phase 1.7: Phone Intelligence (phoneinfoga) ──
    if (!opts.skipPhone && phones.length > 0) {
      console.log(`[auto-discover] Phase 1.7: phoneinfoga — scanning ${phones.length} phone(s)...`);

      for (const phone of phones) {
        const phoneResult = await runPhoneInfoga(phone);
        if (phoneResult.carrier || phoneResult.country) {
          await addFact(subjectId, {
            category: "phone_intel",
            key: `phone_${phone.replace(/[^0-9]/g, "")}`,
            value: `Carrier: ${phoneResult.carrier || "?"}, Country: ${phoneResult.country || "?"}, Type: ${phoneResult.lineType || "?"}`,
            source: "phoneinfoga",
            confidence: 80,
          });
        }
        if (phoneResult.dorks > 0) {
          await addFact(subjectId, {
            category: "exposure",
            key: `phone_exposure_${phone.replace(/[^0-9]/g, "")}`,
            value: `${phoneResult.dorks} Google dork results found — phone number exposed online`,
            source: "phoneinfoga",
            confidence: 75,
          });
        }
      }

      results.phases.phoneinfoga = { phones_checked: phones.length };
    }

    // ── Phase 1.8: Domain/Email Harvesting (theHarvester) ──
    if (!opts.skipHarvester && emails.length > 0) {
      const domains = [...new Set(emails.map(e => e.split("@")[1]).filter(d => d && !d.includes("gmail.com") && !d.includes("hotmail.com") && !d.includes("yahoo.com") && !d.includes("outlook.com")))];

      if (domains.length > 0) {
        console.log(`[auto-discover] Phase 1.8: theHarvester — scanning ${domains.length} domain(s)...`);

        for (const domain of domains) {
          const harvestResult = await runTheHarvester(domain);
          if (harvestResult.total > 0) {
            await addFact(subjectId, {
              category: "domain_intel",
              key: `harvest_${domain.replace(/\./g, "_")}`,
              value: `${harvestResult.emails.length} emails, ${harvestResult.hosts.length} hosts discovered for ${domain}`,
              source: "theHarvester",
              confidence: 80,
            });

            // Store discovered emails as potential new anchors
            for (const discoveredEmail of harvestResult.emails) {
              if (!emails.includes(discoveredEmail)) {
                await addFact(subjectId, {
                  category: "digital_footprint",
                  key: `discovered_email_${discoveredEmail.replace(/[@.]/g, "_")}`,
                  value: discoveredEmail,
                  source: "theHarvester",
                  confidence: 60,
                });
              }
            }
          }

          results.phases.theHarvester = {
            domains_checked: domains.length,
            emails_found: harvestResult.emails.length,
            hosts_found: harvestResult.hosts.length,
          };
        }
      }
    }

    // ── Phase 1.9: Social ID Extraction (socid_extractor) ──
    if (!opts.skipOsint && results.handles_resolved.length > 0) {
      console.log(`[auto-discover] Phase 1.9: socid_extractor — extracting IDs from ${results.handles_resolved.length} profile URLs...`);
      let totalIds = 0;

      for (const handle of results.handles_resolved) {
        if (handle.url) {
          const socidResult = await runSocidExtractor(handle.url);
          const idCount = Object.keys(socidResult.ids).length;
          if (idCount > 0) {
            totalIds += idCount;
            await addFact(subjectId, {
              category: "social_ids",
              key: `socid_${handle.platform}`,
              value: JSON.stringify(socidResult.ids),
              source: "socid_extractor",
              confidence: 85,
            });
          }
        }
      }

      results.phases.socid_extractor = { urls_checked: results.handles_resolved.length, ids_extracted: totalIds };
    }

    // ── Phase 2: Collect profiles on discovered platforms ──
    if (!opts.skipCollect) {
      // Now we have handles from Phase 1.5 — collect ALL platforms, not just Twitter
      const platformsToCollect = ["twitter", "linkedin", "instagram"];

      for (const platform of platformsToCollect) {
        const handle = existingHandles.find(h => h.platform === platform);
        if (handle) {
          console.log(`[auto-discover] Phase 2: Collecting ${platform} profile @${handle.value}...`);
          try {
            const result = await collectProfile(subjectId, platform, handle.value);
            if (result.ok) {
              results.profiles_collected.push(platform);
              console.log(`[auto-discover] ${platform} profile collected`);
            } else {
              results.errors.push(`${platform} collect: ${result.error}`);
            }
          } catch (err) {
            results.errors.push(`${platform} collect: ${err.message}`);
          }
          // Delay between collections
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      results.phases.collect = { profiles: results.profiles_collected.length };
    }

    // ── Phase 3: NLP enrichment happens automatically via KAIROS cron ──
    results.phases.enrich = { status: "queued_for_kairos", note: "NLP enrichment runs every 15 min automatically" };

    // ── Phase 4: Spider connections ──
    if (!opts.skipDiscover) {
      const twitterAnchor = existingHandles.find(h => h.platform === "twitter");

      if (twitterAnchor) {
        console.log(`[auto-discover] Phase 4: Discovering connections from @${twitterAnchor.value}...`);
        try {
          const result = await discoverConnections(subjectId, twitterAnchor.value, "following");
          results.connections_discovered = result.discovered || 0;
          results.phases.discover = {
            new_subjects: result.discovered || 0,
            existing: result.existing || 0,
          };
          console.log(`[auto-discover] Phase 4 done: ${results.connections_discovered} new subjects`);
        } catch (err) {
          results.errors.push(`Discover: ${err.message}`);
        }
      }
    }

    results.completed_at = new Date().toISOString();
    console.log(`[auto-discover] Complete for "${subject.name}":`, JSON.stringify(results.phases));

    // Log completion timeline event
    await addTimeline(subjectId, {
      event_type: "discovery",
      title: `Auto-discovery complete (full OSINT suite)`,
      description: JSON.stringify({
        platforms: results.platforms_found.length,
        handles_resolved: results.handles_resolved.length,
        breaches: results.breaches_found.length,
        profiles: results.profiles_collected.length,
        connections: results.connections_discovered,
        errors: results.errors.length,
      }),
      source: "auto-discover",
    });

  } catch (err) {
    results.errors.push(`Fatal: ${err.message}`);
    console.error(`[auto-discover] Fatal error:`, err.message);
  }

  return results;
}

/**
 * Run auto-discovery on ALL active subjects that haven't been collected yet.
 * Used by KAIROS scheduled task.
 */
async function autoDiscoverAll(opts = {}) {
  const resp = await fetch(`${BRIDGE_URL}/kg/subjects?status=active`);
  const subjects = await resp.json();

  const results = [];
  for (const subject of subjects) {
    if (subject.last_collected_at && !opts.force) continue; // already collected

    const result = await autoDiscover(subject.id, opts);
    results.push(result);

    // Delay between subjects
    await new Promise(r => setTimeout(r, opts.subjectDelay || 10000));
  }

  return results;
}

module.exports = {
  autoDiscover,
  autoDiscoverAll,
  resolveEmailToPlatforms,
  mapPlatform,
  // Individual tool runners (for manual/selective use)
  runSherlock,
  runMaigret,
  runH8mail,
  runPhoneInfoga,
  runTheHarvester,
  runSocidExtractor,
};
