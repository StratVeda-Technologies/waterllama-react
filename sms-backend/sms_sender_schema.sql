-- ================================================
-- sms_sender database schema
-- Based on BlastSMS application data requirements
-- ================================================

USE sms_sender;

-- ── CONTACTS TABLE ────────────────────────────────
-- Stores all bulk SMS recipients / phone contacts
CREATE TABLE IF NOT EXISTS contacts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) NOT NULL UNIQUE COMMENT 'E.164 format e.g. +919876543210',
  `group` ENUM('General', 'VIP', 'Leads', 'Customers') NOT NULL DEFAULT 'General',
  status ENUM('active', 'inactive', 'blocked') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── TEMPLATES TABLE ───────────────────────────────
-- Reusable SMS message templates
CREATE TABLE IF NOT EXISTS templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  content TEXT NOT NULL COMMENT 'SMS text, may contain {name}, {code}, {date}, {amount} variables',
  category VARCHAR(50) DEFAULT 'General',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── CAMPAIGNS TABLE ───────────────────────────────
-- Each bulk send session is recorded as a campaign
CREATE TABLE IF NOT EXISTS campaigns (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL DEFAULT 'Untitled Campaign',
  sender_name VARCHAR(80) NOT NULL DEFAULT 'Aqualama',
  message TEXT NOT NULL COMMENT 'The message body sent to all recipients',
  provider VARCHAR(50) NOT NULL DEFAULT 'Twilio',
  total_recipients INT NOT NULL DEFAULT 0,
  total_sent INT NOT NULL DEFAULT 0,
  total_delivered INT NOT NULL DEFAULT 0,
  total_failed INT NOT NULL DEFAULT 0,
  credits_used INT NOT NULL DEFAULT 0,
  status ENUM('draft', 'sending', 'completed', 'failed') NOT NULL DEFAULT 'completed',
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── SEND LOGS TABLE ───────────────────────────────
-- Per-recipient result for each campaign send
CREATE TABLE IF NOT EXISTS send_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  campaign_id INT NOT NULL,
  contact_phone VARCHAR(20) NOT NULL,
  contact_name VARCHAR(100) DEFAULT NULL,
  status ENUM('sent', 'delivered', 'failed', 'pending') NOT NULL DEFAULT 'pending',
  provider_sid VARCHAR(100) DEFAULT NULL COMMENT 'Twilio SID or other provider message ID',
  error_message TEXT DEFAULT NULL,
  sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_send_logs_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── SENDER SETTINGS TABLE ─────────────────────────
-- Stores Twilio / provider configuration (non-secret metadata)
CREATE TABLE IF NOT EXISTS sender_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(80) NOT NULL UNIQUE,
  setting_value TEXT DEFAULT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── INDEXES ───────────────────────────────────────
CREATE INDEX idx_contacts_phone  ON contacts(phone);
CREATE INDEX idx_contacts_group  ON contacts(`group`);
CREATE INDEX idx_campaigns_sent  ON campaigns(sent_at);
CREATE INDEX idx_send_logs_camp  ON send_logs(campaign_id);
CREATE INDEX idx_send_logs_phone ON send_logs(contact_phone);

-- ── SEED DEFAULT CONTACTS ─────────────────────────
INSERT IGNORE INTO contacts (name, phone, `group`, status) VALUES
  ('Kailash',     '+919876543210', 'VIP',      'active'),
  ('John Doe',    '+11234567890',  'Leads',    'active'),
  ('Alice Smith', '+11987654321',  'VIP',      'active'),
  ('Bob Johnson', '+11122334455',  'General',  'active');

-- ── SEED DEFAULT TEMPLATES ────────────────────────
INSERT IGNORE INTO templates (name, content, category) VALUES
  ('Standard Reminder',   'Hi {name}, hope you are staying hydrated today! Log your water intake in Aqualama.', 'Health'),
  ('Premium Offer',       'Hey {name}! Get 50% off Aqualama Premium this weekend only. Go to the Premium tab now!', 'Promotional'),
  ('Goal Motivation',     'Stay strong {name}! You are close to hitting your daily water target today. Keep tracking!', 'Engagement');

-- ── SEED DEFAULT SETTINGS ─────────────────────────
INSERT IGNORE INTO sender_settings (setting_key, setting_value) VALUES
  ('provider',                'Twilio'),
  ('sender_name',             'Aqualama'),
  ('default_credits',         '2500'),
  ('twilio_from_configured',  'false');
