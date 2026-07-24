// Supabase Edge Function — send-reminder
// Deploy: supabase functions deploy send-reminder --no-verify-jwt
//
// SMS → Twilio API (using _twilioSid/_twilioToken/_twilioFrom from request body or Supabase secrets)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

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
      to, message,
      _twilioSid, _twilioToken, _twilioFrom,
    } = body

    if (!to || !message) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing required fields: to, message' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    // Twilio SMS
    const accountSid = _twilioSid || Deno.env.get('TWILIO_ACCOUNT_SID')
    const authToken  = _twilioToken || Deno.env.get('TWILIO_AUTH_TOKEN')
    const fromSms    = _twilioFrom || Deno.env.get('TWILIO_FROM_SMS') || Deno.env.get('TWILIO_PHONE_NUMBER')

    if (!accountSid || !authToken || !fromSms) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Twilio credentials not configured for SMS.' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    const rawTo = to.replace(/[^\d+]/g, '')
    const toParam = rawTo.startsWith('+') ? rawTo : '+' + rawTo

    const twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + btoa(`${accountSid}:${authToken}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: toParam, From: fromSms, Body: message }),
      }
    )

    const twilioData = await twilioRes.json()
    if (!twilioRes.ok) {
      console.error('Twilio SMS error:', twilioData)
      let friendlyError = twilioData.message ?? 'Twilio API error'
      if (twilioData.code === 21608) {
        friendlyError = 'Cannot send to unverified number (Twilio trial account). Verify caller ID in Twilio Console.'
      } else if (twilioData.code === 21211) {
        friendlyError = 'Invalid phone number format. Use international E.164 format (+919876543210).'
      }
      return new Response(
        JSON.stringify({ ok: false, error: friendlyError, code: twilioData.code }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({ ok: true, sid: twilioData.sid, status: twilioData.status, provider: 'twilio' }),
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
