// Supabase Edge Function — send-reminder
// Deploy: supabase functions deploy send-reminder --no-verify-jwt
//
// SMS  → MSG91 API  (authkey + sender id + template id)
// WhatsApp → Twilio (using _twilioSid/_twilioToken/_twilioFrom from request body)
//
// MSG91 credentials priority:
//   1. _msg91AuthKey / _msg91SenderId / _msg91TemplateId passed in request body
//   2. MSG91_AUTH_KEY / MSG91_SENDER_ID / MSG91_TEMPLATE_ID Supabase secrets

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip everything except digits; prepend country code if needed */
function normalizeMobile(raw: string): string {
  let cleaned = raw.replace(/[^\d+]/g, '')
  if (cleaned.startsWith('+')) cleaned = cleaned.substring(1)  // remove leading +
  if (cleaned.startsWith('00')) cleaned = cleaned.substring(2)
  // 10-digit Indian number → prepend 91
  if (cleaned.length === 10 && /^[6-9]\d{9}$/.test(cleaned)) cleaned = '91' + cleaned
  return cleaned
}

/** Send a single SMS via MSG91 v2 API */
async function sendViaMSG91(authKey: string, senderId: string, mobile: string, message: string, templateId?: string, peId?: string) {
  const payload: any = {
    sender: senderId,
    route: '4',          // 4 = transactional (DLT registered template)
    country: '91',
    sms: [{ message, to: [mobile] }],
  }
  if (templateId) {
    payload.DLT_TE_ID = templateId
  }
  if (peId) {
    payload.PE_ID = peId
  }

  const res = await fetch('https://api.msg91.com/api/v2/sendsms', {
    method: 'POST',
    headers: {
      authkey: authKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  })

  let data: any = {}
  try { data = await res.json() } catch (_) { data = { type: 'error', message: `HTTP ${res.status}` } }
  console.log('MSG91 response:', JSON.stringify(data))
  return data
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  try {
    const body = await req.json()
    const {
      to, method, message,
      _msg91AuthKey, _msg91SenderId, _msg91TemplateId, _msg91PeId, // SMS via MSG91
      _twilioSid, _twilioToken, _twilioFrom, // WhatsApp via Twilio
    } = body

    if (!to || !message) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing required fields: to, message' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const isWhatsApp = method === 'WhatsApp'

    // ── WhatsApp: Twilio ─────────────────────────────────────────────────────
    if (isWhatsApp) {
      const accountSid = _twilioSid || Deno.env.get('TWILIO_ACCOUNT_SID')
      const authToken  = _twilioToken || Deno.env.get('TWILIO_AUTH_TOKEN')
      const fromWaEnv  = Deno.env.get('TWILIO_FROM_WHATSAPP') || Deno.env.get('TWILIO_FROM_SMS') || Deno.env.get('TWILIO_PHONE_NUMBER')
      const fromWa     = _twilioFrom ? `whatsapp:${_twilioFrom}` : (fromWaEnv || 'whatsapp:+14155238886')
      const rawTo      = to.replace(/[^\d+]/g, '')
      const toWa       = `whatsapp:${rawTo.startsWith('+') ? rawTo : '+' + rawTo}`

      if (!accountSid || !authToken) {
        return new Response(
          JSON.stringify({ ok: false, error: 'Twilio credentials not configured for WhatsApp.' }),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
        )
      }

      const twilioRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + btoa(`${accountSid}:${authToken}`),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: toWa, From: fromWa, Body: message }),
        }
      )

      const twilioData = await twilioRes.json()
      if (!twilioRes.ok) {
        console.error('Twilio WhatsApp error:', twilioData)
        return new Response(
          JSON.stringify({ ok: false, error: twilioData.message ?? 'Twilio error', code: twilioData.code }),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ ok: true, sid: twilioData.sid, status: twilioData.status }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    // ── SMS: MSG91 ───────────────────────────────────────────────────────────
    const authKey    = _msg91AuthKey    || Deno.env.get('MSG91_AUTH_KEY')    || ''
    const senderId   = _msg91SenderId   || Deno.env.get('MSG91_SENDER_ID')   || '8956455702'
    const templateId = _msg91TemplateId || Deno.env.get('MSG91_TEMPLATE_ID') || ''
    const peId       = _msg91PeId       || Deno.env.get('MSG91_PE_ID')       || ''

    if (!authKey) {
      return new Response(
        JSON.stringify({ ok: false, error: 'MSG91 not configured. Set MSG91_AUTH_KEY in Supabase secrets or VITE_MSG91_AUTH_KEY in environment.' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const mobile = normalizeMobile(to)
    if (!mobile || mobile.length < 10) {
      return new Response(
        JSON.stringify({ ok: false, error: `Invalid phone number: "${to}". Use format like +919876543210.` }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const data = await sendViaMSG91(authKey, senderId, mobile, message, templateId, peId)

    if (data.type === 'success' || data.type === 'Success') {
      return new Response(
        JSON.stringify({ ok: true, status: 'sent', provider: 'msg91', requestId: data.message }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    // Map MSG91 error messages to friendly text
    let friendlyError = data.message || data.error || 'MSG91 API error'
    const errLower = friendlyError.toLowerCase()
    if (errLower.includes('authentication failed') || errLower.includes('authkey')) {
      friendlyError = 'MSG91 authentication failed. Check the authkey.'
    } else if (errLower.includes('sender') || errLower.includes('senderid')) {
      friendlyError = 'MSG91 sender ID is invalid or not approved. Check sender ID: ' + senderId
    } else if (errLower.includes('balance') || errLower.includes('credit')) {
      friendlyError = 'Insufficient MSG91 credits. Please recharge your account.'
    } else if (errLower.includes('dnd') || errLower.includes('do not disturb')) {
      friendlyError = 'Number is on DND list. MSG91 cannot deliver to this number.'
    } else if (errLower.includes('invalid mobile') || errLower.includes('invalid number')) {
      friendlyError = `Invalid mobile number "${mobile}". Use Indian format: 919876543210`
    }

    return new Response(
      JSON.stringify({ ok: false, error: friendlyError, provider: 'msg91', raw: data }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )

  } catch (err: any) {
    console.error('Edge function error:', err)
    return new Response(
      JSON.stringify({ ok: false, error: err?.message ?? 'Unknown error' }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }
})
