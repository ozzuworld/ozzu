/**
 * Account Pool — multi-account rotation for OSINT collection
 *
 * Manages a pool of social media accounts per platform with:
 * - Automatic rotation when rate-limited or CAPTCHA'd
 * - Health tracking (good, cooldown, restricted, banned)
 * - Cooldown periods after heavy use
 * - SSO login via Google accounts on Redroid
 *
 * Directive: dir_1775979358191
 */

"use strict";

const fs = require("fs");
const path = require("path");

const POOL_FILE = path.join(__dirname, "..", "..", "..", "private", "account-pool.json");

// Cooldown after a session (minutes)
const DEFAULT_COOLDOWN = 30;
// Max collections per session before forced rotation
const MAX_COLLECTIONS_PER_SESSION = 15;

/**
 * @typedef {Object} Account
 * @property {string} id - unique identifier (email or username)
 * @property {string} email - Google/login email
 * @property {string} platform - twitter|linkedin|facebook|tiktok|discord|instagram
 * @property {string} owner - who this account belongs to (e.g. "nat", "hebert", "family")
 * @property {"good"|"cooldown"|"restricted"|"banned"} health
 * @property {number} tier - 1=old active, 2=old dormant, 3=fresh
 * @property {number} sessionsToday - collections in current session
 * @property {string|null} lastUsed - ISO timestamp
 * @property {string|null} cooldownUntil - ISO timestamp when cooldown ends
 * @property {string|null} notes
 */

function loadPool() {
  try {
    return JSON.parse(fs.readFileSync(POOL_FILE, "utf8"));
  } catch {
    return { accounts: [], lastRotation: null };
  }
}

function savePool(pool) {
  const dir = path.dirname(POOL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
}

/**
 * Get all accounts for a platform, sorted by best candidate first
 */
function getAccounts(platform) {
  const pool = loadPool();
  return pool.accounts
    .filter((a) => a.platform === platform)
    .sort((a, b) => {
      // Prefer: good > cooldown > restricted. Never use banned.
      const healthOrder = { good: 0, cooldown: 1, restricted: 2, banned: 3 };
      const ha = healthOrder[a.health] || 9;
      const hb = healthOrder[b.health] || 9;
      if (ha !== hb) return ha - hb;

      // Prefer higher tier (lower number = better)
      if (a.tier !== b.tier) return a.tier - b.tier;

      // Prefer least recently used
      const la = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
      const lb = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
      return la - lb;
    });
}

/**
 * Get the best available account for a platform
 * Skips accounts in cooldown, restricted, or banned
 * @returns {Account|null}
 */
function getBestAccount(platform) {
  const now = new Date();
  const accounts = getAccounts(platform);

  for (const acct of accounts) {
    if (acct.health === "banned") continue;
    if (acct.health === "restricted") continue;

    // Check cooldown
    if (acct.cooldownUntil && new Date(acct.cooldownUntil) > now) continue;

    // Check session limit
    if (acct.sessionsToday >= MAX_COLLECTIONS_PER_SESSION) continue;

    // Clear expired cooldown
    if (acct.health === "cooldown" && acct.cooldownUntil && new Date(acct.cooldownUntil) <= now) {
      acct.health = "good";
      acct.sessionsToday = 0;
    }

    return acct;
  }

  return null;
}

/**
 * Mark account as used after a collection
 */
function markUsed(accountId) {
  const pool = loadPool();
  const acct = pool.accounts.find((a) => a.id === accountId);
  if (!acct) return;

  acct.lastUsed = new Date().toISOString();
  acct.sessionsToday = (acct.sessionsToday || 0) + 1;

  // Auto-cooldown if session limit reached
  if (acct.sessionsToday >= MAX_COLLECTIONS_PER_SESSION) {
    acct.health = "cooldown";
    acct.cooldownUntil = new Date(
      Date.now() + DEFAULT_COOLDOWN * 60 * 1000
    ).toISOString();
    console.log(
      `[pool] ${acct.id} hit session limit (${MAX_COLLECTIONS_PER_SESSION}), cooldown until ${acct.cooldownUntil}`
    );
  }

  savePool(pool);
}

/**
 * Mark account as rate-limited or CAPTCHA'd — put on cooldown
 */
function markCooldown(accountId, minutes) {
  const pool = loadPool();
  const acct = pool.accounts.find((a) => a.id === accountId);
  if (!acct) return;

  acct.health = "cooldown";
  acct.cooldownUntil = new Date(
    Date.now() + (minutes || DEFAULT_COOLDOWN) * 60 * 1000
  ).toISOString();
  console.log(`[pool] ${acct.id} → cooldown for ${minutes || DEFAULT_COOLDOWN}m`);
  savePool(pool);
}

/**
 * Mark account as restricted (needs manual intervention)
 */
function markRestricted(accountId, reason) {
  const pool = loadPool();
  const acct = pool.accounts.find((a) => a.id === accountId);
  if (!acct) return;

  acct.health = "restricted";
  acct.notes = reason || "Account restricted by platform";
  console.log(`[pool] ${acct.id} → restricted: ${acct.notes}`);
  savePool(pool);
}

/**
 * Mark account as banned (permanently unusable)
 */
function markBanned(accountId) {
  const pool = loadPool();
  const acct = pool.accounts.find((a) => a.id === accountId);
  if (!acct) return;

  acct.health = "banned";
  console.log(`[pool] ${acct.id} → BANNED`);
  savePool(pool);
}

/**
 * Restore account to good health
 */
function markGood(accountId) {
  const pool = loadPool();
  const acct = pool.accounts.find((a) => a.id === accountId);
  if (!acct) return;

  acct.health = "good";
  acct.cooldownUntil = null;
  acct.sessionsToday = 0;
  savePool(pool);
}

/**
 * Add a new account to the pool
 */
function addAccount(account) {
  const pool = loadPool();

  // Check for duplicate
  const existing = pool.accounts.find(
    (a) => a.id === account.id && a.platform === account.platform
  );
  if (existing) {
    Object.assign(existing, account);
    savePool(pool);
    return existing;
  }

  const newAcct = {
    id: account.id || account.email,
    email: account.email,
    platform: account.platform,
    owner: account.owner || "unknown",
    health: account.health || "good",
    tier: account.tier || 2,
    sessionsToday: 0,
    lastUsed: null,
    cooldownUntil: null,
    notes: account.notes || null,
  };

  pool.accounts.push(newAcct);
  savePool(pool);
  console.log(`[pool] Added ${newAcct.id} for ${newAcct.platform} (tier ${newAcct.tier}, owner: ${newAcct.owner})`);
  return newAcct;
}

/**
 * Remove an account from the pool
 */
function removeAccount(accountId, platform) {
  const pool = loadPool();
  pool.accounts = pool.accounts.filter(
    (a) => !(a.id === accountId && (!platform || a.platform === platform))
  );
  savePool(pool);
}

/**
 * Get full pool status summary
 */
function getStatus() {
  const pool = loadPool();
  const now = new Date();

  const byPlatform = {};
  for (const acct of pool.accounts) {
    if (!byPlatform[acct.platform]) {
      byPlatform[acct.platform] = { total: 0, good: 0, cooldown: 0, restricted: 0, banned: 0 };
    }
    byPlatform[acct.platform].total++;
    byPlatform[acct.platform][acct.health]++;
  }

  return {
    totalAccounts: pool.accounts.length,
    byPlatform,
    accounts: pool.accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      owner: a.owner,
      health: a.health,
      tier: a.tier,
      sessionsToday: a.sessionsToday,
      lastUsed: a.lastUsed,
      cooldownUntil: a.cooldownUntil,
      inCooldown: a.cooldownUntil ? new Date(a.cooldownUntil) > now : false,
    })),
  };
}

/**
 * Reset all session counters (call daily)
 */
function resetDailyCounts() {
  const pool = loadPool();
  for (const acct of pool.accounts) {
    acct.sessionsToday = 0;
    // Clear expired cooldowns
    if (acct.health === "cooldown" && acct.cooldownUntil && new Date(acct.cooldownUntil) <= new Date()) {
      acct.health = "good";
      acct.cooldownUntil = null;
    }
  }
  savePool(pool);
  console.log(`[pool] Daily counters reset for ${pool.accounts.length} accounts`);
}

module.exports = {
  loadPool,
  savePool,
  getAccounts,
  getBestAccount,
  markUsed,
  markCooldown,
  markRestricted,
  markBanned,
  markGood,
  addAccount,
  removeAccount,
  getStatus,
  resetDailyCounts,
  POOL_FILE,
};
