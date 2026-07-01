/**
 * mysqlClient.js
 * All data goes through the local Express+MySQL backend on port 5000.
 * WhatsApp reminders → wa.me link (opens WhatsApp with pre-filled message)
 * SMS reminders → Twilio via backend /send-bulk-sms endpoint
 */

const API = 'http://localhost:5000';

// Backend is always ready (MySQL via Express server)
export const supabaseReady = true;

// No-op stub for supabase so App.jsx imports don't break
export const supabase = null;

// ── Helpers ────────────────────────────────────────────────────────
async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function del(path) {
  const res = await fetch(`${API}${path}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── WATERLLAMA API ─────────────────────────────────────────────────

export async function loadRemoteState() {
  const userId = localStorage.getItem('aqualama-user-id') || null;
  const data = await post('/wl/load-profile', { userId });
  if (!userId) localStorage.setItem('aqualama-user-id', data.userId);
  return data;
}

export async function saveRemoteProfile(params) {
  await post('/wl/save-profile', params);
}

export async function addRemoteWaterEntry({ userId, entry, hydrationCredit }) {
  return await post('/wl/add-entry', { userId, entry, hydrationCredit });
}

export async function deleteRemoteWaterEntries(userId) {
  await del(`/wl/entries/${userId}`);
}

export async function logRemoteReminder({ userId, method, phone, message, status, providerSid, errorMessage }) {
  await post('/wl/log-reminder', { userId, method, phone, message, status, providerSid, errorMessage });
}

export async function sendReminderViaEdge({ to, method, message, userId }) {
  try {
    if (method === 'WhatsApp') {
      // ── WhatsApp: open wa.me link with pre-filled message (previous service) ──
      const rawPhone = to.replace(/^\+/, '')
      const encodedMsg = encodeURIComponent(message)
      const deeplink = `https://wa.me/${rawPhone}?text=${encodedMsg}`
      window.open(deeplink, '_blank', 'noopener,noreferrer')
      return { ok: true, sid: null }
    }

    // ── SMS: Twilio via local backend ──
    const results = await post('/send-bulk-sms', {
      recipients: [to],
      message,
      senderName: 'Aqualama',
    })
    const r = results[0]
    if (r?.success) return { ok: true, sid: r.sid }
    return { ok: false, error: r?.error || 'SMS failed' }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ── STUBS for features that used Supabase ──────────────────────────

export async function checkDatabaseTables() {
  try {
    // Check if backend is up by hitting a known route
    const res = await fetch(`${API}/wl/load-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: null }),
    });
    const ok = res.ok;
    return {
      ok,
      tables: [
        { name: 'users', label: 'Users', exists: ok },
        { name: 'water_entries', label: 'Water Entries', exists: ok },
        { name: 'goals', label: 'Goals', exists: ok },
        { name: 'subscriptions', label: 'Subscriptions', exists: ok },
      ],
    };
  } catch {
    return { ok: false, tables: [] };
  }
}

export async function syncWaterEntriesToDB({ userId, logs, drinkFactors }) {
  const localOnly = logs.filter((e) => {
    const id = String(e.id)
    return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  })

  let synced = 0
  let failed = 0
  const errors = []

  await Promise.all(
    localOnly.map(async (entry) => {
      const hydration = Math.round(Number(entry.amount) * (drinkFactors[entry.type] ?? 1))
      try {
        await addRemoteWaterEntry({ userId, entry, hydrationCredit: hydration })
        synced++
      } catch (err) {
        failed++
        errors.push(`${entry.type} ${entry.amount}ml — ${err.message}`)
      }
    })
  )

  return { synced, skipped: logs.length - localOnly.length, failed, errors }
}
