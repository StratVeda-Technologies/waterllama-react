import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseReady = Boolean(
  supabaseUrl &&
    supabaseAnonKey &&
    !supabaseAnonKey.includes('PASTE_YOUR_SUPABASE_ANON_KEY_HERE'),
)

export const supabase = supabaseReady
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null

function getDemoUserId() {
  return localStorage.getItem('aqualama-user-id')
}

function setDemoUserId(id) {
  localStorage.setItem('aqualama-user-id', id)
}

function toAppEntry(entry) {
  return {
    id: entry.id,
    amount: entry.amount_ml,
    time: entry.entry_time,
    type: entry.drink_type,
    date: entry.entry_date,
  }
}

export async function loadRemoteState() {
  if (!supabaseReady) {
    return null
  }

  let userId = getDemoUserId()
  let user = null

  if (userId) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle()

    if (error) {
      throw error
    }
    user = data
  }

  if (!user) {
    const { data, error } = await supabase
      .from('users')
      .insert({
        name: 'Kailash',
        phone: '',
        notification_method: 'WhatsApp',
      })
      .select()
      .single()

    if (error) {
      throw error
    }
    user = data
    userId = data.id
    setDemoUserId(userId)

    await supabase.from('goals').insert({
      user_id: userId,
      daily_goal_ml: 2500,
      active: true,
    })

    await supabase.from('subscriptions').insert({
      user_id: userId,
      plan: 'Free',
      status: 'active',
      price_inr: 0,
    })
  }

  const [{ data: goal, error: goalError }, { data: entries, error: entriesError }, { data: subscription, error: subError }] =
    await Promise.all([
      supabase
        .from('goals')
        .select('*')
        .eq('user_id', userId)
        .eq('active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('water_entries')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
      supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

  if (goalError) throw goalError
  if (entriesError) throw entriesError
  if (subError) throw subError

  return {
    userId,
    userName: user.name,
    phone: user.phone ?? '',
    notificationMethod: user.notification_method,
    remindersOn: user.reminders_on,
    reminderGap: user.reminder_gap_hours,
    theme: user.theme,
    goal: goal?.daily_goal_ml ?? 2500,
    logs: (entries ?? []).map(toAppEntry),
    isPremium: subscription?.plan === 'Monthly' || subscription?.plan === 'Yearly',
    premiumPlan: subscription?.plan ?? 'Free',
    premiumExpiry: subscription?.expires_at ?? null,
  }
}

export async function saveRemoteProfile({
  userId,
  userName,
  phone,
  notificationMethod,
  remindersOn,
  reminderGap,
  theme,
  goal,
  isPremium,
  premiumPlan = 'Free',
  premiumExpiry = null,
}) {
  if (!supabaseReady || !userId) {
    return
  }

  const { error: userError } = await supabase
    .from('users')
    .update({
      name: userName,
      phone,
      notification_method: notificationMethod,
      reminders_on: remindersOn,
      reminder_gap_hours: reminderGap,
      theme,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)

  if (userError) throw userError

  const { data: activeGoal, error: goalReadError } = await supabase
    .from('goals')
    .select('id')
    .eq('user_id', userId)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (goalReadError) throw goalReadError

  if (activeGoal?.id) {
    const { error } = await supabase
      .from('goals')
      .update({ daily_goal_ml: goal, updated_at: new Date().toISOString() })
      .eq('id', activeGoal.id)
    if (error) throw error
  } else {
    const { error } = await supabase
      .from('goals')
      .insert({ user_id: userId, daily_goal_ml: goal, active: true })
    if (error) throw error
  }

  const plan = isPremium ? (premiumPlan === 'Free' ? 'Monthly' : premiumPlan) : 'Free'
  const price = plan === 'Monthly' ? 199 : plan === 'Yearly' ? 999 : 0
  const { data: activeSubscription, error: subReadError } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subReadError) throw subReadError

  if (activeSubscription?.id) {
    const { error } = await supabase
      .from('subscriptions')
      .update({ plan, price_inr: price, expires_at: premiumExpiry })
      .eq('id', activeSubscription.id)
    if (error) throw error
  } else {
    const { error } = await supabase
      .from('subscriptions')
      .insert({ user_id: userId, plan, status: 'active', price_inr: price, expires_at: premiumExpiry })
    if (error) throw error
  }
}

export async function addRemoteWaterEntry({ userId, entry, hydrationCredit }) {
  if (!supabaseReady || !userId) {
    return null
  }

  const { data, error } = await supabase
    .from('water_entries')
    .insert({
      user_id: userId,
      entry_date: entry.date,
      entry_time: entry.time,
      drink_type: entry.type,
      amount_ml: entry.amount,
      hydration_credit_ml: hydrationCredit,
    })
    .select()
    .single()

  if (error) throw error
  return toAppEntry(data)
}

export async function deleteRemoteWaterEntries(userId) {
  if (!supabaseReady || !userId) {
    return
  }

  const { error } = await supabase
    .from('water_entries')
    .delete()
    .eq('user_id', userId)

  if (error) throw error
}

export async function logRemoteReminder({
  userId,
  method,
  phone,
  message,
  status,
  providerSid,
  errorMessage,
}) {
  if (!supabaseReady || !userId) {
    return
  }

  const { error } = await supabase
    .from('reminder_logs')
    .insert({
      user_id: userId,
      method,
      phone,
      message,
      status,
      provider_sid: providerSid ?? null,
      error_message: errorMessage ?? null,
    })

  if (error) throw error
}

/**
 * Send an automatic reminder via the Supabase Edge Function → Twilio.
 * Never throws — always returns { ok, error?, notDeployed?, sid? }.
 *
 * @param {{ to: string, method: 'WhatsApp'|'SMS', message: string }} params
 * @returns {Promise<{ ok: boolean, sid?: string, error?: string, notDeployed?: boolean }>}
 */
export async function sendReminderViaEdge({ to, method, message }) {
  // Local mode: Supabase anon key not configured — can't reach any edge function
  if (!supabaseReady) {
    console.log(`[Local mode] ${method} reminder to ${to}:`, message)
    return { ok: false, notDeployed: true, error: 'Supabase not configured' }
  }

  try {
    const { data, error } = await supabase.functions.invoke('send-reminder', {
      body: { to, method, message },
    })

    // FunctionsFetchError — network failure or function not deployed
    if (error) {
      const msg = error.message ?? ''
      const isNotDeployed =
        msg.includes('Failed to send a request') ||
        msg.includes('Failed to fetch') ||
        msg.includes('NetworkError') ||
        msg.includes('404') ||
        msg.includes('not found')

      // Try to read the response body for a more specific message
      let detail = msg
      try {
        if (error.context && typeof error.context.json === 'function') {
          const body = await error.context.json()
          detail = body?.error ?? detail
        }
      } catch {
        // ignore — use error.message
      }

      return { ok: false, error: detail, notDeployed: isNotDeployed }
    }

    // data is { ok, error?, sid? } — already the right shape
    return data ?? { ok: false, error: 'Empty response from edge function' }
  } catch (err) {
    // Unexpected JS error (e.g. JSON parse failure)
    const msg = err?.message ?? 'Unexpected error'
    const isNotDeployed =
      msg.includes('Failed to send a request') ||
      msg.includes('Failed to fetch') ||
      msg.includes('NetworkError')
    return { ok: false, error: msg, notDeployed: isNotDeployed }
  }
}

/**
 * Checks whether all 4 required tables exist in the Supabase project.
 * Returns { ok: boolean, notConfigured?: boolean, tables: { name, exists, label }[] }
 */
export async function checkDatabaseTables() {
  if (!supabaseReady) {
    return { ok: false, notConfigured: true, tables: [] }
  }

  const tableNames = [
    { key: 'users',         label: 'Users' },
    { key: 'water_entries', label: 'Water Entries' },
    { key: 'goals',         label: 'Goals' },
    { key: 'subscriptions', label: 'Subscriptions' },
  ]

  const results = await Promise.all(
    tableNames.map(async ({ key, label }) => {
      const { error } = await supabase.from(key).select('id').limit(1)
      // PostgreSQL error code 42P01 = table does not exist
      const exists = !error || (error.code !== '42P01' && error.code !== 'PGRST116')
      return { name: key, label, exists, errorCode: error?.code ?? null }
    }),
  )

  return {
    ok: results.every((t) => t.exists),
    tables: results,
  }
}

/**
 * Bulk-syncs all local water log entries to Supabase water_entries table.
 * Skips entries that already have a UUID id (already in DB).
 * Returns { synced, skipped, failed, errors[] }
 */
export async function syncWaterEntriesToDB({ userId, logs, drinkFactors }) {
  if (!supabaseReady || !userId) {
    return { synced: 0, skipped: 0, failed: 0, errors: [] }
  }

  const localOnly = logs.filter((e) => {
    // UUID check — entries already pushed have a UUID string id
    const id = String(e.id)
    return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  })

  let synced = 0
  let failed = 0
  const errors = []

  await Promise.all(
    localOnly.map(async (entry) => {
      const hydration = Math.round(Number(entry.amount) * (drinkFactors[entry.type] ?? 1))
      const { error } = await supabase.from('water_entries').insert({
        user_id: userId,
        entry_date: entry.date,
        entry_time: entry.time,
        drink_type: entry.type,
        amount_ml: entry.amount,
        hydration_credit_ml: hydration,
      })
      if (error) {
        failed++
        errors.push(`${entry.type} ${entry.amount}ml — ${error.message}`)
      } else {
        synced++
      }
    }),
  )

  return { synced, skipped: logs.length - localOnly.length, failed, errors }
}
