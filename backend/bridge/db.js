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
  statement_timeout: 30000, // kill queries running longer than 30s
});

let _pgConnected = false;
let _reconnectTimer = null;

// Log when a new client connects from the pool
pool.on("connect", () => {
  console.log("[pg] New client connected to pool");
});

// Handle unexpected pool-level errors (e.g. backend disconnect)
pool.on("error", (err) => {
  console.error("[pg] Pool error:", err.message);
  _pgConnected = false;
  startReconnect();
});

function startReconnect() {
  if (_reconnectTimer) return; // already trying
  console.log("[pg] Starting reconnect attempts every 30s");
  _reconnectTimer = setInterval(async () => {
    try {
      await pool.query("SELECT 1");
      _pgConnected = true;
      console.log("[pg] Reconnected to PostgreSQL");
      clearInterval(_reconnectTimer);
      _reconnectTimer = null;
    } catch (err) {
      console.error("[pg] Reconnect failed:", err.message);
    }
  }, 30000);
}

async function init() {
  try {
    const client = await pool.connect();
    client.release();
    _pgConnected = true;
    console.log("[pg] Connected to PostgreSQL");

    // Migrations: add content_type and metadata to conversation_turns
    await pool.query(`ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS content_type VARCHAR(20) DEFAULT 'text'`);
    await pool.query(`ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_turns_content_type ON conversation_turns(content_type)`);
    // Migration: usage_metrics table
    await pool.query(`CREATE TABLE IF NOT EXISTS usage_metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      metric_name TEXT NOT NULL,
      metric_value NUMERIC NOT NULL DEFAULT 0,
      metadata JSONB DEFAULT '{}',
      UNIQUE(date, metric_name)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_metrics_date ON usage_metrics(date DESC)`);
    // Migration: GIN index for conversation turn search
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_turns_content_search ON conversation_turns USING gin(to_tsvector('english', content))`);
    // Migration: OSINT tables
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_profiles (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      profile_type VARCHAR(20) NOT NULL CHECK (profile_type IN ('email', 'username', 'password', 'phone', 'domain', 'ip')),
      value TEXT NOT NULL,
      tags TEXT[] DEFAULT '{}',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(profile_type, value)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_scans (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER REFERENCES osint_profiles(id),
      scan_type VARCHAR(50) DEFAULT 'full',
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      modules_run TEXT[] DEFAULT '{}',
      findings_count INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_findings (
      id SERIAL PRIMARY KEY,
      scan_id INTEGER REFERENCES osint_scans(id),
      profile_id INTEGER REFERENCES osint_profiles(id),
      module VARCHAR(50) NOT NULL,
      category VARCHAR(30) NOT NULL,
      severity VARCHAR(10) NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
      title TEXT NOT NULL,
      description TEXT,
      source_url TEXT,
      raw_data JSONB,
      status VARCHAR(20) DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'remediated', 'false_positive')),
      remediation TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(profile_id, module, title)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_findings_profile ON osint_findings(profile_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_findings_severity ON osint_findings(severity)`);
    // Migration: OSINT score history
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_score_history (
      id SERIAL PRIMARY KEY,
      score INTEGER NOT NULL,
      breakdown JSONB DEFAULT '{}',
      total_findings INTEGER DEFAULT 0,
      profiles_scanned INTEGER DEFAULT 0,
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_score_history_date ON osint_score_history(recorded_at DESC)`);

    // Migration: Add phone + domain + ip profile types
    await pool.query(`DO $$ BEGIN
      ALTER TABLE osint_profiles DROP CONSTRAINT IF EXISTS osint_profiles_profile_type_check;
      ALTER TABLE osint_profiles ADD CONSTRAINT osint_profiles_profile_type_check
        CHECK (profile_type IN ('email', 'username', 'password', 'phone', 'domain', 'ip'));
    EXCEPTION WHEN others THEN NULL;
    END $$`);

    // Migration: OSINT entity correlation tables
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_entities (
      id SERIAL PRIMARY KEY,
      entity_type VARCHAR(30) NOT NULL CHECK (entity_type IN (
        'person','email','username','phone','domain','ip',
        'social_account','organization','location','image'
      )),
      value TEXT NOT NULL,
      label TEXT,
      metadata JSONB DEFAULT '{}',
      source_module VARCHAR(50),
      source_finding_id INTEGER REFERENCES osint_findings(id),
      profile_id INTEGER REFERENCES osint_profiles(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(entity_type, value)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_entities_type ON osint_entities(entity_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_entities_profile ON osint_entities(profile_id)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS osint_relationships (
      id SERIAL PRIMARY KEY,
      source_entity_id INTEGER REFERENCES osint_entities(id) ON DELETE CASCADE,
      target_entity_id INTEGER REFERENCES osint_entities(id) ON DELETE CASCADE,
      relationship VARCHAR(30) NOT NULL CHECK (relationship IN (
        'uses','owns','linked_to','associated_with','hosted_on',
        'registered_to','member_of','found_on','resolves_to'
      )),
      confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
      source_module VARCHAR(50),
      evidence TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(source_entity_id, target_entity_id, relationship)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_relationships_source ON osint_relationships(source_entity_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_relationships_target ON osint_relationships(target_entity_id)`);

    // Migration: OSINT cross-profile correlations
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_correlations (
      id SERIAL PRIMARY KEY,
      source_profile_id INTEGER REFERENCES osint_profiles(id) ON DELETE CASCADE,
      target_profile_id INTEGER REFERENCES osint_profiles(id) ON DELETE CASCADE,
      correlation_type VARCHAR(30) NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.0,
      evidence JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(source_profile_id, target_profile_id, correlation_type)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_correlations_source ON osint_correlations(source_profile_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_correlations_target ON osint_correlations(target_profile_id)`);

    // Migration: OSINT stored reports
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_reports (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      report_type VARCHAR(20) DEFAULT 'full',
      data JSONB NOT NULL,
      profiles_included INTEGER[] DEFAULT '{}',
      total_findings INTEGER DEFAULT 0,
      score_at_generation INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_reports_created ON osint_reports(created_at DESC)`);

    console.log("[pg] Migrations applied (conversation_turns: content_type, metadata, search; usage_metrics; osint tables; osint_score_history; osint entities/relationships; osint correlations/reports)");
  } catch (err) {
    console.error("[pg] Connection failed:", err.message);
    _pgConnected = false;
    startReconnect();
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

async function getMemoriesByCategory(persona, categories, limit = 20) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT id, fact, category, confidence, created_at, source
     FROM memories WHERE persona = $1 AND category = ANY($2)
     ORDER BY created_at DESC LIMIT $3`,
    [persona, categories, limit]
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

async function addConversationTurn(conversationId, role, content, turnIndex, toolCalls = null, contentType = 'text', metadata = null) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO conversation_turns (conversation_id, role, content, turn_index, tool_calls, content_type, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [conversationId, role, content, turnIndex, toolCalls ? JSON.stringify(toolCalls) : null, contentType, metadata ? JSON.stringify(metadata) : '{}']
  );
  // Increment turn_count on the conversation so it stays accurate even if session drops
  query(`UPDATE conversations SET turn_count = turn_count + 1 WHERE id = $1`, [conversationId])
    .catch(err => console.warn("[pg] increment turn_count:", err.message));
  return res.rows[0]?.id;
}

async function getConversationHistory({ persona = 'cipher', limit = 100, offset = 0, since = null, contentTypes = null, conversationLimit = 5 } = {}) {
  if (!_pgConnected) return [];
  // Get recent conversation IDs for this persona
  const convoParams = [persona, conversationLimit];
  let convoSql = `SELECT id, persona, summary, turn_count, topics, started_at, ended_at
     FROM conversations WHERE persona = $1 ORDER BY started_at DESC LIMIT $2`;
  if (since) {
    convoSql = `SELECT id, persona, summary, turn_count, topics, started_at, ended_at
       FROM conversations WHERE persona = $1 AND started_at >= $3::timestamptz ORDER BY started_at DESC LIMIT $2`;
    convoParams.push(since);
  }
  const convoRes = await query(convoSql, convoParams);
  if (!convoRes.rows.length) return [];

  const convoIds = convoRes.rows.map(r => r.id);

  // Get turns for those conversations
  let turnSql = `SELECT conversation_id, role, content, content_type, metadata, turn_index, tool_calls, created_at
     FROM conversation_turns WHERE conversation_id = ANY($1)`;
  const turnParams = [convoIds];
  if (contentTypes && contentTypes.length) {
    turnSql += ` AND content_type = ANY($2)`;
    turnParams.push(contentTypes);
  }
  turnSql += ` ORDER BY conversation_id, turn_index ASC`;
  if (limit) {
    turnParams.push(limit);
    turnSql += ` LIMIT $${turnParams.length}`;
  }
  const turnRes = await query(turnSql, turnParams);

  // Group turns by conversation
  const turnsByConvo = {};
  for (const t of turnRes.rows) {
    if (!turnsByConvo[t.conversation_id]) turnsByConvo[t.conversation_id] = [];
    turnsByConvo[t.conversation_id].push({
      role: t.role,
      content: t.content,
      contentType: t.content_type,
      metadata: t.metadata,
      turnIndex: t.turn_index,
      toolCalls: t.tool_calls,
      timestamp: t.created_at,
    });
  }

  return convoRes.rows.map(c => ({
    id: c.id,
    persona: c.persona,
    startedAt: c.started_at,
    endedAt: c.ended_at,
    summary: c.summary,
    turnCount: c.turn_count,
    topics: c.topics || [],
    turns: turnsByConvo[c.id] || [],
  }));
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

async function getRecentConversations(limit = 10) {
  if (!_pgConnected) return { rows: [], total: 0 };
  const [dataRes, countRes] = await Promise.all([
    query(
      `SELECT id, persona, summary, turn_count, topics, started_at, ended_at,
              EXTRACT(EPOCH FROM (ended_at - started_at)) / 60 AS duration_minutes
       FROM conversations WHERE summary IS NOT NULL
       ORDER BY started_at DESC LIMIT $1`,
      [limit]
    ),
    query(`SELECT COUNT(*) AS total FROM conversations WHERE summary IS NOT NULL`),
  ]);
  return { rows: dataRes.rows, total: parseInt(countRes.rows[0].total, 10) };
}

// ── Directives ──

async function saveDirective(directive) {
  if (!_pgConnected) return;
  await query(
    `INSERT INTO directives (id, type, title, description, status, plan, approval_id, epic_id, phase_order, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10::double precision / 1000), to_timestamp($11::double precision / 1000))
     ON CONFLICT (id) DO UPDATE SET
       type = EXCLUDED.type, title = EXCLUDED.title, description = EXCLUDED.description,
       status = EXCLUDED.status, plan = EXCLUDED.plan, approval_id = EXCLUDED.approval_id,
       epic_id = EXCLUDED.epic_id, phase_order = EXCLUDED.phase_order,
       updated_at = EXCLUDED.updated_at`,
    [
      directive.id, directive.type, directive.title || "", directive.description || "",
      directive.status, directive.plan || null, directive.directiveApprovalId || null,
      directive.epicId || null, directive.phaseOrder || null,
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

async function getDirectiveHistory(directiveId) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT old_status, new_status, changed_by, changed_at, notes
     FROM directive_history WHERE directive_id = $1 ORDER BY changed_at ASC`,
    [directiveId]
  );
  return res.rows;
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

// ── OSINT Profiles ──

async function createOsintProfile(label, profileType, value, tags = []) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_profiles (label, profile_type, value, tags)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [label, profileType, value, tags]
  );
  return res.rows[0]?.id;
}

async function getOsintProfiles() {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT id, label, profile_type, value, tags, is_active, created_at, updated_at
     FROM osint_profiles WHERE is_active = true ORDER BY created_at DESC`
  );
  return res.rows;
}

async function getOsintProfile(id) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM osint_profiles WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function deleteOsintProfile(id) {
  if (!_pgConnected) return;
  await query(`UPDATE osint_profiles SET is_active = false, updated_at = NOW() WHERE id = $1`, [id]);
}

// ── OSINT Scans ──

async function createOsintScan(profileId, scanType, modulesRun) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_scans (profile_id, scan_type, modules_run)
     VALUES ($1, $2, $3) RETURNING id`,
    [profileId, scanType, modulesRun]
  );
  return res.rows[0]?.id;
}

async function updateOsintScan(id, updates) {
  if (!_pgConnected) return;
  const sets = [];
  const params = [id];
  if (updates.status) { params.push(updates.status); sets.push(`status = $${params.length}`); }
  if (updates.findings_count !== undefined) { params.push(updates.findings_count); sets.push(`findings_count = $${params.length}`); }
  if (updates.error_message) { params.push(updates.error_message); sets.push(`error_message = $${params.length}`); }
  if (updates.status === "completed" || updates.status === "failed") sets.push(`completed_at = NOW()`);
  if (sets.length === 0) return;
  await query(`UPDATE osint_scans SET ${sets.join(", ")} WHERE id = $1`, params);
}

async function getOsintScans(profileId = null, limit = 20) {
  if (!_pgConnected) return [];
  if (profileId) {
    const res = await query(
      `SELECT * FROM osint_scans WHERE profile_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [profileId, limit]
    );
    return res.rows;
  }
  const res = await query(`SELECT * FROM osint_scans ORDER BY created_at DESC LIMIT $1`, [limit]);
  return res.rows;
}

async function getOsintScan(id) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM osint_scans WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

// ── OSINT Findings ──

async function upsertOsintFinding(finding) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_findings (scan_id, profile_id, module, category, severity, title, description, source_url, raw_data, remediation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (profile_id, module, title) DO UPDATE SET
       scan_id = EXCLUDED.scan_id, severity = EXCLUDED.severity,
       description = EXCLUDED.description, source_url = EXCLUDED.source_url,
       raw_data = EXCLUDED.raw_data, remediation = EXCLUDED.remediation,
       updated_at = NOW()
     RETURNING id`,
    [finding.scan_id, finding.profile_id, finding.module, finding.category, finding.severity,
     finding.title, finding.description, finding.source_url,
     finding.raw_data ? JSON.stringify(finding.raw_data) : null, finding.remediation]
  );
  return res.rows[0]?.id;
}

async function getOsintFindings(filters = {}) {
  if (!_pgConnected) return [];
  const params = [];
  const clauses = [];
  if (filters.severity) { params.push(filters.severity); clauses.push(`severity = $${params.length}`); }
  if (filters.category) { params.push(filters.category); clauses.push(`category = $${params.length}`); }
  if (filters.status) { params.push(filters.status); clauses.push(`status = $${params.length}`); }
  if (filters.profileId) { params.push(filters.profileId); clauses.push(`profile_id = $${params.length}`); }
  let sql = `SELECT * FROM osint_findings`;
  if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
  sql += ` ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, created_at DESC`;
  const limit = Math.min(filters.limit || 100, 500);
  const offset = filters.offset || 0;
  params.push(limit);
  sql += ` LIMIT $${params.length}`;
  params.push(offset);
  sql += ` OFFSET $${params.length}`;
  const res = await query(sql, params);
  return res.rows;
}

async function updateOsintFinding(id, status) {
  if (!_pgConnected) return null;
  const res = await query(
    `UPDATE osint_findings SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, status]
  );
  return res.rows[0] || null;
}

async function getOsintFindingCounts() {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT severity, COUNT(*) as count FROM osint_findings
     WHERE status != 'false_positive'
     GROUP BY severity`
  );
  return res.rows;
}

async function recordOsintScore(score, breakdown, totalFindings, profilesScanned) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_score_history (score, breakdown, total_findings, profiles_scanned)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [score, JSON.stringify(breakdown), totalFindings, profilesScanned]
  );
  return res.rows[0] || null;
}

async function getOsintScoreHistory(days = 30) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT * FROM osint_score_history
     WHERE recorded_at > NOW() - INTERVAL '1 day' * $1
     ORDER BY recorded_at ASC`,
    [days]
  );
  return res.rows;
}

async function getLastOsintScanTime() {
  if (!_pgConnected) return null;
  const res = await query(
    `SELECT MAX(created_at) as last_scan FROM osint_scans WHERE status = 'completed'`
  );
  return res.rows[0]?.last_scan || null;
}

// ── OSINT Entities & Relationships ──

async function upsertOsintEntity(entity) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_entities (entity_type, value, label, metadata, source_module, source_finding_id, profile_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (entity_type, value) DO UPDATE SET
       label = COALESCE(EXCLUDED.label, osint_entities.label),
       metadata = osint_entities.metadata || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [entity.entity_type, entity.value, entity.label || null, JSON.stringify(entity.metadata || {}),
     entity.source_module || null, entity.source_finding_id || null, entity.profile_id || null]
  );
  return res.rows[0] || null;
}

async function getOsintEntities(filters = {}) {
  if (!_pgConnected) return [];
  let sql = `SELECT * FROM osint_entities WHERE 1=1`;
  const params = [];
  if (filters.type) {
    params.push(filters.type);
    sql += ` AND entity_type = $${params.length}`;
  }
  if (filters.profileId) {
    params.push(filters.profileId);
    sql += ` AND profile_id = $${params.length}`;
  }
  sql += ` ORDER BY created_at DESC`;
  if (filters.limit) {
    params.push(filters.limit);
    sql += ` LIMIT $${params.length}`;
  }
  const res = await query(sql, params);
  return res.rows;
}

async function getOsintEntity(id) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM osint_entities WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function upsertOsintRelationship(rel) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_relationships (source_entity_id, target_entity_id, relationship, confidence, source_module, evidence)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_entity_id, target_entity_id, relationship) DO UPDATE SET
       confidence = GREATEST(osint_relationships.confidence, EXCLUDED.confidence),
       evidence = COALESCE(EXCLUDED.evidence, osint_relationships.evidence),
       updated_at = NOW()
     RETURNING *`,
    [rel.source_entity_id, rel.target_entity_id, rel.relationship,
     rel.confidence, rel.source_module || null, rel.evidence || null]
  );
  return res.rows[0] || null;
}

async function getOsintRelationships(entityId) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT r.*,
       se.entity_type as source_type, se.value as source_value, se.label as source_label,
       te.entity_type as target_type, te.value as target_value, te.label as target_label
     FROM osint_relationships r
     JOIN osint_entities se ON r.source_entity_id = se.id
     JOIN osint_entities te ON r.target_entity_id = te.id
     WHERE r.source_entity_id = $1 OR r.target_entity_id = $1
     ORDER BY r.confidence DESC`,
    [entityId]
  );
  return res.rows;
}

async function getOsintEntityGraph(profileId = null) {
  if (!_pgConnected) return { entities: [], relationships: [] };
  let entitySql, relSql;
  const params = [];

  if (profileId) {
    params.push(profileId);
    entitySql = `SELECT * FROM osint_entities WHERE profile_id = $1 ORDER BY entity_type, value`;
    relSql = `SELECT r.*,
       se.entity_type as source_type, se.value as source_value, se.label as source_label,
       te.entity_type as target_type, te.value as target_value, te.label as target_label
     FROM osint_relationships r
     JOIN osint_entities se ON r.source_entity_id = se.id
     JOIN osint_entities te ON r.target_entity_id = te.id
     WHERE se.profile_id = $1 OR te.profile_id = $1
     ORDER BY r.confidence DESC`;
  } else {
    entitySql = `SELECT * FROM osint_entities ORDER BY entity_type, value`;
    relSql = `SELECT r.*,
       se.entity_type as source_type, se.value as source_value, se.label as source_label,
       te.entity_type as target_type, te.value as target_value, te.label as target_label
     FROM osint_relationships r
     JOIN osint_entities se ON r.source_entity_id = se.id
     JOIN osint_entities te ON r.target_entity_id = te.id
     ORDER BY r.confidence DESC`;
  }

  const [entities, relationships] = await Promise.all([
    query(entitySql, profileId ? params : []),
    query(relSql, profileId ? params : []),
  ]);

  return { entities: entities.rows, relationships: relationships.rows };
}

async function getOsintCorrelationSummary() {
  if (!_pgConnected) return { totalEntities: 0, totalRelationships: 0, entityTypes: {}, relationshipTypes: {} };
  const [entityRes, relRes, typeRes, relTypeRes] = await Promise.all([
    query(`SELECT COUNT(*) as count FROM osint_entities`),
    query(`SELECT COUNT(*) as count FROM osint_relationships`),
    query(`SELECT entity_type, COUNT(*) as count FROM osint_entities GROUP BY entity_type ORDER BY count DESC`),
    query(`SELECT relationship, COUNT(*) as count FROM osint_relationships GROUP BY relationship ORDER BY count DESC`),
  ]);

  const entityTypes = {};
  for (const row of typeRes.rows) entityTypes[row.entity_type] = parseInt(row.count, 10);
  const relationshipTypes = {};
  for (const row of relTypeRes.rows) relationshipTypes[row.relationship] = parseInt(row.count, 10);

  return {
    totalEntities: parseInt(entityRes.rows[0]?.count || "0", 10),
    totalRelationships: parseInt(relRes.rows[0]?.count || "0", 10),
    entityTypes,
    relationshipTypes,
  };
}

// ── OSINT Cross-Profile Correlations ──

async function upsertOsintCorrelation(sourceProfileId, targetProfileId, correlationType, confidence, evidence) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_correlations (source_profile_id, target_profile_id, correlation_type, confidence, evidence)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_profile_id, target_profile_id, correlation_type) DO UPDATE SET
       confidence = GREATEST(osint_correlations.confidence, EXCLUDED.confidence),
       evidence = EXCLUDED.evidence,
       updated_at = NOW()
     RETURNING *`,
    [sourceProfileId, targetProfileId, correlationType, confidence, JSON.stringify(evidence || {})]
  );
  return res.rows[0];
}

async function getOsintCorrelations(filters = {}) {
  if (!_pgConnected) return [];
  let sql = `SELECT c.*,
    sp.label as source_label, sp.profile_type as source_type, sp.value as source_value,
    tp.label as target_label, tp.profile_type as target_type, tp.value as target_value
    FROM osint_correlations c
    JOIN osint_profiles sp ON c.source_profile_id = sp.id
    JOIN osint_profiles tp ON c.target_profile_id = tp.id
    WHERE 1=1`;
  const params = [];
  let idx = 1;
  if (filters.minConfidence) {
    sql += ` AND c.confidence >= $${idx++}`;
    params.push(filters.minConfidence);
  }
  if (filters.correlationType) {
    sql += ` AND c.correlation_type = $${idx++}`;
    params.push(filters.correlationType);
  }
  if (filters.profileId) {
    sql += ` AND (c.source_profile_id = $${idx} OR c.target_profile_id = $${idx})`;
    params.push(filters.profileId);
    idx++;
  }
  sql += ` ORDER BY c.confidence DESC`;
  if (filters.limit) {
    sql += ` LIMIT $${idx++}`;
    params.push(filters.limit);
  }
  const res = await query(sql, params);
  return res.rows;
}

async function getOsintCorrelationGraph() {
  if (!_pgConnected) return { nodes: [], edges: [] };
  const profiles = await getOsintProfiles();
  const correlations = await getOsintCorrelations();
  const nodes = profiles.map((p) => ({
    id: p.id,
    label: p.label,
    type: p.profile_type,
    value: p.value,
  }));
  const edges = correlations.map((c) => ({
    source: c.source_profile_id,
    target: c.target_profile_id,
    type: c.correlation_type,
    confidence: c.confidence,
    evidence: c.evidence,
  }));
  return { nodes, edges };
}

async function deleteOsintCorrelations() {
  if (!_pgConnected) return;
  await query(`DELETE FROM osint_correlations`);
}

// ── OSINT Stored Reports ──

async function createOsintReport(title, reportType, data, profilesIncluded, totalFindings, scoreAtGeneration) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_reports (title, report_type, data, profiles_included, total_findings, score_at_generation)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [title, reportType || "full", JSON.stringify(data), profilesIncluded || [], totalFindings || 0, scoreAtGeneration || 0]
  );
  return res.rows[0];
}

async function getOsintReports(limit = 20) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT id, title, report_type, profiles_included, total_findings, score_at_generation, created_at
     FROM osint_reports ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function getOsintReportById(id) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM osint_reports WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

module.exports = {
  init,
  isConnected,
  query,
  // Memories
  addMemory,
  getMemories,
  getMemoriesByCategory,
  searchMemories,
  // Conversations
  createConversation,
  endConversation,
  addConversationTurn,
  getConversationHistory,
  getRecentSummaries,
  getRecentConversations,
  // Directives
  saveDirective,
  addDirectiveHistory,
  getDirectiveHistory,
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
  // OSINT
  createOsintProfile,
  getOsintProfiles,
  getOsintProfile,
  deleteOsintProfile,
  createOsintScan,
  updateOsintScan,
  getOsintScans,
  getOsintScan,
  upsertOsintFinding,
  getOsintFindings,
  updateOsintFinding,
  getOsintFindingCounts,
  recordOsintScore,
  getOsintScoreHistory,
  getLastOsintScanTime,
  // OSINT Entities & Relationships
  upsertOsintEntity,
  getOsintEntities,
  getOsintEntity,
  upsertOsintRelationship,
  getOsintRelationships,
  getOsintEntityGraph,
  getOsintCorrelationSummary,
  // OSINT Cross-Profile Correlations
  upsertOsintCorrelation,
  getOsintCorrelations,
  getOsintCorrelationGraph,
  deleteOsintCorrelations,
  // OSINT Stored Reports
  createOsintReport,
  getOsintReports,
  getOsintReportById,
  // Migration
  migrateMemoriesFromRedis,
  migrateSummariesFromRedis,
  migrateDirectivesFromRedis,
  migrateApprovalsFromRedis,
  migrateStatusFromRedis,
  close: () => pool.end(),
};
