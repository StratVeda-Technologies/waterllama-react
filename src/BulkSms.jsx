import { useState, useEffect } from 'react'
import { sendBulkSmsViaEdge, sendBulkWhatsAppViaEdge, sendReminderViaEdge, isSupabaseConfigured, normalizePhoneNumber, getTwilioConfig, setTwilioConfig } from './mysqlClient'
import './BulkSms.css'

const DEFAULT_CONTACTS = [
  { id: 1, name: 'Kailash', phone: '+919876543210', group: 'VIP', status: 'active', selected: true },
  { id: 2, name: 'Rahul Sharma', phone: '+919876543211', group: 'Leads', status: 'active', selected: true },
  { id: 3, name: 'Priya Patel', phone: '+919876543212', group: 'VIP', status: 'active', selected: false },
  { id: 4, name: 'Amit Kumar', phone: '+919876543213', group: 'General', status: 'active', selected: false }
]

const DEFAULT_TEMPLATES = [
  { id: 1, name: 'Standard Reminder', content: 'Hi {name}, hope you are staying hydrated today! Log your water intake in Aqualama.' },
  { id: 2, name: 'Premium Special offer', content: 'Hey {name}! Get 50% off Aqualama Premium this weekend only. Go to the Premium tab now!' },
  { id: 3, name: 'Goal Streak Motivation', content: 'Stay strong {name}! You are close to hitting your daily water target today. Keep tracking!' }
]

const STORAGE_KEYS = {
  contacts: 'blastSms.contacts',
  templates: 'blastSms.templates',
  history: 'blastSms.history',
}

function loadStoredData(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch (error) {
    return fallback
  }
}

function saveStoredData(key, data) {
  localStorage.setItem(key, JSON.stringify(data))
}

function isValidPhone(value) {
  return /^\+\d{10,15}$/.test(value || '')
}

export default function BulkSms() {
  const [activeSubTab, setActiveSubTab] = useState('compose')
  const [backendReady, setBackendReady] = useState(false)

  // Compose state
  const [message, setMessage] = useState('')
  const [senderName, setSenderName] = useState('Aqualama')
  const [campaignName, setCampaignName] = useState('Hydration Push Campaign')
  const [messageType, setMessageType] = useState('sms') // 'sms'

  // Contacts state
  const [contacts, setContacts] = useState(() => loadStoredData(STORAGE_KEYS.contacts, DEFAULT_CONTACTS))

  // Templates state
  const [templates, setTemplates] = useState(() => loadStoredData(STORAGE_KEYS.templates, DEFAULT_TEMPLATES))

  // History state
  const [history, setHistory] = useState(() => loadStoredData(STORAGE_KEYS.history, []))

  // Modal / Sending state
  const [showSendModal, setShowSendModal] = useState(false)
  const [sendingProgress, setSendingProgress] = useState(0)
  const [isSending, setIsSending] = useState(false)
  const [sendResult, setSendResult] = useState(null)

  // Twilio state
  const initialTwilio = getTwilioConfig()
  const [twilioSid, setTwilioSid] = useState(initialTwilio.sid)
  const [twilioToken, setTwilioToken] = useState(initialTwilio.token)
  const [twilioFrom, setTwilioFrom] = useState(initialTwilio.from)

  // Check Supabase availability on mount
  useEffect(() => {
    const supabaseReady = isSupabaseConfigured();
    if (supabaseReady) {
      setBackendReady(true);
    } else {
      setBackendReady(false);
    }
  }, []);

  // Save contacts to localStorage
  useEffect(() => {
    saveStoredData(STORAGE_KEYS.contacts, contacts)
  }, [contacts])

  // Save templates to localStorage
  useEffect(() => {
    saveStoredData(STORAGE_KEYS.templates, templates)
  }, [templates])

  // Save history to localStorage
  useEffect(() => {
    saveStoredData(STORAGE_KEYS.history, history)
  }, [history])

  // Toggle single contact selection
  const toggleContactSelection = (id) => {
    setContacts(prev => prev.map(c => c.id === id ? { ...c, selected: !c.selected } : c))
  }

  // Select/Deselect all
  const toggleSelectAll = (checked) => {
    setContacts(prev => prev.map(c => ({ ...c, selected: checked })))
  }

  // Add Contact
  const [showAddContact, setShowAddContact] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [countryCode, setCountryCode] = useState('+91')
  const [newGroup, setNewGroup] = useState('General')

  const handleAddContact = () => {
    if (!newName || !newPhone) return
    const phoneNum = `${countryCode}${newPhone}`
    if (!isValidPhone(phoneNum)) {
      alert(`Please enter a valid mobile number with country code (${countryCode})`)
      return
    }
    const newContact = {
      id: Date.now(),
      name: newName,
      phone: phoneNum,
      group: newGroup,
      status: 'active',
      selected: true
    }
    setContacts(prev => [...prev, newContact])
    setNewName('')
    setNewPhone('')
    setShowAddContact(false)
  }

  const handleDeleteContact = (id) => {
    setContacts(prev => prev.filter(c => c.id !== id))
  }

  // templates
  const useTemplate = (content) => {
    setMessage(content)
    setActiveSubTab('compose')
  }

  const deleteTemplate = (id) => {
    setTemplates(prev => prev.filter(t => t.id !== id))
  }

  const addTemplate = () => {
    const title = prompt('Template Name:')
    const text = prompt('Template content (use {name} for variable):')
    if (!title || !text) return
    setTemplates(prev => [...prev, { id: Date.now(), name: title, content: text }])
  }

  // Get active recipients
  const rawRecipients = contacts.filter(c => c.selected).map(c => c.phone)
  // Normalize phone numbers to E.164 format
  const recipients = rawRecipients.map(normalizePhoneNumber)

  // Send campaign handler - WhatsApp via wa.me (client-side), SMS via Supabase Edge Functions
  const handleSendCampaign = async () => {
    if (recipients.length === 0) {
      alert('Please select at least one recipient.')
      return
    }
    if (!message.trim()) {
      alert('Please write a message.')
      return
    }

    // For SMS, verify that at least one backend is available (local server at 5000 is default fallback)
    // No longer blocks since we have local backend fallback.

    setIsSending(true)
    setSendingProgress(10)
    setShowSendModal(true)

    try {
      setSendingProgress(30)

      // Personalize message for each recipient
      const personalizedRecipients = recipients.map(phone => {
        const contact = contacts.find(c => c.phone === phone)
        return {
          phone,
          message: message.replace(/{name}/g, contact?.name || 'there'),
        }
      })

      let results = []
      let waLinks = undefined

      if (messageType === 'whatsapp') {
        const result = await sendBulkWhatsAppViaEdge({
          recipients: personalizedRecipients.map(r => r.phone),
          message,
          senderName,
        })
        if (!result.ok) {
          throw new Error(result.error || 'Failed to send bulk WhatsApp')
        }
        results = result.results || []
        waLinks = result.waLinks
      } else {
        // Send SMS individually using the same robust service as the reminder section
        let progressStep = 50 / personalizedRecipients.length
        for (let i = 0; i < personalizedRecipients.length; i++) {
          const item = personalizedRecipients[i]
          try {
            const res = await sendReminderViaEdge({
              to: item.phone,
              method: 'SMS',
              message: item.message,
              userId: undefined
            })
            results.push({
              phone: item.phone,
              success: true,
              delivered: true,
              sid: res.sid,
              status: 'delivered'
            })
          } catch (err) {
            results.push({
              phone: item.phone,
              success: false,
              delivered: false,
              error: err.message || 'SMS delivery failed',
              code: err.code
            })
          }
          setSendingProgress(30 + Math.round((i + 1) * progressStep))
        }
      }

      setSendingProgress(100)
      const actuallyDelivered = results.filter(r => r.success === true).length
      const acceptedByTwilio = actuallyDelivered
      const failed = results.filter(r => r.success === false).length

      setSendResult({
        total: results.length,
        delivered: actuallyDelivered,
        accepted: acceptedByTwilio,
        failed,
        results,
        waLinks,
      })

      // Save to history
      const newHistoryEntry = {
        id: Date.now(),
        name: campaignName || `Campaign — ${new Date().toLocaleDateString()}`,
        preview: message.substring(0, 50) + (message.length > 50 ? '…' : ''),
        sent: results.length,
        delivered: actuallyDelivered,
        accepted: acceptedByTwilio,
        failed,
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        provider: messageType === 'whatsapp' ? 'wa.me (WhatsApp)' : 'Twilio (SMS)',
        timestamp: new Date().toISOString(),
      }
      setHistory(prev => [newHistoryEntry, ...prev].slice(0, 100))

    } catch (error) {
      setSendResult({
        error: error.message
      })
    } finally {
      setIsSending(false)
    }
  }

  const charLimit = 160
  const totalSms = Math.ceil(message.length / charLimit) || 1

  return (
    <div className="bulk-sms-container">
      <div className="sms-sidebar">
        <button
          className={`sms-nav-item ${activeSubTab === 'compose' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('compose')}
        >
          ✍️ Compose
        </button>
        <button
          className={`sms-nav-item ${activeSubTab === 'contacts' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('contacts')}
        >
          👥 Contacts ({contacts.length})
        </button>
        <button
          className={`sms-nav-item ${activeSubTab === 'templates' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('templates')}
        >
          📋 Templates
        </button>
        <button
          className={`sms-nav-item ${activeSubTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('history')}
        >
          📊 History
        </button>
      </div>

      <div className="sms-content">
        {messageType === 'sms' && !backendReady && (
          <div className="sms-warning-banner" style={{ backgroundColor: '#eff6ff', borderColor: '#bfdbfe', color: '#1e40af' }}>
            ℹ️ <b>Using Local Backend (port 5000) for Bulk SMS</b>
            <br />
            <small>
              Supabase is not configured, so SMS will be sent via your local backend Node server. Make sure the backend server is running at port 5000.
            </small>
          </div>
        )}

        {activeSubTab === 'compose' && (
          <div>
            <h2 className="sms-page-title">Compose Bulk Message</h2>
            <p className="sms-page-subtitle">
              Send bulk messages via 📱 WhatsApp (free, wa.me) or 📲 Twilio SMS to Indian (+91) numbers.
            </p>

            <div className="sms-grid">
              <div>
                <div className="sms-card">
                  <div className="sms-form-group">
                    <label>Campaign Name</label>
                    <input
                      type="text"
                      className="sms-input"
                      value={campaignName}
                      onChange={e => setCampaignName(e.target.value)}
                    />
                  </div>

                  <div className="sms-form-group">
                    <label>Sender Name / Company Name</label>
                    <input
                      type="text"
                      className="sms-input"
                      value={senderName}
                      onChange={e => setSenderName(e.target.value)}
                    />
                  </div>

                  <div className="sms-form-group">
                    <label>Channel</label>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="messageType"
                          value="sms"
                          checked={messageType === 'sms'}
                          onChange={() => setMessageType('sms')}
                        />
                        📲 Twilio SMS
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="messageType"
                          value="whatsapp"
                          checked={messageType === 'whatsapp'}
                          onChange={() => setMessageType('whatsapp')}
                        />
                        📱 WhatsApp (wa.me — free)
                      </label>
                    </div>
                    <p style={{ margin: '6px 0 0 0', fontSize: '0.78rem', color: 'var(--muted)' }}>
                      {messageType === 'whatsapp'
                        ? '💡 WhatsApp opens pre-filled chats via wa.me links — works without any backend'
                        : '💡 SMS sent via Twilio — requires active Twilio service'}
                    </p>
                  </div>

                  <div className="sms-form-group">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label>Message Content</label>
                      <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                        {message.length} chars / {totalSms} SMS
                      </span>
                    </div>
                    <textarea
                      className="sms-textarea"
                      placeholder="Type your SMS message here. Use {name} for personalization."
                      value={message}
                      onChange={e => setMessage(e.target.value)}
                    />
                    <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <button className="sms-btn sms-btn-outline" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={() => setMessage(m => m + ' {name}')}>
                        + Add {"{name}"}
                      </button>
                      <button className="sms-btn sms-btn-outline" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={() => setMessage('')}>
                        Clear Message
                      </button>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '12px' }}>
                  <button
                    className="sms-btn sms-btn-primary"
                    onClick={handleSendCampaign}
                    disabled={isSending}
                  >
                    {isSending ? '📤 Sending...' : `📤 Send Campaign to ${recipients.length} Users`}
                  </button>
                </div>
              </div>

              <div>
                <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', fontWeight: 800 }}>Message Preview</h3>
                <div className="sms-preview-phone">
                  <div className="sms-preview-header">
                    💬 {senderName || 'Aqualama'}
                  </div>
                  <div className="sms-preview-bubble">
                    {message || 'Your message preview will appear here.'}
                  </div>
                </div>

                <div style={{ marginTop: '24px' }} className="sms-card">
                  <h4 style={{ margin: '0 0 8px 0', fontSize: '0.9rem', fontWeight: 800 }}>
                    {messageType === 'whatsapp'
                      ? 'WhatsApp Cost: Free (via wa.me — client-side)'
                      : backendReady
                        ? 'SMS Cost Estimate'
                        : 'SMS: Requires Supabase + Twilio'}
                  </h4>
                  <p style={{ margin: 0, fontSize: '0.85rem' }}>
                    Recipients: <b>{recipients.length}</b>
                    <br />
                    {messageType === 'whatsapp' ? (
                      <>
                        WhatsApp messages are free — opens individual chats via wa.me links
                        <br />
                        Works without any backend configuration
                      </>
                    ) : backendReady ? (
                      <>
                        SMS Parts: <b>{totalSms}</b>
                        <br />
                        Estimated Credits: <b>{recipients.length * totalSms}</b>
                      </>
                    ) : (
                      'Configure Supabase + Twilio to enable SMS'
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeSubTab === 'contacts' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div>
                <h2 className="sms-page-title">Contact Management</h2>
                <p className="sms-page-subtitle">Manage phone lists for bulk SMS campaigns.</p>
              </div>
              <button className="sms-btn sms-btn-primary" onClick={() => setShowAddContact(true)}>
                ➕ Add Contact
              </button>
            </div>

            {showAddContact && (
              <div className="sms-card" style={{ background: 'var(--soft)', border: '1.5px solid var(--brand)' }}>
                <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem' }}>New Contact Details</h3>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <input
                    type="text"
                    placeholder="Name"
                    className="sms-input"
                    style={{ flex: 1 }}
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                    <select
                      className="sms-select"
                      style={{ width: '100px', fontWeight: 600 }}
                      value={countryCode}
                      onChange={e => setCountryCode(e.target.value)}
                    >
                      <option value="+91">🇮🇳 +91</option>
                      <option value="+1">🇺🇸 +1</option>
                      <option value="+44">🇬🇧 +44</option>
                      <option value="+61">🇦🇺 +61</option>
                      <option value="+971">🇦🇪 +971</option>
                    </select>
                    <input
                      type="tel"
                      placeholder="9876543210"
                      className="sms-input"
                      style={{ flex: 1 }}
                      value={newPhone}
                      onChange={e => setNewPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                      maxLength={10}
                    />
                  </div>
                  <select
                    className="sms-select"
                    style={{ width: '120px' }}
                    value={newGroup}
                    onChange={e => setNewGroup(e.target.value)}
                  >
                    <option value="General">General</option>
                    <option value="VIP">VIP</option>
                    <option value="Leads">Leads</option>
                  </select>
                  <button className="sms-btn sms-btn-primary" onClick={handleAddContact}>Save</button>
                  <button className="sms-btn sms-btn-outline" onClick={() => setShowAddContact(false)}>Cancel</button>
                </div>
                <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '8px', marginBottom: 0 }}>
                  Enter 10-digit Indian mobile number (auto-prefixed with +91)
                </p>
              </div>
            )}

            <table className="sms-table">
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>
                    <input
                      type="checkbox"
                      checked={contacts.length > 0 && contacts.every(c => c.selected)}
                      onChange={e => toggleSelectAll(e.target.checked)}
                    />
                  </th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Group</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map(c => (
                  <tr key={c.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={c.selected}
                        onChange={() => toggleContactSelection(c.id)}
                      />
                    </td>
                    <td><b>{c.name}</b></td>
                    <td><code>{c.phone}</code></td>
                    <td>
                      <span className={`sms-tag ${c.group.toLowerCase()}`}>{c.group}</span>
                    </td>
                    <td>
                      <span className="sms-tag active">{c.status}</span>
                    </td>
                    <td>
                      <button className="sms-btn sms-btn-danger" style={{ padding: '4px 8px', fontSize: '0.8rem' }} onClick={() => handleDeleteContact(c.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeSubTab === 'templates' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div>
                <h2 className="sms-page-title">Message Templates</h2>
                <p className="sms-page-subtitle">Save text structures for reusable campaign creation.</p>
              </div>
              <button className="sms-btn sms-btn-primary" onClick={addTemplate}>
                ➕ Create Template
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
              {templates.map(t => (
                <div className="sms-card" key={t.id}>
                  <h3 style={{ margin: '0 0 8px 0', fontSize: '1.05rem', fontWeight: 800 }}>📝 {t.name}</h3>
                  <p style={{ margin: '0 0 16px 0', fontSize: '0.85rem', color: 'var(--muted)', background: 'var(--soft)', padding: '10px', borderRadius: '8px' }}>
                    {t.content}
                  </p>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button className="sms-btn sms-btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem' }} onClick={() => useTemplate(t.content)}>
                      Use Template
                    </button>
                    <button className="sms-btn sms-btn-danger" style={{ padding: '6px 12px', fontSize: '0.8rem' }} onClick={() => deleteTemplate(t.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeSubTab === 'history' && (
          <div>
            <h2 className="sms-page-title">Campaign History</h2>
            <p className="sms-page-subtitle">Track sent campaigns and delivery analytics.</p>

            {history.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--muted)', padding: '40px' }}>No campaigns have been sent yet.</p>
            ) : (
              <div>
                {history.map((h, i) => (
                  <div className="sms-history-item" key={i}>
                    <div className="sms-history-info">
                      <div className="sms-history-meta">
                        <span style={{ fontWeight: 800, color: 'var(--brand-strong)' }}>{h.name || 'Campaign'}</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{new Date(h.timestamp || Date.now()).toLocaleString()}</span>
                      </div>
                      <span className="sms-history-text">{h.preview || h.message}</span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span className="sms-tag active" style={{ display: 'block', marginBottom: '4px' }}>
                        Delivered: {h.delivered ?? h.accepted ?? h.sent}
                      </span>
                      {h.accepted && h.accepted !== h.delivered && (
                        <span className="sms-tag vip" style={{ display: 'block', marginBottom: '4px', fontSize: '0.7rem' }}>
                          Accepted: {h.accepted}
                        </span>
                      )}
                      {h.failed > 0 && (
                        <span className="sms-tag vip" style={{ display: 'block' }}>
                          Failed: {h.failed}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {showSendModal && (
        <div className="sms-modal-overlay">
          <div className="sms-modal">
            <h3 className="sms-modal-title">Sending Bulk Campaign</h3>
            {isSending ? (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <p>{messageType === 'whatsapp'
                  ? 'Opening WhatsApp chats via wa.me links...'
                  : 'Sending messages via Supabase Edge Functions → Twilio...'}</p>
                <div style={{ background: 'var(--line)', height: '8px', borderRadius: '4px', overflow: 'hidden', marginTop: '12px' }}>
                  <div style={{ background: 'var(--brand)', height: '100%', width: `${sendingProgress}%`, transition: 'width 0.3s ease' }}></div>
                </div>
              </div>
            ) : (
              <div>
                {sendResult?.error ? (
                  <div style={{ color: '#dc2626', fontWeight: 700 }}>
                    ❌ Error: {sendResult.error}
                  </div>
                ) : (
                  <div>
                    {/* Determine overall status */}
                    {sendResult?.failed === sendResult?.total && sendResult?.total > 0 ? (
                      // All failed
                      <div>
                        <p style={{ fontWeight: 700, color: '#dc2626', marginBottom: '12px' }}>
                          ❌ Campaign Failed - No Messages Delivered
                        </p>
                        <p style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>
                          Total Sent: <b>{sendResult?.total}</b>
                          <br />
                          Accepted by Twilio: <b>{sendResult?.accepted}</b>
                          <br />
                          Actually Delivered: <b>{sendResult?.delivered}</b>
                          <br />
                          Failed: <b>{sendResult?.failed}</b>
                        </p>
                        <div style={{ marginTop: '12px', padding: '12px', background: '#fef2f2', borderRadius: '8px', border: '1px solid #fecaca' }}>
                          <p style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '8px', color: '#dc2626' }}>
                            ⚠️ Twilio Trial Account Limitation
                          </p>
                          <p style={{ fontSize: '0.8rem', color: '#991b1b', marginBottom: '8px' }}>
                            You're using a Twilio trial account. Trial accounts can <b>only send SMS to verified phone numbers</b>.
                            Add recipient numbers in Twilio Console → Phone Numbers → Verified Caller IDs.
                          </p>
                          <p style={{ fontSize: '0.8rem', color: '#991b1b' }}>
                            <b>Common error codes:</b>
                            <br/>• 21608: Unverified number (trial limitation)
                            <br/>• 21211: Invalid phone format
                            <br/>• 21614: Not a mobile number
                          </p>
                        </div>
                      </div>
                    ) : sendResult?.failed > 0 ? (
                      // Partial failure
                      <div>
                        <p style={{ fontWeight: 700, color: '#f59e0b', marginBottom: '12px' }}>
                          ⚠️ Campaign Partially Delivered
                        </p>
                        <p style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>
                          Total Sent: <b>{sendResult?.total}</b>
                          <br />
                          Accepted by Twilio: <b>{sendResult?.accepted}</b>
                          <br />
                          Actually Delivered: <b>{sendResult?.delivered}</b>
                          <br />
                          Failed: <b>{sendResult?.failed}</b>
                        </p>
                        {sendResult?.results && sendResult.results.length > 0 && (
                          <div style={{ marginTop: '12px', maxHeight: '200px', overflowY: 'auto' }}>
                            <p style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: '8px', color: '#f59e0b' }}>
                              Failed recipients:
                            </p>
                            {sendResult.results
                              .filter(r => !r.success)
                              .map((r, i) => (
                                <div key={i} style={{ fontSize: '0.75rem', color: '#dc2626', padding: '4px 8px', background: '#fef2f2', borderRadius: '4px', marginBottom: '4px' }}>
                                  <code>{r.phone}</code>: {r.error || 'Unknown error'}{r.code && ` (Code: ${r.code})`}
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    ) : (sendResult?.accepted === sendResult?.total || sendResult?.delivered === sendResult?.total) && sendResult?.total > 0 ? (
                      // All successfully sent / delivered
                      <div>
                        <p style={{ fontWeight: 700, color: '#167b58', marginBottom: '12px' }}>
                          ✅ Campaign Sent Successfully!
                        </p>
                        <p style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>
                          Total Sent: <b>{sendResult?.total}</b>
                          <br />
                          Failed: <b>{sendResult?.failed}</b>
                        </p>
                      </div>
                    ) : (
                      // Accepted but not completed
                      <div>
                        <p style={{ fontWeight: 700, color: '#1d4ed8', marginBottom: '12px' }}>
                          📤 Campaign accepted by Twilio
                        </p>
                        <p style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>
                          Total Sent: <b>{sendResult?.total}</b>
                          <br />
                          Accepted: <b>{sendResult?.accepted}</b>
                          <br />
                          Failed: <b>{sendResult?.failed}</b>
                        </p>
                      </div>
                    )}

                    {messageType === 'whatsapp' && sendResult?.waLinks && sendResult.waLinks.length > 0 && (
                      <div style={{ marginTop: '16px', padding: '12px', background: 'var(--soft)', borderRadius: '8px', border: '1px solid var(--line)' }}>
                        <p style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '8px' }}>
                          📱 WhatsApp chats opened via wa.me links
                        </p>
                        <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '8px' }}>
                          If popups were blocked, click links below to open manually:
                        </p>
                        <div style={{ maxHeight: '150px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {sendResult.waLinks.slice(0, 10).map((link, i) => (
                            <a key={i} href={link} target="_blank" rel="noopener noreferrer"
                               style={{ fontSize: '0.75rem', color: 'var(--brand)', textDecoration: 'underline', cursor: 'pointer' }}>
                              📱 Contact {i + 1} (wa.me)
                            </a>
                          ))}
                          {sendResult.waLinks.length > 10 && (
                            <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                              + {sendResult.waLinks.length - 10} more contacts...
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="sms-btn sms-btn-primary" onClick={() => setShowSendModal(false)}>Close</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}