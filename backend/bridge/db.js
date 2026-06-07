// PostgreSQL connection pool and query helpers for ozzu-bridge
const { Pool } = require("pg");
const crypto = require("crypto");

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
    // Migration: Volts importance scoring on conversation turns
    await pool.query(`ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS importance SMALLINT DEFAULT 1`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_turns_importance ON conversation_turns(importance DESC, created_at DESC)`);
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
      await pool.query(`ALTER TABLE osint_profiles ADD CONSTRAINT osint_profiles_profile_type_check CHECK (profile_type IN ('email', 'username', 'password', 'phone', 'domain', 'ip', 'image', 'cedula', 'nit'))`);
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

    // Face recognition: cédula face database
    await pool.query(`CREATE TABLE IF NOT EXISTS cedula_faces (
      id SERIAL PRIMARY KEY,
      cedula VARCHAR(20) NOT NULL UNIQUE,
      full_name TEXT,
      photo_path TEXT,
      embedding FLOAT8[],
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cedula_faces_cedula ON cedula_faces(cedula)`);

    // Migration: business_projects + business_tasks tables
    await pool.query(`CREATE TABLE IF NOT EXISTS business_projects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      emoji VARCHAR(10) DEFAULT '📁',
      color VARCHAR(10) DEFAULT '#06B6D4',
      status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','paused','completed','archived')),
      position INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS business_tasks (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES business_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done')),
      priority VARCHAR(10) DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
      position INTEGER DEFAULT 0,
      due_date DATE,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_business_tasks_project ON business_tasks(project_id)`);

    // Migration: add phase + notes columns to business_tasks
    await pool.query(`ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS phase TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`);

    // Migration: business_attachments table
    await pool.query(`CREATE TABLE IF NOT EXISTS business_attachments (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES business_tasks(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      thumbnail_path TEXT,
      file_type VARCHAR(20) DEFAULT 'image',
      mime_type VARCHAR(50) DEFAULT 'image/jpeg',
      file_size INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_business_attachments_task ON business_attachments(task_id)`);

    // Migration: task verification engine — requirements + verification columns
    await pool.query(`ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS requirements JSONB DEFAULT '[]'`);
    await pool.query(`ALTER TABLE business_attachments ADD COLUMN IF NOT EXISTS verification JSONB DEFAULT NULL`);

    // Migration: financial tracking columns on business_projects
    await pool.query(`ALTER TABLE business_projects ADD COLUMN IF NOT EXISTS budget DECIMAL(15,2) DEFAULT NULL`);
    await pool.query(`ALTER TABLE business_projects ADD COLUMN IF NOT EXISTS currency VARCHAR(5) DEFAULT 'COP'`);

    // Migration: financial tracking columns on business_tasks
    await pool.query(`ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS estimated_cost DECIMAL(15,2) DEFAULT NULL`);
    await pool.query(`ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS actual_cost DECIMAL(15,2) DEFAULT NULL`);
    await pool.query(`ALTER TABLE business_tasks ADD COLUMN IF NOT EXISTS cost_category VARCHAR(30) DEFAULT NULL`);

    // Migration: business_expenses table
    await pool.query(`CREATE TABLE IF NOT EXISTS business_expenses (
      id SERIAL PRIMARY KEY,
      task_id INTEGER REFERENCES business_tasks(id) ON DELETE CASCADE,
      attachment_id INTEGER REFERENCES business_attachments(id) ON DELETE SET NULL,
      amount DECIMAL(15,2) NOT NULL,
      iva_amount DECIMAL(15,2) DEFAULT 0,
      subtotal DECIMAL(15,2) DEFAULT NULL,
      category VARCHAR(30) NOT NULL,
      vendor TEXT DEFAULT '',
      description TEXT DEFAULT '',
      payment_status VARCHAR(20) DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','partial','overdue')),
      payment_method VARCHAR(20) DEFAULT NULL,
      expense_date DATE DEFAULT CURRENT_DATE,
      receipt_data JSONB DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_business_expenses_task ON business_expenses(task_id)`);

    // Migration: receipt_data on business_attachments
    await pool.query(`ALTER TABLE business_attachments ADD COLUMN IF NOT EXISTS receipt_data JSONB DEFAULT NULL`);

    // Migration: verified column on business_expenses
    await pool.query(`ALTER TABLE business_expenses ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false`);
    await pool.query(`UPDATE business_expenses SET verified = true WHERE attachment_id IS NOT NULL AND receipt_data IS NOT NULL AND verified = false`);

    // Migration: project_type on business_projects
    await pool.query(`ALTER TABLE business_projects ADD COLUMN IF NOT EXISTS project_type VARCHAR(20) DEFAULT 'general'`);

    // Migration: business_contacts table
    await pool.query(`CREATE TABLE IF NOT EXISTS business_contacts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      company TEXT,
      type VARCHAR(20) NOT NULL DEFAULT 'other',
      email TEXT,
      phone TEXT,
      address TEXT,
      city TEXT,
      country TEXT DEFAULT 'Colombia',
      currency VARCHAR(5) DEFAULT 'COP',
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Migration: business_shipments table
    await pool.query(`CREATE TABLE IF NOT EXISTS business_shipments (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES business_projects(id),
      buyer_contact_id INTEGER REFERENCES business_contacts(id),
      reference TEXT,
      status VARCHAR(30) DEFAULT 'preparing',
      coffee_type TEXT,
      quantity_kg DECIMAL(12,2),
      bags_count INTEGER,
      price_per_kg DECIMAL(10,2),
      total_value DECIMAL(15,2),
      currency VARCHAR(5) DEFAULT 'USD',
      shipping_cost DECIMAL(12,2) DEFAULT 0,
      insurance_cost DECIMAL(12,2) DEFAULT 0,
      customs_fees DECIMAL(12,2) DEFAULT 0,
      origin_port TEXT DEFAULT 'Buenaventura',
      destination_port TEXT DEFAULT 'Yokohama',
      ship_date DATE,
      estimated_arrival DATE,
      actual_arrival DATE,
      tracking_number TEXT,
      vessel_name TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Migration: business_invoices table
    await pool.query(`CREATE TABLE IF NOT EXISTS business_invoices (
      id SERIAL PRIMARY KEY,
      shipment_id INTEGER REFERENCES business_shipments(id),
      contact_id INTEGER REFERENCES business_contacts(id),
      invoice_number TEXT,
      amount DECIMAL(15,2) NOT NULL,
      currency VARCHAR(5) DEFAULT 'USD',
      status VARCHAR(20) DEFAULT 'draft',
      issue_date DATE,
      due_date DATE,
      paid_date DATE,
      paid_amount DECIMAL(15,2) DEFAULT 0,
      payment_method VARCHAR(20),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Migration: business_investments table
    await pool.query(`CREATE TABLE IF NOT EXISTS business_investments (
      id SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES business_projects(id),
      title TEXT NOT NULL,
      description TEXT,
      category VARCHAR(30) DEFAULT 'other',
      amount DECIMAL(15,2) NOT NULL,
      currency VARCHAR(5) DEFAULT 'COP',
      status VARCHAR(20) DEFAULT 'planned',
      investment_date DATE,
      expected_return_date DATE,
      roi_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Browser automation: audit log + session objectives (financial safeguards)
    await pool.query(`CREATE TABLE IF NOT EXISTS browser_audit_log (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args JSONB DEFAULT '{}',
      result_summary TEXT,
      url_at_time TEXT,
      flagged BOOLEAN DEFAULT false,
      flag_reason TEXT,
      approval_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_browser_audit_session ON browser_audit_log(session_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_browser_audit_flagged ON browser_audit_log(flagged) WHERE flagged = true`);

    await pool.query(`CREATE TABLE IF NOT EXISTS browser_sessions (
      id TEXT PRIMARY KEY,
      objective TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      last_action_at TIMESTAMPTZ DEFAULT NOW(),
      url_history TEXT[] DEFAULT '{}',
      is_financial BOOLEAN DEFAULT false,
      payment_context JSONB DEFAULT '{}'
    )`);

    // Device Schedules (home automation scheduling)
    await pool.query(`CREATE TABLE IF NOT EXISTS device_schedules (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      service TEXT NOT NULL,
      service_data JSONB DEFAULT '{}',
      cron_days INTEGER[] DEFAULT '{0,1,2,3,4,5,6}',
      cron_hour INTEGER NOT NULL DEFAULT 22,
      cron_minute INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN DEFAULT true,
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ,
      run_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // OSINT Investigations (Photo Intelligence Pipeline)
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_investigations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      seed_profile_id INTEGER REFERENCES osint_profiles(id) ON DELETE SET NULL,
      status VARCHAR(20) DEFAULT 'active',
      max_depth INTEGER DEFAULT 2,
      pivot_count INTEGER DEFAULT 0,
      config JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // OSINT EKF State (Extended Kalman Filter fusion)
    await pool.query(`CREATE TABLE IF NOT EXISTS osint_ekf_state (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER REFERENCES osint_profiles(id) ON DELETE CASCADE UNIQUE,
      state_vector JSONB NOT NULL DEFAULT '[]',
      covariance_matrix JSONB NOT NULL DEFAULT '[]',
      observation_count INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Migration: pivot columns on osint_profiles
    await pool.query(`ALTER TABLE osint_profiles ADD COLUMN IF NOT EXISTS investigation_id INTEGER REFERENCES osint_investigations(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE osint_profiles ADD COLUMN IF NOT EXISTS pivot_depth INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE osint_profiles ADD COLUMN IF NOT EXISTS pivot_source TEXT`);

    // ── Identity Resolution Engine ──

    // Face clusters — groups of same-face vectors
    await pool.query(`CREATE TABLE IF NOT EXISTS face_clusters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cluster_size INTEGER DEFAULT 0,
      representative_point_id TEXT,
      representative_label TEXT,
      avg_det_score FLOAT DEFAULT 0,
      sources JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Face identities — resolved person profiles from clusters
    await pool.query(`CREATE TABLE IF NOT EXISTS face_identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cluster_id UUID REFERENCES face_clusters(id) ON DELETE SET NULL,
      primary_name TEXT,
      alternate_names TEXT[] DEFAULT '{}',
      organizations TEXT[] DEFAULT '{}',
      locations TEXT[] DEFAULT '{}',
      occupations TEXT[] DEFAULT '{}',
      confidence FLOAT DEFAULT 0,
      source_count INTEGER DEFAULT 0,
      domain_count INTEGER DEFAULT 0,
      first_seen TIMESTAMPTZ,
      last_seen TIMESTAMPTZ,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Face relationships — co-occurrence edges between identities
    await pool.query(`CREATE TABLE IF NOT EXISTS face_relationships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      identity_a UUID REFERENCES face_identities(id) ON DELETE CASCADE,
      identity_b UUID REFERENCES face_identities(id) ON DELETE CASCADE,
      relationship_type TEXT,
      weight FLOAT DEFAULT 0,
      evidence_count INTEGER DEFAULT 0,
      evidence JSONB DEFAULT '[]',
      first_seen TIMESTAMPTZ,
      last_seen TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(identity_a, identity_b)
    )`);

    // Owner profile — personal details, address, timezone (single-row)
    await pool.query(`CREATE TABLE IF NOT EXISTS owner_profile (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      full_name TEXT,
      phone TEXT,
      email TEXT,
      timezone TEXT DEFAULT 'America/New_York',
      address_line1 TEXT,
      address_line2 TEXT,
      city TEXT,
      state TEXT,
      country TEXT,
      postal_code TEXT,
      shipping_same_as_billing BOOLEAN DEFAULT true,
      shipping_address_line1 TEXT,
      shipping_address_line2 TEXT,
      shipping_city TEXT,
      shipping_state TEXT,
      shipping_country TEXT,
      shipping_postal_code TEXT,
      extra JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // Add timezone column to device_schedules if missing
    await pool.query(`ALTER TABLE device_schedules ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/New_York'`);

    // Indexes for identity resolution queries
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_face_identities_cluster ON face_identities(cluster_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_face_identities_name ON face_identities(primary_name)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_face_relationships_a ON face_relationships(identity_a)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_face_relationships_b ON face_relationships(identity_b)`);

    // Migration: expand directives table for CRM
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS emoji TEXT`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS created_by VARCHAR(30)`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS work_summary TEXT`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS working_state TEXT`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS activity_log JSONB DEFAULT '[]'`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS duration BIGINT`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 3`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS depends_on TEXT[]`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS failure_reason TEXT`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS category VARCHAR(20) DEFAULT 'dev'`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_directives_status ON directives(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_directives_category ON directives(category)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_directives_completed ON directives(completed_at DESC) WHERE completed_at IS NOT NULL`);

    // Migration: directive threads — topic grouping for related directives
    await pool.query(`CREATE TABLE IF NOT EXISTS directive_threads (
      id VARCHAR(40) PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT,
      status VARCHAR(20) DEFAULT 'active',
      decisions JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_threads_status ON directive_threads(status)`);
    await pool.query(`ALTER TABLE directives ADD COLUMN IF NOT EXISTS thread_id VARCHAR(40) REFERENCES directive_threads(id) ON DELETE SET NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_directives_thread ON directives(thread_id) WHERE thread_id IS NOT NULL`);

    // Migration: service health monitoring tables (watchdog)
    await pool.query(`CREATE TABLE IF NOT EXISTS service_health_log (
      id SERIAL PRIMARY KEY,
      service VARCHAR(30) NOT NULL,
      status VARCHAR(10) NOT NULL,
      latency_ms INTEGER,
      details JSONB DEFAULT '{}',
      checked_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_health_log_service ON service_health_log(service, checked_at DESC)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS service_incidents (
      id SERIAL PRIMARY KEY,
      service VARCHAR(30) NOT NULL,
      from_status VARCHAR(10),
      to_status VARCHAR(10) NOT NULL,
      details JSONB DEFAULT '{}',
      started_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_incidents_service ON service_incidents(service, started_at DESC)`);

    // Migration: token usage tracking
    await pool.query(`CREATE TABLE IF NOT EXISTS token_usage (
      id SERIAL PRIMARY KEY,
      source VARCHAR(20) NOT NULL,
      session_id TEXT,
      run_id TEXT,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER GENERATED ALWAYS AS (input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) STORED,
      cost_usd NUMERIC(10,6) DEFAULT 0,
      duration_ms INTEGER,
      metadata JSONB DEFAULT '{}',
      recorded_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_usage_recorded ON token_usage(recorded_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_token_usage_source ON token_usage(source, recorded_at DESC)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS device_push_tokens (
      token TEXT PRIMARY KEY,
      device_id TEXT,
      platform TEXT DEFAULT 'ios',
      device_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS file_folders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES file_folders(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`DO $$ BEGIN
      ALTER TABLE files ADD COLUMN folder_id INTEGER REFERENCES file_folders(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$`);

    // Migration: identity vault
    await pool.query(`CREATE TABLE IF NOT EXISTS identity_profile (
      id SERIAL PRIMARY KEY,
      owner_key VARCHAR(100) NOT NULL DEFAULT 'kazuma' UNIQUE,
      full_name TEXT,
      date_of_birth DATE,
      place_of_birth TEXT,
      nationality TEXT,
      cedula TEXT,
      passport_number TEXT,
      passport_issued DATE,
      passport_expires DATE,
      passport_issuing_authority TEXT,
      visas JSONB DEFAULT '[]',
      emergency_contact JSONB DEFAULT '{}',
      extra JSONB DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS identity_travel_history (
      id SERIAL PRIMARY KEY,
      owner_key VARCHAR(100) NOT NULL DEFAULT 'kazuma',
      event_date DATE NOT NULL,
      country TEXT NOT NULL,
      city TEXT,
      port TEXT,
      direction VARCHAR(10) CHECK (direction IN ('entry','exit','transit','stamp')),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_travel_history_date ON identity_travel_history(event_date DESC)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS identity_documents (
      id SERIAL PRIMARY KEY,
      owner_key VARCHAR(100) NOT NULL DEFAULT 'kazuma',
      doc_type VARCHAR(50) NOT NULL,
      label TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    // ── Knowledge Graph tables (OSINT Intelligence Layer) ──

    // Subjects — focal persons or organizations being studied
    await pool.query(`CREATE TABLE IF NOT EXISTS kg_subjects (
      id SERIAL PRIMARY KEY,
      subject_type VARCHAR(20) NOT NULL DEFAULT 'person' CHECK (subject_type IN ('person','organization','event')),
      name TEXT NOT NULL,
      aliases TEXT[] DEFAULT '{}',
      summary TEXT,
      status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','archived','monitoring')),
      confidence INTEGER DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(subject_type, name)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_subjects_type ON kg_subjects(subject_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_subjects_name ON kg_subjects(name)`);

    // Anchors — identity anchors linking a subject to the digital/physical world
    await pool.query(`CREATE TABLE IF NOT EXISTS kg_anchors (
      id SERIAL PRIMARY KEY,
      subject_id INTEGER REFERENCES kg_subjects(id) ON DELETE CASCADE,
      anchor_type VARCHAR(30) NOT NULL CHECK (anchor_type IN (
        'email','phone','social_handle','domain','username','website',
        'address','document_id','cedula','nit','passport'
      )),
      platform VARCHAR(50),
      value TEXT NOT NULL,
      verified BOOLEAN DEFAULT false,
      confidence INTEGER DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),
      source TEXT,
      metadata JSONB DEFAULT '{}',
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(subject_id, anchor_type, platform, value)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_anchors_subject ON kg_anchors(subject_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_anchors_type ON kg_anchors(anchor_type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_anchors_value ON kg_anchors(value)`);

    // Facts — individual verified/unverified facts about a subject
    await pool.query(`CREATE TABLE IF NOT EXISTS kg_facts (
      id SERIAL PRIMARY KEY,
      subject_id INTEGER REFERENCES kg_subjects(id) ON DELETE CASCADE,
      category VARCHAR(30) NOT NULL CHECK (category IN (
        'employment','education','location','skill','affiliation',
        'legal','financial','personal','medical','military','political','other',
        'digital_footprint','security','pii_exposure','phone_intel','domain_intel',
        'social_ids','exposure','breach','identity','media','social'
      )),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      start_date DATE,
      end_date DATE,
      is_current BOOLEAN DEFAULT false,
      confidence INTEGER DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),
      source TEXT,
      source_url TEXT,
      verified BOOLEAN DEFAULT false,
      verified_by TEXT,
      verified_at TIMESTAMPTZ,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_facts_subject ON kg_facts(subject_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_facts_category ON kg_facts(category)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_facts_current ON kg_facts(is_current) WHERE is_current = true`);

    // Timeline — chronological events associated with a subject
    await pool.query(`CREATE TABLE IF NOT EXISTS kg_timeline (
      id SERIAL PRIMARY KEY,
      subject_id INTEGER REFERENCES kg_subjects(id) ON DELETE CASCADE,
      event_type VARCHAR(30) NOT NULL CHECK (event_type IN (
        'career','education','legal','travel','publication','social',
        'financial','personal','incident','observation','other',
        'discovery','collection','enrichment','alert'
      )),
      title TEXT NOT NULL,
      description TEXT,
      event_date DATE,
      event_end_date DATE,
      location TEXT,
      source TEXT,
      source_url TEXT,
      confidence INTEGER DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_timeline_subject ON kg_timeline(subject_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_timeline_date ON kg_timeline(event_date DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_timeline_type ON kg_timeline(event_type)`);

    // Connections — relationships between subjects
    await pool.query(`CREATE TABLE IF NOT EXISTS kg_connections (
      id SERIAL PRIMARY KEY,
      source_id INTEGER REFERENCES kg_subjects(id) ON DELETE CASCADE,
      target_id INTEGER REFERENCES kg_subjects(id) ON DELETE CASCADE,
      relationship VARCHAR(30) NOT NULL CHECK (relationship IN (
        'employs','employed_by','colleague','manages','reports_to',
        'knows','friend','family','spouse','studied_with',
        'client_of','supplier_of','partner','investor','legal_opponent',
        'member_of','founder_of','owns','affiliated','other',
        'follows','followed_by','mentions','interacts_with'
      )),
      description TEXT,
      start_date DATE,
      end_date DATE,
      is_current BOOLEAN DEFAULT true,
      confidence INTEGER DEFAULT 50 CHECK (confidence >= 0 AND confidence <= 100),
      source TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(source_id, target_id, relationship)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_connections_source ON kg_connections(source_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_connections_target ON kg_connections(target_id)`);

    // Observations — raw data collected from social media / web sources
    await pool.query(`CREATE TABLE IF NOT EXISTS kg_observations (
      id SERIAL PRIMARY KEY,
      subject_id INTEGER REFERENCES kg_subjects(id) ON DELETE CASCADE,
      platform VARCHAR(30) NOT NULL,
      observation_type VARCHAR(30) NOT NULL CHECK (observation_type IN (
        'post','comment','like','share','follow','unfollow',
        'profile_update','mention','message','activity','other'
      )),
      content TEXT,
      author_handle TEXT,
      url TEXT,
      engagement JSONB DEFAULT '{}',
      sentiment VARCHAR(10) CHECK (sentiment IN ('positive','negative','neutral',NULL)),
      entities_extracted JSONB DEFAULT '[]',
      raw_data JSONB DEFAULT '{}',
      observed_at TIMESTAMPTZ NOT NULL,
      collected_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_observations_subject ON kg_observations(subject_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_observations_platform ON kg_observations(platform)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_observations_date ON kg_observations(observed_at DESC)`);

    // Collections — tracking what was collected, from where, when
    await pool.query(`CREATE TABLE IF NOT EXISTS kg_collections (
      id SERIAL PRIMARY KEY,
      subject_id INTEGER REFERENCES kg_subjects(id) ON DELETE CASCADE,
      platform VARCHAR(30) NOT NULL,
      collection_type VARCHAR(30) DEFAULT 'scrape',
      status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
      items_collected INTEGER DEFAULT 0,
      error_message TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      metadata JSONB DEFAULT '{}'
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_collections_subject ON kg_collections(subject_id)`);

    // ANALYZE stage columns
    await pool.query(`ALTER TABLE kg_observations ADD COLUMN IF NOT EXISTS nlp_enriched BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE kg_observations ADD COLUMN IF NOT EXISTS nlp_result JSONB DEFAULT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_observations_unenriched ON kg_observations(nlp_enriched) WHERE nlp_enriched = false`);
    await pool.query(`ALTER TABLE kg_subjects ADD COLUMN IF NOT EXISTS last_collected_at TIMESTAMPTZ DEFAULT NULL`);
    await pool.query(`ALTER TABLE kg_subjects ADD COLUMN IF NOT EXISTS collect_interval_hours INTEGER DEFAULT 24`);

    // Identity resolution candidates
    await pool.query(`CREATE TABLE IF NOT EXISTS kg_identity_candidates (
      id              SERIAL PRIMARY KEY,
      subject_id      INTEGER REFERENCES kg_subjects(id) ON DELETE CASCADE,
      platform        VARCHAR(50) NOT NULL,
      username        VARCHAR(200) NOT NULL,
      profile_url     TEXT,
      classification  VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (classification IN ('pending','confirmed','probable','possible','unlikely','rejected')),
      match_weight    FLOAT,
      confidence      FLOAT,
      signals         JSONB DEFAULT '[]',
      collected_data  JSONB,
      stage_reached   INTEGER DEFAULT 0,
      reviewed_by     VARCHAR(50),
      reviewed_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(subject_id, platform, username)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_identity_classification ON kg_identity_candidates(classification)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_identity_subject ON kg_identity_candidates(subject_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kg_identity_weight ON kg_identity_candidates(match_weight DESC NULLS LAST)`);

    // Update kg_facts category constraint to include identity/media/social
    await pool.query(`DO $$ BEGIN
      ALTER TABLE kg_facts DROP CONSTRAINT IF EXISTS kg_facts_category_check;
      ALTER TABLE kg_facts ADD CONSTRAINT kg_facts_category_check CHECK (category IN (
        'employment','education','location','skill','affiliation',
        'legal','financial','personal','medical','military','political','other',
        'digital_footprint','security','pii_exposure','phone_intel','domain_intel',
        'social_ids','exposure','breach','identity','media','social'
      ));
    END $$`);

    // Migration: Agent audit trail for multi-agent pentest system
    await pool.query(`CREATE TABLE IF NOT EXISTS agent_audit_log (
      id SERIAL PRIMARY KEY,
      agent_name VARCHAR(50) NOT NULL,
      engagement_id VARCHAR(50),
      directive_id VARCHAR(50) REFERENCES directives(id),
      task TEXT NOT NULL,
      spawned_by VARCHAR(50),
      status VARCHAR(20) DEFAULT 'running',
      evidence JSONB DEFAULT '[]',
      findings JSONB DEFAULT '[]',
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      output TEXT,
      metadata JSONB DEFAULT '{}'
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_audit_engagement ON agent_audit_log(engagement_id, started_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_audit_agent ON agent_audit_log(agent_name, started_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_audit_spawned ON agent_audit_log(spawned_by, started_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_audit_directive ON agent_audit_log(directive_id)`);

    // ── SOC core: engagements / findings / reports / disclosures (dir_1780543681043) ──
    // These tables were created ad-hoc in the live DB and were NOT in schema-as-code, so
    // a fresh rebuild/restore would throw on recon_hosts' FK to pentest_engagements below
    // (latent data-loss bug on a box that's been wiped once). Codified here so a rebuild
    // recreates the whole SOC platform. CREATE IF NOT EXISTS = no-op on the live DB; the
    // CREATE bodies are the field-union target schema, and the ALTERs after reconcile the
    // pre-existing live pentest_findings up to that target.
    await pool.query(`CREATE TABLE IF NOT EXISTS pentest_engagements (
      id              VARCHAR(50) PRIMARY KEY,
      venture_id      INTEGER,
      client_name     VARCHAR(200) NOT NULL,
      engagement_type VARCHAR(50),
      scope           JSONB NOT NULL,
      roe             JSONB,
      sow_url         TEXT,
      status          VARCHAR(20) DEFAULT 'scoping',
      start_date      DATE,
      end_date        DATE,
      lead_engineer   VARCHAR(100),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      metadata        JSONB DEFAULT '{}'
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pentest_findings (
      id              SERIAL PRIMARY KEY,
      engagement_id   VARCHAR(50) REFERENCES pentest_engagements(id),
      severity        VARCHAR(20) NOT NULL,
      title           VARCHAR(200) NOT NULL,
      description     TEXT,
      cvss_score      NUMERIC(3,1),
      cvss_vector     VARCHAR(255),
      affected_asset  VARCHAR(200),
      affected_assets JSONB DEFAULT '[]',
      refs            JSONB DEFAULT '[]',
      mitre_attack    JSONB DEFAULT '[]',
      reproduction    JSONB,
      remediation     TEXT,
      evidence_files  JSONB DEFAULT '[]',
      status          VARCHAR(20) DEFAULT 'open',
      discovered_at   TIMESTAMPTZ DEFAULT NOW(),
      discovered_by   VARCHAR(50)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_findings_engagement ON pentest_findings(engagement_id, severity)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_findings_severity ON pentest_findings(severity, status)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pentest_reports (
      id            SERIAL PRIMARY KEY,
      engagement_id VARCHAR(50) REFERENCES pentest_engagements(id),
      report_type   VARCHAR(50),
      format        VARCHAR(20),
      file_path     TEXT,
      generated_by  VARCHAR(50),
      generated_at  TIMESTAMPTZ DEFAULT NOW(),
      delivered_at  TIMESTAMPTZ,
      metadata      JSONB DEFAULT '{}'
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS disclosures (
      id                     VARCHAR(50) PRIMARY KEY,
      finding_id             INTEGER REFERENCES pentest_findings(id),
      engagement_id          VARCHAR(50),
      target_vendor          VARCHAR(100),
      target_psirt_email     VARCHAR(200),
      cve_id                 VARCHAR(30),
      severity               VARCHAR(20),
      cvss_score             NUMERIC(3,1),
      cvss_vector            VARCHAR(120),
      status                 VARCHAR(30) DEFAULT 'draft',
      initial_email_sent_at  TIMESTAMPTZ,
      vendor_acknowledged_at TIMESTAMPTZ,
      vendor_fix_eta         TIMESTAMPTZ,
      patch_released_at      TIMESTAMPTZ,
      public_disclosure_at   TIMESTAMPTZ,
      deadline_90day         TIMESTAMPTZ,
      advisory_path          TEXT,
      notes                  TEXT,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    )`);
    // Field-union alignment: bring the pre-existing live pentest_findings up to target —
    // refs[] (CVE/ExploitDB/MSF/advisory references), affected_assets[] (multi-host links
    // with per-finding port subsets, joinable to recon_hosts), and a wider cvss_vector for
    // CVSS v4 strings. Idempotent; no-op once applied.
    await pool.query(`ALTER TABLE pentest_findings ADD COLUMN IF NOT EXISTS refs JSONB DEFAULT '[]'`);
    await pool.query(`ALTER TABLE pentest_findings ADD COLUMN IF NOT EXISTS affected_assets JSONB DEFAULT '[]'`);
    await pool.query(`ALTER TABLE pentest_findings ALTER COLUMN cvss_vector TYPE VARCHAR(255)`);
    // dir_1780785501461: offense-aggregator.js writes a short evidence_summary
    // string (the model's distilled signal from the queue item's raw output).
    // Without this column the INSERT throws and the aggregator's try/catch
    // swallows every finding silently — agent runs produced zero findings.
    await pool.query(`ALTER TABLE pentest_findings ADD COLUMN IF NOT EXISTS evidence_summary TEXT`);

    // ── Attack-graph data model (dir_1780781999942) ──
    // informed_by: [{finding_id, edge_kind in {'evidence','implies','refutes'}}, ...]
    //   — DAG of inference: which prior finding(s) led the model to propose / discover this one
    // enables: [{hypothesis_label, ttp_hint}, ...]
    //   — which open attack paths this finding makes possible. Hypothesis nodes get linked back
    //     when later findings confirm/refute them.
    // kind: 'confirmed' (a real finding the PA ran a probe and we have evidence) | 'hypothesis'
    //   (the model proposed a probe; no result yet) | 'refuted' (probe ran and disproved)
    // See feedback_soc_observer_role.md + OFFENSE-AGENT-DESIGN.md.
    await pool.query(`ALTER TABLE pentest_findings ADD COLUMN IF NOT EXISTS informed_by JSONB DEFAULT '[]'`);
    await pool.query(`ALTER TABLE pentest_findings ADD COLUMN IF NOT EXISTS enables JSONB DEFAULT '[]'`);
    await pool.query(`ALTER TABLE pentest_findings ADD COLUMN IF NOT EXISTS kind VARCHAR(16) DEFAULT 'confirmed'`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_findings_informed_by ON pentest_findings USING GIN (informed_by)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_findings_kind ON pentest_findings(engagement_id, kind)`);
    // Per-engagement feature flag — keep legacy free-intent path the default until
    // the new graph prompt is smoke-tested. Flip true on engagements that opt in.
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS graph_mode_enabled BOOLEAN DEFAULT false`);

    // ── Phase-gated autonomous execution (dir_1780784224487) ──
    // autonomous_execution_enabled: when true, queueStep auto-spawns SSH execution
    //   for recon/enumeration phase steps via the existing /soc/queue/:id/run path.
    //   Foothold + post_exploit + lateral + exploitation stay gated (pending queue).
    // autonomous_paused: kill switch — disables auto-execution even on safe phases.
    // last_phase_advance_push_at: throttle bookkeeping for push notifications.
    // soc_queue_items.auto_executed: marker so the SOC app can badge auto-runs.
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS autonomous_execution_enabled BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS autonomous_paused BOOLEAN DEFAULT false`);
    // dir_1780787660588: opt-in unattended observation window — when true AND
    // autonomous_execution_enabled=true, every claimed intent auto-runs (ROE
    // block-list still applies). No push spam during the window.
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS autonomous_full_access BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS last_phase_advance_push_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE soc_queue_items ADD COLUMN IF NOT EXISTS auto_executed BOOLEAN DEFAULT false`);
    // ── Step-level intent classifier (dir_1780784990563) ──
    // intent_class: model-declared intent for THIS step. NULL = legacy / model omitted
    //   → treated as gated by autonomous-executor.
    // Auto-run set = {recon, enum, banner_grab, service_version, tool_setup}.
    // Harness lints declared intent vs command content; mismatch gates regardless.
    await pool.query(`ALTER TABLE soc_queue_items ADD COLUMN IF NOT EXISTS intent_class VARCHAR(24)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_soc_queue_intent ON soc_queue_items(engagement_id, intent_class)`);

    // ── Model knowledge tools (dir_1780827444328) ──
    // cve_cache: NVD lookups for verify_cve. 7-day TTL.
    // nse_script_catalog: parsed `nmap --script-help all` from dev-01 for list_nse_scripts.
    await pool.query(`CREATE TABLE IF NOT EXISTS cve_cache (
      cve_id      VARCHAR(20) PRIMARY KEY,
      metadata    JSONB NOT NULL,
      fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS nse_script_catalog (
      name         VARCHAR(80) PRIMARY KEY,
      categories   JSONB NOT NULL DEFAULT '[]',
      description  TEXT,
      refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_nse_categories ON nse_script_catalog USING GIN (categories)`);

    // ── Per-engagement executor routing (dir_1780586225013) ──
    // executor_host: 'dev-01' (default, runs commands as-is on the kali toolhost) or
    //   'tablet-p610' (or any android-pentest-bridge style executor — runs commands
    //   ON the tablet via adb-over-WG so wlan0 reaches the target LAN directly,
    //   avoiding the subnet conflict between dev-01's 192.168.1.0/24 and the
    //   target's 192.168.1.0/24).
    // executor_adb_target: e.g. '10.9.0.10:5555' — set when executor_host is a
    //   tablet/phone we reach via adb. NULL for dev-01-direct executors.
    // executor_tools: jsonb array of tool names available on the executor —
    //   passed to the L3 prompt so the model picks commands appropriate to the runner.
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS executor_host VARCHAR(64) DEFAULT 'dev-01'`);
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS executor_adb_target VARCHAR(64)`);
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS executor_tools JSONB DEFAULT '[]'`);
    // dir_1780588077262 — Step 1 of OFFENSE-AGENT-DESIGN.md: live-probed tool list.
    // executor-probe.js sets this timestamp; probes older than 24h are re-run.
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS executor_tools_probed_at TIMESTAMPTZ`);

    // dir_1780589262481 — Step 5 of OFFENSE-AGENT-DESIGN.md: agent loop state.
    // engagement_phase: where the agent thinks it is in the kill chain.
    // agent_run_state: full conversation transcript (system+user+assistant+tool messages)
    //   so a bridge restart mid-run doesn't lose conversation history.
    // agent_status: idle | running | completed | error — drives the SOC app's
    //   "agent running" badge in Step 6.
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS engagement_phase VARCHAR(32) DEFAULT 'recon'`);
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS agent_run_state JSONB DEFAULT '{}'::jsonb`);
    await pool.query(`ALTER TABLE pentest_engagements ADD COLUMN IF NOT EXISTS agent_status VARCHAR(16) DEFAULT 'idle'`);

    // Seed: SKYLINE-SOC-2026-628 (EDIFICIO LAURA) runs through tablet-p610 because
    // dev-01 can't reach the target LAN (subnet conflict). Idempotent — only sets
    // values if columns are still at their defaults.
    await pool.query(`UPDATE pentest_engagements
      SET executor_host = 'tablet-p610',
          executor_adb_target = '10.9.0.10:5555',
          executor_tools = '["sh","busybox","curl","nc","base64","cat","grep","awk","ip","iptables","tcpdump"]'::jsonb
      WHERE id = 'SKYLINE-SOC-2026-628'
        AND executor_host = 'dev-01'`);

    // Seed the default kali toolchain for all other engagements that are still at
    // the empty executor_tools default. Idempotent.
    await pool.query(`UPDATE pentest_engagements
      SET executor_tools = '["nmap","masscan","msfconsole","hydra","sqlmap","curl","wget","ssh","python3","gobuster","nikto","searchsploit","tcpdump","ncat","openssl"]'::jsonb
      WHERE executor_host = 'dev-01'
        AND (executor_tools IS NULL OR executor_tools = '[]'::jsonb)`);

    // dir_1780594102051 — Step 8 of OFFENSE-AGENT-DESIGN.md: Task Coordination Graph.
    // The xOffense multi-agent pattern's persistent backbone — a DAG of tasks per
    // engagement. The Orchestrator agent reads this graph to pick the next unblocked
    // task; the Aggregator agent writes outcome_summary after each task completes.
    // parent_ids encodes DAG edges (a task can have multiple prerequisites).
    await pool.query(`CREATE TABLE IF NOT EXISTS engagement_tasks (
      id              SERIAL PRIMARY KEY,
      engagement_id   VARCHAR(50) NOT NULL REFERENCES pentest_engagements(id) ON DELETE CASCADE,
      parent_ids      INTEGER[] NOT NULL DEFAULT '{}',
      directive       TEXT NOT NULL,
      phase           VARCHAR(32),
      prerequisites   TEXT,
      status          VARCHAR(16) NOT NULL DEFAULT 'pending',
                      -- pending | in_flight | done | failed | skipped
      queue_item_id   INTEGER REFERENCES soc_queue_items(id) ON DELETE SET NULL,
      outcome_summary JSONB,
      iteration       INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_engagement_tasks_engagement ON engagement_tasks(engagement_id, status, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_engagement_tasks_queue_item ON engagement_tasks(queue_item_id)`);

    // ── model_behavior_notes (dir_1780763057382) ──
    // Per-iteration tags surfacing what the L3 agent did well or badly during an
    // engagement, so the v1.4 training corpus can be quality-labeled: gold-standard
    // iterations marked positive, give-up-early / hallucination / false-end marked
    // negative for filtering or down-weighting. Without this every transcript bakes
    // every behavior — good and bad — into v1.4 equally. tag is a controlled
    // vocabulary (see routes/mcp.js note_model_behavior). queue_item_id is optional
    // because some observations are about decision-shape, not the queued command.
    await pool.query(`CREATE TABLE IF NOT EXISTS model_behavior_notes (
      id            SERIAL PRIMARY KEY,
      engagement_id VARCHAR(50) NOT NULL REFERENCES pentest_engagements(id) ON DELETE CASCADE,
      queue_item_id INTEGER REFERENCES soc_queue_items(id) ON DELETE SET NULL,
      iter          INTEGER,
      model_used    VARCHAR(64),
      tag           VARCHAR(32) NOT NULL,
      polarity      VARCHAR(8)  NOT NULL,
                    -- positive | negative | neutral
      observation   TEXT NOT NULL,
      suggested_fix TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by    VARCHAR(50) DEFAULT 'cipher'
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mbn_engagement ON model_behavior_notes(engagement_id, created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mbn_tag ON model_behavior_notes(tag, polarity)`);

    // ── SOC recon hosts (dir_1780530175588) ──
    // Structured host/port rows parsed SERVER-SIDE from scan stdout at ingest, so
    // Cipher analyzes these rows (via get_recon) instead of pasting raw nmap/nc dumps
    // into chat — raw dumps trip the usage-policy classifier. Raw output stays in
    // agent_audit_log.output for the app/evidence; recon_hosts is the analysis surface.
    await pool.query(`CREATE TABLE IF NOT EXISTS recon_hosts (
      id            SERIAL PRIMARY KEY,
      engagement_id VARCHAR(50) NOT NULL REFERENCES pentest_engagements(id) ON DELETE CASCADE,
      session_id    TEXT,
      ip            VARCHAR(45) NOT NULL,
      mac           VARCHAR(17),
      vendor        TEXT,
      hostname      TEXT,
      status        VARCHAR(16),
      ports         JSONB DEFAULT '[]',
      raw_excerpt   TEXT,
      discovered_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (engagement_id, ip)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_recon_hosts_engagement ON recon_hosts(engagement_id, discovered_at DESC)`);

    // ── L3 telemetry / audit loop (dir_1780583452935) ──
    // One row per advance_offense call. Holds SHAPE + TIMING + OUTCOME of the L3
    // model's behavior — never raw commands or rationales (those live in
    // soc_queue_items, joined via queue_item_id). Membrane-safe audit surface
    // for L4: read aggregates, spot harness gaps, build harness upgrades.
    await pool.query(`CREATE TABLE IF NOT EXISTS offense_telemetry (
      id                    SERIAL PRIMARY KEY,
      engagement_id         VARCHAR(50) NOT NULL REFERENCES pentest_engagements(id) ON DELETE CASCADE,
      queue_item_id         INTEGER REFERENCES soc_queue_items(id) ON DELETE SET NULL,
      model_used            VARCHAR(80) NOT NULL,
      intent_category       VARCHAR(32),
      n_hosts               INTEGER NOT NULL DEFAULT 0,
      n_findings            INTEGER NOT NULL DEFAULT 0,
      step_queued           BOOLEAN NOT NULL,
      in_scope              BOOLEAN,
      n_references          INTEGER DEFAULT 0,
      references_validated  JSONB,
      latency_ms            INTEGER NOT NULL,
      outcome               VARCHAR(24) DEFAULT 'pending',
      outcome_notes         TEXT,
      error_message         TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_offense_telemetry_engagement ON offense_telemetry(engagement_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_offense_telemetry_model ON offense_telemetry(model_used, created_at DESC)`);

    // ── Membrane write-guard (dir_1780773748369) ──
    // Structural backstop preventing L4 (Cipher) from authoring exploit content
    // into soc_queue_items.command / .output. Trip on 2026-06-06 (cfa3bf59) was
    // a literal `-u admin:12345` curl string Cipher wrote into a queue cancellation
    // output field — tripped the Anthropic cyber-use safeguard. Behavior is covered
    // by memory feedback_soc_observer_role.md; this trigger is the structural backstop.
    //
    // Bypass: legitimate writes from offense-engine / offense-agent-tools (the L3
    // model's own outputs, which the membrane handles) set session var
    // `app.bypass_exploit_check` via db.withBypass(label, fn). PA executor capture
    // doesn't need bypass — the patterns target Cipher's authoring fingerprint
    // (curl -u user:pass, raw Basic auth, default-cred substrings), not natural
    // scan output which contains things like `WWW-Authenticate: Basic realm=...`.
    await pool.query(`CREATE TABLE IF NOT EXISTS cipher_exploit_write_attempts (
      id              SERIAL PRIMARY KEY,
      engagement_id   VARCHAR(50),
      queue_item_id   INTEGER,
      op              VARCHAR(10),
      column_hit      VARCHAR(16),
      pattern_matched VARCHAR(64),
      body_excerpt    TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cipher_exploit_attempts_eng ON cipher_exploit_write_attempts(engagement_id, created_at DESC)`);

    await pool.query(`CREATE OR REPLACE FUNCTION check_cipher_exploit_write()
    RETURNS TRIGGER AS $func$
    DECLARE
      bypass_label TEXT;
      combined TEXT;
      pattern_hit TEXT := NULL;
      col_hit TEXT;
    BEGIN
      BEGIN
        bypass_label := current_setting('app.bypass_exploit_check', true);
      EXCEPTION WHEN OTHERS THEN
        bypass_label := NULL;
      END;
      IF bypass_label IS NOT NULL AND bypass_label <> '' THEN
        RETURN NEW;
      END IF;

      combined := COALESCE(NEW.command, '') || E'\n--SEP--\n' || COALESCE(NEW.output, '');

      IF combined ~ E'\\\\m(curl|wget)\\\\M[^\\n]{0,200}(-u[[:space:]]|--user[=[:space:]]|--password[=[:space:]])[[:space:]]*[[:alnum:]._-]+:[[:alnum:]._@!#%-]+' THEN
        pattern_hit := 'curl_wget_literal_creds';
      ELSIF combined ~ E'Authorization[[:space:]]*:[[:space:]]*Basic[[:space:]]+[A-Za-z0-9+/=]{8,}' THEN
        pattern_hit := 'raw_basic_auth_header';
      ELSIF combined ~ E'\\\\m(admin:(12345|admin|password|1234|root)|root:(root|toor|password|admin)|guest:guest|user:user|administrator:administrator)\\\\M' THEN
        pattern_hit := 'default_cred_substring';
      END IF;

      IF pattern_hit IS NOT NULL THEN
        IF COALESCE(NEW.command, '') ~ E'(curl|wget|Authorization|admin:|root:|guest:|user:|administrator:)' THEN
          col_hit := 'command';
        ELSE
          col_hit := 'output';
        END IF;
        RAISE WARNING 'CIPHER_EXPLOIT_WRITE_BLOCKED engagement=% queue_item=% column=% pattern=%',
          NEW.engagement_id, NEW.id, col_hit, pattern_hit;
        RAISE EXCEPTION 'CIPHER_EXPLOIT_WRITE_BLOCKED: pattern=% on soc_queue_items.%, see feedback_soc_observer_role.md', pattern_hit, col_hit
          USING ERRCODE = 'P0001',
                HINT = 'L4 should not author exploit commands. Use prompt/harness/ROE directives instead.';
      END IF;

      RETURN NEW;
    END;
    $func$ LANGUAGE plpgsql`);

    await pool.query(`DROP TRIGGER IF EXISTS trg_check_cipher_exploit_write ON soc_queue_items`);
    await pool.query(`CREATE TRIGGER trg_check_cipher_exploit_write
      BEFORE INSERT OR UPDATE OF command, output ON soc_queue_items
      FOR EACH ROW EXECUTE FUNCTION check_cipher_exploit_write()`);

    // ── Infra-state (dir_1780260211325 D4, dir_1780260211365 D5, dir_1780260211404 D6) ──
    await pool.query(`CREATE TABLE IF NOT EXISTS device_credentials (
      device_id    TEXT PRIMARY KEY,
      token_hash   TEXT NOT NULL,
      scopes       TEXT[] NOT NULL DEFAULT '{heartbeat:write}',
      label        TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS device_state (
      device_id          TEXT PRIMARY KEY,
      status             TEXT,
      source             TEXT,
      wifi_ssid          TEXT,
      lan_ip             TEXT,
      public_ip          TEXT,
      wg_ip              TEXT,
      wg_handshake_age_s INTEGER,
      battery_pct        INTEGER,
      meta               JSONB DEFAULT '{}',
      last_seen          TIMESTAMPTZ,
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS device_state_log (
      id          SERIAL PRIMARY KEY,
      device_id   TEXT,
      from_status TEXT,
      to_status   TEXT,
      change      TEXT,
      details     JSONB DEFAULT '{}',
      ts          TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_device_state_log_device ON device_state_log(device_id, ts DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_device_state_log_ts ON device_state_log(ts DESC)`);

    console.log("[pg] Migrations applied (osint tables + schedules/alerts/persons/groups/remediations/incidents + cedula_faces + business + ceo + browser audit + investigations + ekf + identity resolution + owner profile + watchdog + token_usage + device_push_tokens + file_folders + identity_vault + knowledge_graph + agent_audit_log + recon_hosts + infra_state)");
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

// Run fn inside a transaction with app.bypass_exploit_check set to label.
// Use for legitimate writes to soc_queue_items.command/.output from internal
// paths (offense-engine, offense-agent-tools) — the trigger sees the bypass
// session var and skips the exploit-write check. fn receives the pg client
// and MUST use it (not db.query) so the session var applies.
//
// Cipher (L4) MUST NOT use this helper. It exists for the membrane-handled
// L3 model paths only. See feedback_soc_observer_role.md.
async function withBypass(label, fn) {
  if (!label || typeof label !== 'string') {
    throw new Error('withBypass requires a non-empty label');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.bypass_exploit_check', $1, true)`, [label]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
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
    `INSERT INTO directives (id, type, title, description, status, plan, approval_id, epic_id, phase_order,
       created_at, updated_at, emoji, created_by, work_summary, working_state, activity_log,
       started_at, completed_at, duration, priority, depends_on, failure_reason, category, retry_count, thread_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
       to_timestamp($10::double precision / 1000), to_timestamp($11::double precision / 1000),
       $12, $13, $14, $15, $16::jsonb,
       CASE WHEN $17::double precision > 0 THEN to_timestamp($17::double precision / 1000) ELSE NULL END,
       CASE WHEN $18::double precision > 0 THEN to_timestamp($18::double precision / 1000) ELSE NULL END,
       $19, $20, $21::text[], $22, $23, $24, $25)
     ON CONFLICT (id) DO UPDATE SET
       type = EXCLUDED.type, title = EXCLUDED.title, description = EXCLUDED.description,
       status = EXCLUDED.status, plan = EXCLUDED.plan, approval_id = EXCLUDED.approval_id,
       epic_id = EXCLUDED.epic_id, phase_order = EXCLUDED.phase_order,
       updated_at = EXCLUDED.updated_at, emoji = EXCLUDED.emoji, created_by = EXCLUDED.created_by,
       work_summary = EXCLUDED.work_summary, working_state = EXCLUDED.working_state,
       activity_log = EXCLUDED.activity_log, started_at = EXCLUDED.started_at,
       completed_at = EXCLUDED.completed_at, duration = EXCLUDED.duration,
       priority = EXCLUDED.priority, depends_on = EXCLUDED.depends_on,
       failure_reason = EXCLUDED.failure_reason, category = EXCLUDED.category,
       retry_count = EXCLUDED.retry_count, thread_id = EXCLUDED.thread_id`,
    [
      directive.id, directive.type, directive.title || "", directive.description || "",
      directive.status, directive.plan || null, directive.directiveApprovalId || null,
      directive.epicId || null, directive.phaseOrder || null,
      directive.createdAt, directive.updatedAt,
      directive.emoji || null, directive.createdBy || null,
      directive.work_summary || null, directive.working_state || null,
      JSON.stringify(directive.activity_log || []),
      directive.startedAt || 0, directive.completedAt || 0,
      directive.duration || null, directive.priority || 3,
      directive.dependsOn || null, directive.failureReason || null,
      directive.category || "dev", directive.retryCount || 0,
      directive.thread_id || null,
    ]
  );
}

async function backfillDirectives(directives) {
  if (!_pgConnected) return { synced: 0 };
  let synced = 0;
  for (const d of directives) {
    try {
      await saveDirective(d);
      synced++;
    } catch (err) {
      console.error(`[pg] Failed to backfill directive ${d.id}:`, err.message);
    }
  }
  return { synced };
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

// ── Directive Threads ──

async function saveThread(thread) {
  if (!_pgConnected) return;
  await query(
    `INSERT INTO directive_threads (id, name, summary, status, decisions, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, summary = EXCLUDED.summary, status = EXCLUDED.status,
       decisions = EXCLUDED.decisions, updated_at = EXCLUDED.updated_at`,
    [
      thread.id, thread.name, thread.summary || null, thread.status || "active",
      JSON.stringify(thread.decisions || []),
      thread.created_at || new Date(), thread.updated_at || new Date(),
    ]
  );
}

async function getThreads(statusFilter = null) {
  if (!_pgConnected) return [];
  let res;
  if (statusFilter) {
    res = await query(`SELECT * FROM directive_threads WHERE status = $1 ORDER BY updated_at DESC`, [statusFilter]);
  } else {
    res = await query(`SELECT * FROM directive_threads ORDER BY updated_at DESC`);
  }
  return res.rows;
}

async function getThread(threadId) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM directive_threads WHERE id = $1`, [threadId]);
  if (res.rows.length === 0) return null;
  const thread = res.rows[0];
  // Fetch linked directives
  const dirRes = await query(
    `SELECT id, type, title, status, emoji, category, work_summary, created_at, completed_at, duration, thread_id
     FROM directives WHERE thread_id = $1 ORDER BY created_at ASC`,
    [threadId]
  );
  thread.directives = dirRes.rows;
  return thread;
}

async function linkDirectiveToThread(directiveId, threadId) {
  if (!_pgConnected) return;
  await query(`UPDATE directives SET thread_id = $1 WHERE id = $2`, [threadId, directiveId]);
}

async function unlinkDirectiveFromThread(directiveId) {
  if (!_pgConnected) return;
  await query(`UPDATE directives SET thread_id = NULL WHERE id = $1`, [directiveId]);
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

async function bulkUpdateOsintFindings(newStatus, { findingIds, severity, module, currentStatus } = {}) {
  if (!_pgConnected) return 0;
  const validStatuses = ["new", "acknowledged", "remediated", "false_positive"];
  if (!validStatuses.includes(newStatus)) return 0;

  if (findingIds && findingIds.length > 0) {
    const res = await query(
      `UPDATE osint_findings SET status = $1, updated_at = NOW() WHERE id = ANY($2) RETURNING id`,
      [newStatus, findingIds]
    );
    return res.rowCount;
  }

  // Filter-based bulk update
  const params = [newStatus];
  const clauses = [];
  if (severity) { params.push(severity); clauses.push(`severity = $${params.length}`); }
  if (module) { params.push(module); clauses.push(`module = $${params.length}`); }
  if (currentStatus) { params.push(currentStatus); clauses.push(`status = $${params.length}`); }
  if (clauses.length === 0) return 0; // safety: require at least one filter
  const sql = `UPDATE osint_findings SET status = $1, updated_at = NOW() WHERE ${clauses.join(" AND ")} RETURNING id`;
  const res = await query(sql, params);
  return res.rowCount;
}

async function getOsintFindingCounts() {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT severity, COUNT(*) as count FROM osint_findings
     WHERE status NOT IN ('false_positive', 'acknowledged')
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

// ── OSINT Investigations ──

async function createOsintInvestigation(data) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_investigations (name, seed_profile_id, max_depth, config)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [data.name, data.seed_profile_id || null, data.max_depth || 2, JSON.stringify(data.config || {})]
  );
  return res.rows[0];
}

async function getOsintInvestigation(id) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM osint_investigations WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function getOsintInvestigations() {
  if (!_pgConnected) return [];
  const res = await query(`SELECT i.*, p.label as seed_label, p.profile_type as seed_type FROM osint_investigations i LEFT JOIN osint_profiles p ON i.seed_profile_id = p.id ORDER BY i.created_at DESC`);
  return res.rows;
}

async function incrementInvestigationPivots(id, count) {
  if (!_pgConnected) return;
  await query(`UPDATE osint_investigations SET pivot_count = pivot_count + $2, updated_at = NOW() WHERE id = $1`, [id, count]);
}

// ── OSINT Profile Pivot Support ──

async function getOsintProfileByValue(profileType, value) {
  if (!_pgConnected) return null;
  const res = await query(
    `SELECT * FROM osint_profiles WHERE profile_type = $1 AND value = $2 AND is_active = true`,
    [profileType, value]
  );
  return res.rows[0] || null;
}

async function updateOsintProfilePivot(id, data) {
  if (!_pgConnected) return;
  await query(
    `UPDATE osint_profiles SET investigation_id = $2, pivot_depth = $3, pivot_source = $4, updated_at = NOW() WHERE id = $1`,
    [id, data.investigation_id || null, data.pivot_depth || 0, data.pivot_source || null]
  );
}

// ── OSINT EKF State ──

async function getOsintEkfState(profileId) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM osint_ekf_state WHERE profile_id = $1`, [profileId]);
  return res.rows[0] || null;
}

async function upsertOsintEkfState(profileId, data) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO osint_ekf_state (profile_id, state_vector, covariance_matrix, observation_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (profile_id) DO UPDATE SET
       state_vector = $2, covariance_matrix = $3, observation_count = $4, updated_at = NOW()
     RETURNING *`,
    [profileId, JSON.stringify(data.state_vector), JSON.stringify(data.covariance_matrix), data.observation_count || 0]
  );
  return res.rows[0];
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
  // Dedup: skip if an alert for the same finding_id already exists (within 24h)
  if (data.finding_id) {
    const existing = await query(
      `SELECT id FROM osint_alerts WHERE finding_id = $1 AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
      [data.finding_id]
    );
    if (existing.rows.length > 0) return null;
  }
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

// ── Cédula Face DB ──

async function upsertCedulaFace(cedula, fullName, photoPath, embedding, metadata) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO cedula_faces (cedula, full_name, photo_path, embedding, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (cedula) DO UPDATE SET
       full_name = COALESCE(EXCLUDED.full_name, cedula_faces.full_name),
       photo_path = COALESCE(EXCLUDED.photo_path, cedula_faces.photo_path),
       embedding = COALESCE(EXCLUDED.embedding, cedula_faces.embedding),
       metadata = cedula_faces.metadata || EXCLUDED.metadata
     RETURNING *`,
    [cedula, fullName, photoPath, embedding, metadata || {}]
  );
  return res.rows[0] || null;
}

async function getCedulaFace(cedula) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM cedula_faces WHERE cedula = $1`, [cedula]);
  return res.rows[0] || null;
}

async function getCedulaFaces(limit = 100, offset = 0) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT id, cedula, full_name, photo_path, metadata, created_at FROM cedula_faces ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return res.rows;
}

async function deleteCedulaFace(cedula) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM cedula_faces WHERE cedula = $1`, [cedula]);
  return res.rowCount > 0;
}

async function getAllCedulaEmbeddings() {
  if (!_pgConnected) return [];
  const res = await query(`SELECT id, cedula, full_name, embedding FROM cedula_faces WHERE embedding IS NOT NULL`);
  return res.rows;
}

// ── Business Projects & Tasks ──

async function getBusinessProjects() {
  if (!_pgConnected) return [];
  const res = await query(`
    SELECT p.*,
      COUNT(t.id)::int AS task_count,
      COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done_count,
      COUNT(t.id) FILTER (WHERE t.status = 'in_progress')::int AS in_progress_count,
      COALESCE(SUM(t.estimated_cost), 0)::numeric AS total_estimated,
      COALESCE((SELECT SUM(e.amount) FROM business_expenses e JOIN business_tasks bt ON bt.id = e.task_id WHERE bt.project_id = p.id), 0)::numeric AS total_actual
    FROM business_projects p
    LEFT JOIN business_tasks t ON t.project_id = p.id
    WHERE p.status != 'archived'
    GROUP BY p.id
    ORDER BY p.position, p.created_at DESC
  `);
  return res.rows;
}

async function getBusinessProject(id) {
  if (!_pgConnected) return null;
  const pRes = await query(`SELECT * FROM business_projects WHERE id = $1`, [id]);
  if (pRes.rows.length === 0) return null;
  const tRes = await query(
    `SELECT t.*, COALESCE(a.cnt, 0)::int AS attachment_count, COALESCE(e.cnt, 0)::int AS expense_count
     FROM business_tasks t
     LEFT JOIN (SELECT task_id, COUNT(*)::int AS cnt FROM business_attachments GROUP BY task_id) a ON a.task_id = t.id
     LEFT JOIN (SELECT task_id, COUNT(*)::int AS cnt FROM business_expenses GROUP BY task_id) e ON e.task_id = t.id
     WHERE t.project_id = $1 ORDER BY t.position, t.created_at`,
    [id]
  );
  return { ...pRes.rows[0], tasks: tRes.rows };
}

async function createBusinessProject({ name, description, emoji, color }) {
  if (!_pgConnected) return null;
  const posRes = await query(`SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM business_projects`);
  const pos = posRes.rows[0].next_pos;
  const res = await query(
    `INSERT INTO business_projects (name, description, emoji, color, position) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, description || '', emoji || '📁', color || '#06B6D4', pos]
  );
  return res.rows[0];
}

async function updateBusinessProject(id, updates) {
  if (!_pgConnected) return null;
  const fields = [];
  const vals = [];
  let idx = 1;
  for (const key of ['name', 'description', 'emoji', 'color', 'status', 'position', 'budget', 'currency']) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = $${idx}`);
      vals.push(updates[key]);
      idx++;
    }
  }
  if (fields.length === 0) return null;
  fields.push(`updated_at = NOW()`);
  vals.push(id);
  const res = await query(
    `UPDATE business_projects SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return res.rows[0] || null;
}

async function archiveBusinessProject(id) {
  if (!_pgConnected) return false;
  const res = await query(
    `UPDATE business_projects SET status = 'archived', updated_at = NOW() WHERE id = $1`,
    [id]
  );
  return res.rowCount > 0;
}

async function createBusinessTask({ project_id, title, description, priority, due_date, phase, notes, estimated_cost, cost_category }) {
  if (!_pgConnected) return null;
  const posRes = await query(
    `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM business_tasks WHERE project_id = $1`,
    [project_id]
  );
  const pos = posRes.rows[0].next_pos;
  const res = await query(
    `INSERT INTO business_tasks (project_id, title, description, priority, due_date, position, phase, notes, estimated_cost, cost_category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [project_id, title, description || '', priority || 'medium', due_date || null, pos, phase || '', notes || '', estimated_cost || null, cost_category || null]
  );
  return res.rows[0];
}

async function updateBusinessTask(id, updates) {
  if (!_pgConnected) return null;
  const fields = [];
  const vals = [];
  let idx = 1;
  for (const key of ['title', 'description', 'status', 'priority', 'position', 'due_date', 'phase', 'notes', 'requirements', 'estimated_cost', 'actual_cost', 'cost_category']) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = $${idx}`);
      vals.push(updates[key]);
      idx++;
    }
  }
  if (updates.status === 'done') {
    fields.push(`completed_at = NOW()`);
  } else if (updates.status && updates.status !== 'done') {
    fields.push(`completed_at = NULL`);
  }
  if (fields.length === 0) return null;
  fields.push(`updated_at = NOW()`);
  vals.push(id);
  const res = await query(
    `UPDATE business_tasks SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return res.rows[0] || null;
}

async function deleteBusinessTask(id) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM business_tasks WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

async function toggleBusinessTaskStatus(id) {
  if (!_pgConnected) return null;
  const cur = await query(`SELECT status FROM business_tasks WHERE id = $1`, [id]);
  if (cur.rows.length === 0) return null;
  const cycle = { pending: 'in_progress', in_progress: 'done', done: 'pending' };
  const next = cycle[cur.rows[0].status] || 'pending';
  return updateBusinessTask(id, { status: next });
}

// ── Business Attachments ──

async function createBusinessAttachment({ task_id, file_name, file_path, thumbnail_path, file_type, mime_type, file_size }) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO business_attachments (task_id, file_name, file_path, thumbnail_path, file_type, mime_type, file_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [task_id, file_name, file_path, thumbnail_path || null, file_type || 'image', mime_type || 'image/jpeg', file_size || 0]
  );
  return res.rows[0];
}

async function getBusinessAttachments(task_id) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT id, task_id, file_name, file_type, mime_type, file_size, verification, created_at FROM business_attachments WHERE task_id = $1 ORDER BY created_at DESC`,
    [task_id]
  );
  return res.rows;
}

async function getBusinessAttachment(id) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM business_attachments WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function deleteBusinessAttachment(id) {
  if (!_pgConnected) return null;
  const res = await query(`DELETE FROM business_attachments WHERE id = $1 RETURNING *`, [id]);
  return res.rows[0] || null;
}

async function updateBusinessAttachmentVerification(id, verification) {
  if (!_pgConnected) return null;
  const res = await query(
    `UPDATE business_attachments SET verification = $1 WHERE id = $2 RETURNING *`,
    [JSON.stringify(verification), id]
  );
  return res.rows[0] || null;
}

// ── Business Expenses ──

async function createBusinessExpense({ task_id, project_id, attachment_id, amount, iva_amount, category, vendor, description, payment_status, payment_method, expense_date, receipt_data }) {
  if (!_pgConnected) return null;
  const subtotal = amount - (iva_amount || 0);
  const verified = !!(attachment_id && receipt_data);
  const res = await query(
    `INSERT INTO business_expenses (task_id, project_id, attachment_id, amount, iva_amount, subtotal, category, vendor, description, payment_status, payment_method, expense_date, receipt_data, verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [task_id || null, project_id || null, attachment_id || null, amount, iva_amount || 0, subtotal, category, vendor || '', description || '', payment_status || 'pending', payment_method || null, expense_date || new Date().toISOString().split('T')[0], receipt_data ? JSON.stringify(receipt_data) : null, verified]
  );
  return res.rows[0];
}

async function getProjectExpenses(project_id) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT * FROM business_expenses WHERE project_id = $1 ORDER BY expense_date DESC, created_at DESC`,
    [project_id]
  );
  return res.rows;
}

async function getBusinessExpenses(task_id) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT * FROM business_expenses WHERE task_id = $1 ORDER BY expense_date DESC, created_at DESC`,
    [task_id]
  );
  return res.rows;
}

async function updateBusinessExpense(id, updates) {
  if (!_pgConnected) return null;
  const fields = [];
  const vals = [];
  let idx = 1;
  for (const key of ['amount', 'iva_amount', 'category', 'vendor', 'description', 'payment_status', 'payment_method', 'expense_date', 'attachment_id', 'receipt_data', 'verified']) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = $${idx}`);
      vals.push(key === 'receipt_data' ? JSON.stringify(updates[key]) : updates[key]);
      idx++;
    }
  }
  if (fields.length === 0) return null;
  // Auto-set verified when receipt is attached
  if (updates.attachment_id && updates.receipt_data && updates.verified === undefined) {
    fields.push(`verified = $${idx}`);
    vals.push(true);
    idx++;
  }
  // Recompute subtotal if amount or iva changed
  if (updates.amount !== undefined || updates.iva_amount !== undefined) {
    const cur = await query(`SELECT amount, iva_amount FROM business_expenses WHERE id = $1`, [id]);
    if (cur.rows.length > 0) {
      const amt = updates.amount !== undefined ? updates.amount : cur.rows[0].amount;
      const iva = updates.iva_amount !== undefined ? updates.iva_amount : cur.rows[0].iva_amount;
      fields.push(`subtotal = $${idx}`);
      vals.push(amt - iva);
      idx++;
    }
  }
  fields.push(`updated_at = NOW()`);
  vals.push(id);
  const res = await query(
    `UPDATE business_expenses SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return res.rows[0] || null;
}

async function deleteBusinessExpense(id) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM business_expenses WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

async function getProjectFinancials(projectId) {
  if (!_pgConnected) return null;
  const pRes = await query(`SELECT budget, currency FROM business_projects WHERE id = $1`, [projectId]);
  if (pRes.rows.length === 0) return null;
  const { budget, currency } = pRes.rows[0];

  // Task-level aggregates
  const taskRes = await query(
    `SELECT COALESCE(SUM(estimated_cost), 0)::numeric AS total_estimated FROM business_tasks WHERE project_id = $1`,
    [projectId]
  );
  const totalEstimated = parseFloat(taskRes.rows[0].total_estimated);

  // Expense aggregates (task-linked + project-level) with verified breakdown
  const expRes = await query(
    `SELECT COALESCE(SUM(e.amount), 0)::numeric AS total_actual, COALESCE(SUM(e.iva_amount), 0)::numeric AS total_iva,
       COALESCE(SUM(CASE WHEN e.verified THEN e.amount ELSE 0 END), 0)::numeric AS verified_total,
       COALESCE(SUM(CASE WHEN NOT e.verified THEN e.amount ELSE 0 END), 0)::numeric AS unverified_total,
       COUNT(CASE WHEN e.verified THEN 1 END)::int AS verified_count,
       COUNT(CASE WHEN NOT e.verified THEN 1 END)::int AS unverified_count
     FROM business_expenses e
     LEFT JOIN business_tasks t ON t.id = e.task_id
     WHERE e.project_id = $1 OR t.project_id = $1`,
    [projectId]
  );
  const totalActual = parseFloat(expRes.rows[0].total_actual);
  const totalIVA = parseFloat(expRes.rows[0].total_iva);
  const verifiedTotal = parseFloat(expRes.rows[0].verified_total);
  const unverifiedTotal = parseFloat(expRes.rows[0].unverified_total);
  const verifiedCount = expRes.rows[0].verified_count;
  const unverifiedCount = expRes.rows[0].unverified_count;

  // By category
  const catRes = await query(
    `SELECT e.category, SUM(e.amount)::numeric AS total
     FROM business_expenses e
     LEFT JOIN business_tasks t ON t.id = e.task_id
     WHERE e.project_id = $1 OR t.project_id = $1
     GROUP BY e.category ORDER BY total DESC`,
    [projectId]
  );
  const byCategory = {};
  for (const r of catRes.rows) byCategory[r.category] = parseFloat(r.total);

  // By phase
  const phaseRes = await query(
    `SELECT COALESCE(NULLIF(t.phase, ''), 'Uncategorized') AS phase,
       COALESCE(SUM(t.estimated_cost), 0)::numeric AS estimated,
       COALESCE(SUM(e_agg.actual), 0)::numeric AS actual,
       COUNT(t.id)::int AS task_count
     FROM business_tasks t
     LEFT JOIN (SELECT task_id, SUM(amount)::numeric AS actual FROM business_expenses GROUP BY task_id) e_agg ON e_agg.task_id = t.id
     WHERE t.project_id = $1
     GROUP BY phase ORDER BY phase`,
    [projectId]
  );
  const byPhase = {};
  for (const r of phaseRes.rows) byPhase[r.phase] = { estimated: parseFloat(r.estimated), actual: parseFloat(r.actual), taskCount: r.task_count };

  // By payment status
  const payRes = await query(
    `SELECT e.payment_status, COUNT(*)::int AS count, SUM(e.amount)::numeric AS total
     FROM business_expenses e
     LEFT JOIN business_tasks t ON t.id = e.task_id
     WHERE e.project_id = $1 OR t.project_id = $1
     GROUP BY e.payment_status`,
    [projectId]
  );
  const byPaymentStatus = {};
  for (const r of payRes.rows) byPaymentStatus[r.payment_status] = { count: r.count, total: parseFloat(r.total) };

  const budgetVal = budget ? parseFloat(budget) : null;
  const budgetUtilization = budgetVal ? Math.round((totalActual / budgetVal) * 10000) / 100 : null;

  return { budget: budgetVal, currency, totalEstimated, totalActual, totalIVA, verifiedTotal, unverifiedTotal, verifiedCount, unverifiedCount, byCategory, byPhase, byPaymentStatus, budgetUtilization };
}

async function updateBusinessAttachmentReceiptData(id, receiptData) {
  if (!_pgConnected) return null;
  const res = await query(
    `UPDATE business_attachments SET receipt_data = $1 WHERE id = $2 RETURNING *`,
    [JSON.stringify(receiptData), id]
  );
  return res.rows[0] || null;
}

// ── Business Contacts ──

async function createBusinessContact({ name, company, type, email, phone, address, city, country, currency, notes }) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO business_contacts (name, company, type, email, phone, address, city, country, currency, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [name, company || null, type || 'other', email || null, phone || null, address || null, city || null, country || 'Colombia', currency || 'COP', notes || null]
  );
  return res.rows[0];
}

async function getBusinessContacts(filterType) {
  if (!_pgConnected) return [];
  let q = `SELECT * FROM business_contacts ORDER BY name`;
  const params = [];
  if (filterType) {
    q = `SELECT * FROM business_contacts WHERE type = $1 ORDER BY name`;
    params.push(filterType);
  }
  const res = await query(q, params);
  return res.rows;
}

async function getBusinessContact(id) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM business_contacts WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function updateBusinessContact(id, updates) {
  if (!_pgConnected) return null;
  const fields = []; const vals = []; let idx = 1;
  for (const key of ['name','company','type','email','phone','address','city','country','currency','notes']) {
    if (updates[key] !== undefined) { fields.push(`${key} = $${idx}`); vals.push(updates[key]); idx++; }
  }
  if (fields.length === 0) return null;
  fields.push(`updated_at = NOW()`);
  vals.push(id);
  const res = await query(`UPDATE business_contacts SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, vals);
  return res.rows[0] || null;
}

async function deleteBusinessContact(id) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM business_contacts WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

// ── Business Shipments ──

async function createBusinessShipment(data) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO business_shipments (project_id, buyer_contact_id, reference, status, coffee_type, quantity_kg, bags_count, price_per_kg, total_value, currency, shipping_cost, insurance_cost, customs_fees, origin_port, destination_port, ship_date, estimated_arrival, tracking_number, vessel_name, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [data.project_id||null, data.buyer_contact_id||null, data.reference||null, data.status||'preparing', data.coffee_type||null, data.quantity_kg||null, data.bags_count||null, data.price_per_kg||null, data.total_value||null, data.currency||'USD', data.shipping_cost||0, data.insurance_cost||0, data.customs_fees||0, data.origin_port||'Buenaventura', data.destination_port||'Yokohama', data.ship_date||null, data.estimated_arrival||null, data.tracking_number||null, data.vessel_name||null, data.notes||null]
  );
  return res.rows[0];
}

async function getBusinessShipments(filterStatus) {
  if (!_pgConnected) return [];
  let q = `SELECT s.*, c.name AS buyer_name, c.company AS buyer_company
    FROM business_shipments s LEFT JOIN business_contacts c ON c.id = s.buyer_contact_id ORDER BY s.created_at DESC`;
  const params = [];
  if (filterStatus) {
    q = `SELECT s.*, c.name AS buyer_name, c.company AS buyer_company
      FROM business_shipments s LEFT JOIN business_contacts c ON c.id = s.buyer_contact_id WHERE s.status = $1 ORDER BY s.created_at DESC`;
    params.push(filterStatus);
  }
  const res = await query(q, params);
  return res.rows;
}

async function getBusinessShipment(id) {
  if (!_pgConnected) return null;
  const sRes = await query(
    `SELECT s.*, c.name AS buyer_name, c.company AS buyer_company
     FROM business_shipments s LEFT JOIN business_contacts c ON c.id = s.buyer_contact_id WHERE s.id = $1`, [id]);
  if (sRes.rows.length === 0) return null;
  const iRes = await query(`SELECT * FROM business_invoices WHERE shipment_id = $1 ORDER BY created_at DESC`, [id]);
  return { ...sRes.rows[0], invoices: iRes.rows };
}

async function updateBusinessShipment(id, updates) {
  if (!_pgConnected) return null;
  const fields = []; const vals = []; let idx = 1;
  for (const key of ['project_id','buyer_contact_id','reference','status','coffee_type','quantity_kg','bags_count','price_per_kg','total_value','currency','shipping_cost','insurance_cost','customs_fees','origin_port','destination_port','ship_date','estimated_arrival','actual_arrival','tracking_number','vessel_name','notes']) {
    if (updates[key] !== undefined) { fields.push(`${key} = $${idx}`); vals.push(updates[key]); idx++; }
  }
  if (fields.length === 0) return null;
  fields.push(`updated_at = NOW()`);
  vals.push(id);
  const res = await query(`UPDATE business_shipments SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, vals);
  return res.rows[0] || null;
}

async function deleteBusinessShipment(id) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM business_shipments WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

// ── Business Invoices ──

async function createBusinessInvoice(data) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO business_invoices (shipment_id, contact_id, invoice_number, amount, currency, status, issue_date, due_date, paid_amount, payment_method, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [data.shipment_id||null, data.contact_id||null, data.invoice_number||null, data.amount, data.currency||'USD', data.status||'draft', data.issue_date||null, data.due_date||null, data.paid_amount||0, data.payment_method||null, data.notes||null]
  );
  return res.rows[0];
}

async function getBusinessInvoices(filterStatus) {
  if (!_pgConnected) return [];
  let q = `SELECT i.*, c.name AS contact_name FROM business_invoices i LEFT JOIN business_contacts c ON c.id = i.contact_id ORDER BY i.created_at DESC`;
  const params = [];
  if (filterStatus) {
    q = `SELECT i.*, c.name AS contact_name FROM business_invoices i LEFT JOIN business_contacts c ON c.id = i.contact_id WHERE i.status = $1 ORDER BY i.created_at DESC`;
    params.push(filterStatus);
  }
  const res = await query(q, params);
  return res.rows;
}

async function getBusinessInvoice(id) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT i.*, c.name AS contact_name FROM business_invoices i LEFT JOIN business_contacts c ON c.id = i.contact_id WHERE i.id = $1`, [id]);
  return res.rows[0] || null;
}

async function updateBusinessInvoice(id, updates) {
  if (!_pgConnected) return null;
  const fields = []; const vals = []; let idx = 1;
  for (const key of ['shipment_id','contact_id','invoice_number','amount','currency','status','issue_date','due_date','paid_date','paid_amount','payment_method','notes']) {
    if (updates[key] !== undefined) { fields.push(`${key} = $${idx}`); vals.push(updates[key]); idx++; }
  }
  if (fields.length === 0) return null;
  fields.push(`updated_at = NOW()`);
  vals.push(id);
  const res = await query(`UPDATE business_invoices SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, vals);
  return res.rows[0] || null;
}

async function deleteBusinessInvoice(id) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM business_invoices WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

// ── Business Investments ──

async function createBusinessInvestment(data) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO business_investments (project_id, title, description, category, amount, currency, status, investment_date, expected_return_date, roi_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [data.project_id||null, data.title, data.description||null, data.category||'other', data.amount, data.currency||'COP', data.status||'planned', data.investment_date||null, data.expected_return_date||null, data.roi_notes||null]
  );
  return res.rows[0];
}

async function getBusinessInvestments() {
  if (!_pgConnected) return [];
  const res = await query(`SELECT * FROM business_investments ORDER BY created_at DESC`);
  return res.rows;
}

async function getBusinessInvestment(id) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM business_investments WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function updateBusinessInvestment(id, updates) {
  if (!_pgConnected) return null;
  const fields = []; const vals = []; let idx = 1;
  for (const key of ['project_id','title','description','category','amount','currency','status','investment_date','expected_return_date','roi_notes']) {
    if (updates[key] !== undefined) { fields.push(`${key} = $${idx}`); vals.push(updates[key]); idx++; }
  }
  if (fields.length === 0) return null;
  fields.push(`updated_at = NOW()`);
  vals.push(id);
  const res = await query(`UPDATE business_investments SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, vals);
  return res.rows[0] || null;
}

async function deleteBusinessInvestment(id) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM business_investments WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

// ── CEO Dashboard Metrics ──

async function getDashboardMetrics(period) {
  if (!_pgConnected) return null;
  let dateFilter = '';
  let prevStart = '';
  let prevEnd = '';
  const now = new Date();
  if (period === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    dateFilter = `AND created_at >= '${start}'`;
    const ps = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
    const pe = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];
    prevStart = ps; prevEnd = pe;
  } else if (period === 'quarter') {
    const qm = Math.floor(now.getMonth() / 3) * 3;
    const start = new Date(now.getFullYear(), qm, 1).toISOString().split('T')[0];
    dateFilter = `AND created_at >= '${start}'`;
    const ps = new Date(now.getFullYear(), qm - 3, 1).toISOString().split('T')[0];
    const pe = new Date(now.getFullYear(), qm, 0).toISOString().split('T')[0];
    prevStart = ps; prevEnd = pe;
  } else if (period === 'year') {
    const start = new Date(now.getFullYear(), 0, 1).toISOString().split('T')[0];
    dateFilter = `AND created_at >= '${start}'`;
    const ps = new Date(now.getFullYear() - 1, 0, 1).toISOString().split('T')[0];
    const pe = new Date(now.getFullYear() - 1, 11, 31).toISOString().split('T')[0];
    prevStart = ps; prevEnd = pe;
  }

  // Revenue = paid invoices
  const revRes = await query(`SELECT COALESCE(SUM(paid_amount), 0)::numeric AS total FROM business_invoices WHERE status = 'paid' ${dateFilter}`);
  const totalRevenue = parseFloat(revRes.rows[0].total);

  // Expenses
  const expRes = await query(`SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM business_expenses WHERE 1=1 ${dateFilter.replace('created_at', 'expense_date')}`);
  const totalExpenses = parseFloat(expRes.rows[0].total);

  // Active shipments by status
  const shipRes = await query(`SELECT status, COUNT(*)::int AS count FROM business_shipments WHERE status NOT IN ('paid') GROUP BY status`);
  const shipmentsByStatus = {};
  let activeShipments = 0;
  for (const r of shipRes.rows) { shipmentsByStatus[r.status] = r.count; activeShipments += r.count; }

  // Pending payments
  const pendRes = await query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(amount - paid_amount), 0)::numeric AS total FROM business_invoices WHERE status IN ('sent','partial','overdue')`);
  const pendingPayments = pendRes.rows[0].count;
  const pendingPaymentAmount = parseFloat(pendRes.rows[0].total);

  // Top buyers
  const buyerRes = await query(`SELECT c.name, c.company, SUM(i.paid_amount)::numeric AS revenue FROM business_invoices i JOIN business_contacts c ON c.id = i.contact_id WHERE i.status = 'paid' GROUP BY c.id, c.name, c.company ORDER BY revenue DESC LIMIT 5`);
  const topBuyers = buyerRes.rows.map(r => ({ name: r.name, company: r.company, revenue: parseFloat(r.revenue) }));

  // Investments
  const invRes = await query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS total FROM business_investments GROUP BY status`);
  const investmentsByStatus = {};
  let totalInvestments = 0;
  for (const r of invRes.rows) { investmentsByStatus[r.status] = { count: r.count, total: parseFloat(r.total) }; totalInvestments += parseFloat(r.total); }

  // Previous period P&L
  let previousPeriodPL = null;
  if (prevStart && prevEnd) {
    const prevRev = await query(`SELECT COALESCE(SUM(paid_amount), 0)::numeric AS total FROM business_invoices WHERE status = 'paid' AND created_at BETWEEN '${prevStart}' AND '${prevEnd}'`);
    const prevExp = await query(`SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM business_expenses WHERE expense_date BETWEEN '${prevStart}' AND '${prevEnd}'`);
    previousPeriodPL = parseFloat(prevRev.rows[0].total) - parseFloat(prevExp.rows[0].total);
  }

  return {
    totalRevenue, totalExpenses, netPL: totalRevenue - totalExpenses,
    activeShipments, shipmentsByStatus, pendingPayments, pendingPaymentAmount,
    topBuyers, totalInvestments, investmentsByStatus,
    periodLabel: period || 'all', previousPeriodPL
  };
}

// ── Browser Audit & Sessions ──

async function addBrowserAuditEntry(entry) {
  if (!_pgConnected) return null;
  // Mask sensitive data in args before storing
  const safeArgs = entry.args ? JSON.parse(JSON.stringify(entry.args)) : {};
  if (safeArgs.text && typeof safeArgs.text === 'string') {
    // Mask anything that looks like a CC number (13-19 digits)
    safeArgs.text = safeArgs.text.replace(/\b(\d{4})\d{9,15}/g, '$1****');
  }
  const res = await query(
    `INSERT INTO browser_audit_log (session_id, tool_name, args, result_summary, url_at_time, flagged, flag_reason, approval_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [entry.session_id || 'default', entry.tool_name, JSON.stringify(safeArgs),
     entry.result_summary || null, entry.url_at_time || null,
     !!entry.flagged, entry.flag_reason || null, entry.approval_id || null]
  );
  return res.rows[0]?.id;
}

async function getBrowserAuditLog(sessionId, limit = 50) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT id, session_id, tool_name, args, result_summary, url_at_time, flagged, flag_reason, approval_id, created_at
     FROM browser_audit_log WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [sessionId, limit]
  );
  return res.rows;
}

async function upsertBrowserSession(sessionId, data) {
  if (!_pgConnected) return;
  await query(
    `INSERT INTO browser_sessions (id, objective, is_financial, payment_context)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       objective = COALESCE(EXCLUDED.objective, browser_sessions.objective),
       is_financial = COALESCE(EXCLUDED.is_financial, browser_sessions.is_financial),
       payment_context = COALESCE(EXCLUDED.payment_context, browser_sessions.payment_context),
       last_action_at = NOW()`,
    [sessionId, data.objective || null, !!data.is_financial, JSON.stringify(data.payment_context || {})]
  );
}

async function getBrowserSession(sessionId) {
  if (!_pgConnected) return null;
  const res = await query(
    `SELECT id, objective, started_at, last_action_at, url_history, is_financial, payment_context
     FROM browser_sessions WHERE id = $1`,
    [sessionId]
  );
  return res.rows[0] || null;
}

// ── Identity Clusters ──

async function upsertIdentityCluster(cluster) {
  if (!_pgConnected) return null;
  await query(`
    CREATE TABLE IF NOT EXISTS osint_identity_clusters (
      id SERIAL PRIMARY KEY,
      cluster_label TEXT NOT NULL,
      confidence INTEGER DEFAULT 0,
      entity_ids JSONB DEFAULT '[]',
      profile_ids JSONB DEFAULT '[]',
      evidence TEXT,
      breakdown JSONB DEFAULT '{}',
      entity_count INTEGER DEFAULT 0,
      profile_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Upsert by matching entity_ids set (sorted for consistency)
  const sortedIds = [...cluster.entity_ids].sort((a, b) => a - b);
  const existing = await query(
    `SELECT id FROM osint_identity_clusters WHERE entity_ids::text = $1::text`,
    [JSON.stringify(sortedIds)]
  );

  if (existing.rows.length > 0) {
    const res = await query(
      `UPDATE osint_identity_clusters SET
        cluster_label = $1, confidence = $2, evidence = $3,
        breakdown = $4, entity_count = $5, profile_count = $6,
        profile_ids = $7, updated_at = NOW()
      WHERE id = $8 RETURNING *`,
      [cluster.label, cluster.confidence, cluster.evidence,
       JSON.stringify(cluster.breakdown), cluster.entity_count, cluster.profile_count,
       JSON.stringify(cluster.profile_ids), existing.rows[0].id]
    );
    return res.rows[0];
  }

  const res = await query(
    `INSERT INTO osint_identity_clusters
      (cluster_label, confidence, entity_ids, profile_ids, evidence, breakdown, entity_count, profile_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [cluster.label, cluster.confidence, JSON.stringify(sortedIds),
     JSON.stringify(cluster.profile_ids), cluster.evidence,
     JSON.stringify(cluster.breakdown), cluster.entity_count, cluster.profile_count]
  );
  return res.rows[0];
}

async function getIdentityClusters(filters = {}) {
  if (!_pgConnected) return [];
  // Table might not exist yet
  try {
    let sql = `SELECT * FROM osint_identity_clusters WHERE 1=1`;
    const params = [];
    if (filters.minConfidence) {
      params.push(filters.minConfidence);
      sql += ` AND confidence >= $${params.length}`;
    }
    sql += ` ORDER BY confidence DESC`;
    if (filters.limit) {
      params.push(filters.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const res = await query(sql, params);
    return res.rows;
  } catch {
    return [];
  }
}

// ── Knowledge Graph Functions ──

async function kgCreateSubject(subject) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO kg_subjects (subject_type, name, aliases, summary, status, confidence, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (subject_type, name) DO UPDATE SET
       aliases = EXCLUDED.aliases, summary = EXCLUDED.summary,
       confidence = EXCLUDED.confidence, metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [subject.subject_type || 'person', subject.name, subject.aliases || [],
     subject.summary || null, subject.status || 'active',
     subject.confidence || 0, JSON.stringify(subject.metadata || {})]
  );
  return res.rows[0] || null;
}

async function kgGetSubjects(filters = {}) {
  if (!_pgConnected) return [];
  let sql = `SELECT s.*,
    (SELECT COUNT(*) FROM kg_facts WHERE subject_id = s.id)::int AS fact_count,
    (SELECT COUNT(*) FROM kg_anchors WHERE subject_id = s.id)::int AS anchor_count,
    (SELECT COUNT(*) FROM kg_connections WHERE source_id = s.id OR target_id = s.id)::int AS connection_count,
    (SELECT COUNT(*) FROM kg_timeline WHERE subject_id = s.id)::int AS event_count
    FROM kg_subjects s WHERE 1=1`;
  const params = [];
  if (filters.subject_type) { params.push(filters.subject_type); sql += ` AND s.subject_type = $${params.length}`; }
  if (filters.status) { params.push(filters.status); sql += ` AND s.status = $${params.length}`; }
  if (filters.search) { params.push(`%${filters.search}%`); sql += ` AND (s.name ILIKE $${params.length} OR s.summary ILIKE $${params.length})`; }
  sql += ` ORDER BY s.updated_at DESC`;
  const res = await query(sql, params);
  return res.rows;
}

async function kgGetSubject(id) {
  if (!_pgConnected) return null;
  const res = await query(`SELECT * FROM kg_subjects WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

async function kgUpdateSubject(id, updates) {
  if (!_pgConnected) return null;
  const fields = [];
  const params = [id];
  for (const [key, val] of Object.entries(updates)) {
    if (['name','aliases','summary','status','confidence','metadata','subject_type'].includes(key)) {
      params.push(key === 'metadata' || key === 'aliases' ? JSON.stringify(val) : val);
      fields.push(`${key} = $${params.length}`);
    }
  }
  if (fields.length === 0) return null;
  fields.push('updated_at = NOW()');
  const res = await query(`UPDATE kg_subjects SET ${fields.join(', ')} WHERE id = $1 RETURNING *`, params);
  return res.rows[0] || null;
}

async function kgDeleteSubject(id) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM kg_subjects WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

// Anchors
async function kgAddAnchor(anchor) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO kg_anchors (subject_id, anchor_type, platform, value, verified, confidence, source, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (subject_id, anchor_type, platform, value) DO UPDATE SET
       verified = EXCLUDED.verified,
       confidence = EXCLUDED.confidence, last_seen = NOW()
     RETURNING *`,
    [anchor.subject_id, anchor.anchor_type, anchor.platform || null,
     anchor.value, anchor.verified || false, anchor.confidence || 50,
     anchor.source || null, JSON.stringify(anchor.metadata || {})]
  );
  return res.rows[0] || null;
}

async function kgGetAnchors(subjectId) {
  if (!_pgConnected) return [];
  const res = await query(`SELECT * FROM kg_anchors WHERE subject_id = $1 ORDER BY anchor_type, created_at`, [subjectId]);
  return res.rows;
}

async function kgDeleteAnchor(id) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM kg_anchors WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

// Facts
async function kgAddFact(fact) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO kg_facts (subject_id, category, key, value, start_date, end_date, is_current, confidence, source, source_url, verified, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [fact.subject_id, fact.category, fact.key, fact.value,
     fact.start_date || null, fact.end_date || null, fact.is_current || false,
     fact.confidence || 50, fact.source || null, fact.source_url || null,
     fact.verified || false, JSON.stringify(fact.metadata || {})]
  );
  return res.rows[0] || null;
}

async function kgGetFacts(subjectId, category) {
  if (!_pgConnected) return [];
  let sql = `SELECT * FROM kg_facts WHERE subject_id = $1`;
  const params = [subjectId];
  if (category) { params.push(category); sql += ` AND category = $${params.length}`; }
  sql += ` ORDER BY is_current DESC, start_date DESC NULLS LAST, created_at DESC`;
  const res = await query(sql, params);
  return res.rows;
}

async function kgUpdateFact(id, updates) {
  if (!_pgConnected) return null;
  const fields = [];
  const params = [id];
  for (const [key, val] of Object.entries(updates)) {
    if (['category','key','value','start_date','end_date','is_current','confidence','source','source_url','verified','verified_by','metadata'].includes(key)) {
      params.push(key === 'metadata' ? JSON.stringify(val) : val);
      fields.push(`${key} = $${params.length}`);
    }
  }
  if (fields.length === 0) return null;
  if (updates.verified) fields.push('verified_at = NOW()');
  fields.push('updated_at = NOW()');
  const res = await query(`UPDATE kg_facts SET ${fields.join(', ')} WHERE id = $1 RETURNING *`, params);
  return res.rows[0] || null;
}

async function kgDeleteFact(id) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM kg_facts WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

// Timeline
async function kgAddEvent(event) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO kg_timeline (subject_id, event_type, title, description, event_date, event_end_date, location, source, source_url, confidence, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [event.subject_id, event.event_type, event.title, event.description || null,
     event.event_date || null, event.event_end_date || null, event.location || null,
     event.source || null, event.source_url || null, event.confidence || 50,
     JSON.stringify(event.metadata || {})]
  );
  return res.rows[0] || null;
}

async function kgGetTimeline(subjectId, eventType) {
  if (!_pgConnected) return [];
  let sql = `SELECT * FROM kg_timeline WHERE subject_id = $1`;
  const params = [subjectId];
  if (eventType) { params.push(eventType); sql += ` AND event_type = $${params.length}`; }
  sql += ` ORDER BY event_date DESC NULLS LAST, created_at DESC`;
  const res = await query(sql, params);
  return res.rows;
}

async function kgDeleteEvent(id) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM kg_timeline WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

// Connections
async function kgAddConnection(conn) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO kg_connections (source_id, target_id, relationship, description, start_date, end_date, is_current, confidence, source, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (source_id, target_id, relationship) DO UPDATE SET
       description = EXCLUDED.description, is_current = EXCLUDED.is_current,
       confidence = EXCLUDED.confidence, updated_at = NOW()
     RETURNING *`,
    [conn.source_id, conn.target_id, conn.relationship, conn.description || null,
     conn.start_date || null, conn.end_date || null, conn.is_current !== false,
     conn.confidence || 50, conn.source || null, JSON.stringify(conn.metadata || {})]
  );
  return res.rows[0] || null;
}

async function kgGetConnections(subjectId) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT c.*,
       s1.name AS source_name, s1.subject_type AS source_type,
       s2.name AS target_name, s2.subject_type AS target_type
     FROM kg_connections c
     JOIN kg_subjects s1 ON s1.id = c.source_id
     JOIN kg_subjects s2 ON s2.id = c.target_id
     WHERE c.source_id = $1 OR c.target_id = $1
     ORDER BY c.is_current DESC, c.confidence DESC`,
    [subjectId]
  );
  return res.rows;
}

async function kgDeleteConnection(id) {
  if (!_pgConnected) return false;
  const res = await query(`DELETE FROM kg_connections WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

// Observations
async function kgAddObservation(obs) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO kg_observations (subject_id, platform, observation_type, content, author_handle, url, engagement, sentiment, entities_extracted, raw_data, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [obs.subject_id, obs.platform, obs.observation_type, obs.content || null,
     obs.author_handle || null, obs.url || null,
     JSON.stringify(obs.engagement || {}), obs.sentiment || null,
     JSON.stringify(obs.entities_extracted || []),
     JSON.stringify(obs.raw_data || {}), obs.observed_at || new Date()]
  );
  return res.rows[0] || null;
}

async function kgGetObservations(subjectId, filters = {}) {
  if (!_pgConnected) return [];
  let sql = `SELECT * FROM kg_observations WHERE subject_id = $1`;
  const params = [subjectId];
  if (filters.platform) { params.push(filters.platform); sql += ` AND platform = $${params.length}`; }
  if (filters.observation_type) { params.push(filters.observation_type); sql += ` AND observation_type = $${params.length}`; }
  sql += ` ORDER BY observed_at DESC`;
  if (filters.limit) { params.push(filters.limit); sql += ` LIMIT $${params.length}`; }
  const res = await query(sql, params);
  return res.rows;
}

// Collections
async function kgCreateCollection(coll) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO kg_collections (subject_id, platform, collection_type, status, metadata)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [coll.subject_id, coll.platform, coll.collection_type || 'scrape',
     'running', JSON.stringify(coll.metadata || {})]
  );
  return res.rows[0] || null;
}

async function kgCompleteCollection(id, itemsCollected, error) {
  if (!_pgConnected) return null;
  const res = await query(
    `UPDATE kg_collections SET status = $2, items_collected = $3, error_message = $4, completed_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, error ? 'failed' : 'completed', itemsCollected || 0, error || null]
  );
  return res.rows[0] || null;
}

// Full dossier — get everything about a subject in one call
async function kgGetDossier(subjectId) {
  if (!_pgConnected) return null;
  const subject = await kgGetSubject(subjectId);
  if (!subject) return null;
  const [anchors, facts, timeline, connections, observations] = await Promise.all([
    kgGetAnchors(subjectId),
    kgGetFacts(subjectId),
    kgGetTimeline(subjectId),
    kgGetConnections(subjectId),
    kgGetObservations(subjectId, { limit: 50 }),
  ]);
  return { subject, anchors, facts, timeline, connections, observations };
}

// ── ANALYZE stage — KAIROS NLP enrichment + queries + diffs ──

async function kgGetUnenrichedObservations(limit = 10) {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT o.*, s.name as subject_name FROM kg_observations o
     JOIN kg_subjects s ON o.subject_id = s.id
     WHERE o.nlp_enriched = false AND o.observation_type IN ('profile_update', 'post', 'activity')
     ORDER BY o.collected_at ASC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function kgMarkObservationEnriched(obsId, nlpResult) {
  if (!_pgConnected) return null;
  const res = await query(
    `UPDATE kg_observations SET nlp_enriched = true, nlp_result = $2,
     sentiment = COALESCE($3, sentiment),
     entities_extracted = COALESCE($4, entities_extracted)
     WHERE id = $1 RETURNING *`,
    [obsId, JSON.stringify(nlpResult),
     nlpResult.sentiment || null,
     nlpResult.entities ? JSON.stringify(nlpResult.entities) : null]
  );
  return res.rows[0] || null;
}

async function kgGetSubjectsDueForCollection() {
  if (!_pgConnected) return [];
  const res = await query(
    `SELECT * FROM kg_subjects
     WHERE status = 'active'
     AND (last_collected_at IS NULL
          OR last_collected_at < NOW() - (collect_interval_hours || ' hours')::interval)
     ORDER BY last_collected_at ASC NULLS FIRST`
  );
  return res.rows;
}

async function kgMarkSubjectCollected(subjectId) {
  if (!_pgConnected) return null;
  const res = await query(
    `UPDATE kg_subjects SET last_collected_at = NOW() WHERE id = $1 RETURNING *`,
    [subjectId]
  );
  return res.rows[0] || null;
}

async function kgSearchObservations(searchText, filters = {}) {
  if (!_pgConnected) return [];
  let sql = `SELECT o.*, s.name as subject_name FROM kg_observations o
             JOIN kg_subjects s ON o.subject_id = s.id
             WHERE (o.content ILIKE $1 OR o.raw_data::text ILIKE $1)`;
  const params = [`%${searchText}%`];
  if (filters.platform) { params.push(filters.platform); sql += ` AND o.platform = $${params.length}`; }
  if (filters.subject_id) { params.push(filters.subject_id); sql += ` AND o.subject_id = $${params.length}`; }
  sql += ` ORDER BY o.observed_at DESC LIMIT 50`;
  const res = await query(sql, params);
  return res.rows;
}

async function kgGetObservationDiffs(subjectId, platform) {
  if (!_pgConnected) return [];
  // Get last 2 profile_update observations for the subject+platform and diff them
  const res = await query(
    `SELECT * FROM kg_observations
     WHERE subject_id = $1 AND platform = $2 AND observation_type = 'profile_update'
     ORDER BY observed_at DESC LIMIT 2`,
    [subjectId, platform]
  );
  if (res.rows.length < 2) return [];
  const [current, previous] = res.rows;
  const diffs = [];
  try {
    const cur = typeof current.raw_data === "string" ? JSON.parse(current.raw_data) : current.raw_data;
    const prev = typeof previous.raw_data === "string" ? JSON.parse(previous.raw_data) : previous.raw_data;
    const keys = new Set([...Object.keys(cur), ...Object.keys(prev)]);
    for (const k of keys) {
      if (JSON.stringify(cur[k]) !== JSON.stringify(prev[k])) {
        diffs.push({ field: k, previous: prev[k], current: cur[k], observed_at: current.observed_at });
      }
    }
  } catch {}
  return diffs;
}

// ── Identity Resolution Candidates ──

async function kgUpsertCandidate(c) {
  if (!_pgConnected) return null;
  const res = await query(
    `INSERT INTO kg_identity_candidates (subject_id, platform, username, profile_url, classification, match_weight, confidence, signals, collected_data, stage_reached)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (subject_id, platform, username) DO UPDATE SET
       classification = EXCLUDED.classification, match_weight = EXCLUDED.match_weight,
       confidence = EXCLUDED.confidence, signals = EXCLUDED.signals,
       collected_data = COALESCE(EXCLUDED.collected_data, kg_identity_candidates.collected_data),
       stage_reached = GREATEST(kg_identity_candidates.stage_reached, EXCLUDED.stage_reached),
       updated_at = NOW()
     RETURNING *`,
    [c.subject_id, c.platform, c.username, c.profile_url || null,
     c.classification || 'pending', c.match_weight || null, c.confidence || null,
     JSON.stringify(c.signals || []), c.collected_data ? JSON.stringify(c.collected_data) : null,
     c.stage_reached || 0]
  );
  return res.rows[0] || null;
}

async function kgGetCandidates(subjectId, filters = {}) {
  if (!_pgConnected) return [];
  let sql = `SELECT * FROM kg_identity_candidates WHERE subject_id = $1`;
  const params = [subjectId];
  if (filters.classification) { params.push(filters.classification); sql += ` AND classification = $${params.length}`; }
  if (filters.minStage !== undefined) { params.push(filters.minStage); sql += ` AND stage_reached >= $${params.length}`; }
  if (filters.maxStage !== undefined) { params.push(filters.maxStage); sql += ` AND stage_reached < $${params.length}`; }
  if (filters.platform) { params.push(filters.platform); sql += ` AND platform = $${params.length}`; }
  sql += ` ORDER BY match_weight DESC NULLS LAST`;
  const res = await query(sql, params);
  return res.rows;
}

async function kgReviewCandidate(candidateId, classification, reviewedBy) {
  if (!_pgConnected) return null;
  const res = await query(
    `UPDATE kg_identity_candidates SET classification = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [candidateId, classification, reviewedBy || 'human']
  );
  return res.rows[0] || null;
}

async function kgGetStats() {
  if (!_pgConnected) return {};
  const res = await query(
    `SELECT
       (SELECT count(*) FROM kg_subjects) as subjects,
       (SELECT count(*) FROM kg_observations) as observations,
       (SELECT count(*) FROM kg_observations WHERE nlp_enriched = true) as enriched,
       (SELECT count(*) FROM kg_observations WHERE nlp_enriched = false) as unenriched,
       (SELECT count(*) FROM kg_facts) as facts,
       (SELECT count(*) FROM kg_connections) as connections,
       (SELECT count(*) FROM kg_collections WHERE status = 'completed') as collections_completed`
  );
  return res.rows[0] || {};
}

// ── Infra-state helpers (D4/D5/D6) ──

// Issue a fresh per-device token. Returns the PLAINTEXT token once (caller must
// store it); only the sha256 hash is persisted. Rotating re-issues + clears revoke.
async function issueDeviceToken(deviceId, { scopes = ["heartbeat:write"], label = null } = {}) {
  if (!_pgConnected) return null;
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  await query(
    `INSERT INTO device_credentials (device_id, token_hash, scopes, label, created_at, revoked_at)
     VALUES ($1, $2, $3, $4, NOW(), NULL)
     ON CONFLICT (device_id) DO UPDATE SET
       token_hash = EXCLUDED.token_hash, scopes = EXCLUDED.scopes,
       label = COALESCE(EXCLUDED.label, device_credentials.label),
       created_at = NOW(), revoked_at = NULL, last_used_at = NULL`,
    [deviceId, tokenHash, scopes, label]
  );
  return { device_id: deviceId, token, scopes };
}

// Verify a presented token. Returns {device_id, scopes} if valid + has scope, else null.
// Constant-time hash compare; rejects revoked credentials.
async function verifyDeviceToken(token, requiredScope = "heartbeat:write") {
  if (!_pgConnected || !token || typeof token !== "string") return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const res = await query(
    `SELECT device_id, token_hash, scopes, revoked_at FROM device_credentials`
  );
  const want = Buffer.from(tokenHash, "hex");
  for (const row of res.rows) {
    if (row.revoked_at) continue;
    let stored;
    try { stored = Buffer.from(row.token_hash, "hex"); } catch { continue; }
    if (stored.length !== want.length) continue;
    if (crypto.timingSafeEqual(stored, want)) {
      if (requiredScope && !(row.scopes || []).includes(requiredScope)) return null;
      query(`UPDATE device_credentials SET last_used_at = NOW() WHERE device_id = $1`, [row.device_id]).catch(() => {});
      return { device_id: row.device_id, scopes: row.scopes || [] };
    }
  }
  return null;
}

async function revokeDeviceToken(deviceId) {
  if (!_pgConnected) return false;
  const res = await query(`UPDATE device_credentials SET revoked_at = NOW() WHERE device_id = $1 AND revoked_at IS NULL`, [deviceId]);
  return res.rowCount > 0;
}

async function listDeviceCredentials() {
  if (!_pgConnected) return [];
  const res = await query(`SELECT device_id, scopes, label, created_at, last_used_at, revoked_at FROM device_credentials ORDER BY device_id`);
  return res.rows;
}

// Upsert live device state. Logs a transition row when status changes (or on first
// sight, or when public_ip / wifi_ssid roams). Returns {previous, current, changed}.
async function upsertDeviceState(s) {
  if (!_pgConnected || !s || !s.device_id) return null;
  const prevRes = await query(`SELECT * FROM device_state WHERE device_id = $1`, [s.device_id]);
  const prev = prevRes.rows[0] || null;
  await query(
    `INSERT INTO device_state (device_id, status, source, wifi_ssid, lan_ip, public_ip, wg_ip, wg_handshake_age_s, battery_pct, meta, last_seen, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11, NOW()), NOW())
     ON CONFLICT (device_id) DO UPDATE SET
       status = EXCLUDED.status, source = EXCLUDED.source,
       wifi_ssid = COALESCE(EXCLUDED.wifi_ssid, device_state.wifi_ssid),
       lan_ip = COALESCE(EXCLUDED.lan_ip, device_state.lan_ip),
       public_ip = COALESCE(EXCLUDED.public_ip, device_state.public_ip),
       wg_ip = COALESCE(EXCLUDED.wg_ip, device_state.wg_ip),
       wg_handshake_age_s = EXCLUDED.wg_handshake_age_s,
       battery_pct = COALESCE(EXCLUDED.battery_pct, device_state.battery_pct),
       meta = COALESCE(EXCLUDED.meta, device_state.meta),
       last_seen = COALESCE(EXCLUDED.last_seen, NOW()), updated_at = NOW()`,
    [s.device_id, s.status || null, s.source || null, s.wifi_ssid || null, s.lan_ip || null,
     s.public_ip || null, s.wg_ip || null, s.wg_handshake_age_s ?? null, s.battery_pct ?? null,
     s.meta ? JSON.stringify(s.meta) : null, s.last_seen || null]
  );
  // Detect noteworthy transitions
  const changes = [];
  if (!prev) changes.push("first_seen");
  else {
    if (prev.status !== (s.status || null)) changes.push(`status:${prev.status}→${s.status}`);
    if (s.public_ip && prev.public_ip && prev.public_ip !== s.public_ip) changes.push(`public_ip:${prev.public_ip}→${s.public_ip}`);
    if (s.wifi_ssid && prev.wifi_ssid && prev.wifi_ssid !== s.wifi_ssid) changes.push(`wifi:${prev.wifi_ssid}→${s.wifi_ssid}`);
  }
  if (changes.length) {
    await query(
      `INSERT INTO device_state_log (device_id, from_status, to_status, change, details)
       VALUES ($1,$2,$3,$4,$5)`,
      [s.device_id, prev ? prev.status : null, s.status || null, changes.join(", "),
       JSON.stringify({ lan_ip: s.lan_ip, public_ip: s.public_ip, wifi_ssid: s.wifi_ssid, source: s.source })]
    );
  }
  return { previous: prev, changed: changes };
}

async function getDeviceStates() {
  if (!_pgConnected) return [];
  const res = await query(`SELECT * FROM device_state ORDER BY device_id`);
  return res.rows;
}

async function getDeviceHistory(deviceId, { since = null, limit = 100 } = {}) {
  if (!_pgConnected) return [];
  const params = [deviceId];
  let sql = `SELECT device_id, from_status, to_status, change, details, ts FROM device_state_log WHERE device_id = $1`;
  if (since) { params.push(since); sql += ` AND ts >= $${params.length}::timestamptz`; }
  params.push(limit);
  sql += ` ORDER BY ts DESC LIMIT $${params.length}`;
  const res = await query(sql, params);
  return res.rows;
}

module.exports = {
  init,
  isConnected,
  query,
  withBypass,
  // Infra-state (D4/D5/D6)
  issueDeviceToken,
  verifyDeviceToken,
  revokeDeviceToken,
  listDeviceCredentials,
  upsertDeviceState,
  getDeviceStates,
  getDeviceHistory,
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
  backfillDirectives,
  addDirectiveHistory,
  getDirectiveHistory,
  getDirectives,
  // Threads
  saveThread,
  getThreads,
  getThread,
  linkDirectiveToThread,
  unlinkDirectiveFromThread,
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
  bulkUpdateOsintFindings,
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
  // OSINT Investigations
  createOsintInvestigation,
  getOsintInvestigation,
  getOsintInvestigations,
  incrementInvestigationPivots,
  // OSINT Profile Pivot
  getOsintProfileByValue,
  updateOsintProfilePivot,
  // OSINT EKF State
  getOsintEkfState,
  upsertOsintEkfState,
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
  // OSINT Incidents (SOC)
  createOsintIncident,
  getOsintIncidents,
  updateOsintIncident,
  addIncidentTimelineEvent,
  getOsintIncidentStats,
  // Cédula Face DB
  upsertCedulaFace,
  getCedulaFace,
  getCedulaFaces,
  deleteCedulaFace,
  getAllCedulaEmbeddings,
  // Business Projects & Tasks
  getBusinessProjects,
  getBusinessProject,
  createBusinessProject,
  updateBusinessProject,
  archiveBusinessProject,
  createBusinessTask,
  updateBusinessTask,
  deleteBusinessTask,
  toggleBusinessTaskStatus,
  // Business Attachments
  createBusinessAttachment,
  getBusinessAttachments,
  getBusinessAttachment,
  deleteBusinessAttachment,
  updateBusinessAttachmentVerification,
  updateBusinessAttachmentReceiptData,
  // Business Expenses
  createBusinessExpense,
  getBusinessExpenses,
  getProjectExpenses,
  updateBusinessExpense,
  deleteBusinessExpense,
  getProjectFinancials,
  // Business Contacts
  createBusinessContact,
  getBusinessContacts,
  getBusinessContact,
  updateBusinessContact,
  deleteBusinessContact,
  // Business Shipments
  createBusinessShipment,
  getBusinessShipments,
  getBusinessShipment,
  updateBusinessShipment,
  deleteBusinessShipment,
  // Business Invoices
  createBusinessInvoice,
  getBusinessInvoices,
  getBusinessInvoice,
  updateBusinessInvoice,
  deleteBusinessInvoice,
  // Business Investments
  createBusinessInvestment,
  getBusinessInvestments,
  getBusinessInvestment,
  updateBusinessInvestment,
  deleteBusinessInvestment,
  // CEO Dashboard
  getDashboardMetrics,
  // Browser Audit & Sessions
  addBrowserAuditEntry,
  getBrowserAuditLog,
  upsertBrowserSession,
  getBrowserSession,
  // Identity Clusters
  upsertIdentityCluster,
  getIdentityClusters,
  // Knowledge Graph
  kgCreateSubject,
  kgGetSubjects,
  kgGetSubject,
  kgUpdateSubject,
  kgDeleteSubject,
  kgAddAnchor,
  kgGetAnchors,
  kgDeleteAnchor,
  kgAddFact,
  kgGetFacts,
  kgUpdateFact,
  kgDeleteFact,
  kgAddEvent,
  kgGetTimeline,
  kgDeleteEvent,
  kgAddConnection,
  kgGetConnections,
  kgDeleteConnection,
  kgAddObservation,
  kgGetObservations,
  kgCreateCollection,
  kgCompleteCollection,
  kgGetDossier,
  // KG ANALYZE
  kgGetUnenrichedObservations,
  kgMarkObservationEnriched,
  kgGetSubjectsDueForCollection,
  kgMarkSubjectCollected,
  kgSearchObservations,
  kgGetObservationDiffs,
  kgGetStats,
  // KG Identity Resolution
  kgUpsertCandidate,
  kgGetCandidates,
  kgReviewCandidate,
  // Migration
  migrateMemoriesFromRedis,
  migrateSummariesFromRedis,
  migrateDirectivesFromRedis,
  migrateApprovalsFromRedis,
  migrateStatusFromRedis,
  close: () => pool.end(),
};
