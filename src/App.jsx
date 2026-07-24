import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addRemoteWaterEntry,
  deleteRemoteWaterEntries,
  loadRemoteState,
  logRemoteReminder,
  saveRemoteProfile,
  sendReminderViaEdge,
  dbReady,
  isSupabaseConfigured,
  normalizePhoneNumber,
  getMsg91TemplateId,
  setMsg91TemplateId,
  getMsg91SenderId,
  setMsg91SenderId,
  getMsg91PeId,
  setMsg91PeId,
  getTwilioConfig,
  setTwilioConfig,
} from './mysqlClient'
import './App.css'
import BulkSms from './BulkSms'

const todayKey = new Date().toISOString().slice(0, 10)

const defaultLogs = [
  { id: 1, amount: 250, time: '08:15', type: 'Water', date: todayKey },
  { id: 2, amount: 350, time: '10:30', type: 'Water', date: todayKey },
  { id: 3, amount: 200, time: '12:05', type: 'Tea', date: todayKey },
]

const weekSeed = [2100, 1850, 2400, 1600, 2200, 1750]
const quickAdds = [150, 250, 350, 500]
const drinkFactors = { Water: 1, Tea: 0.85, Coffee: 0.75, Juice: 0.9 }

const marketProblems = [
  'Water drinking',
  'Sleep tracking',
  'Walking tracker',
  'Weight loss',
  'Gym consistency',
  'Meditation',
  'Expense tracking',
  'Study hours',
  'Screen time',
  'Reading habit',
  'Medicine reminders',
  'Meal planning',
  'Posture breaks',
  'Journaling',
  'Skincare routine',
  'Language practice',
  'Budget saving',
  'Deep work',
  'Stretching',
  'Digital detox',
]

const paidProblems = [
  'Weight loss',
  'Sleep tracking',
  'Gym consistency',
  'Meditation',
  'Expense tracking',
  'Water drinking',
]

const onboardingSlides = [
  {
    title: 'Meet your daily water buddy',
    text: 'Cute character, clear progress, and tiny nudges make hydration feel easy.',
  },
  {
    title: 'Set a goal that fits you',
    text: 'Choose a daily target, then log water, tea, coffee, or juice in one tap.',
  },
  {
    title: 'Stay consistent',
    text: 'Smart reminders, streaks, XP, and badges help you come back tomorrow.',
  },
]

const databaseTables = ['Users', 'Water Entries', 'Goals', 'Subscriptions']

function getStoredState() {
  try {
    const stored = localStorage.getItem('aqualama-state')
    return stored ? JSON.parse(stored) : null
  } catch {
    return null
  }
}

function formatLiters(value) {
  return `${(value / 1000).toFixed(value >= 1000 ? 1 : 2)} L`
}

function getNotificationPermission() {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

function Mascot({ progress }) {
  return (
    <div className="mascot-wrap" aria-hidden="true">
      <div className="water-orbit">
        <span style={{ '--i': 0 }}></span>
        <span style={{ '--i': 1 }}></span>
        <span style={{ '--i': 2 }}></span>
      </div>
      <div className="mascot">
        <div className="mascot-ear left"></div>
        <div className="mascot-ear right"></div>
        <div className="mascot-face">
          <span className="eye left"></span>
          <span className="eye right"></span>
          <span className="nose"></span>
          <span className="smile"></span>
        </div>
        <div className="mascot-neck"></div>
      </div>
      <div className="mascot-label">{Math.round(progress)}%</div>
    </div>
  )
}

function ProgressRing({ progress }) {
  const angle = Math.min(progress, 100) * 3.6
  return (
    <div className="progress-ring" style={{ '--angle': `${angle}deg` }}>
      <div>
        <strong>{Math.round(progress)}%</strong>
        <span>complete</span>
      </div>
    </div>
  )
}

function App() {
  const stored = getStoredState()
  const [goal, setGoal] = useState(stored?.goal ?? 2500)
  const [logs, setLogs] = useState(stored?.logs ?? defaultLogs)
  const [amount, setAmount] = useState(250)
  const [drinkType, setDrinkType] = useState('Water')
  const [activeTab, setActiveTab] = useState('dashboard')
  const [remindersOn, setRemindersOn] = useState(stored?.remindersOn ?? true)
  const [reminderGap, setReminderGap] = useState(stored?.reminderGap ?? 2)
  const [theme, setTheme] = useState(stored?.theme ?? 'Lagoon')
  const [userName, setUserName] = useState(stored?.userName ?? 'Kailash')
  const [phone, setPhone] = useState(stored?.phone || '+919876543210')
  const [notificationMethod, setNotificationMethod] = useState('SMS')
  const [lastReminder, setLastReminder] = useState(stored?.lastReminder ?? '')
  const [isPremium, setIsPremium] = useState(stored?.isPremium ?? false)
  const [premiumPlan, setPremiumPlan] = useState(stored?.premiumPlan ?? 'Free')
  const [premiumExpiry, setPremiumExpiry] = useState(stored?.premiumExpiry ?? null)
  const [browserPermission, setBrowserPermission] = useState(getNotificationPermission())
  const [userId, setUserId] = useState(stored?.userId ?? '')
  const [remoteLoaded, setRemoteLoaded] = useState(false)
  const [syncStatus, setSyncStatus] = useState('Local mode (localStorage)')
  // Auto-reminder state
  const [autoSendStatus, setAutoSendStatus] = useState('idle') // idle | sending | sent | error
  const [autoSendError, setAutoSendError] = useState('')
  const [lastAutoSent, setLastAutoSent] = useState(stored?.lastAutoSent ?? null) // ISO string
  const [nextReminderIn, setNextReminderIn] = useState(null) // seconds until next fire

  // Twilio credentials state
  const initialTwilio = getTwilioConfig()
  const [twilioSid, setTwilioSid] = useState(initialTwilio.sid)
  const [twilioToken, setTwilioToken] = useState(initialTwilio.token)
  const [twilioFrom, setTwilioFrom] = useState(initialTwilio.from)

  // Refs for auto-reminder engine (prevent stale closure + duplicate sends)
  const isSendingRef = useRef(false)   // guard: only one send at a time
  const sendReminderRef = useRef(null) // always points to latest sendReminder fn

  const total = useMemo(
    () =>
      logs.reduce(
        (sum, entry) => sum + Number(entry.amount) * (drinkFactors[entry.type] ?? 1),
        0,
      ),
    [logs],
  )

  const progress = Math.min((total / goal) * 100, 100)
  const remaining = Math.max(goal - total, 0)
  const streak = total >= goal ? 4 : 3
  const xp = Math.floor(total / 50) + streak * 20
  const week = [...weekSeed, total]
  const tabs = ['onboarding', 'dashboard', 'reminders', 'stats', 'premium', 'bulk-sms']
  const cleanPhone = normalizePhoneNumber(phone)
  const reminderMessage = `Hi ${userName || 'there'}, time to drink water. You have completed ${Math.round(progress)}% of your ${formatLiters(goal)} hydration goal today.`

  const formattedExpiry = useMemo(() => {
    if (!premiumExpiry) return ''
    try {
      return new Date(premiumExpiry).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    } catch {
      return ''
    }
  }, [premiumExpiry])

  useEffect(() => {
    localStorage.setItem(
      'aqualama-state',
      JSON.stringify({
        userId,
        goal,
        logs,
        remindersOn,
        reminderGap,
        theme,
        userName,
        phone,
        notificationMethod,
        lastReminder,
        isPremium,
        premiumPlan,
        premiumExpiry,
        lastAutoSent,
      }),
    )
  }, [
    userId,
    goal,
    logs,
    remindersOn,
    reminderGap,
    theme,
    userName,
    phone,
    notificationMethod,
    lastReminder,
    isPremium,
    premiumPlan,
    premiumExpiry,
    lastAutoSent,
  ])

  useEffect(() => {
    let cancelled = false

    async function loadDatabase() {
      try {
        const remote = await loadRemoteState()
        if (cancelled || !remote) return

        setUserId(remote.userId)
        setUserName(remote.userName)
        setPhone(remote.phone)
        setNotificationMethod(remote.notificationMethod)
        setRemindersOn(remote.remindersOn)
        setReminderGap(remote.reminderGap)
        setTheme(remote.theme)
        setGoal(remote.goal)
        setLogs(remote.logs.length ? remote.logs : defaultLogs)
        setIsPremium(remote.isPremium)
        setPremiumPlan(remote.premiumPlan || 'Free')
        setPremiumExpiry(remote.premiumExpiry || null)
        setSyncStatus('Loaded from localStorage')
      } catch (error) {
        setSyncStatus(`Error: ${error.message}`)
      } finally {
        if (!cancelled) setRemoteLoaded(true)
      }
    }

    loadDatabase()

    return () => {
      cancelled = true
    }
  }, [])

  // Note: MySQL backend doesn't support realtime subscriptions like Supabase.
  // Premium status is synced via regular profile save/load operations.

  useEffect(() => {
    if (!remoteLoaded || !userId) {
      return
    }

    const handle = window.setTimeout(async () => {
      try {
        setSyncStatus('Saving to localStorage...')
        await saveRemoteProfile({
          userId,
          userName,
          phone,
          notificationMethod,
          remindersOn,
          reminderGap,
          theme,
          goal,
          isPremium,
          premiumPlan,
          premiumExpiry,
        })
        setSyncStatus('Saved to localStorage')
      } catch (error) {
        setSyncStatus(`Error: ${error.message}`)
      }
    }, 700)

    return () => window.clearTimeout(handle)
  }, [
    userId,
    remoteLoaded,
    userName,
    phone,
    notificationMethod,
    remindersOn,
    reminderGap,
    theme,
    goal,
    isPremium,
    premiumPlan,
    premiumExpiry,
  ])

  async function addDrink(size = amount) {
    const now = new Date()
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const entry = { id: Date.now(), amount: Number(size), time, type: drinkType, date: todayKey }
    setLogs((current) => [entry, ...current])

    if (!userId) {
      return
    }

    try {
      setSyncStatus('Saving drink...')
      const remoteEntry = await addRemoteWaterEntry({
        userId,
        entry,
        hydrationCredit: Math.round(Number(size) * (drinkFactors[drinkType] ?? 1)),
      })
      if (remoteEntry) {
        setLogs((current) =>
          current.map((item) => (item.id === entry.id ? remoteEntry : item)),
        )
      }
      setSyncStatus('Saved to localStorage')
    } catch (error) {
      setSyncStatus(`Error: ${error.message}`)
    }
  }

  async function resetDay() {
    setLogs([])
    if (!userId) {
      return
    }

    try {
      setSyncStatus('Deleting entries...')
      await deleteRemoteWaterEntries(userId)
      setSyncStatus('Deleted from localStorage')
    } catch (error) {
      setSyncStatus(`Error: ${error.message}`)
    }
  }

  async function sendReminder({ isAuto = false } = {}) {
    if (!cleanPhone) return
    setAutoSendStatus('sending')
    setAutoSendError('')

    try {
      // Use sendReminderViaEdge for both WhatsApp and SMS
      // For WhatsApp: uses wa.me links (client-side, no backend needed)
      // For SMS: uses Supabase Edge Functions → Twilio (send-reminder function)
      const result = await sendReminderViaEdge({
        to: cleanPhone,
        message: reminderMessage,
        method: notificationMethod, // 'WhatsApp' or 'SMS'
        userId: userId || undefined,
      })

      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      setLastReminder(now)
      setLastAutoSent(new Date().toISOString())
      setAutoSendStatus('sent')
      setTimeout(() => setAutoSendStatus('idle'), 4000)

      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(`Aqualama — ${notificationMethod} reminder`, {
          body: `${notificationMethod} reminder sent to ${cleanPhone}`,
        })
      }

      // For WhatsApp via wa.me, open the links
      if (notificationMethod === 'WhatsApp' && result.waLinks) {
        result.waLinks.forEach(link => window.open(link, '_blank', 'noopener,noreferrer'))
      }
    } catch (err) {
      // sendReminderViaEdge throws for SMS failures — catch here to show error chip in UI
      console.error(`sendReminder ${notificationMethod} error:`, err)
      const errMsg = err?.message ?? `Could not send ${notificationMethod}`
      setAutoSendError(errMsg)
      setAutoSendStatus('error')
      setTimeout(() => setAutoSendStatus('idle'), 8000)
    }
  }

  async function createBrowserReminder() {
    if (!remindersOn) {
      setRemindersOn(true)
      return
    }

    let permission = browserPermission
    if (typeof Notification !== 'undefined' && permission === 'default') {
      permission = await Notification.requestPermission()
      setBrowserPermission(permission)
    }

    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    setLastReminder(stamp)

    if (permission === 'granted') {
      new Notification('Aqualama hydration reminder', { body: reminderMessage })
    }
  }

  function exportData() {
    const rows = [
      ['date', 'time', 'type', 'amount_ml', 'hydration_credit_ml'],
      ...logs.map((entry) => [
        entry.date ?? todayKey,
        entry.time,
        entry.type,
        entry.amount,
        Math.round(Number(entry.amount) * (drinkFactors[entry.type] ?? 1)),
      ]),
    ]
    const csv = rows.map((row) => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `aqualama-hydration-${todayKey}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  async function handleUpgradePremium(planName) {
    setIsPremium(true)
    setPremiumPlan(planName)
    const expiry = new Date()
    if (planName === 'Monthly') {
      expiry.setMonth(expiry.getMonth() + 1)
    } else if (planName === 'Yearly') {
      expiry.setFullYear(expiry.getFullYear() + 1)
    }
    const expiryStr = expiry.toISOString()
    setPremiumExpiry(expiryStr)

    if (!dbReady || !userId) return

    try {
      await saveRemoteProfile({
        userId,
        userName,
        phone,
        notificationMethod,
        remindersOn,
        reminderGap,
        theme,
        goal,
        isPremium: true,
        premiumPlan: planName,
        premiumExpiry: expiryStr,
      })
      setSyncStatus('Database synced')
    } catch (err) {
      console.error('Failed to update subscription in database:', err)
      setSyncStatus(`Database error: ${err.message}`)
    }
  }

  async function handleDowngradePremium() {
    setIsPremium(false)
    setPremiumPlan('Free')
    setPremiumExpiry(null)

    if (!dbReady || !userId) return

    try {
      await saveRemoteProfile({
        userId,
        userName,
        phone,
        notificationMethod,
        remindersOn,
        reminderGap,
        theme,
        goal,
        isPremium: false,
        premiumPlan: 'Free',
        premiumExpiry: null,
      })
      setSyncStatus('Database synced')
    } catch (err) {
      console.error('Failed to downgrade subscription in database:', err)
      setSyncStatus(`Database error: ${err.message}`)
    }
  }

  // ── Keep sendReminderRef current on every render (fixes stale closure) ──
  useEffect(() => {
    sendReminderRef.current = sendReminder
  })

  // ── Auto-reminder countdown engine ───────────────────────────────────────
  useEffect(() => {
    if (!remindersOn || !cleanPhone) {
      setNextReminderIn(null)
      return
    }

    const gapMs = reminderGap * 60 * 60 * 1000 // hours → ms

    function computeSecondsLeft() {
      // Bug fix: when no prior send exists, treat "last sent" as right now
      // so the first reminder waits a full gap instead of firing immediately.
      const base = lastAutoSent
        ? new Date(lastAutoSent).getTime()
        : Date.now()                        // ← was: Date.now() - gapMs (wrong)
      const fireAt = base + gapMs
      return Math.max(0, Math.round((fireAt - Date.now()) / 1000))
    }

    setNextReminderIn(computeSecondsLeft())

    const tick = setInterval(() => {
      const secs = computeSecondsLeft()
      setNextReminderIn(secs)
      // Bug fix: isSendingRef prevents duplicate sends while async is in flight
      // sendReminderRef.current ensures fresh values (method, message, phone)
      if (secs === 0 && !isSendingRef.current) {
        isSendingRef.current = true
        sendReminderRef.current({ isAuto: true }).finally(() => {
          isSendingRef.current = false
        })
      }
    }, 1000)

    return () => clearInterval(tick)
  }, [remindersOn, cleanPhone, reminderGap, lastAutoSent])

  // ── Helpers ──────────────────────────────────────────────────────────────
  function formatCountdown(secs) {
    if (secs === null) return null
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    const s = secs % 60
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
    return `${s}s`
  }

  return (
    <main className={`app-shell theme-${theme.toLowerCase()}`}>
      <section className="phone-frame">
        <header className="top-bar">
          <div>
            <p className="eyebrow">Aqualama</p>
            <h1>Hydration tracker</h1>
            <p className="sync-status">{syncStatus}</p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => window.location.href = `${import.meta.env.BASE_URL}sms-dashboard.html`} className="avatar-button" style={{ fontSize: '16px', background: 'var(--brand-strong)' }} title="Bulk SMS Dashboard">
              💬
            </button>
            <button className="avatar-button" type="button" title="Profile" onClick={() => setActiveTab('premium')}>
              {(userName || 'U').slice(0, 2).toUpperCase()}
            </button>
          </div>
        </header>
 
        <nav className="tabs" aria-label="App sections">
          {tabs.map((tab) => (
            <button
              className={activeTab === tab ? 'active' : ''}
              key={tab}
              onClick={() => setActiveTab(tab)}
              type="button"
            >
              {tab}
            </button>
          ))}
        </nav>

        {activeTab === 'onboarding' && (
          <div className="onboarding-grid">
            <section className="onboarding-panel">
              <p className="eyebrow">Apple-level premium UI</p>
              <h2>Hydration made playful, premium, and simple.</h2>
              <div className="onboarding-phone">
                <Mascot progress={progress} />
                <ProgressRing progress={progress} />
              </div>
            </section>

            <section className="feature-panel">
              {onboardingSlides.map((slide, index) => (
                <div key={slide.title}>
                  <strong>{index + 1}</strong>
                  <p>
                    <b>{slide.title}</b>
                    <span>{slide.text}</span>
                  </p>
                </div>
              ))}
            </section>

            <section className="research-panel onboarding-research">
              <div className="section-heading">
                <h2>Market demand rank</h2>
                <span>Top 20</span>
              </div>
              <ol className="rank-list">
                {marketProblems.map((problem, index) => (
                  <li key={problem}>
                    <span>{index + 1}</span>
                    {problem}
                  </li>
                ))}
              </ol>
            </section>

            <section className="research-panel onboarding-research">
              <div className="section-heading">
                <h2>Subscription fit</h2>
                <span>High intent</span>
              </div>
              <div className="pill-grid">
                {paidProblems.map((problem) => (
                  <span key={problem}>{problem}</span>
                ))}
              </div>
              <p>AI tells you both demand and monetization potential.</p>
            </section>
          </div>
        )}

        {activeTab === 'dashboard' && (
          <div className="screen-grid">
            <section className="hero-panel">
              <div>
                <p className="eyebrow">Today</p>
                <h2>{formatLiters(total)} of {formatLiters(goal)}</h2>
                <p>
                  {remaining > 0
                    ? `${Math.round(remaining)} ml left to hit your goal`
                    : 'Goal completed. Keep the streak alive.'}
                </p>
              </div>
              <ProgressRing progress={progress} />
              <Mascot progress={progress} />
            </section>

            <section className="profile-panel">
              <div className="section-heading">
                <h2>User profile</h2>
                <span>{isPremium ? 'Premium' : 'Free'}</span>
              </div>
              <div className="form-grid">
                <label>
                  Name
                  <input
                    value={userName}
                    onChange={(event) => setUserName(event.target.value)}
                    placeholder="Your name"
                  />
                </label>
                <label>
                  SMS Mobile Number
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
                    <select
                      value={(() => {
                        const codes = ['+971', '+91', '+44', '+61', '+1'];
                        for (const c of codes) {
                          if (phone && phone.startsWith(c)) return c;
                        }
                        return '+91';
                      })()}
                      onChange={(e) => {
                        const newCode = e.target.value;
                        const codes = ['+971', '+91', '+44', '+61', '+1'];
                        let currentDigits = phone;
                        for (const c of codes) {
                          if (phone && phone.startsWith(c)) {
                            currentDigits = phone.slice(c.length);
                            break;
                          }
                        }
                        currentDigits = currentDigits.replace(/\D/g, '');
                        setPhone(`${newCode}${currentDigits}`);
                      }}
                      style={{ padding: '8px 12px', background: 'var(--soft)', borderRadius: '8px', border: '1px solid var(--line)', fontWeight: 600, color: 'var(--text)', fontSize: '0.95rem' }}
                    >
                      <option value="+91">🇮🇳 +91</option>
                      <option value="+1">🇺🇸 +1</option>
                      <option value="+44">🇬🇧 +44</option>
                      <option value="+61">🇦🇺 +61</option>
                      <option value="+971">🇦🇪 +971</option>
                    </select>
                    <input
                      value={(() => {
                        const codes = ['+971', '+91', '+44', '+61', '+1'];
                        for (const c of codes) {
                          if (phone && phone.startsWith(c)) return phone.slice(c.length);
                        }
                        return phone ? phone.replace(/\D/g, '') : '';
                      })()}
                      onChange={(event) => {
                        const codes = ['+971', '+91', '+44', '+61', '+1'];
                        let code = '+91';
                        for (const c of codes) {
                          if (phone && phone.startsWith(c)) {
                            code = c;
                            break;
                          }
                        }
                        const digits = event.target.value.replace(/\D/g, '').slice(0, 10);
                        setPhone(`${code}${digits}`);
                      }}
                      placeholder="9876543210"
                      type="tel"
                      style={{ flex: 1, fontSize: '0.95rem' }}
                      maxLength={10}
                    />
                  </div>
                  <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '6px', marginBottom: 0 }}>
                    Select country code and enter 10-digit mobile number
                  </p>
                </label>
              </div>
              <div className="profile-grid">
                <div>
                  <small>Goal</small>
                  <strong>{formatLiters(goal)}</strong>
                </div>
                <div>
                  <small>Hydration credit</small>
                  <strong>{Math.round(total)} ml</strong>
                </div>
                <div>
                  <small>Plan</small>
                  <strong>{isPremium ? 'Premium' : 'Free'}</strong>
                </div>
              </div>
            </section>

            <section className="control-panel">
              <div className="section-heading">
                <h2>Add intake</h2>
                <select value={drinkType} onChange={(event) => setDrinkType(event.target.value)}>
                  <option>Water</option>
                  <option>Tea</option>
                  <option>Coffee</option>
                  <option>Juice</option>
                </select>
              </div>

              <div className="quick-adds">
                {quickAdds.map((size) => (
                  <button key={size} type="button" onClick={() => addDrink(size)}>
                    +{size} ml
                  </button>
                ))}
              </div>

              <label className="slider-row">
                <span>Custom amount</span>
                <strong>{amount} ml</strong>
                <input
                  max="1000"
                  min="50"
                  step="50"
                  type="range"
                  value={amount}
                  onChange={(event) => setAmount(Number(event.target.value))}
                />
              </label>

              <button className="primary-action" type="button" onClick={() => addDrink()}>
                Add drink
              </button>
            </section>

            <section className="settings-panel">
              <div className="section-heading">
                <h2>Daily goal</h2>
                <span>{goal} ml</span>
              </div>
              <input
                max="5000"
                min="1000"
                step="100"
                type="range"
                value={goal}
                onChange={(event) => setGoal(Number(event.target.value))}
              />
            </section>

            <section className="history-panel">
              <div className="section-heading">
                <h2>Recent drinks</h2>
                <button type="button" onClick={resetDay}>Reset</button>
              </div>
              {logs.length === 0 ? (
                <p>No drinks logged yet.</p>
              ) : (
                <ul>
                  {logs.slice(0, 5).map((entry) => (
                    <li key={entry.id}>
                      <span>{entry.type}</span>
                      <strong>{entry.amount} ml</strong>
                      <small>{entry.time}</small>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        {activeTab === 'reminders' && (
          <div className="screen-grid">
            <section className="reminder-panel">
              <p className="eyebrow">Auto-delivery engine</p>
              <h2>Smart hydration reminders every {reminderGap} hours.</h2>
              <p>Reminders fire automatically. Choose WhatsApp (free, via wa.me) or Twilio SMS. Enable them, add your +91 mobile number, and the app handles the rest.</p>

              <div className="method-toggle">
                <button
                  className={notificationMethod === 'WhatsApp' ? 'active' : ''}
                  type="button"
                  onClick={() => setNotificationMethod('WhatsApp')}
                >
                  📱 WhatsApp
                </button>
                <button
                  className={notificationMethod === 'SMS' ? 'active' : ''}
                  type="button"
                  onClick={() => setNotificationMethod('SMS')}
                >
                  📲 Twilio SMS
                </button>
              </div>
              <span className="method-note">
                {notificationMethod === 'WhatsApp'
                  ? '💡 WhatsApp opens a pre-filled chat via wa.me (free, no backend needed)'
                  : '💡 SMS sent via Twilio — ensure Supabase secrets are configured'}
              </span>

              <div className="section-heading">
                <h2>Auto reminders</h2>
                <label className="switch">
                  <input
                    checked={remindersOn}
                    type="checkbox"
                    onChange={(event) => {
                      const checked = event.target.checked
                      setRemindersOn(checked)
                      if (checked) {
                        setLastAutoSent(new Date().toISOString())
                      }
                    }}
                  />
                  <span></span>
                </label>
              </div>
              <div className="stepper">
                <button type="button" onClick={() => {
                  setReminderGap(Math.max(1, reminderGap - 1))
                  setLastAutoSent(new Date().toISOString())
                }}>-</button>
                <strong>Every {reminderGap} hours</strong>
                <button type="button" onClick={() => {
                  setReminderGap(Math.min(8, reminderGap + 1))
                  setLastAutoSent(new Date().toISOString())
                }}>+</button>
              </div>

              {/* ── Countdown + status row ── */}
              <div className="reminder-status-row">
                {remindersOn && cleanPhone ? (
                  nextReminderIn !== null ? (
                    <div className="reminder-countdown">
                      <span className="countdown-pulse"></span>
                      <span>Next auto-send in <strong>{formatCountdown(nextReminderIn)}</strong></span>
                    </div>
                  ) : null
                ) : (
                  <div className="reminder-inactive">
                    {!cleanPhone
                      ? '⚠ Add a phone number to enable auto-reminders'
                      : '⏸ Auto reminders paused — toggle on above'}
                  </div>
                )}
                {autoSendStatus === 'sending' && (
                  <div className="send-chip send-chip--sending">
                    <span className="chip-spinner"></span> Opening…
                  </div>
                )}
                {autoSendStatus === 'sent' && (
                  <div className="send-chip send-chip--sent">✓ Opened via {notificationMethod}</div>
                )}
                {autoSendStatus === 'error' && (
                  <div className="send-chip send-chip--error" title={autoSendError}>
                    ✗ Error — {autoSendError.slice(0, 48)}{autoSendError.length > 48 ? '…' : ''}
                  </div>
                )}
              </div>

              <div className="reminder-preview">
                <small>Message preview</small>
                <p>{reminderMessage}</p>
                <span>Browser permission: {browserPermission}</span>
                {lastReminder && <span>Last sent at {lastReminder}</span>}
              </div>

              <div className="reminder-actions">
                <button
                  className="primary-action"
                  type="button"
                  disabled={autoSendStatus === 'sending' || !cleanPhone}
                  onClick={() => sendReminder()}
                >
                  {autoSendStatus === 'sending'
                    ? `Sending ${notificationMethod}…`
                    : notificationMethod === 'SMS'
                      ? `📲 Send SMS now`
                      : `📱 Send WhatsApp now`}
                </button>
                <button
                  className="secondary-action"
                  type="button"
                  onClick={createBrowserReminder}
                >
                  {remindersOn ? 'Test browser notification' : 'Turn reminders on'}
                </button>
              </div>
            </section>

            <section className="backend-panel">
              <p className="eyebrow">Local mode (localStorage)</p>
              <h2>Running in local mode</h2>
              <p>All data is stored in your browser's localStorage. No database server required.</p>
              <p>Works offline and on any device - just open the app!</p>

              <div style={{ marginTop: '20px', padding: '16px', background: 'var(--soft)', borderRadius: '12px', border: '1px solid var(--line)' }}>
                <strong>✅ Data persists locally</strong>
                <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px', fontSize: '0.9rem' }}>
                  <li>Water intake logs</li>
                  <li>User profile & settings</li>
                  <li>Reminders & preferences</li>
                  <li>Premium status</li>
                </ul>
              </div>

              <div style={{ marginTop: '16px', padding: '16px', background: 'var(--soft)', borderRadius: '12px', border: '1px solid var(--line)' }}>
                <strong>📱 Reminder Channels</strong>
                <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: 'var(--bg)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                    <span style={{ fontSize: '1.5rem' }}>📱</span>
                    <div>
                      <strong>WhatsApp (wa.me)</strong>
                      <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: 'var(--muted)' }}>
                        ✅ Works automatically — opens WhatsApp chat via wa.me links
                        <br />No backend configuration needed
                      </p>
                    </div>
                    <span className="sms-tag active" style={{ fontSize: '0.7rem', padding: '4px 8px' }}>Ready</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: 'var(--bg)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                    <span style={{ fontSize: '1.5rem' }}>📲</span>
                    <div>
                      <strong>SMS (MSG91 via Supabase)</strong>
                      <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: 'var(--muted)' }}>
                        {isSupabaseConfigured()
                          ? '✅ Configured — SMS reminders sent via MSG91 through Supabase Edge Functions'
                          : '⚠ Not configured — Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local'}
                      </p>
                    </div>
                    <span className={`sms-tag ${isSupabaseConfigured() ? 'active' : 'vip'}`} style={{ fontSize: '0.7rem', padding: '4px 8px' }}>
                      {isSupabaseConfigured() ? 'Ready' : 'Setup Required'}
                    </span>
                  </div>
                </div>
                <p style={{ margin: '12px 0 0 0', fontSize: '0.8rem', color: 'var(--muted)' }}>
                  For auto-reminders, SMS users will receive messages automatically every {reminderGap} hours.
                  WhatsApp auto-reminders open wa.me links (requires app to be open).
                </p>
                <div style={{ marginTop: '16px', padding: '14px', background: 'var(--bg)', borderRadius: '10px', border: '1.5px solid var(--brand)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <p style={{ fontSize: '0.9rem', fontWeight: 800, margin: 0, color: 'var(--brand-strong)' }}>
                    ⚡ Twilio SMS API Credentials (Required for SMS)
                  </p>
                  <p style={{ fontSize: '0.78rem', color: 'var(--muted)', margin: 0 }}>
                    Enter your new rotated <strong>Auth Token</strong> and <strong>Account SID</strong> from your <a href="https://console.twilio.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand)', textDecoration: 'underline' }}>Twilio Console</a>.
                  </p>
                  <div>
                    <label style={{ fontSize: '0.78rem', fontWeight: 700, display: 'block', marginBottom: '4px' }}>Twilio Account SID</label>
                    <input
                      type="text"
                      placeholder="e.g. ACa9a843c3410a82db219187d42f0cc36e"
                      value={twilioSid}
                      onChange={e => {
                        const val = e.target.value.trim()
                        setTwilioSid(val)
                        setTwilioConfig(val, twilioToken, twilioFrom)
                      }}
                      style={{
                        width: '100%', padding: '8px 12px', borderRadius: '8px',
                        border: '1px solid var(--line)', background: 'var(--card)',
                        color: 'var(--text)', fontSize: '0.85rem', fontFamily: 'monospace'
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '0.78rem', fontWeight: 700, display: 'block', marginBottom: '4px' }}>New Twilio Auth Token</label>
                    <input
                      type="password"
                      placeholder="Paste new Auth Token from Console"
                      value={twilioToken}
                      onChange={e => {
                        const val = e.target.value.trim()
                        setTwilioToken(val)
                        setTwilioConfig(twilioSid, val, twilioFrom)
                      }}
                      style={{
                        width: '100%', padding: '8px 12px', borderRadius: '8px',
                        border: '1px solid var(--line)', background: 'var(--card)',
                        color: 'var(--text)', fontSize: '0.85rem', fontFamily: 'monospace'
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '0.78rem', fontWeight: 700, display: 'block', marginBottom: '4px' }}>Twilio Phone Number (From)</label>
                    <input
                      type="text"
                      placeholder="e.g. +16187536219"
                      value={twilioFrom}
                      onChange={e => {
                        const val = e.target.value.trim()
                        setTwilioFrom(val)
                        setTwilioConfig(twilioSid, twilioToken, val)
                      }}
                      style={{
                        width: '100%', padding: '8px 12px', borderRadius: '8px',
                        border: '1px solid var(--line)', background: 'var(--card)',
                        color: 'var(--text)', fontSize: '0.85rem', fontFamily: 'monospace'
                      }}
                    />
                  </div>
                  {twilioSid && twilioToken ? (
                    <span style={{ color: '#16a34a', fontSize: '0.8rem', fontWeight: 600 }}>✅ Twilio Credentials Saved</span>
                  ) : (
                    <span style={{ color: '#dc2626', fontSize: '0.8rem', fontWeight: 600 }}>⚠ Please enter your new rotated Twilio Auth Token above</span>
                  )}
                </div>

                <div style={{ marginTop: '16px', padding: '14px', background: 'var(--bg)', borderRadius: '10px', border: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div>
                    <p style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '6px', color: 'var(--text)' }}>
                      📋 DLT Template ID (Required for SMS delivery in India)
                    </p>
                    <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '8px' }}>
                      India's TRAI regulations require every SMS to use a DLT-registered template.
                      Register at <strong>msg91.com → SMS → DLT Templates</strong>.
                    </p>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input
                        id="msg91-template-id"
                        type="text"
                        placeholder="e.g. 1207163234567890123"
                        defaultValue={getMsg91TemplateId()}
                        style={{
                          flex: 1, padding: '8px 12px', borderRadius: '8px',
                          border: '1px solid var(--line)', background: 'var(--card)',
                          color: 'var(--text)', fontSize: '0.85rem', fontFamily: 'monospace'
                        }}
                        onChange={e => setMsg91TemplateId(e.target.value.trim())}
                      />
                      {getMsg91TemplateId()
                        ? <span style={{ color: '#16a34a', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>✅ Set</span>
                        : <span style={{ color: '#dc2626', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>⚠ Not set</span>}
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid var(--line)', paddingTop: '14px' }}>
                    <p style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '6px', color: 'var(--text)' }}>
                      🔑 MSG91 Sender ID
                    </p>
                    <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '8px' }}>
                      Enter the exact Sender ID registered and approved in your{' '}
                      <strong>MSG91 Dashboard → SMS → Sender ID</strong>.
                      This must match exactly — copy it from the MSG91 website.
                    </p>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input
                        id="msg91-sender-id"
                        type="text"
                        placeholder="e.g. 8956455702"
                        defaultValue={getMsg91SenderId()}
                        style={{
                          flex: 1, padding: '8px 12px', borderRadius: '8px',
                          border: '1px solid var(--line)', background: 'var(--card)',
                          color: 'var(--text)', fontSize: '0.85rem', fontFamily: 'monospace'
                        }}
                        onChange={e => setMsg91SenderId(e.target.value.trim())}
                      />
                      {getMsg91SenderId()
                        ? <span style={{ color: '#16a34a', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>✅ Set</span>
                        : <span style={{ color: '#dc2626', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>⚠ Not set</span>}
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid var(--line)', paddingTop: '14px' }}>
                    <p style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '6px', color: 'var(--text)' }}>
                      🏢 DLT Entity / PE ID
                    </p>
                    <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '8px' }}>
                      Your registered <strong>Principal Entity ID</strong> from the DLT portal (e.g. Jio, Airtel, Vi).
                      Required by TRAI — sent as <code>PE_ID</code> in every MSG91 request.
                    </p>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input
                        id="msg91-pe-id"
                        type="text"
                        placeholder="e.g. 895645"
                        defaultValue={getMsg91PeId()}
                        style={{
                          flex: 1, padding: '8px 12px', borderRadius: '8px',
                          border: '1px solid var(--line)', background: 'var(--card)',
                          color: 'var(--text)', fontSize: '0.85rem', fontFamily: 'monospace'
                        }}
                        onChange={e => setMsg91PeId(e.target.value.trim())}
                      />
                      {getMsg91PeId()
                        ? <span style={{ color: '#16a34a', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>✅ Set</span>
                        : <span style={{ color: '#dc2626', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>⚠ Not set</span>}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}

        {activeTab === 'stats' && (
          <div className="screen-grid">
            <section className="score-panel">
              <div>
                <p className="eyebrow">Streak</p>
                <h2>{streak} days</h2>
              </div>
              <div>
                <p className="eyebrow">XP</p>
                <h2>{xp}</h2>
              </div>
            </section>

            <section className="chart-panel">
              <div className="section-heading">
                <h2>Weekly intake</h2>
                <span>{formatLiters(week.reduce((a, b) => a + b, 0) / 7)} avg</span>
              </div>
              <div className="bars">
                {week.map((value, index) => (
                  <div key={`${value}-${index}`}>
                    <span style={{ height: `${Math.max((value / goal) * 100, 12)}%` }}></span>
                    <small>{['M', 'T', 'W', 'T', 'F', 'S', 'S'][index]}</small>
                  </div>
                ))}
              </div>
            </section>

            <section className="badges-panel">
              <h2>Achievements</h2>
              <div className="badges">
                {[
                  { title: '3 Day Streak', active: streak >= 3 },
                  { title: 'Morning Starter', active: logs.some((entry) => entry.time < '10:00') },
                  { title: 'Goal Crusher', active: total >= goal },
                  { title: 'Hydration Pro', active: isPremium },
                ].map((badge) => (
                  <div className={badge.active ? 'earned' : ''} key={badge.title}>
                    <span></span>
                    <strong>{badge.title}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="settings-panel">
              <div className="section-heading">
                <h2>Theme</h2>
                <select value={theme} onChange={(event) => setTheme(event.target.value)}>
                  <option>Lagoon</option>
                  <option>Mint</option>
                  <option>Coral</option>
                </select>
              </div>
              <button className="primary-action" type="button" onClick={exportData}>
                Export CSV
              </button>
            </section>
          </div>
        )}

        {activeTab === 'premium' && (
          <div className="screen-grid">
            <section className="premium-panel">
              <p className="eyebrow">Premium Status</p>
              {isPremium ? (
                <div className="premium-status-box">
                  <div className="premium-badge-active">✨ Premium Active</div>
                  <h2>You've unlocked the full experience!</h2>
                  <p className="premium-desc">
                    Your active plan is <strong>{premiumPlan}</strong>.
                    This subscription is verified in realtime with the phpMyAdmin database.
                  </p>
                  {formattedExpiry && (
                    <div className="premium-expiry-info">
                      📅 Valid until: <strong>{formattedExpiry}</strong>
                    </div>
                  )}
                  <button
                    className="secondary-action"
                    type="button"
                    style={{ marginTop: '20px', width: '100%', borderColor: 'rgba(255, 100, 100, 0.4)', color: '#ff6464' }}
                    onClick={handleDowngradePremium}
                  >
                    Downgrade to Free Plan
                  </button>
                </div>
              ) : (
                <>
                  <h2>Build a habit that actually sticks.</h2>
                  <p>Smart reminders, advanced analytics, custom goals, widgets, themes and export tools.</p>
                  <div className="pricing">
                    <button type="button" onClick={() => handleUpgradePremium('Monthly')}>
                      <span>Monthly</span>
                      <strong>Rs 199</strong>
                    </button>
                    <button type="button" onClick={() => handleUpgradePremium('Yearly')}>
                      <span>Yearly</span>
                      <strong>Rs 999</strong>
                    </button>
                  </div>
                  <button className="primary-action" type="button" onClick={() => handleUpgradePremium('Monthly')}>
                    Start premium
                  </button>
                </>
              )}
            </section>

            <section className="feature-panel">
              {[
                'Smart hydration reminders',
                'Advanced analytics',
                'Custom daily goals',
                'Widgets',
                'Premium themes',
                'Export data',
              ].map((feature) => (
                <div key={feature}>
                  <span></span>
                  <p>{feature}</p>
                </div>
              ))}
            </section>
          </div>
        )}

        {activeTab === 'bulk-sms' && (
          <BulkSms />
        )}
      </section>
    </main>
  )
}

export default App
