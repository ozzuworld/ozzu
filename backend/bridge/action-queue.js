// action-queue.js — Redis-backed action queue for bridging Cipher sessions
// Actions are pushed by: daemon runs, watchdog alerts, directive changes, user requests.
// Pulled by cipher.sh at session start via /cipher/context, or manually via /cipher/actions/pull.
// Each action has: id, priority, type, message, metadata, createdAt, expiresAt.
// Deduplication by type+key: if an action with same type+key exists, it's updated, not duplicated.

"use strict";

const crypto = require("crypto");

const REDIS_KEY = "ozzu:cipher:actions";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_QUEUE_SIZE = 50;

let _redis = null;
let _db = null;

// ── Priority levels ──
const PRIORITY = {
  critical: 0,  // service down, deploy failed
  high: 1,      // blocked directive, gpu idle
  normal: 2,    // status updates, completed work
  low: 3,       // informational
};

// ── Core ──

function init(ctx) {
  _redis = ctx.redis;
  _db = ctx.db;
}

/**
 * Push an action to the queue.
 * Deduplicates by type+dedupKey — if exists, updates instead of adding.
 * @param {Object} action - { type, message, priority?, dedupKey?, metadata?, ttlMs? }
 * @returns {Object} - { id, created, updated }
 */
async function push(action) {
  if (!_redis) throw new Error("Redis not connected");

  const id = action.dedupKey
    ? `${action.type}:${action.dedupKey}`
    : `${action.type}:${crypto.randomBytes(6).toString("hex")}`;

  const entry = {
    id,
    type: action.type || "generic",
    message: action.message,
    priority: PRIORITY[action.priority] ?? PRIORITY.normal,
    priorityLabel: action.priority || "normal",
    metadata: action.metadata || {},
    createdAt: Date.now(),
    expiresAt: Date.now() + (action.ttlMs || DEFAULT_TTL_MS),
    acknowledged: false,
  };

  // Check for existing entry with same id (dedup)
  const existing = await getAll();
  const existingIdx = existing.findIndex(e => e.id === id);
  let updated = false;

  if (existingIdx >= 0) {
    // Update existing
    existing[existingIdx] = { ...existing[existingIdx], ...entry, createdAt: existing[existingIdx].createdAt };
    await _redis.set(REDIS_KEY, JSON.stringify(existing));
    updated = true;
  } else {
    // Add new, enforce max size (drop lowest priority/oldest)
    existing.push(entry);
    if (existing.length > MAX_QUEUE_SIZE) {
      // Sort by priority (ascending = higher priority first), then by createdAt (newest first)
      existing.sort((a, b) => a.priority - b.priority || b.createdAt - a.createdAt);
      existing.length = MAX_QUEUE_SIZE;
    }
    await _redis.set(REDIS_KEY, JSON.stringify(existing));
  }

  return { id, created: !updated, updated };
}

/**
 * Pull all pending (non-acknowledged, non-expired) actions, sorted by priority.
 * @param {Object} opts - { includeAcked?, limit? }
 * @returns {Array} sorted actions
 */
async function pull(opts = {}) {
  const all = await getAll();
  const now = Date.now();
  const limit = opts.limit || 20;

  let filtered = all.filter(a => {
    if (a.expiresAt && a.expiresAt < now) return false;  // expired
    if (!opts.includeAcked && a.acknowledged) return false;
    return true;
  });

  // Clean expired from Redis
  if (filtered.length < all.length) {
    const alive = all.filter(a => !a.expiresAt || a.expiresAt >= now);
    await _redis.set(REDIS_KEY, JSON.stringify(alive));
  }

  // Sort: priority asc (critical first), then createdAt desc (newest first)
  filtered.sort((a, b) => a.priority - b.priority || b.createdAt - a.createdAt);

  return filtered.slice(0, limit);
}

/**
 * Acknowledge an action (mark as handled).
 * @param {string} actionId
 * @returns {boolean} true if found and acked
 */
async function ack(actionId) {
  const all = await getAll();
  const entry = all.find(a => a.id === actionId);
  if (!entry) return false;
  entry.acknowledged = true;
  entry.ackedAt = Date.now();
  await _redis.set(REDIS_KEY, JSON.stringify(all));
  return true;
}

/**
 * Acknowledge all pending actions (batch).
 * @returns {number} count of actions acked
 */
async function ackAll() {
  const all = await getAll();
  let count = 0;
  for (const a of all) {
    if (!a.acknowledged) {
      a.acknowledged = true;
      a.ackedAt = Date.now();
      count++;
    }
  }
  if (count > 0) await _redis.set(REDIS_KEY, JSON.stringify(all));
  return count;
}

/**
 * Remove a specific action.
 */
async function remove(actionId) {
  const all = await getAll();
  const filtered = all.filter(a => a.id !== actionId);
  if (filtered.length < all.length) {
    await _redis.set(REDIS_KEY, JSON.stringify(filtered));
    return true;
  }
  return false;
}

/**
 * Get formatted text for injection into cipher context.
 * Returns empty string if no pending actions.
 */
async function getContextBlock() {
  try {
    const actions = await pull({ limit: 10 });
    if (actions.length === 0) return "";

    const lines = actions.map((a, i) => {
      const pri = a.priorityLabel ? `[${a.priorityLabel.toUpperCase()}]` : "";
      const meta = a.metadata?.directiveId ? ` (${a.metadata.directiveId})` : "";
      return `${i + 1}. ${pri} ${a.message}${meta}`;
    });

    return "\n## Action Queue (from between sessions — handle these)\n" + lines.join("\n");
  } catch {
    return "";
  }
}

// ── Internal ──

async function getAll() {
  if (!_redis) return [];
  try {
    const raw = await _redis.get(REDIS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

module.exports = { init, push, pull, ack, ackAll, remove, getContextBlock, PRIORITY };
