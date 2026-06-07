CREATE DATABASE IF NOT EXISTS ozzulab;
USE ozzulab;

CREATE TABLE IF NOT EXISTS flags (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  flag_text VARCHAR(255) NOT NULL,
  captured_at TIMESTAMP NULL
);

INSERT INTO flags (name, flag_text) VALUES
  ('flag3_db_read', 'OZZULAB{flag3-db-pivot-via-mysql-creds-from-config-php}'),
  ('flag3_alt',     'OZZULAB{flag3-alt-token-for-deduplication-check}');

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  role VARCHAR(32) NOT NULL,
  email VARCHAR(128),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users (username, role, email) VALUES
  ('admin',      'admin',    'admin@skyline.local'),
  ('webdev',     'engineer', 'webdev@skyline.local'),
  ('ops_lead',   'admin',    'ops@skyline.local');

-- web_user matches /var/www/html/config.php's $DB_USER + $DB_PASS
CREATE USER IF NOT EXISTS 'web_user'@'%' IDENTIFIED BY 'WebDB!Pass2026';
GRANT SELECT ON ozzulab.* TO 'web_user'@'%';

FLUSH PRIVILEGES;
