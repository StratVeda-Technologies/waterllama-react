-- Supabase Migration: Initial Schema
-- PostgreSQL equivalent of MySQL tables from sms-backend/server.js

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- WATERLLAMA DATABASE TABLES
-- ============================================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL DEFAULT 'User',
    phone VARCHAR(20),
    notification_method VARCHAR(10) NOT NULL DEFAULT 'WhatsApp' CHECK (notification_method IN ('WhatsApp', 'SMS')),
    reminders_on BOOLEAN NOT NULL DEFAULT TRUE,
    reminder_gap_hours INTEGER NOT NULL DEFAULT 2,
    theme VARCHAR(10) NOT NULL DEFAULT 'Lagoon' CHECK (theme IN ('Lagoon', 'Mint', 'Coral')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Goals table
CREATE TABLE IF NOT EXISTS goals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    daily_goal_ml INTEGER NOT NULL DEFAULT 2500,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Water entries table
CREATE TABLE IF NOT EXISTS water_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_date DATE NOT NULL,
    entry_time VARCHAR(10) NOT NULL,
    drink_type VARCHAR(10) NOT NULL DEFAULT 'Water' CHECK (drink_type IN ('Water', 'Tea', 'Coffee', 'Juice')),
    amount_ml INTEGER NOT NULL,
    hydration_credit_ml INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan VARCHAR(10) NOT NULL DEFAULT 'Free' CHECK (plan IN ('Free', 'Monthly', 'Yearly')),
    status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired')),
    price_inr INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

-- Reminder logs table
CREATE TABLE IF NOT EXISTS reminder_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method VARCHAR(10) NOT NULL CHECK (method IN ('WhatsApp', 'SMS')),
    phone VARCHAR(20) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(10) NOT NULL CHECK (status IN ('sent', 'failed')),
    provider_sid VARCHAR(50),
    error_message TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- SMS_SENDER DATABASE TABLES
-- ============================================================================

-- Contacts table
CREATE TABLE IF NOT EXISTS contacts (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL UNIQUE,
    "group" VARCHAR(50) DEFAULT 'General',
    status VARCHAR(10) DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Campaigns table
CREATE TABLE IF NOT EXISTS campaigns (
    id BIGSERIAL PRIMARY KEY,
    campaign_name VARCHAR(200),
    sender_name VARCHAR(100),
    message TEXT NOT NULL,
    total_recipients INTEGER DEFAULT 0,
    total_sent INTEGER DEFAULT 0,
    total_delivered INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Campaign results table
CREATE TABLE IF NOT EXISTS campaign_results (
    id BIGSERIAL PRIMARY KEY,
    campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    phone VARCHAR(20) NOT NULL,
    success BOOLEAN DEFAULT FALSE,
    provider_sid VARCHAR(100),
    error_message TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Templates table
CREATE TABLE IF NOT EXISTS templates (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Water entries indexes
CREATE INDEX IF NOT EXISTS idx_water_entries_user_date ON water_entries(user_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_water_entries_user_created ON water_entries(user_id, created_at DESC);

-- Reminder logs indexes
CREATE INDEX IF NOT EXISTS idx_reminder_logs_user_sent ON reminder_logs(user_id, sent_at DESC);

-- Campaigns indexes
CREATE INDEX IF NOT EXISTS idx_campaigns_created ON campaigns(created_at DESC);

-- Campaign results indexes
CREATE INDEX IF NOT EXISTS idx_campaign_results_campaign ON campaign_results(campaign_id);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE water_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;

-- Users: users can only access their own data
CREATE POLICY "Users can view own profile" ON users
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON users
    FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile" ON users
    FOR INSERT WITH CHECK (auth.uid() = id);

-- Goals: users can only access their own goals
CREATE POLICY "Users can view own goals" ON goals
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own goals" ON goals
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own goals" ON goals
    FOR UPDATE USING (auth.uid() = user_id);

-- Water entries: users can only access their own entries
CREATE POLICY "Users can view own water entries" ON water_entries
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own water entries" ON water_entries
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own water entries" ON water_entries
    FOR DELETE USING (auth.uid() = user_id);

-- Subscriptions: users can only access their own
CREATE POLICY "Users can view own subscriptions" ON subscriptions
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own subscriptions" ON subscriptions
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own subscriptions" ON subscriptions
    FOR UPDATE USING (auth.uid() = user_id);

-- Reminder logs: users can only access their own
CREATE POLICY "Users can view own reminder logs" ON reminder_logs
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own reminder logs" ON reminder_logs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Contacts: users can only access their own (or public if needed)
-- For now, allow all authenticated users to manage contacts
CREATE POLICY "Authenticated users can view contacts" ON contacts
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can insert contacts" ON contacts
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update contacts" ON contacts
    FOR UPDATE USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can delete contacts" ON contacts
    FOR DELETE USING (auth.role() = 'authenticated');

-- Campaigns: authenticated users
CREATE POLICY "Authenticated users can view campaigns" ON campaigns
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can insert campaigns" ON campaigns
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update campaigns" ON campaigns
    FOR UPDATE USING (auth.role() = 'authenticated');

-- Campaign results: authenticated users
CREATE POLICY "Authenticated users can view campaign results" ON campaign_results
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can insert campaign results" ON campaign_results
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Templates: authenticated users
CREATE POLICY "Authenticated users can view templates" ON templates
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can insert templates" ON templates
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update templates" ON templates
    FOR UPDATE USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can delete templates" ON templates
    FOR DELETE USING (auth.role() = 'authenticated');

-- ============================================================================
-- UPDATED_AT TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_goals_updated_at BEFORE UPDATE ON goals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();