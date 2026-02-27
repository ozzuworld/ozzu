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
      profile_type VARCHAR(20) NOT NULL CHECK (profile_type IN ('email', 'username', 'password', 'phone', 'domain', 'ip', 'image')),
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

    // OSINT Metrics (Epic 3)
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_metrics (
      id SERIAL PRIMARY KEY,
      scan_id INTEGER REFERENCES osint_scans(id) ON DELETE SET NULL,
      profile_id INTEGER REFERENCES osint_profiles(id) ON DELETE CASCADE,
      metric_type VARCHAR(30) NOT NULL,
      value REAL NOT NULL,
      metadata JSONB DEFAULT '{}',
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_metrics_type ON osint_metrics(metric_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_metrics_profile ON osint_metrics(profile_id)`);

    // OSINT Locations (Epic 3)
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_locations (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER REFERENCES osint_profiles(id) ON DELETE CASCADE,
      latitude REAL,
      longitude REAL,
      location_text TEXT,
      source_module VARCHAR(50),
      source_finding_id INTEGER REFERENCES osint_findings(id) ON DELETE SET NULL,
      confidence REAL DEFAULT 0.5,
      location_type VARCHAR(20),
      raw_data JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_locations_profile ON osint_locations(profile_id)`);

    // OSINT Images (Epic 5)
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_images (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER REFERENCES osint_profiles(id) ON DELETE CASCADE,
      file_hash VARCHAR(64) NOT NULL,
      file_path TEXT NOT NULL,
      original_filename TEXT,
      mime_type VARCHAR(50),
      file_size INTEGER,
      width INTEGER,
      height INTEGER,
      thumbnail_path TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(file_hash)
    )`);

    // Migration: add 'image' to existing profile_type constraint if needed
    try {
      await pool.query(`ALTER TABLE osint_profiles DROP CONSTRAINT IF EXISTS osint_profiles_profile_type_check`);
      await pool.query(`ALTER TABLE osint_profiles ADD CONSTRAINT osint_profiles_profile_type_check CHECK (profile_type IN ('email', 'username', 'password', 'phone', 'domain', 'ip', 'image'))`);
    } catch { /* constraint already exists or column has no constraint */ }

    // OSINT Schedules (Epic 6)
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_schedules (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER REFERENCES osint_profiles(id) ON DELETE CASCADE,
      interval_hours INTEGER NOT NULL DEFAULT 24,
      last_run TIMESTAMPTZ,
      next_run TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // OSINT Alerts (Epic 6)
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_alerts (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER REFERENCES osint_profiles(id) ON DELETE CASCADE,
      alert_type VARCHAR(50) NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'medium',
      title TEXT NOT NULL,
      description TEXT,
      finding_id INTEGER,
      is_read BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_osint_alerts_unread ON osint_alerts(is_read) WHERE is_read = false`);

    // OSINT Persons — family profile grouping (Epic 6)
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_persons (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      relationship VARCHAR(50) DEFAULT 'self',
      avatar_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Migration: add person_id to osint_profiles
    try { await pool.query(`ALTER TABLE osint_profiles ADD COLUMN IF NOT EXISTS person_id INTEGER REFERENCES osint_persons(id) ON DELETE SET NULL`); } catch {}
    // Migration: add first_seen_at and is_new to osint_findings for delta detection
    try { await pool.query(`ALTER TABLE osint_findings ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW()`); } catch {}
    try { await pool.query(`ALTER TABLE osint_findings ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT NOW()`); } catch {}
    try { await pool.query(`ALTER TABLE osint_findings ADD COLUMN IF NOT EXISTS is_new BOOLEAN DEFAULT true`); } catch {}

    // OSINT Groups — family/group profile management (Epic 6)
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT DEFAULT '👪',
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // Migration: add group_id to osint_profiles
    try { await pool.query(`ALTER TABLE osint_profiles ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES osint_groups(id) ON DELETE SET NULL`); } catch {}

    // Remediation engine (Epic 7)
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_remediations (
      id SERIAL PRIMARY KEY,
      finding_id INTEGER REFERENCES osint_findings(id) ON DELETE CASCADE,
      profile_id INTEGER REFERENCES osint_profiles(id) ON DELETE CASCADE,
      remediation_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      action_url TEXT,
      action_type TEXT DEFAULT 'link',
      priority INTEGER DEFAULT 3,
      status TEXT DEFAULT 'pending',
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // SOC compliance: incident tracking with NIST SP 800-61 aligned fields
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_incidents (
      id SERIAL PRIMARY KEY,
      incident_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      severity TEXT NOT NULL DEFAULT 'medium',
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      profile_id INTEGER REFERENCES osint_profiles(id) ON DELETE SET NULL,
      finding_ids INTEGER[] DEFAULT '{}',
      remediation_ids INTEGER[] DEFAULT '{}',
      nist_phase TEXT DEFAULT 'identification',
      classification TEXT DEFAULT 'exposure',
      affected_assets TEXT[] DEFAULT '{}',
      attack_vector TEXT,
      indicators JSONB DEFAULT '{}',
      timeline JSONB DEFAULT '[]',
      assigned_to TEXT,
      escalated BOOLEAN DEFAULT false,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Auto-remediation triage stats on scans
    try { await pool.query(`ALTER TABLE osint_scans ADD COLUMN IF NOT EXISTS triage_stats JSONB DEFAULT NULL`); } catch {}

    console.log("[pg] Migrations applied (osint tables + schedules/alerts/persons/groups/remediations/incidents)");
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
  if (updates.triage_stats !== undefined) { params.push(JSON.stringify(updates.triage_stats)); sets.push(`triage_stats = $${params.length}::jsonb`); }
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
  if (filters.scanId) { params.push(filters.scanId); clauses.push(`scan_id = $${params.length}`); }
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

// ── OSINT Metrics ──

async function recordOsintMetric(scanId, profileId, metricType, value, metadata = {}) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_metrics (scan_id, profile_id, metric_type, value, metadata)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [scanId, profileId, metricType, value, JSON.stringify(metadata)]
  );
  return res.rows[0];
}

async function getOsintMetrics(filters = {}) {
  if (!_pgConnected) return [];
  let sql = `SELECT * FROM osint_metrics WHERE 1=1`;
  const params = [];
  let idx = 1;
  if (filters.metric_type) {
    sql += ` AND metric_type = $${idx++}`;
    params.push(filters.metric_type);
  }
  if (filters.profile_id) {
    sql += ` AND profile_id = $${idx++}`;
    params.push(filters.profile_id);
  }
  if (filters.days) {
    sql += ` AND recorded_at > NOW() - INTERVAL '1 day' * $${idx++}`;
    params.push(filters.days);
  }
  sql += ` ORDER BY recorded_at DESC`;
  if (filters.limit) {
    sql += ` LIMIT $${idx++}`;
    params.push(filters.limit);
  }
  const res = await query(sql, params);
  return res.rows;
}

async function getOsintMetricsSummary(days = 30) {
  if (!_pgConnected) return { totalScans: 0, avgDuration: 0, totalFindings: 0 };
  const res = await query(
    `SELECT
      COUNT(*) FILTER (WHERE metric_type = 'scan_timing') as total_scans,
      COALESCE(AVG(value) FILTER (WHERE metric_type = 'scan_timing'), 0) as avg_duration,
      COALESCE(SUM(value) FILTER (WHERE metric_type = 'score_delta'), 0) as total_score_delta
     FROM osint_metrics WHERE recorded_at > NOW() - INTERVAL '1 day' * $1`,
    [days]
  );
  const row = res.rows[0] || {};
  return {
    totalScans: parseInt(row.total_scans) || 0,
    avgDuration: Math.round(parseFloat(row.avg_duration) || 0),
    totalScoreDelta: parseFloat(row.total_score_delta) || 0,
  };
}

// ── OSINT Locations ──

async function upsertOsintLocation(profileId, data) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_locations (profile_id, latitude, longitude, location_text, source_module, source_finding_id, confidence, location_type, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [profileId, data.latitude || null, data.longitude || null, data.location_text || null,
     data.source_module || null, data.source_finding_id || null, data.confidence || 0.5,
     data.location_type || null, JSON.stringify(data.raw_data || {})]
  );
  return res.rows[0];
}

async function getOsintLocations(filters = {}) {
  if (!_pgConnected) return [];
  let sql = `SELECT * FROM osint_locations WHERE 1=1`;
  const params = [];
  let idx = 1;
  if (filters.profile_id) {
    sql += ` AND profile_id = $${idx++}`;
    params.push(filters.profile_id);
  }
  sql += ` ORDER BY confidence DESC, created_at DESC`;
  const res = await query(sql, params);
  return res.rows;
}

// ── OSINT Images ──

async function createOsintImage(data) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_images (profile_id, file_hash, file_path, original_filename, mime_type, file_size, width, height, thumbnail_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (file_hash) DO UPDATE SET profile_id = $1
     RETURNING *`,
    [data.profile_id, data.file_hash, data.file_path, data.original_filename || null,
     data.mime_type || null, data.file_size || null, data.width || null, data.height || null,
     data.thumbnail_path || null]
  );
  return res.rows[0];
}

async function getOsintImage(imageId) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM osint_images WHERE id = $1`, [imageId]);
  return res.rows[0] || null;
}

async function getOsintImageByProfile(profileId) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM osint_images WHERE profile_id = $1`, [profileId]);
  return res.rows[0] || null;
}

// ── OSINT Schedules ──

async function getOsintSchedules() {
  if (!_pgConnected) return [];
  const res = await query(`SELECT s.*, p.label as profile_label, p.profile_type FROM osint_schedules s LEFT JOIN osint_profiles p ON s.profile_id = p.id WHERE s.is_active = true ORDER BY s.next_run ASC`);
  return res.rows;
}

async function upsertOsintSchedule(data) {
  if (!_pgConnected) return null;
  const nextRun = new Date(Date.now() + (data.interval_hours || 24) * 3600000);
  const res = await query(
    `INSERT INTO osint_schedules (profile_id, interval_hours, next_run, is_active)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING RETURNING *`,
    [data.profile_id || null, data.interval_hours || 24, nextRun, data.is_active !== false]
  );
  return res.rows[0] || null;
}

async function updateOsintSchedule(id, updates) {
  if (!_pgConnected) return null;
  const fields = [];
  const vals = [];
  let idx = 1;
  if (updates.interval_hours != null) { fields.push(`interval_hours = $${idx++}`); vals.push(updates.interval_hours); }
  if (updates.last_run != null) { fields.push(`last_run = $${idx++}`); vals.push(updates.last_run); }
  if (updates.next_run != null) { fields.push(`next_run = $${idx++}`); vals.push(updates.next_run); }
  if (updates.is_active != null) { fields.push(`is_active = $${idx++}`); vals.push(updates.is_active); }
  if (fields.length === 0) return null;
  vals.push(id);
  const res = await query(`UPDATE osint_schedules SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, vals);
  return res.rows[0] || null;
}

async function deleteOsintSchedule(id) {
  if (!_pgConnected) return;
  await query(`DELETE FROM osint_schedules WHERE id = $1`, [id]);
}

// ── OSINT Alerts ──

async function createOsintAlert(data) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_alerts (profile_id, alert_type, severity, title, description, finding_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [data.profile_id || null, data.alert_type, data.severity || "medium", data.title, data.description || null, data.finding_id || null]
  );
  return res.rows[0] || null;
}

async function getOsintAlerts(opts = {}) {
  if (!_pgConnected) return [];
  let sql = `SELECT a.*, p.label as profile_label FROM osint_alerts a LEFT JOIN osint_profiles p ON a.profile_id = p.id WHERE 1=1`;
  const vals = [];
  let idx = 1;
  if (opts.unreadOnly) { sql += ` AND a.is_read = false`; }
  if (opts.profileId) { sql += ` AND a.profile_id = $${idx++}`; vals.push(opts.profileId); }
  sql += ` ORDER BY a.created_at DESC LIMIT $${idx++}`;
  vals.push(opts.limit || 50);
  const res = await query(sql, vals);
  return res.rows;
}

async function markOsintAlertRead(id) {
  if (!_pgConnected) return;
  await query(`UPDATE osint_alerts SET is_read = true WHERE id = $1`, [id]);
}

async function markAllOsintAlertsRead() {
  if (!_pgConnected) return;
  await query(`UPDATE osint_alerts SET is_read = true WHERE is_read = false`);
}

async function getOsintAlertCount() {
  if (!_pgConnected) return 0;
  const res = await query(`SELECT COUNT(*) as count FROM osint_alerts WHERE is_read = false`);
  return parseInt(res.rows[0]?.count || "0");
}

// ── OSINT Persons ──

async function createOsintPerson(data) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_persons (name, relationship, avatar_url) VALUES ($1, $2, $3) RETURNING *`,
    [data.name, data.relationship || "self", data.avatar_url || null]
  );
  return res.rows[0] || null;
}

async function getOsintPersons() {
  if (!_pgConnected) return [];
  const res = await query(`SELECT p.*, COUNT(pr.id) as profile_count FROM osint_persons p LEFT JOIN osint_profiles pr ON pr.person_id = p.id GROUP BY p.id ORDER BY p.created_at ASC`);
  return res.rows;
}

async function updateOsintPerson(id, updates) {
  if (!_pgConnected) return null;
  const fields = [];
  const vals = [];
  let idx = 1;
  if (updates.name != null) { fields.push(`name = $${idx++}`); vals.push(updates.name); }
  if (updates.relationship != null) { fields.push(`relationship = $${idx++}`); vals.push(updates.relationship); }
  if (updates.avatar_url !== undefined) { fields.push(`avatar_url = $${idx++}`); vals.push(updates.avatar_url); }
  if (fields.length === 0) return null;
  vals.push(id);
  const res = await query(`UPDATE osint_persons SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, vals);
  return res.rows[0] || null;
}

async function assignProfileToPerson(profileId, personId) {
  if (!_pgConnected) return null;
  const res = await query(`UPDATE osint_profiles SET person_id = $1 WHERE id = $2 RETURNING *`, [personId, profileId]);
  return res.rows[0] || null;
}

// ── OSINT Groups ──

async function createOsintGroup(data) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_groups (name, emoji, description) VALUES ($1, $2, $3) RETURNING *`,
    [data.name, data.emoji || '👪', data.description || null]
  );
  return res.rows[0] || null;
}

async function getOsintGroups() {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT g.*, COUNT(p.id) as member_count
     FROM osint_groups g LEFT JOIN osint_profiles p ON p.group_id = g.id
     GROUP BY g.id ORDER BY g.created_at ASC`
  );
  return res.rows;
}

async function updateOsintGroup(id, updates) {
  if (!_pgConnected) return null;
  const fields = [];
  const vals = [];
  let idx = 1;
  if (updates.name != null) { fields.push(`name = $${idx++}`); vals.push(updates.name); }
  if (updates.emoji != null) { fields.push(`emoji = $${idx++}`); vals.push(updates.emoji); }
  if (updates.description !== undefined) { fields.push(`description = $${idx++}`); vals.push(updates.description); }
  if (fields.length === 0) return null;
  vals.push(id);
  const res = await query(`UPDATE osint_groups SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, vals);
  return res.rows[0] || null;
}

async function deleteOsintGroup(id) {
  if (!_pgConnected) return;
  await query(`UPDATE osint_profiles SET group_id = NULL WHERE group_id = $1`, [id]);
  await query(`DELETE FROM osint_groups WHERE id = $1`, [id]);
}

async function assignProfileToGroup(profileId, groupId) {
  if (!_pgConnected) return null;
  const res = await query(`UPDATE osint_profiles SET group_id = $1 WHERE id = $2 RETURNING *`, [groupId, profileId]);
  return res.rows[0] || null;
}

async function getOsintGroupScore(groupId) {
  if (!_pgConnected) return null;
  const res = await query(
    `SELECT f.severity, COUNT(*) as count
     FROM osint_findings f
     JOIN osint_profiles p ON f.profile_id = p.id
     WHERE p.group_id = $1 AND f.status NOT IN ('false_positive', 'remediated')
     GROUP BY f.severity`,
    [groupId]
  );
  return res.rows;
}

async function getOsintGroupFindings(groupId, limit = 100) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT f.*, p.label as profile_label, p.profile_type
     FROM osint_findings f
     JOIN osint_profiles p ON f.profile_id = p.id
     WHERE p.group_id = $1
     ORDER BY f.created_at DESC LIMIT $2`,
    [groupId, limit]
  );
  return res.rows;
}

async function getOsintFindingsForDelta(profileId) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT id, module, title, severity, category, is_new, first_seen_at, last_seen_at
     FROM osint_findings WHERE profile_id = $1 AND status NOT IN ('false_positive')
     ORDER BY created_at DESC`,
    [profileId]
  );
  return res.rows;
}

async function markFindingsSeen(findingIds) {
  if (!_pgConnected || findingIds.length === 0) return;
  await query(`UPDATE osint_findings SET last_seen_at = NOW(), is_new = false WHERE id = ANY($1)`, [findingIds]);
}

async function cleanupOldAlerts(daysOld = 30) {
  if (!_pgConnected) return;
  await query(`DELETE FROM osint_alerts WHERE is_read = true AND created_at < NOW() - interval '${daysOld} days'`);
}

// ── OSINT Remediations ──────────────────────────────────────────────
async function createOsintRemediation({ findingId, profileId, remediationType, title, description, actionUrl, actionType, priority }) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_remediations (finding_id, profile_id, remediation_type, title, description, action_url, action_type, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [findingId, profileId, remediationType, title, description || null, actionUrl || null, actionType || 'link', priority || 3]
  );
  return res.rows[0] || null;
}

async function getOsintRemediations(profileId, { status, priority, limit = 50 } = {}) {
  if (!_pgConnected) return [];
  let sql = `SELECT r.*, f.title as finding_title, f.severity as finding_severity, f.module as finding_module,
     p.label as profile_label, p.profile_type
     FROM osint_remediations r
     LEFT JOIN osint_findings f ON r.finding_id = f.id
     LEFT JOIN osint_profiles p ON r.profile_id = p.id`;
  const vals = [];
  const conditions = [];
  if (profileId) {
    vals.push(profileId);
    conditions.push(`r.profile_id = $${vals.length}`);
  }
  if (status) {
    vals.push(status);
    conditions.push(`r.status = $${vals.length}`);
  }
  if (priority) {
    vals.push(priority);
    conditions.push(`r.priority = $${vals.length}`);
  }
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
  vals.push(limit);
  sql += ` ORDER BY r.priority ASC, r.created_at DESC LIMIT $${vals.length}`;
  const res = await query(sql, vals);
  return res.rows;
}

async function updateOsintRemediation(id, updates) {
  if (!_pgConnected) return null;
  const fields = [];
  const vals = [];
  let idx = 1;
  if (updates.status != null) {
    fields.push(`status = $${idx++}`);
    vals.push(updates.status);
    if (updates.status === 'completed') {
      fields.push(`completed_at = NOW()`);
    }
  }
  if (updates.priority != null) { fields.push(`priority = $${idx++}`); vals.push(updates.priority); }
  if (fields.length === 0) return null;
  vals.push(id);
  const res = await query(`UPDATE osint_remediations SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, vals);
  return res.rows[0] || null;
}

async function getOsintRemediationStats(profileId) {
  if (!_pgConnected) return { total: 0, pending: 0, in_progress: 0, completed: 0, dismissed: 0, byPriority: {} };
  let sql = `SELECT status, priority, COUNT(*) as count FROM osint_remediations`;
  const vals = [];
  if (profileId) { vals.push(profileId); sql += ` WHERE profile_id = $1`; }
  sql += ` GROUP BY status, priority`;
  const res = await query(sql, vals);
  const stats = { total: 0, pending: 0, in_progress: 0, completed: 0, dismissed: 0, byPriority: {} };
  for (const row of res.rows) {
    const count = parseInt(row.count);
    stats[row.status] = (stats[row.status] || 0) + count;
    stats.total += count;
    const p = `p${row.priority}`;
    if (!stats.byPriority[p]) stats.byPriority[p] = { total: 0, pending: 0, completed: 0 };
    stats.byPriority[p].total += count;
    stats.byPriority[p][row.status] = (stats.byPriority[p][row.status] || 0) + count;
  }
  return stats;
}

async function bulkCreateRemediations(remediations) {
  if (!_pgConnected || remediations.length === 0) return [];
  const created = [];
  for (const r of remediations) {
    const result = await createOsintRemediation(r);
    if (result) created.push(result);
  }
  return created;
}

async function bulkUpdateOsintFindings(findingIds, status) {
  if (!_pgConnected || !findingIds || findingIds.length === 0) return [];
  const res = await query(
    `UPDATE osint_findings SET status = $1, updated_at = NOW()
     WHERE id = ANY($2) AND status = 'new'
     RETURNING id`,
    [status, findingIds]
  );
  return res.rows.map((r) => r.id);
}

// ── OSINT Incidents (SOC Compliance) ──────────────────────────────

async function createOsintIncident({ incidentId, title, description, severity, category, profileId, findingIds, remediationIds, classification, affectedAssets, attackVector, indicators, assignedTo }) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_incidents (incident_id, title, description, severity, category, profile_id, finding_ids, remediation_ids, classification, affected_assets, attack_vector, indicators, assigned_to, timeline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [incidentId, title, description || null, severity || 'medium', category, profileId || null,
     findingIds || [], remediationIds || [], classification || 'exposure', affectedAssets || [],
     attackVector || null, JSON.stringify(indicators || {}), assignedTo || null,
     JSON.stringify([{ timestamp: new Date().toISOString(), action: 'incident_created', actor: 'system' }])]
  );
  return res.rows[0] || null;
}

async function getOsintIncidents({ status, severity, profileId, limit = 50 } = {}) {
  if (!_pgConnected) return [];
  let sql = `SELECT i.*, p.label as profile_label, p.profile_type FROM osint_incidents i LEFT JOIN osint_profiles p ON i.profile_id = p.id`;
  const vals = [];
  const conds = [];
  if (status) { vals.push(status); conds.push(`i.status = $${vals.length}`); }
  if (severity) { vals.push(severity); conds.push(`i.severity = $${vals.length}`); }
  if (profileId) { vals.push(profileId); conds.push(`i.profile_id = $${vals.length}`); }
  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  vals.push(limit);
  sql += ` ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, i.created_at DESC LIMIT $${vals.length}`;
  const res = await query(sql, vals);
  return res.rows;
}

async function updateOsintIncident(id, updates) {
  if (!_pgConnected) return null;
  const fields = [];
  const vals = [];
  let idx = 1;
  if (updates.status != null) { fields.push(`status = $${idx++}`); vals.push(updates.status); if (updates.status === 'resolved') fields.push(`resolved_at = NOW()`); }
  if (updates.severity != null) { fields.push(`severity = $${idx++}`); vals.push(updates.severity); }
  if (updates.nistPhase != null) { fields.push(`nist_phase = $${idx++}`); vals.push(updates.nistPhase); }
  if (updates.assignedTo !== undefined) { fields.push(`assigned_to = $${idx++}`); vals.push(updates.assignedTo); }
  if (updates.escalated != null) { fields.push(`escalated = $${idx++}`); vals.push(updates.escalated); }
  if (updates.description != null) { fields.push(`description = $${idx++}`); vals.push(updates.description); }
  fields.push(`updated_at = NOW()`);
  if (fields.length <= 1) return null;
  vals.push(id);
  const res = await query(`UPDATE osint_incidents SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`, vals);
  return res.rows[0] || null;
}

async function addIncidentTimelineEvent(id, action, actor, details) {
  if (!_pgConnected) return null;
  const event = JSON.stringify({ timestamp: new Date().toISOString(), action, actor: actor || 'system', details: details || null });
  const res = await query(
    `UPDATE osint_incidents SET timeline = timeline || $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, event]
  );
  return res.rows[0] || null;
}

async function getOsintIncidentStats() {
  if (!_pgConnected) return { total: 0, open: 0, investigating: 0, contained: 0, resolved: 0 };
  const res = await query(`SELECT status, severity, COUNT(*) as count FROM osint_incidents GROUP BY status, severity`);
  const stats = { total: 0, open: 0, investigating: 0, contained: 0, resolved: 0, bySeverity: {} };
  for (const row of res.rows) {
    const count = parseInt(row.count);
    stats.total += count;
    stats[row.status] = (stats[row.status] || 0) + count;
    if (!stats.bySeverity[row.severity]) stats.bySeverity[row.severity] = 0;
    stats.bySeverity[row.severity] += count;
  }
  return stats;
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
  // OSINT Metrics
  recordOsintMetric,
  getOsintMetrics,
  getOsintMetricsSummary,
  // OSINT Locations
  upsertOsintLocation,
  getOsintLocations,
  // OSINT Images
  createOsintImage,
  getOsintImage,
  getOsintImageByProfile,
  // OSINT Schedules
  getOsintSchedules,
  upsertOsintSchedule,
  updateOsintSchedule,
  deleteOsintSchedule,
  // OSINT Alerts
  createOsintAlert,
  getOsintAlerts,
  markOsintAlertRead,
  markAllOsintAlertsRead,
  getOsintAlertCount,
  // OSINT Persons
  createOsintPerson,
  getOsintPersons,
  updateOsintPerson,
  assignProfileToPerson,
  // OSINT Groups
  createOsintGroup,
  getOsintGroups,
  updateOsintGroup,
  deleteOsintGroup,
  assignProfileToGroup,
  getOsintGroupScore,
  getOsintGroupFindings,
  // OSINT Delta Detection
  getOsintFindingsForDelta,
  markFindingsSeen,
  cleanupOldAlerts,
  // OSINT Remediations
  createOsintRemediation,
  getOsintRemediations,
  updateOsintRemediation,
  getOsintRemediationStats,
  bulkCreateRemediations,
  bulkUpdateOsintFindings,
  // OSINT Incidents (SOC)
  createOsintIncident,
  getOsintIncidents,
  updateOsintIncident,
  addIncidentTimelineEvent,
  getOsintIncidentStats,
  // Migration
  migrateMemoriesFromRedis,
  migrateSummariesFromRedis,
  migrateDirectivesFromRedis,
  migrateApprovalsFromRedis,
  migrateStatusFromRedis,
  close: () => pool.end(),
};
