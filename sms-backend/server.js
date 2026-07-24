require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 5000;

// ── TWILIO CONFIG ─────────────────────────────────────────────────
const fromNumber = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_PHONE || process.env.TWILIO_FROM_SMS;
const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const apiKeySid = process.env.TWILIO_API_KEY_SID;
const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
const dataDir = path.join(__dirname, 'data');
const sendHistoryFile = path.join(dataDir, 'sms-history.json');

function createTwilioClient() {
  if (apiKeySid && apiKeySecret && accountSid) {
    return twilio(apiKeySid, apiKeySecret, { accountSid });
  }
  if (accountSid && authToken && accountSid.startsWith('AC')) {
    return twilio(accountSid, authToken);
  }
  return null;
}

const twilioClient = createTwilioClient();

// ── MSG91 CONFIG ──────────────────────────────────────────────────
const msg91AuthKey   = process.env.MSG91_AUTH_KEY    || '548199AF2QjGjmXu6a4ca37eP1';
const msg91SenderId  = process.env.MSG91_SENDER_ID   || '8956455702';
const msg91TemplateId = process.env.MSG91_TEMPLATE_ID || '';
// DLT Principal Entity ID (PE ID) — registered with TRAI. Required alongside DLT_TE_ID.
const msg91PeId      = process.env.MSG91_PE_ID       || '895645';

async function sendMsg91Sms(to, message, templateId, peId) {
  let mobile = to.replace(/[^\d]/g, '');
  // Indian 10-digit format fallback
  if (mobile.length === 10 && /^[6-9]/.test(mobile)) {
    mobile = '91' + mobile;
  }

  const payload = {
    sender: msg91SenderId,
    route: '4', // Transactional
    country: '91',
    sms: [{ message, to: [mobile] }]
  };

  // DLT_TE_ID = DLT Template ID (exact MSG91 v2 API field name)
  const tid = templateId || msg91TemplateId;
  if (tid) payload.DLT_TE_ID = tid;

  // PE_ID = Principal Entity ID (exact MSG91 v2 API field name)
  const pid = peId || msg91PeId;
  if (pid) payload.PE_ID = pid;

  console.log(`📤 MSG91 payload for ${mobile}:`, JSON.stringify(payload));

  const response = await fetch('https://api.msg91.com/api/v2/sendsms', {
    method: 'POST',
    headers: {
      'authkey': msg91AuthKey,
      'content-type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  console.log(`MSG91 response for ${mobile}:`, JSON.stringify(data));
  return data;
}

// ── MYSQL POOL ────────────────────────────────────────────────────
let wlPool = null;
let smsPool = null;

async function initDB() {
  const baseConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  };

  // Create waterllama pool
  wlPool = mysql.createPool({ ...baseConfig, database: process.env.DB_NAME_WATERLLAMA || 'waterllama' });
  // Create sms_sender pool
  smsPool = mysql.createPool({ ...baseConfig, database: process.env.DB_NAME_SMS || 'sms_sender' });

  // Create waterllama tables
  await wlPool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
      name VARCHAR(100) NOT NULL DEFAULT 'User',
      phone VARCHAR(20),
      notification_method ENUM('WhatsApp', 'SMS') NOT NULL DEFAULT 'WhatsApp',
      reminders_on TINYINT(1) NOT NULL DEFAULT 1,
      reminder_gap_hours INT NOT NULL DEFAULT 2,
      theme ENUM('Lagoon', 'Mint', 'Coral') NOT NULL DEFAULT 'Lagoon',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await wlPool.execute(`
    CREATE TABLE IF NOT EXISTS goals (
      id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
      user_id VARCHAR(36) NOT NULL,
      daily_goal_ml INT NOT NULL DEFAULT 2500,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await wlPool.execute(`
    CREATE TABLE IF NOT EXISTS water_entries (
      id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
      user_id VARCHAR(36) NOT NULL,
      entry_date DATE NOT NULL,
      entry_time VARCHAR(10) NOT NULL,
      drink_type ENUM('Water', 'Tea', 'Coffee', 'Juice') NOT NULL DEFAULT 'Water',
      amount_ml INT NOT NULL,
      hydration_credit_ml INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await wlPool.execute(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
      user_id VARCHAR(36) NOT NULL,
      plan ENUM('Free', 'Monthly', 'Yearly') NOT NULL DEFAULT 'Free',
      status ENUM('active', 'cancelled', 'expired') NOT NULL DEFAULT 'active',
      price_inr INT NOT NULL DEFAULT 0,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await wlPool.execute(`
    CREATE TABLE IF NOT EXISTS reminder_logs (
      id VARCHAR(36) PRIMARY KEY DEFAULT (UUID()),
      user_id VARCHAR(36) NOT NULL,
      method ENUM('WhatsApp', 'SMS') NOT NULL,
      phone VARCHAR(20) NOT NULL,
      message TEXT NOT NULL,
      status ENUM('sent', 'failed') NOT NULL,
      provider_sid VARCHAR(50),
      error_message TEXT,
      sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Create sms_sender tables
  await smsPool.execute(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20) NOT NULL UNIQUE,
      \`group\` VARCHAR(50) DEFAULT 'General',
      status ENUM('active', 'inactive') DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await smsPool.execute(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_name VARCHAR(200),
      sender_name VARCHAR(100),
      message TEXT NOT NULL,
      total_sent INT DEFAULT 0,
      total_delivered INT DEFAULT 0,
      total_failed INT DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await smsPool.execute(`
    CREATE TABLE IF NOT EXISTS campaign_results (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_id INT NOT NULL,
      phone VARCHAR(20) NOT NULL,
      success TINYINT(1) DEFAULT 0,
      provider_sid VARCHAR(100),
      error_message TEXT,
      sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
    )
  `);

  await smsPool.execute(`
    CREATE TABLE IF NOT EXISTS templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('✅ MySQL tables created/verified in waterllama and sms_sender databases');
}

// ── HELPER FUNCTIONS ──────────────────────────────────────────────
async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

function isPhoneNumber(value) {
  return /^\+\d{10,15}$/.test(value || '');
}

function buildMessageOptions(phone, message) {
  const options = { body: message, to: phone };
  if (messagingServiceSid) {
    options.messagingServiceSid = messagingServiceSid;
  } else {
    options.from = fromNumber;
  }
  return options;
}

// ── WATERLLAMA ROUTES ─────────────────────────────────────────────

// Check MySQL database tables (for phpMyAdmin setup)
app.get('/wl/check-tables', async (req, res) => {
  try {
    if (!wlPool) {
      return res.json({ ok: false, notConfigured: true, tables: [] });
    }

    const tableNames = [
      { key: 'users', label: 'Users' },
      { key: 'water_entries', label: 'Water Entries' },
      { key: 'goals', label: 'Goals' },
      { key: 'subscriptions', label: 'Subscriptions' },
      { key: 'reminder_logs', label: 'Reminder Logs' },
    ];

    const results = await Promise.all(
      tableNames.map(async ({ key, label }) => {
        try {
          await wlPool.execute(`SELECT 1 FROM \`${key}\` LIMIT 1`);
          return { name: key, label, exists: true, errorCode: null };
        } catch (error) {
          // MySQL error code 1146 = table doesn't exist
          const exists = error.code !== 'ER_NO_SUCH_TABLE' && error.errno !== 1146;
          return { name: key, label, exists, errorCode: error.code ?? null };
        }
      }),
    );

    res.json({
      ok: results.every((t) => t.exists),
      tables: results,
    });
  } catch (err) {
    console.error('Check tables error:', err);
    res.status(500).json({ ok: false, error: err.message, tables: [] });
  }
});

// Load full user profile (or create if new)
app.post('/wl/load-profile', async (req, res) => {
  try {
    const { userId } = req.body;
    let user = null;

    if (userId) {
      const [rows] = await wlPool.execute('SELECT * FROM users WHERE id = ?', [userId]);
      user = rows[0] || null;
    }

    if (!user) {
      const id = require('crypto').randomUUID();
      await wlPool.execute(
        `INSERT INTO users (id, name, phone, notification_method) VALUES (?, ?, ?, ?)`,
        [id, 'User', '', 'WhatsApp']
      );
      await wlPool.execute(
        `INSERT INTO goals (id, user_id, daily_goal_ml) VALUES (?, ?, ?)`,
        [require('crypto').randomUUID(), id, 2500]
      );
      await wlPool.execute(
        `INSERT INTO subscriptions (id, user_id, plan, status, price_inr) VALUES (?, ?, ?, ?, ?)`,
        [require('crypto').randomUUID(), id, 'Free', 'active', 0]
      );
      const [newRows] = await wlPool.execute('SELECT * FROM users WHERE id = ?', [id]);
      user = newRows[0];
    }

    const [[goal]] = await wlPool.execute(
      'SELECT * FROM goals WHERE user_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1',
      [user.id]
    );

    const [entries] = await wlPool.execute(
      'SELECT * FROM water_entries WHERE user_id = ? ORDER BY created_at DESC',
      [user.id]
    );

    const [[sub]] = await wlPool.execute(
      "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1",
      [user.id]
    );

    res.json({
      userId: user.id,
      userName: user.name,
      phone: user.phone || '',
      notificationMethod: user.notification_method,
      remindersOn: Boolean(user.reminders_on),
      reminderGap: user.reminder_gap_hours,
      theme: user.theme,
      goal: goal?.daily_goal_ml ?? 2500,
      logs: entries.map(e => ({
        id: e.id,
        amount: e.amount_ml,
        time: e.entry_time,
        type: e.drink_type,
        date: e.entry_date instanceof Date
          ? e.entry_date.toISOString().slice(0, 10)
          : String(e.entry_date).slice(0, 10)
      })),
      isPremium: sub?.plan === 'Monthly' || sub?.plan === 'Yearly',
      premiumPlan: sub?.plan || 'Free',
      premiumExpiry: sub?.expires_at || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Save user profile
app.post('/wl/save-profile', async (req, res) => {
  try {
    const { userId, userName, phone, notificationMethod, remindersOn, reminderGap, theme, goal, isPremium, premiumPlan, premiumExpiry } = req.body;

    await wlPool.execute(
      `UPDATE users SET name=?, phone=?, notification_method=?, reminders_on=?, reminder_gap_hours=?, theme=?, updated_at=NOW() WHERE id=?`,
      [userName, phone, notificationMethod, remindersOn ? 1 : 0, reminderGap, theme, userId]
    );

    // Update goal
    const [goalRows] = await wlPool.execute('SELECT id FROM goals WHERE user_id=? AND active=1 LIMIT 1', [userId]);
    if (goalRows[0]) {
      await wlPool.execute('UPDATE goals SET daily_goal_ml=?, updated_at=NOW() WHERE id=?', [goal, goalRows[0].id]);
    } else {
      await wlPool.execute('INSERT INTO goals (id, user_id, daily_goal_ml) VALUES (?, ?, ?)', [require('crypto').randomUUID(), userId, goal]);
    }

    // Update subscription
    const plan = isPremium ? (premiumPlan === 'Free' ? 'Monthly' : premiumPlan) : 'Free';
    const price = plan === 'Monthly' ? 199 : plan === 'Yearly' ? 999 : 0;
    const [subRows] = await wlPool.execute("SELECT id FROM subscriptions WHERE user_id=? AND status='active' LIMIT 1", [userId]);
    if (subRows[0]) {
      await wlPool.execute('UPDATE subscriptions SET plan=?, price_inr=?, expires_at=? WHERE id=?', [plan, price, premiumExpiry || null, subRows[0].id]);
    } else {
      await wlPool.execute('INSERT INTO subscriptions (id, user_id, plan, status, price_inr, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [require('crypto').randomUUID(), userId, plan, 'active', price, premiumExpiry || null]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Add water entry
app.post('/wl/add-entry', async (req, res) => {
  try {
    const { userId, entry, hydrationCredit } = req.body;
    const id = require('crypto').randomUUID();
    await wlPool.execute(
      'INSERT INTO water_entries (id, user_id, entry_date, entry_time, drink_type, amount_ml, hydration_credit_ml) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, userId, entry.date, entry.time, entry.type, entry.amount, hydrationCredit]
    );
    res.json({ id, amount: entry.amount, time: entry.time, type: entry.type, date: entry.date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete all water entries for a user
app.delete('/wl/entries/:userId', async (req, res) => {
  try {
    await wlPool.execute('DELETE FROM water_entries WHERE user_id=?', [req.params.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Log reminder
app.post('/wl/log-reminder', async (req, res) => {
  try {
    const { userId, method, phone, message, status, providerSid, errorMessage } = req.body;
    await wlPool.execute(
      'INSERT INTO reminder_logs (id, user_id, method, phone, message, status, provider_sid, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [require('crypto').randomUUID(), userId, method, phone, message, status, providerSid || null, errorMessage || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TWILIO SMS (BULK) ROUTES ──────────────────────────────────────
app.get('/sender-status', async (req, res) => {
  if (!twilioClient) return res.status(503).json({ error: 'Twilio not configured', ready: false });
  try {
    const [numbers, services] = await Promise.all([
      twilioClient.incomingPhoneNumbers.list({ limit: 100 }),
      twilioClient.messaging.v1.services.list({ limit: 100 })
    ]);
    const ownedNumbers = numbers.map(n => ({ phoneNumber: n.phoneNumber, friendlyName: n.friendlyName }));
    const messagingServices = services.map(s => ({ sid: s.sid, friendlyName: s.friendlyName }));
    const fromNumberIsOwned = Boolean(fromNumber) && ownedNumbers.some(n => n.phoneNumber === fromNumber);
    const messagingServiceExists = Boolean(messagingServiceSid) && messagingServices.some(s => s.sid === messagingServiceSid);
    res.json({ configuredFrom: fromNumber, ownedNumbers, messagingServices, fromNumberIsOwned, messagingServiceExists, ready: fromNumberIsOwned || messagingServiceExists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/send-history', async (req, res) => {
  try {
    const [rows] = await smsPool.execute('SELECT c.*, GROUP_CONCAT(cr.phone) as recipient_list FROM campaigns c LEFT JOIN campaign_results cr ON c.id=cr.campaign_id GROUP BY c.id ORDER BY c.sent_at DESC LIMIT 50');
    res.json(rows.map(r => ({
      id: r.id,
      name: r.name || r.campaign_name || 'Campaign',
      preview: r.message,
      sent: r.total_sent,
      delivered: r.total_delivered,
      failed: r.total_failed,
      timestamp: r.sent_at || r.created_at,
      provider: 'Twilio'
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/send-bulk-sms', async (req, res) => {
  const { recipients, message, senderName, _twilioSid, _twilioToken, _twilioFrom } = req.body;
  if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
    return res.status(400).json({ error: 'Request body must include recipients array and message.' });
  }

  const client = (_twilioSid && _twilioToken) ? twilio(_twilioSid, _twilioToken) : twilioClient;
  const from = _twilioFrom || fromNumber || '+16187536219';

  if (!client || !from) {
    return res.status(503).json({ error: 'Twilio SMS service not configured.' });
  }

  const results = [];
  for (const phone of recipients) {
    let cleanPhone = phone.replace(/[^\d+]/g, '');
    if (!cleanPhone.startsWith('+')) {
      cleanPhone = cleanPhone.startsWith('91') ? '+' + cleanPhone : '+91' + cleanPhone;
    }

    try {
      const smsPayload = { to: cleanPhone, body: message };
      if (messagingServiceSid) smsPayload.messagingServiceSid = messagingServiceSid;
      else smsPayload.from = from;

      const twMsg = await client.messages.create(smsPayload);
      results.push({
        phone: cleanPhone,
        success: true,
        delivered: true,
        sid: twMsg.sid,
        status: twMsg.status,
        note: 'Sent via Twilio.'
      });
    } catch (err) {
      let friendlyError = err.message || 'Twilio SMS error';
      if (err.code === 21608) {
        friendlyError = 'Cannot send to unverified number (Twilio trial). Verify caller ID in Twilio console.';
      } else if (err.code === 21211) {
        friendlyError = 'Invalid phone number format. Use international E.164 format (+919876543210).';
      }
      results.push({
        phone: cleanPhone,
        success: false,
        error: friendlyError,
        code: err.code
      });
    }
  }

  // Save to MySQL
  const delivered = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  let campaignId = null;
  try {
    const [campaignResult] = await smsPool.execute(
      'INSERT INTO campaigns (name, sender_name, message, total_recipients, total_sent, total_delivered, total_failed) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [senderName || 'Campaign', senderName || 'Aqualama', message, results.length, results.length, delivered, failed]
    );
    campaignId = campaignResult.insertId;
    for (const r of results) {
      await smsPool.execute(
        'INSERT INTO campaign_results (campaign_id, phone, success, provider_sid, error_message) VALUES (?, ?, ?, ?, ?)',
        [campaignId, r.phone, r.success ? 1 : 0, r.sid || null, r.error || null]
      );
    }
  } catch (dbErr) {
    console.error('MySQL logging failed:', dbErr.message);
  }

  // Also save to local JSON as backup
  try {
    const history = await readJsonFile(sendHistoryFile, []);
    await writeJsonFile(sendHistoryFile, [{ id: campaignId || Date.now(), message, sent: results.length, delivered, failed, timestamp: new Date().toISOString() }, ...history].slice(0, 100));
  } catch (jsonErr) {
    console.error('JSON logging failed:', jsonErr.message);
  }

  res.json(results);
});

// ── WHATSAPP DIRECT SEND (via Twilio WhatsApp API) ───────────────
app.post('/send-whatsapp', async (req, res) => {
  const { to, message, userId } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required.' });
  }
  if (!twilioClient) {
    return res.status(503).json({ error: 'Twilio not configured on server.' });
  }

  // Format: Twilio WhatsApp requires "whatsapp:+E164" prefix
  const waTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const waFrom = process.env.TWILIO_WHATSAPP_FROM
    ? `whatsapp:${process.env.TWILIO_WHATSAPP_FROM}`
    : `whatsapp:${fromNumber}`;

  try {
    const msg = await twilioClient.messages.create({
      from: waFrom,
      to: waTo,
      body: message,
    });

    // Log to reminder_logs if userId provided
    if (userId && wlPool) {
      await wlPool.execute(
        'INSERT INTO reminder_logs (id, user_id, method, phone, message, status, provider_sid) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [require('crypto').randomUUID(), userId, 'WhatsApp', to, message, 'sent', msg.sid]
      );
    }

    res.json({ ok: true, sid: msg.sid });
  } catch (err) {
    console.error('WhatsApp send error:', err.message);

    if (userId && wlPool) {
      await wlPool.execute(
        'INSERT INTO reminder_logs (id, user_id, method, phone, message, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [require('crypto').randomUUID(), userId, 'WhatsApp', to, message, 'failed', err.message]
      );
    }

    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── CONTACTS API ──────────────────────────────────────────────────
app.get('/contacts', async (req, res) => {
  try {
    const [rows] = await smsPool.execute('SELECT * FROM contacts ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/contacts', async (req, res) => {
  try {
    const { name, phone, grp } = req.body;
    const [result] = await smsPool.execute('INSERT INTO contacts (name, phone, `group`) VALUES (?, ?, ?)', [name, phone, grp || 'General']);
    res.json({ id: result.insertId, name, phone, grp: grp || 'General', status: 'active' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/contacts/:id', async (req, res) => {
  try {
    await smsPool.execute('DELETE FROM contacts WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TEMPLATES API ─────────────────────────────────────────────────
app.get('/templates', async (req, res) => {
  try {
    const [rows] = await smsPool.execute('SELECT * FROM templates ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/templates', async (req, res) => {
  try {
    const { name, content } = req.body;
    const [result] = await smsPool.execute('INSERT INTO templates (name, content) VALUES (?, ?)', [name, content]);
    res.json({ id: result.insertId, name, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/templates/:id', async (req, res) => {
  try {
    await smsPool.execute('DELETE FROM templates WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AUTOMATIC BACKGROUND REMINDERS CHECK LOOP ─────────────────────
// WhatsApp reminders are handled by the frontend (wa.me link - previous service).
// This loop only handles SMS users automatically via Twilio.

// In-memory cooldown: skip a user for 1 hour after any Twilio send failure
const smsCooldown = new Map(); // userId -> timestamp when cooldown expires

async function checkAndSendReminders() {
  if (!wlPool) return;
  try {
    // Only fetch SMS users — WhatsApp is handled by frontend wa.me countdown
    const [users] = await wlPool.execute(
      "SELECT * FROM users WHERE reminders_on = 1 AND phone IS NOT NULL AND phone != '' AND notification_method = 'SMS'"
    );

    for (const user of users) {
      // Skip users in cooldown (after a Twilio failure, wait 1 hour before retrying)
      const cooldownUntil = smsCooldown.get(user.id);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        console.log(`⏳ SMS cooldown active for ${user.name} — skipping until ${new Date(cooldownUntil).toLocaleTimeString()}`);
        continue;
      }

      // Get last sent reminder for this user
      const [logs] = await wlPool.execute(
        "SELECT sent_at FROM reminder_logs WHERE user_id = ? ORDER BY sent_at DESC LIMIT 1",
        [user.id]
      );

      const baseTime = logs[0] ? new Date(logs[0].sent_at) : new Date(user.created_at);
      const diffMs = Date.now() - baseTime.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      if (diffHours < user.reminder_gap_hours) continue; // Not time yet

      // Build personalised message with today's progress
      const [[goal]] = await wlPool.execute(
        "SELECT daily_goal_ml FROM goals WHERE user_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1",
        [user.id]
      );
      const dailyGoal = goal ? goal.daily_goal_ml : 2500;
      const today = new Date().toISOString().slice(0, 10);
      const [entries] = await wlPool.execute(
        "SELECT SUM(hydration_credit_ml) as total FROM water_entries WHERE user_id = ? AND entry_date = ?",
        [user.id, today]
      );
      const totalIntake = entries[0]?.total || 0;
      const progress = Math.min(100, Math.round((totalIntake / dailyGoal) * 100));
      const message = `Hi ${user.name}, time to drink water! You have completed ${progress}% of your ${(dailyGoal / 1000).toFixed(1)}L hydration goal today. Keep it up! 💧`;

      if (!twilioClient || (!fromNumber && !messagingServiceSid)) {
        console.warn('⚠️ Twilio client not configured — skipping auto SMS reminder.');
        continue;
      }

      console.log(`⏰ Sending automatic SMS reminder to ${user.name} (${user.phone})`);

      try {
        let cleanPhone = user.phone.replace(/[^\d+]/g, '');
        if (!cleanPhone.startsWith('+')) {
          cleanPhone = cleanPhone.startsWith('91') ? '+' + cleanPhone : '+91' + cleanPhone;
        }

        const smsPayload = { to: cleanPhone, body: message };
        if (messagingServiceSid) smsPayload.messagingServiceSid = messagingServiceSid;
        else smsPayload.from = fromNumber || '+16187536219';

        const twMsg = await twilioClient.messages.create(smsPayload);
        smsCooldown.delete(user.id);

        await wlPool.execute(
          "INSERT INTO reminder_logs (id, user_id, method, phone, message, status, provider_sid) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [require('crypto').randomUUID(), user.id, 'SMS', user.phone, message, 'sent', twMsg.sid]
        );
        console.log(`✅ Auto SMS reminder sent to ${user.phone} via Twilio (SID: ${twMsg.sid})`);
      } catch (err) {
        // Set 1-hour cooldown so we don't hammer MSG91 on other errors
        smsCooldown.set(user.id, Date.now() + 60 * 60 * 1000);

        await wlPool.execute(
          "INSERT INTO reminder_logs (id, user_id, method, phone, message, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [require('crypto').randomUUID(), user.id, 'SMS', user.phone, message, 'failed', err.message]
        );
        console.error(`❌ Auto SMS reminder failed for ${user.phone}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('❌ Error in automatic reminders loop:', err.message);
  }
}

// Check every 10 seconds
setInterval(checkAndSendReminders, 10000);

// ── START ─────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log(`✅ Connected to MySQL: waterllama + sms_sender databases`);
    });
  })
  .catch(err => {
    console.error('❌ Failed to connect to MySQL:', err.message);
    process.exit(1);
  });
