// PostgreSQL connection pool and query helpers for ozzu-bridge
const { Pool } = require("pg");

const pool = new Pool({
  host: "127.0.0.1",
  port: 5432,
  database: "ozzu",
  user: "ozzu",
  password: process.env.POSTGRES_PASSWORD || "ozzu",
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

let _pgConnected = false;

async function init() {
  try {
    const client = await pool.connect();
    client.release();
    _pgConnected = true;
    console.log("[pg] Connected to PostgreSQL");
  } catch (err) {
    console.error("[pg] Connection failed:", err.message);
    _pgConnected = false;
  }
  return _pgConnected;
}

function isConnected() {
  return _pgConnected;
}

async function query(text, params) {
  return pool.query(text, params);
}

// ── Memories ──

async function addMemory(persona, fact, category = "general", source = null) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO memories (persona, fact, category, source)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [persona, fact, category, source]
  );
  return res.rows[0]?.id;
}

async function getMemories(persona, limit = 50) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT id, fact, category, confidence, created_at, source
     FROM memories WHERE persona = $1
     ORDER BY confidence DESC, created_at DESC LIMIT $2`,
    [persona, limit]
  );
  return res.rows;
}

async function searchMemories(persona, searchText, limit = 10) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT id, fact, category, confidence, created_at,
            ts_rank(search_vector, plainto_tsquery('english', $2)) AS rank
     FROM memories WHERE persona = $1 AND search_vector @@ plainto_tsquery('english', $2)
     ORDER BY rank DESC, confidence DESC LIMIT $3`,
    [persona, searchText, limit]
  );
  return res.rows;
}

// ── Conversations ──

async function createConversation(persona, devices = []) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO conversations (persona, devices) VALUES ($1, $2) RETURNING id`,
    [persona, devices]
  );
  return res.rows[0]?.id;
}

async function endConversation(conversationId, summary, turnCount, topics = []) {
  if (!_pgConnected) return;
  await query(
    `UPDATE conversations SET ended_at = NOW(), summary = $2, turn_count = $3, topics = $4
     WHERE id = $1`,
    [conversationId, summary, turnCount, topics]
  );
}

async function addConversationTurn(conversationId, role, content, turnIndex, toolCalls = null) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO conversation_turns (conversation_id, role, content, turn_index, tool_calls)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [conversationId, role, content, turnIndex, toolCalls ? JSON.stringify(toolCalls) : null]
  );
  return res.rows[0]?.id;
}

async function getRecentSummaries(persona, limit = 5) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT id, summary, turn_count, topics, started_at, ended_at
     FROM conversations WHERE persona = $1 AND summary IS NOT NULL
     ORDER BY started_at DESC LIMIT $2`,
    [persona, limit]
  );
  return res.rows;
}

// ── Directives ──

async function saveDirective(directive) {
  if (!_pgConnected) return;
  await query(
    `INSERT INTO directives (id, type, title, description, status, plan, approval_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::double precision / 1000), to_timestamp($9::double precision / 1000))
     ON CONFLICT (id) DO UPDATE SET
       type = EXCLUDED.type, title = EXCLUDED.title, description = EXCLUDED.description,
       status = EXCLUDED.status, plan = EXCLUDED.plan, approval_id = EXCLUDED.approval_id,
       updated_at = EXCLUDED.updated_at`,
    [
      directive.id, directive.type, directive.title || "", directive.description || "",
      directive.status, directive.plan || null, directive.directiveApprovalId || null,
      directive.createdAt, directive.updatedAt,
    ]
  );
}

async function addDirectiveHistory(directiveId, oldStatus, newStatus, changedBy, notes = null) {
  if (!_pgConnected) return;
  await query(
    `INSERT INTO directive_history (directive_id, old_status, new_status, changed_by, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [directiveId, oldStatus, newStatus, changedBy, notes]
  );
}

async function getDirectives(statusFilter = null) {
  if (!_pgConnected) return null;
  let res;
  if (statusFilter) {
    res = await query(
      `SELECT * FROM directives WHERE status = $1 ORDER BY created_at DESC`,
      [statusFilter]
    );
  } else {
    res = await query(`SELECT * FROM directives ORDER BY created_at DESC`);
  }
  return res.rows;
}

// ── Approvals ──

async function saveApproval(approval) {
  if (!_pgConnected) return;
  await query(
    `INSERT INTO approvals (id, tool, description, risk, resolved, approved, auto_approved, reason, directive_id, created_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10::double precision / 1000), $11)
     ON CONFLICT (id) DO UPDATE SET
       resolved = EXCLUDED.resolved, approved = EXCLUDED.approved,
       auto_approved = EXCLUDED.auto_approved, reason = EXCLUDED.reason,
       resolved_at = EXCLUDED.resolved_at`,
    [
      approval.id, approval.tool || "", approval.description || "",
      approval.risk || "low", !!approval.resolved, approval.approved ?? null,
      !!approval.autoApproved, approval.reason || null,
      approval.directiveId || null, approval.createdAt,
      approval.resolvedAt ? new Date(approval.resolvedAt) : null,
    ]
  );
}

// ── Status Log ──

async function addStatusEntry(entry, persona = null) {
  if (!_pgConnected) return;
  await query(
    `INSERT INTO status_log (event, tool, message, persona, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [entry.event, entry.tool || null, entry.message || null, persona, entry.timestamp || new Date().toISOString()]
  );
}

async function getStatusLog(limit = 20) {
  if (!_pgConnected) return null;
  const res = await query(
    `SELECT event, tool, message, persona, created_at as timestamp FROM status_log
     ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

// ── Device Registry ──

async function upsertDevice(deviceId, deviceType = null, model = null, ipAddress = null, adbPort = null, arch = null) {
  if (!_pgConnected) return;
  await query(
    `INSERT INTO devices (device_id, device_type, model, ip_address, adb_port, arch, last_seen)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (device_id) DO UPDATE SET
       device_type = COALESCE(EXCLUDED.device_type, devices.device_type),
       model = COALESCE(EXCLUDED.model, devices.model),
       ip_address = COALESCE(EXCLUDED.ip_address, devices.ip_address),
       adb_port = COALESCE(EXCLUDED.adb_port, devices.adb_port),
       arch = COALESCE(EXCLUDED.arch, devices.arch),
       last_seen = NOW()`,
    [deviceId, deviceType, model, ipAddress, adbPort, arch]
  );
}

async function touchDevice(deviceId) {
  if (!_pgConnected) return;
  await query(`UPDATE devices SET last_seen = NOW() WHERE device_id = $1`, [deviceId]);
}

// ── Entity Snapshots ──

async function addEntitySnapshot(entityId, state, attributes = null) {
  if (!_pgConnected) return;
  await query(
    `INSERT INTO entity_snapshots (entity_id, state, attributes)
     VALUES ($1, $2, $3)`,
    [entityId, state, attributes ? JSON.stringify(attributes) : null]
  );
}

async function getEntityHistory(entityId, limit = 100) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT state, attributes, captured_at FROM entity_snapshots
     WHERE entity_id = $1 ORDER BY captured_at DESC LIMIT $2`,
    [entityId, limit]
  );
  return res.rows;
}

async function pruneEntitySnapshots(daysToKeep = 7) {
  if (!_pgConnected) return;
  await query(
    `DELETE FROM entity_snapshots WHERE captured_at < NOW() - INTERVAL '1 day' * $1`,
    [daysToKeep]
  );
}

// ── Deployments ──

async function addDeployment(type, version = null, targetDevices = [], notes = null) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO deployments (type, version, target_devices, notes)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [type, version, targetDevices, notes]
  );
  return res.rows[0]?.id;
}

async function completeDeployment(id, status = "completed", notes = null) {
  if (!_pgConnected) return;
  await query(
    `UPDATE deployments SET status = $2, completed_at = NOW(), notes = COALESCE($3, notes) WHERE id = $1`,
    [id, status, notes]
  );
}

// ── Query History (for Gemini query_history tool) ──

async function queryHistory(table, filters = {}) {
  if (!_pgConnected) return { error: "PostgreSQL not connected" };

  const limit = Math.min(filters.limit || 20, 50);

  switch (table) {
    case "directives": {
      let sql = `SELECT id, type, title, status, created_at, updated_at FROM directives`;
      const params = [];
      const clauses = [];
      if (filters.status) { params.push(filters.status); clauses.push(`status = $${params.length}`); }
      if (filters.type) { params.push(filters.type); clauses.push(`type = $${params.length}`); }
      if (filters.since) { params.push(filters.since); clauses.push(`created_at >= $${params.length}::timestamptz`); }
      if (clauses.length) sql += ` WHERE ` + clauses.join(" AND ");
      params.push(limit);
      sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
      const res = await query(sql, params);
      return { count: res.rows.length, rows: res.rows };
    }
    case "approvals": {
      let sql = `SELECT id, tool, description, risk, resolved, approved, created_at FROM approvals`;
      const params = [];
      const clauses = [];
      if (filters.resolved !== undefined) { params.push(filters.resolved); clauses.push(`resolved = $${params.length}`); }
      if (filters.risk) { params.push(filters.risk); clauses.push(`risk = $${params.length}`); }
      if (filters.since) { params.push(filters.since); clauses.push(`created_at >= $${params.length}::timestamptz`); }
      if (clauses.length) sql += ` WHERE ` + clauses.join(" AND ");
      params.push(limit);
      sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
      const res = await query(sql, params);
      return { count: res.rows.length, rows: res.rows };
    }
    case "memories": {
      let sql = `SELECT id, persona, fact, category, confidence, created_at FROM memories`;
      const params = [];
      const clauses = [];
      if (filters.persona) { params.push(filters.persona); clauses.push(`persona = $${params.length}`); }
      if (filters.category) { params.push(filters.category); clauses.push(`category = $${params.length}`); }
      if (filters.search) { params.push(filters.search); clauses.push(`search_vector @@ plainto_tsquery('english', $${params.length})`); }
      if (filters.since) { params.push(filters.since); clauses.push(`created_at >= $${params.length}::timestamptz`); }
      if (clauses.length) sql += ` WHERE ` + clauses.join(" AND ");
      params.push(limit);
      sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
      const res = await query(sql, params);
      return { count: res.rows.length, rows: res.rows };
    }
    case "status": {
      let sql = `SELECT event, tool, message, persona, created_at FROM status_log`;
      const params = [];
      const clauses = [];
      if (filters.event) { params.push(filters.event); clauses.push(`event = $${params.length}`); }
      if (filters.persona) { params.push(filters.persona); clauses.push(`persona = $${params.length}`); }
      if (filters.since) { params.push(filters.since); clauses.push(`created_at >= $${params.length}::timestamptz`); }
      if (clauses.length) sql += ` WHERE ` + clauses.join(" AND ");
      params.push(limit);
      sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
      const res = await query(sql, params);
      return { count: res.rows.length, rows: res.rows };
    }
    case "directive_history": {
      let sql = `SELECT dh.directive_id, d.title, dh.old_status, dh.new_status, dh.changed_by, dh.changed_at
                 FROM directive_history dh LEFT JOIN directives d ON dh.directive_id = d.id`;
      const params = [];
      const clauses = [];
      if (filters.directive_id) { params.push(filters.directive_id); clauses.push(`dh.directive_id = $${params.length}`); }
      if (filters.since) { params.push(filters.since); clauses.push(`dh.changed_at >= $${params.length}::timestamptz`); }
      if (clauses.length) sql += ` WHERE ` + clauses.join(" AND ");
      params.push(limit);
      sql += ` ORDER BY dh.changed_at DESC LIMIT $${params.length}`;
      const res = await query(sql, params);
      return { count: res.rows.length, rows: res.rows };
    }
    default:
      return { error: `Unknown table: ${table}. Available: directives, approvals, memories, status, directive_history` };
  }
}

// ── Health Check ──

async function healthCheck() {
  try {
    const res = await query("SELECT NOW() as time, pg_database_size('ozzu') as db_size");
    return { connected: true, time: res.rows[0].time, dbSize: res.rows[0].db_size };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

// ── Migration: import data from Redis ──

async function migrateMemoriesFromRedis(persona, redisMemories) {
  if (!_pgConnected || !redisMemories.length) return 0;
  let count = 0;
  for (const mem of redisMemories) {
    try {
      await query(
        `INSERT INTO memories (persona, fact, category, source, created_at)
         VALUES ($1, $2, $3, 'redis-migration', to_timestamp($4::double precision / 1000))
         ON CONFLICT DO NOTHING`,
        [persona, mem.fact, mem.category || "general", mem.ts || Date.now()]
      );
      count++;
    } catch (err) {
      console.error(`[pg] migrate memory failed: ${err.message}`);
    }
  }
  return count;
}

async function migrateSummariesFromRedis(persona, redisSummaries) {
  if (!_pgConnected || !redisSummaries.length) return 0;
  let count = 0;
  for (const sum of redisSummaries) {
    try {
      await query(
        `INSERT INTO conversations (persona, summary, turn_count, started_at, ended_at)
         VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000), to_timestamp($4::double precision / 1000))`,
        [persona, sum.summary, sum.turns || 0, sum.timestamp || Date.now()]
      );
      count++;
    } catch (err) {
      console.error(`[pg] migrate summary failed: ${err.message}`);
    }
  }
  return count;
}

async function migrateDirectivesFromRedis(directives) {
  if (!_pgConnected || !directives.length) return 0;
  let count = 0;
  for (const d of directives) {
    try {
      await saveDirective(d);
      count++;
    } catch (err) {
      console.error(`[pg] migrate directive failed: ${err.message}`);
    }
  }
  return count;
}

async function migrateApprovalsFromRedis(approvals) {
  if (!_pgConnected || !approvals.length) return 0;
  let count = 0;
  for (const a of approvals) {
    try {
      await saveApproval(a);
      count++;
    } catch (err) {
      console.error(`[pg] migrate approval failed: ${err.message}`);
    }
  }
  return count;
}

async function migrateStatusFromRedis(entries) {
  if (!_pgConnected || !entries.length) return 0;
  let count = 0;
  for (const e of entries) {
    try {
      await addStatusEntry(e);
      count++;
    } catch (err) {
      console.error(`[pg] migrate status failed: ${err.message}`);
    }
  }
  return count;
}

module.exports = {
  init,
  isConnected,
  query,
  // Memories
  addMemory,
  getMemories,
  searchMemories,
  // Conversations
  createConversation,
  endConversation,
  addConversationTurn,
  getRecentSummaries,
  // Directives
  saveDirective,
  addDirectiveHistory,
  getDirectives,
  // Approvals
  saveApproval,
  // Status
  addStatusEntry,
  getStatusLog,
  // Devices
  upsertDevice,
  touchDevice,
  // Entity snapshots
  addEntitySnapshot,
  getEntityHistory,
  pruneEntitySnapshots,
  // Deployments
  addDeployment,
  completeDeployment,
  // Query history
  queryHistory,
  // Health
  healthCheck,
  // Migration
  migrateMemoriesFromRedis,
  migrateSummariesFromRedis,
  migrateDirectivesFromRedis,
  migrateApprovalsFromRedis,
  migrateStatusFromRedis,
};
