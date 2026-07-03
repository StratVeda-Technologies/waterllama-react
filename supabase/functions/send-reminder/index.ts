// Supabase Edge Function — send-reminder
// Deploy: supabase functions deploy send-reminder --no-verify-jwt
//
// Priority for Twilio credentials:
//   1. Fallback credentials passed in request body (_twilioSid, _twilioToken, _twilioFrom)
//   2. Supabase secrets (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)

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
    const { to, method, message, _twilioSid, _twilioToken, _twilioFrom } = await req.json()

    if (!to || !message) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing required fields: to, message' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    // Prioritize credentials sent by frontend (_twilioSid) over Supabase environment secrets
    const accountSid = _twilioSid || Deno.env.get('TWILIO_ACCOUNT_SID')
    const authToken  = _twilioToken || Deno.env.get('TWILIO_AUTH_TOKEN')
    const fromSms    = _twilioFrom || Deno.env.get('TWILIO_FROM_SMS') || Deno.env.get('TWILIO_PHONE_NUMBER')
    const fromWaEnv  = Deno.env.get('TWILIO_FROM_WHATSAPP') || Deno.env.get('TWILIO_FROM_SMS') || Deno.env.get('TWILIO_PHONE_NUMBER')
    const fromWa     = _twilioFrom ? `whatsapp:${_twilioFrom}` : (fromWaEnv || 'whatsapp:+14155238886')

    if (!accountSid || !authToken) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Twilio credentials not configured. Please set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.' }),
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
        JSON.stringify({ ok: false, error: 'No sender phone number configured.' }),
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
      let friendlyError = twilioData.message ?? 'Twilio API error'
      if (twilioData.code === 21608) {
        friendlyError = 'Cannot send to unverified number (Twilio trial account). Verify the number in Twilio Console → Verified Caller IDs.'
      } else if (twilioData.code === 21211) {
        friendlyError = 'Invalid phone number format. Use international format with country code (e.g. +919876543210).'
      }
      return new Response(
        JSON.stringify({ ok: false, error: friendlyError, code: twilioData.code }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(JSON.stringify({ ok: true, sid: twilioData.sid, status: twilioData.status }), {
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
