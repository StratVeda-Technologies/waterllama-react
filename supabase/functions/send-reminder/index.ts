// Supabase Edge Function — send-reminder
// Deploy: supabase functions deploy send-reminder
// Secrets needed (Supabase dashboard → Project → Edge Functions → Secrets):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_SMS        e.g. +14155552671
//   TWILIO_FROM_WHATSAPP   e.g. whatsapp:+14155238886  (Twilio sandbox default)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  try {
    const { to, method, message } = await req.json()

    if (!to || !message) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing required fields: to, message' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')
    const authToken  = Deno.env.get('TWILIO_AUTH_TOKEN')
    // Support both TWILIO_FROM_SMS and TWILIO_PHONE_NUMBER (whichever is set in Supabase secrets)
    const fromSms    = Deno.env.get('TWILIO_FROM_SMS') || Deno.env.get('TWILIO_PHONE_NUMBER')
    const fromWa     = Deno.env.get('TWILIO_FROM_WHATSAPP') || Deno.env.get('TWILIO_FROM_SMS') || Deno.env.get('TWILIO_PHONE_NUMBER') || 'whatsapp:+14155238886'

    if (!accountSid || !authToken) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Twilio credentials not configured in Supabase secrets' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const isWhatsApp = method === 'WhatsApp'
    const rawTo = to.replace(/[^\d+]/g, '')
    const toParam = isWhatsApp
      ? `whatsapp:${rawTo.startsWith('+') ? rawTo : '+' + rawTo}`
      : rawTo.startsWith('+') ? rawTo : '+' + rawTo
    const fromParam = isWhatsApp ? fromWa : fromSms

    if (!fromParam) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: isWhatsApp
            ? 'TWILIO_FROM_WHATSAPP secret not set'
            : 'TWILIO_FROM_SMS secret not set',
        }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`
    const body = new URLSearchParams({ To: toParam, From: fromParam, Body: message })

    const twilioRes = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${accountSid}:${authToken}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })

    const twilioData = await twilioRes.json()

    if (!twilioRes.ok) {
      console.error('Twilio error:', twilioData)
      return new Response(
        JSON.stringify({
          ok: false,
          error: twilioData.message ?? 'Twilio API error',
          code: twilioData.code,
        }),
        // Always 200 so Supabase invoke puts the body in `data`, not `error`
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(JSON.stringify({ ok: true, sid: twilioData.sid }), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Edge function error:', err)
    return new Response(
      JSON.stringify({ ok: false, error: err.message ?? 'Unknown error' }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }
})
