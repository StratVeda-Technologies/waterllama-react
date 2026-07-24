// @ts-ignore - Deno imports work at runtime in Supabase Edge Functions
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// @ts-ignore - Deno imports work at runtime in Supabase Edge Functions
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// @ts-ignore - Deno global exists at runtime in Supabase Edge Functions
declare const Deno: { env: { get: (key: string) => string | undefined } };

// SMS provider: Twilio API
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normalizePhoneNumber(phone: string): string {
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.substring(2);
  if (cleaned.length === 10 && /^[6-9]\d{9}$/.test(cleaned)) return '+91' + cleaned;
  return '+' + cleaned;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      recipients, message, senderName, campaignId,
      _twilioSid, _twilioToken, _twilioFrom,
    } = await req.json();

    if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
      return new Response(
        JSON.stringify({ error: "Request body must include recipients array and message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve Twilio credentials
    const accountSid = _twilioSid || Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken  = _twilioToken || Deno.env.get("TWILIO_AUTH_TOKEN");
    const fromSms    = _twilioFrom  || Deno.env.get("TWILIO_FROM_SMS") || Deno.env.get("TWILIO_PHONE_NUMBER");

    if (!accountSid || !authToken || !fromSms) {
      return new Response(
        JSON.stringify({ error: "Twilio credentials not configured. Set TWILIO_ACCOUNT_SID in Supabase secrets." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Initialize Supabase client for logging (non-fatal if missing)
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SERVICE_ROLE_KEY");
    const supabase = (supabaseUrl && supabaseServiceKey)
      ? createClient(supabaseUrl, supabaseServiceKey)
      : null;

    let campaignIdToUse = campaignId;
    if (!campaignIdToUse && supabase) {
      const { data: campaign, error: campaignError } = await supabase
        .from("campaigns")
        .insert({
          campaign_name: senderName || "Campaign",
          sender_name: senderName || "Aqualama",
          message,
          total_recipients: recipients.length,
          total_sent: 0,
          total_delivered: 0,
          total_failed: 0,
        })
        .select("id")
        .single();

      if (campaignError) {
        console.error("Campaign creation error:", campaignError);
      } else {
        campaignIdToUse = campaign.id;
      }
    }

    const results: any[] = [];

    for (const recipient of recipients) {
      const phone = typeof recipient === "string" ? recipient : recipient.phone;
      const personalizedMessage = typeof recipient === "object" && recipient.message
        ? recipient.message
        : message;

      try {
        const normalizedPhone = normalizePhoneNumber(phone);

        const twilioRes = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: "Basic " + btoa(`${accountSid}:${authToken}`),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ To: normalizedPhone, From: fromSms, Body: personalizedMessage }),
          }
        );

        const data = await twilioRes.json();
        console.log(`Twilio SMS response for ${normalizedPhone}:`, data);

        if (twilioRes.ok) {
          results.push({
            phone: normalizedPhone,
            originalPhone: phone,
            success: true,
            delivered: true,
            sid: data.sid,
            status: data.status,
            note: "Message sent via Twilio.",
          });
        } else {
          let friendlyError = data.message || "Twilio error";
          if (data.code === 21608) {
            friendlyError = "Cannot send to unverified number (Twilio trial). Verify caller ID in Twilio console.";
          } else if (data.code === 21211) {
            friendlyError = "Invalid phone number format. Use +91 format for India.";
          }

          results.push({
            phone: normalizedPhone,
            originalPhone: phone,
            success: false,
            error: friendlyError,
            code: data.code,
          });
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        results.push({ phone: normalizePhoneNumber(phone), originalPhone: phone, success: false, error: errorMessage });
      }
    }

    const delivered = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    if (supabase && campaignIdToUse) {
      await supabase.from("campaigns").update({ total_sent: results.length, total_delivered: delivered, total_failed: failed }).eq("id", campaignIdToUse);
      await supabase.from("campaign_results").insert(results.map(r => ({
        campaign_id: campaignIdToUse,
        phone: r.phone,
        success: r.success,
        provider_sid: r.sid || null,
        error_message: r.error || null,
      })));
    }

    return new Response(
      JSON.stringify({ ok: true, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    console.error("Bulk SMS error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});