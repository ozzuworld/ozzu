-- Influence Platform — Social media account management
-- Directive: dir_1775926142812

-- Members: one row per real person (friend/family), one Dolphin profile each
CREATE TABLE IF NOT EXISTS influence_members (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(100) NOT NULL,
  google_email        VARCHAR(255),
  encrypted_google_pw TEXT,
  dolphin_profile_id  VARCHAR(100),
  proxy_port          INTEGER,
  status              VARCHAR(20) DEFAULT 'active',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(google_email)
);

-- Platform accounts linked to members (SSO or direct login)
CREATE TABLE IF NOT EXISTS influence_accounts (
  id                  SERIAL PRIMARY KEY,
  member_id           INTEGER REFERENCES influence_members(id) ON DELETE CASCADE,
  owner_name          VARCHAR(100) NOT NULL,
  owner_email         VARCHAR(255),
  platform            VARCHAR(20) NOT NULL,
  username            VARCHAR(100) NOT NULL,
  display_name        VARCHAR(100),
  auth_type           VARCHAR(20) DEFAULT 'google_sso',
  google_email        VARCHAR(255),
  encrypted_password  TEXT,
  dolphin_profile_id  VARCHAR(100),
  proxy_port          INTEGER,
  status              VARCHAR(20) DEFAULT 'active',
  warming_day         INTEGER DEFAULT 0,
  last_active         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(platform, username)
);

-- Campaigns group posts together
CREATE TABLE IF NOT EXISTS influence_campaigns (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(200) NOT NULL,
  description     TEXT,
  status          VARCHAR(20) DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled/posted content
CREATE TABLE IF NOT EXISTS influence_posts (
  id              SERIAL PRIMARY KEY,
  text_content    TEXT,
  media_urls      TEXT[],
  hashtags        TEXT[],
  campaign_id     INTEGER REFERENCES influence_campaigns(id) ON DELETE SET NULL,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  status          VARCHAR(20) DEFAULT 'scheduled',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Which accounts a post targets
CREATE TABLE IF NOT EXISTS influence_post_accounts (
  id              SERIAL PRIMARY KEY,
  post_id         INTEGER NOT NULL REFERENCES influence_posts(id) ON DELETE CASCADE,
  account_id      INTEGER NOT NULL REFERENCES influence_accounts(id) ON DELETE CASCADE,
  status          VARCHAR(20) DEFAULT 'pending',
  posted_at       TIMESTAMPTZ,
  error_message   TEXT,
  UNIQUE(post_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_influence_members_status ON influence_members(status);
CREATE INDEX IF NOT EXISTS idx_influence_accounts_platform ON influence_accounts(platform);
CREATE INDEX IF NOT EXISTS idx_influence_accounts_status ON influence_accounts(status);
CREATE INDEX IF NOT EXISTS idx_influence_accounts_member ON influence_accounts(member_id);
CREATE INDEX IF NOT EXISTS idx_influence_posts_status ON influence_posts(status);
CREATE INDEX IF NOT EXISTS idx_influence_posts_scheduled ON influence_posts(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_influence_post_accounts_post ON influence_post_accounts(post_id);
