-- Fleet Device Management Schema
-- Run: psql -h 127.0.0.1 -U ozzu -d ozzu -f schema-fleet.sql

-- Proxy endpoints (residential IPs from friends/home)
CREATE TABLE IF NOT EXISTS fleet_proxies (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(50) UNIQUE NOT NULL,     -- e.g. "home", "friend-carlos", "friend-pipe"
  type            VARCHAR(20) NOT NULL DEFAULT 'vpn',  -- vpn, socks5, http
  vpn_peer        VARCHAR(50),                     -- OpenVPN CCD client name
  exit_ip         INET,                            -- resolved residential IP
  country         VARCHAR(5) DEFAULT 'CO',
  city            VARCHAR(50),
  owner           VARCHAR(100),                    -- who owns this connection
  status          VARCHAR(20) DEFAULT 'offline',   -- online, offline, error
  last_checked    TIMESTAMPTZ,
  last_ip_check   INET,                            -- last verified exit IP
  config          JSONB DEFAULT '{}',              -- extra config (port, auth, etc)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Fleet devices (Redroid instances)
CREATE TABLE IF NOT EXISTS fleet_devices (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(50) UNIQUE NOT NULL,     -- e.g. "redroid01"
  container_name  VARCHAR(50) NOT NULL,
  adb_port        INTEGER NOT NULL,
  proxy_id        INTEGER REFERENCES fleet_proxies(id),
  fingerprint     JSONB DEFAULT '{}',              -- model, manufacturer, serial, dpi
  status          VARCHAR(20) DEFAULT 'stopped',   -- running, stopped, booting, error
  exit_ip         INET,                            -- current verified exit IP
  max_accounts    INTEGER DEFAULT 5,
  last_health     TIMESTAMPTZ,
  health_ok       BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Fleet accounts (social media accounts assigned to devices)
CREATE TABLE IF NOT EXISTS fleet_accounts (
  id              SERIAL PRIMARY KEY,
  device_id       INTEGER REFERENCES fleet_devices(id),
  platform        VARCHAR(30) NOT NULL,            -- facebook, instagram, tiktok, x, youtube
  username        VARCHAR(100),
  email           VARCHAR(200),
  phone           VARCHAR(30),
  display_name    VARCHAR(200),
  password_ref    VARCHAR(100),                    -- reference key in vault, NOT plaintext
  status          VARCHAR(20) DEFAULT 'pending',   -- pending, active, locked, suspended, warming
  login_verified  BOOLEAN DEFAULT false,
  owner           VARCHAR(100),                    -- real person who owns this account
  warmup_start    TIMESTAMPTZ,
  last_active     TIMESTAMPTZ,
  notes           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fleet_accounts_device ON fleet_accounts(device_id);
CREATE INDEX IF NOT EXISTS idx_fleet_accounts_platform ON fleet_accounts(platform);
CREATE INDEX IF NOT EXISTS idx_fleet_accounts_owner ON fleet_accounts(owner);

-- Fleet health log (time-series)
CREATE TABLE IF NOT EXISTS fleet_health_log (
  id              SERIAL PRIMARY KEY,
  device_id       INTEGER REFERENCES fleet_devices(id),
  proxy_id        INTEGER REFERENCES fleet_proxies(id),
  check_type      VARCHAR(20) NOT NULL,            -- device, proxy, account
  status          VARCHAR(20) NOT NULL,            -- ok, error, timeout
  exit_ip         INET,
  details         TEXT,
  checked_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fleet_health_device ON fleet_health_log(device_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_fleet_health_checked ON fleet_health_log(checked_at DESC);
