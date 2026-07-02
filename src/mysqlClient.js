/**
 * mysqlClient.js - Local-first data layer for Waterllama
 * Pure localStorage mode - works on any device, no backend needed
 * - All data persists in localStorage
 * - WhatsApp reminders → wa.me link (works client-side)
 * - SMS reminders → Not available in local mode (requires backend)
 * - Auto reminders → Client-side interval when app is open
 */

// Always use local mode - no backend needed
export const dbReady = false;

// ─── Helpers ──────────────────────────────────────────────────────────────
const STORAGE_KEY = 'aqualama-state';

function getStoredState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function saveStoredState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save to localStorage:', e);
  }
}

function getUserId() {
  let id = localStorage.getItem('aqualama-user-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('aqualama-user-id', id);
  }
  return id;
}

// ─── WATERLLAMA API (all localStorage) ────────────────────────────────────

/**
 * Load user state from localStorage
 * Returns defaults if no data exists
 */
export async function loadRemoteState() {
  const userId = getUserId();
  const stored = getStoredState();

  if (stored) {
    return {
      userId: stored.userId || userId,
      userName: stored.userName || 'User',
      phone: stored.phone || '',
      notificationMethod: stored.notificationMethod || 'WhatsApp',
      remindersOn: stored.remindersOn ?? true,
      reminderGap: stored.reminderGap ?? 2,
      theme: stored.theme || 'Lagoon',
      goal: stored.goal ?? 2500,
      logs: stored.logs || [],
      isPremium: stored.isPremium ?? false,
      premiumPlan: stored.premiumPlan || 'Free',
      premiumExpiry: stored.premiumExpiry || null,
    };
  }

  // First run defaults
  return {
    userId,
    userName: 'User',
    phone: '',
    notificationMethod: 'WhatsApp',
    remindersOn: true,
    reminderGap: 2,
    theme: 'Lagoon',
    goal: 2500,
    logs: [],
    isPremium: false,
    premiumPlan: 'Free',
    premiumExpiry: null,
  };
}

/**
 * Save user profile to localStorage
 */
export async function saveRemoteProfile(params) {
  saveStoredState(params);
}

/**
 * Add water entry - returns entry with UUID for localStorage sync
 */
export async function addRemoteWaterEntry({ userId, entry, hydrationCredit }) {
  // Return entry with UUID for local storage
  return { ...entry, id: entry.id || crypto.randomUUID() };
}

/**
 * Delete all water entries for user from localStorage
 */
export async function deleteRemoteWaterEntries(userId) {
  const stored = getStoredState();
  if (stored) {
    stored.logs = [];
    saveStoredState(stored);
  }
}

/**
 * Log reminder (local only - no backend)
 */
export async function logRemoteReminder({ userId, method, phone, message, status, providerSid, errorMessage }) {
  // Could log locally if needed
  console.log(`[Reminder Log] ${method} to ${phone}: ${status}`, { message, providerSid, errorMessage });
}

/**
 * Send reminder - WhatsApp works client-side, SMS requires backend (not available in local mode)
 */
export async function sendReminderViaEdge({ to, method, message, userId }) {
  try {
    if (method === 'WhatsApp') {
      // WhatsApp: always works client-side via wa.me
      const rawPhone = to.replace(/^\+/, '');
      const encodedMsg = encodeURIComponent(message);
      const deeplink = `https://wa.me/${rawPhone}?text=${encodedMsg}`;
      window.open(deeplink, '_blank', 'noopener,noreferrer');
      return { ok: true, sid: null };
    }

    // SMS: requires backend (not available in local mode)
    return { ok: false, error: 'SMS requires backend server. Use WhatsApp or run the local backend server.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── STUBS for features that used Supabase/MySQL ─────────────────────────

/**
 * Check database tables - returns not configured in local mode
 */
export async function checkDatabaseTables() {
  return {
    ok: false,
    notConfigured: true,
    tables: [
      { name: 'users', label: 'Users', exists: false },
      { name: 'water_entries', label: 'Water Entries', exists: false },
      { name: 'goals', label: 'Goals', exists: false },
      { name: 'subscriptions', label: 'Subscriptions', exists: false },
      { name: 'reminder_logs', label: 'Reminder Logs', exists: false },
    ],
    message: 'Running in local mode (localStorage only). No database required.'
  };
}

/**
 * Sync water entries to database - no-op in local mode
 */
export async function syncWaterEntriesToDB({ userId, logs, drinkFactors }) {
  return {
    synced: 0,
    skipped: logs.length,
    failed: 0,
    errors: [],
    message: 'Running in local mode. Data stays in localStorage.'
  };
}

/**
 * Send bulk SMS - requires backend
 */
export async function sendBulkSmsViaEdge({ recipients, message, senderName }) {
  return {
    ok: false,
    error: 'Bulk SMS requires backend server. Run: cd sms-backend && npm start'
  };
}