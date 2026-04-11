-- Influence Platform — Social media account management
-- Directive: dir_1775926142812

-- Managed social media accounts (real people, consent-based)
CREATE TABLE IF NOT EXISTS influence_accounts (
  id                  SERIAL PRIMARY KEY,
  owner_name          VARCHAR(100) NOT NULL,
  owner_email         VARCHAR(255),
  platform            VARCHAR(20) NOT NULL,
  username            VARCHAR(100) NOT NULL,
  display_name        VARCHAR(100),
  encrypted_password  TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_influence_accounts_platform ON influence_accounts(platform);
CREATE INDEX IF NOT EXISTS idx_influence_accounts_status ON influence_accounts(status);
CREATE INDEX IF NOT EXISTS idx_influence_posts_status ON influence_posts(status);
CREATE INDEX IF NOT EXISTS idx_influence_posts_scheduled ON influence_posts(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_influence_post_accounts_post ON influence_post_accounts(post_id);
