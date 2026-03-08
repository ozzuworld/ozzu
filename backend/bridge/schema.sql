-- Ozzu PostgreSQL Schema
-- Auto-run on first start via Docker /docker-entrypoint-initdb.d/

-- Persona memories with full-text search
CREATE TABLE memories (
  id            SERIAL PRIMARY KEY,
  persona       VARCHAR(20) NOT NULL,
  fact          TEXT NOT NULL,
  category      VARCHAR(20) DEFAULT 'general',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  source        VARCHAR(50),
  confidence    REAL DEFAULT 1.0,
  related_to    INTEGER REFERENCES memories(id),
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', fact)) STORED
);
CREATE INDEX idx_memories_persona ON memories(persona);
CREATE INDEX idx_memories_category ON memories(persona, category);
CREATE INDEX idx_memories_search ON memories USING GIN(search_vector);
CREATE INDEX idx_memories_created ON memories(created_at DESC);

-- Conversation sessions with summaries
CREATE TABLE conversations (
  id            SERIAL PRIMARY KEY,
  persona       VARCHAR(20) NOT NULL,
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,
  turn_count    INTEGER DEFAULT 0,
  summary       TEXT,
  topics        TEXT[],
  devices       TEXT[],
  metadata      JSONB DEFAULT '{}'
);
CREATE INDEX idx_conversations_persona ON conversations(persona, started_at DESC);
CREATE INDEX idx_conversations_persona_summary ON conversations(persona, started_at DESC) WHERE summary IS NOT NULL;

-- Full conversation transcript (turns)
CREATE TABLE conversation_turns (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  role            VARCHAR(20) NOT NULL,
  content         TEXT NOT NULL,
  turn_index      INTEGER NOT NULL,
  tool_calls      JSONB,
  content_type    VARCHAR(20) DEFAULT 'text',
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_turns_conversation ON conversation_turns(conversation_id, turn_index);
CREATE INDEX idx_turns_content_type ON conversation_turns(content_type);

-- Directives with full audit trail
CREATE TABLE directives (
  id              VARCHAR(50) PRIMARY KEY,
  type            VARCHAR(20) NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  context         TEXT,  -- King Kazuma's original words and intent, passed through to worker agents
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  plan            TEXT,
  approval_id     VARCHAR(50),
  epic_id         VARCHAR(50) REFERENCES directives(id),
  phase_order     INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Directive status change history
CREATE TABLE directive_history (
  id              SERIAL PRIMARY KEY,
  directive_id    VARCHAR(50) REFERENCES directives(id),
  old_status      VARCHAR(20),
  new_status      VARCHAR(20) NOT NULL,
  changed_at      TIMESTAMPTZ DEFAULT NOW(),
  changed_by      VARCHAR(20),
  notes           TEXT
);

-- Approvals with full history
CREATE TABLE approvals (
  id              VARCHAR(50) PRIMARY KEY,
  tool            VARCHAR(50) NOT NULL,
  description     TEXT NOT NULL,
  risk            VARCHAR(20) DEFAULT 'low',
  resolved        BOOLEAN DEFAULT FALSE,
  approved        BOOLEAN,
  auto_approved   BOOLEAN DEFAULT FALSE,
  reason          TEXT,
  directive_id    VARCHAR(50) REFERENCES directives(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

-- Device registry (persistent, survives restarts)
CREATE TABLE devices (
  id              SERIAL PRIMARY KEY,
  device_id       VARCHAR(50) UNIQUE NOT NULL,
  device_type     VARCHAR(20),
  model           VARCHAR(100),
  ip_address      INET,
  adb_port        INTEGER,
  arch            VARCHAR(20),
  last_seen       TIMESTAMPTZ DEFAULT NOW(),
  metadata        JSONB DEFAULT '{}'
);

-- Entity state snapshots (time-series for analytics)
CREATE TABLE entity_snapshots (
  id              SERIAL PRIMARY KEY,
  entity_id       VARCHAR(100) NOT NULL,
  state           VARCHAR(50),
  attributes      JSONB,
  captured_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_entity_snapshots_entity ON entity_snapshots(entity_id, captured_at DESC);
CREATE INDEX idx_entity_snapshots_captured ON entity_snapshots(captured_at DESC);

-- Status log (replaces Redis/JSON status entries)
CREATE TABLE status_log (
  id              SERIAL PRIMARY KEY,
  event           VARCHAR(50) NOT NULL,
  tool            VARCHAR(50),
  message         TEXT,
  persona         VARCHAR(20),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_status_log_created ON status_log(created_at DESC);

-- Deployment history
CREATE TABLE deployments (
  id              SERIAL PRIMARY KEY,
  type            VARCHAR(20) NOT NULL,
  version         VARCHAR(50),
  target_devices  TEXT[],
  status          VARCHAR(20) DEFAULT 'started',
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  notes           TEXT
);

-- Usage metrics (daily aggregates for dashboard)
CREATE TABLE usage_metrics (
  id              SERIAL PRIMARY KEY,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  metric_name     TEXT NOT NULL,
  metric_value    NUMERIC NOT NULL DEFAULT 0,
  metadata        JSONB DEFAULT '{}',
  UNIQUE(date, metric_name)
);
CREATE INDEX idx_usage_metrics_date ON usage_metrics(date DESC);

-- Personal file storage (Dropbox-style)
CREATE TABLE files (
  id              SERIAL PRIMARY KEY,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  source          TEXT DEFAULT 'upload',   -- 'glasses', 'upload', 'intel', 'bridge'
  category        TEXT DEFAULT 'general',  -- 'photos', 'documents', 'intel', 'temp'
  storage_path    TEXT NOT NULL,           -- path on disk
  thumbnail_path  TEXT,                    -- optional thumbnail
  metadata        JSONB DEFAULT '{}',
  is_temp         BOOLEAN DEFAULT false,   -- temp files auto-expire
  expires_at      TIMESTAMPTZ,             -- null = permanent
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_files_category ON files(category);
CREATE INDEX idx_files_source ON files(source);
CREATE INDEX idx_files_created ON files(created_at DESC);
CREATE INDEX idx_files_temp ON files(is_temp) WHERE is_temp = true;
