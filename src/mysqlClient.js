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

/**
 * Normalize phone number to E.164 format
 * Handles common formats and adds country code for Indian numbers
 */
export function normalizePhoneNumber(phone) {
  if (!phone) return '';

  // Remove all non-digits except +
  let cleaned = String(phone).replace(/[^\d+]/g, '');

  // If already has + prefix, return as-is (assuming valid E.164)
  if (cleaned.startsWith('+')) {
    return cleaned;
  }

  // If starts with 00, replace with +
  if (cleaned.startsWith('00')) {
    return '+' + cleaned.substring(2);
  }

  // If starts with country code but no +, add it
  // Common patterns: 91xxxxxxxxxx (India), 1xxxxxxxxxx (US/Canada)
  if (cleaned.length >= 10) {
    // India numbers: 10 digits starting with 6-9
    if (cleaned.length === 10 && /^[6-9]\d{9}$/.test(cleaned)) {
      return '+91' + cleaned;
    }
    // US/Canada: 10 digits or 11 digits starting with 1
    if (cleaned.length === 10) {
      return '+1' + cleaned; // Default to US
    }
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
      return '+' + cleaned;
    }
    // If 12+ digits, assume it has country code
    if (cleaned.length >= 11) {
      return '+' + cleaned;
    }
  }

  // Default: assume it's a local number, prepend +
  return '+' + cleaned;
}

/**
 * Validate phone number is in E.164 format
 */
export function isValidE164Phone(phone) {
  return /^\+\d{10,15}$/.test(normalizePhoneNumber(phone));
}

/**
 * Get phone number display format (e.g., +91 98765 43210)
 */
export function formatPhoneForDisplay(phone) {
  const normalized = normalizePhoneNumber(phone);
  // Format: +91 98765 43210
  if (normalized.startsWith('+91') && normalized.length === 13) {
    return normalized.replace(/(\+91)(\d{5})(\d{5})/, '$1 $2 $3');
  }
  if (normalized.startsWith('+1') && normalized.length === 12) {
    return normalized.replace(/(\+1)(\d{3})(\d{3})(\d{4})/, '$1 ($2) $3-$4');
  }
  return normalized;
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
const BACKEND_URL = import.meta.env?.VITE_API_URL || 'http://localhost:5000';

export async function sendReminderViaEdge({ to, method, message, userId }) {
  // Normalize phone number to E.164 format before sending
  const normalizedTo = normalizePhoneNumber(to);

  try {
    if (method === 'WhatsApp') {
      // Try Supabase Edge Function first (for actual WhatsApp via Twilio)
      if (isSupabaseConfigured()) {
        const result = await callSupabaseFunction('send-reminder', { to: normalizedTo, message, method: 'WhatsApp', userId });
        if (result.ok) return { ok: true, sid: result.sid };
        // Fall back to wa.me if edge function fails
        console.warn('Supabase WhatsApp failed, falling back to wa.me:', result.error);
      }

      // Fallback: wa.me link (always works client-side)
      const rawPhone = normalizedTo.replace(/^\+/, '');
      const encodedMsg = encodeURIComponent(message);
      const deeplink = `https://wa.me/${rawPhone}?text=${encodedMsg}`;
      window.open(deeplink, '_blank', 'noopener,noreferrer');
      return { ok: true, sid: null };
    }

    // SMS: Try Supabase Edge Function first
    if (isSupabaseConfigured()) {
      try {
        const result = await callSupabaseFunction('send-reminder', { to: normalizedTo, message, method: 'SMS', userId });
        if (result.ok) return result;
        console.warn('Supabase SMS reminder failed, trying local backend fallback:', result.error);
      } catch (err) {
        console.warn('Supabase SMS reminder failed, trying local backend fallback:', err.message);
      }
    }

    // Local Node.js server fallback (port 5000)
    try {
      const response = await fetch(`${BACKEND_URL}/send-bulk-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: [normalizedTo], message, senderName: 'Aqualama' }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      const singleResult = data[0] || data.results?.[0];
      if (singleResult && !singleResult.success) {
        throw new Error(singleResult.error || 'SMS failed');
      }
      return { ok: true, sid: singleResult?.sid || null };
    } catch (err) {
      throw new Error(`SMS failed: ${err.message}. Make sure the local backend server (port 5000) is running and configured.`);
    }
  } catch (err) {
    throw err; // Re-throw so sendReminder() catches it and shows error chip in UI
  }
}

/**
 * Call a Supabase Edge Function.
 * Returns the full response body so Twilio errors (wrong number, trial limits,
 * bad credentials) are surfaced in the UI instead of silently showing success.
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
      // HTTP-level failure (e.g. 401, 500 from the edge function itself)
      return { ok: false, error: data.error || `HTTP ${response.status}: ${response.statusText}` };
    }

    // Return the full response body so Twilio errors are not swallowed.
    // Edge functions always return 200 with { ok: true/false } — check that field.
    if (data.ok === false) {
      return { ok: false, error: data.error || 'SMS send failed', ...data };
    }

    return { ok: true, ...data };
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
 * Send bulk SMS — via Supabase Edge Function (send-bulk-sms) → Twilio.
 * Returns { ok, results } where each result has: { phone, success, delivered, sid, status, error, note, trialWarning }
 * 'success' means Twilio accepted the message for delivery (queued/sent).
 * 'delivered' is true ONLY when Twilio confirms handset delivery (async, rarely immediate).
 */
export async function sendBulkSmsViaEdge({ recipients, message, senderName }) {
  // Normalize all recipient phone numbers to E.164 format
  const normalizedRecipients = recipients.map(normalizePhoneNumber);

  if (isSupabaseConfigured()) {
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/send-bulk-sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ recipients: normalizedRecipients, message, senderName }),
      });

      const data = await response.json();

      if (response.ok) {
        // data.results is an array — each entry has success/error per recipient
        const results = data.results || [];
        const allFailed = results.length > 0 && results.every(r => !r.success);
        const topError = allFailed
          ? (results[0]?.error || 'All messages failed. Check Twilio credentials and recipient numbers.')
          : undefined;

        return { ok: !allFailed, results, error: topError };
      }
      console.warn('Supabase bulk SMS failed, trying local backend fallback:', response.status);
    } catch (err) {
      console.warn('Supabase bulk SMS failed, trying local backend fallback:', err.message);
    }
  }

  // Local Node.js server fallback (port 5000)
  try {
    const response = await fetch(`${BACKEND_URL}/send-bulk-sms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ recipients: normalizedRecipients, message, senderName }),
    });

    const data = await response.json();

    if (!response.ok) {
      return { ok: false, error: data.error || `HTTP ${response.status}: ${response.statusText}` };
    }

    // The local backend returns an array: results = [{ phone, success, delivered, sid, status, error, note, trialWarning }, ...]
    const results = Array.isArray(data) ? data : (data.results || []);
    const allFailed = results.length > 0 && results.every(r => !r.success);
    const topError = allFailed
      ? (results[0]?.error || 'All messages failed.')
      : undefined;

    return { ok: !allFailed, results, error: topError };
  } catch (err) {
    return {
      ok: false,
      error: `Local backend connection failed: ${err.message}. Make sure the local backend server (port 5000) is running and configured.`
    };
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