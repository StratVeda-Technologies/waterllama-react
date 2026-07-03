/**
 * mysqlClient.js - Local-first data layer for Waterllama
 * - All data persists in localStorage (works offline, any device)
 * - WhatsApp reminders → wa.me link (works client-side)
 * - SMS/WhatsApp via Supabase Edge Functions (when configured)
 * - Auto reminders → Client-side interval when app is open
 */

// Always use local mode for data storage
export const dbReady = false;

// Supabase configuration (set these in .env.local or localStorage for production)
// Supports both VITE_SUPABASE_ANON_KEY (legacy) and VITE_SUPABASE_PUBLISHABLE_KEY (new format)
let SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || localStorage.getItem('supabase_url') || '';
let SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || localStorage.getItem('supabase_anon_key') || localStorage.getItem('supabase_publishable_key') || '';

export function setSupabaseConfig(url, key) {
  SUPABASE_URL = url;
  SUPABASE_ANON_KEY = key;
  if (url) localStorage.setItem('supabase_url', url);
  if (key) localStorage.setItem('supabase_anon_key', key);
}

export function getSupabaseConfig() {
  return { url: SUPABASE_URL, key: SUPABASE_ANON_KEY };
}

export function isSupabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

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
 * Log reminder - local console + Supabase Edge Function when configured
 */
export async function logRemoteReminder({ userId, method, phone, message, status, providerSid, errorMessage }) {
  // Always log locally
  console.log(`[Reminder Log] ${method} to ${phone}: ${status}`, { message, providerSid, errorMessage });

  // Try Supabase Edge Function if configured
  if (isSupabaseConfigured()) {
    try {
      await callSupabaseFunction('log-reminder', { userId, method, phone, message, status, providerSid, errorMessage });
    } catch (err) {
      console.warn('Supabase log-reminder failed:', err.message);
    }
  }
}

/**
 * Send reminder - WhatsApp works client-side, SMS via Supabase Edge Functions (when configured)
 */
export async function sendReminderViaEdge({ to, method, message, userId }) {
  try {
    if (method === 'WhatsApp') {
      // Try Supabase Edge Function first (for actual WhatsApp via Twilio)
      if (isSupabaseConfigured()) {
        const result = await callSupabaseFunction('send-whatsapp', { to, message, userId });
        if (result.ok) return { ok: true, sid: result.sid };
        // Fall back to wa.me if function fails
        console.warn('Supabase WhatsApp failed, falling back to wa.me:', result.error);
      }

      // Fallback: wa.me link (always works client-side)
      const rawPhone = to.replace(/^\+/, '');
      const encodedMsg = encodeURIComponent(message);
      const deeplink = `https://wa.me/${rawPhone}?text=${encodedMsg}`;
      window.open(deeplink, '_blank', 'noopener,noreferrer');
      return { ok: true, sid: null };
    }

    // SMS: try Supabase Edge Function
    if (isSupabaseConfigured()) {
      const result = await callSupabaseFunction('send-sms', { to, message });
      return result;
    }

    // Not configured - fallback message
    return { ok: false, error: 'SMS requires Supabase configuration. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local or configure in Settings.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Call a Supabase Edge Function
 */
async function callSupabaseFunction(functionName, payload) {
  if (!isSupabaseConfigured()) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      // Handle trial/unverified limits gracefully
      if (data.simulated) {
        return { ok: true, sid: data.sid, simulated: true };
      }
      return { ok: false, error: data.error || `HTTP ${response.status}` };
    }

    return { ok: true, sid: data.sid, simulated: data.simulated };
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
 * Send bulk SMS - via Supabase Edge Function when configured
 */
export async function sendBulkSmsViaEdge({ recipients, message, senderName }) {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      error: 'Bulk SMS requires Supabase configuration. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local'
    };
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/send-bulk-sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ recipients, message, senderName }),
    });

    const data = await response.json();

    if (!response.ok) {
      // Handle trial limits
      if (data.results?.some(r => r.simulated)) {
        return { ok: true, results: data.results };
      }
      return { ok: false, error: data.error || `HTTP ${response.status}` };
    }

    return { ok: true, results: data.results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send bulk WhatsApp via wa.me links (client-side, free, no backend needed)
 * Opens individual WhatsApp chats with pre-filled messages
 * Returns wa.me links for manual opening if popups blocked
 */
export async function sendBulkWhatsAppViaEdge({ recipients, message, senderName }) {
  // This works entirely client-side via wa.me links - no backend required
  // Returns simulated results for UI consistency + links for manual access

  const waLinks = recipients.map((phone, index) => {
    // Normalize phone: remove + and non-digits
    const cleanPhone = phone.replace(/[^\d]/g, '');
    const encodedMsg = encodeURIComponent(message);
    const waLink = `https://wa.me/${cleanPhone}?text=${encodedMsg}`;
    return { phone, waLink, index };
  });

  // Open all links simultaneously (modern browsers allow multiple tabs from user action)
  waLinks.forEach(({ waLink }) => {
    window.open(waLink, '_blank', 'noopener,noreferrer');
  });

  // Also store links globally for manual access if popups blocked
  if (typeof window !== 'undefined') {
    window.__waMeLinks = waLinks.map(l => l.waLink);
    window.__waMeContacts = waLinks.map(l => l.phone);
  }

  const results = waLinks.map(({ phone, index }) => ({
    phone,
    success: true,
    sid: `wa.me_${Date.now()}_${index}`,
    provider: 'wa.me (client-side)',
    simulated: true,
  }));

  return { ok: true, results, waLinks: waLinks.map(l => l.waLink) };
}