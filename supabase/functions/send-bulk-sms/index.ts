// @ts-ignore - Deno imports work at runtime in Supabase Edge Functions
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// @ts-ignore - Deno imports work at runtime in Supabase Edge Functions
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// @ts-ignore - Deno global exists at runtime in Supabase Edge Functions
declare const Deno: { env: { get: (key: string) => string | undefined } };

// Priority for Twilio credentials:
//   1. Fallback credentials passed in request body (_twilioSid, _twilioToken, _twilioFrom)
//      - these come from VITE_TWILIO_* env vars baked into the frontend build
//   2. Supabase secrets (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { recipients, message, senderName, campaignId, _twilioSid, _twilioToken, _twilioFrom } = await req.json();

    if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
      return new Response(
        JSON.stringify({ error: "Request body must include recipients array and message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Prioritize credentials sent by frontend (_twilioSid) over Supabase environment secrets
    const accountSid = _twilioSid || Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken  = _twilioToken || Deno.env.get("TWILIO_AUTH_TOKEN");
    const fromNumber = _twilioFrom || Deno.env.get("TWILIO_PHONE_NUMBER");
    const serviceSid = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");

    if (!accountSid || !authToken) {
      return new Response(
        JSON.stringify({ error: "Twilio credentials not configured. Please set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!fromNumber && !serviceSid) {
      return new Response(
        JSON.stringify({ error: "No sender configured: set TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID" }),
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
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const authHeader = "Basic " + btoa(`${accountSid}:${authToken}`);
    const isLikelyTrialAccount = accountSid && accountSid.startsWith("AC");

    for (const recipient of recipients) {
      const phone = typeof recipient === "string" ? recipient : recipient.phone;
      const personalizedMessage = typeof recipient === "object" && recipient.message
        ? recipient.message
        : message;

      try {
        const normalizedPhone = normalizePhoneNumber(phone);

        const body = new URLSearchParams();
        body.append("To", normalizedPhone);
        body.append("Body", personalizedMessage);
        if (serviceSid) {
          body.append("MessagingServiceSid", serviceSid);
        } else {
          body.append("From", fromNumber!);
        }

        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": authHeader,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        });

        const data = await response.json();

        if (response.ok) {
          const twilioStatus = data.status;
          const isActuallyDelivered = twilioStatus === "delivered" || twilioStatus === "sent";
          const isFailedOrUndelivered = twilioStatus === "failed" || twilioStatus === "undelivered";
          const isAccepted = twilioStatus === "queued";

          results.push({
            phone: normalizedPhone,
            originalPhone: phone,
            success: !isFailedOrUndelivered,
            delivered: isActuallyDelivered,
            sid: data.sid,
            status: twilioStatus,
            note: isAccepted
              ? "Message accepted by Twilio for delivery."
              : isActuallyDelivered
                ? "Message delivered to recipient's phone."
                : "Message failed or was undelivered.",
            trialWarning: isLikelyTrialAccount && !serviceSid
              ? "Trial account: can only send to verified numbers. Add numbers in Twilio Console → Verified Caller IDs."
              : undefined,
          });
        } else {
          const errorCode = data.code;
          const errorMessage = data.message || "Twilio API error";
          let friendlyError = errorMessage;
          let isTrialError = false;
          let isUnverifiedNumber = false;

          if (errorCode === 21211) friendlyError = "Invalid phone number format. Use E.164 format (e.g., +919876543210).";
          else if (errorCode === 21614) friendlyError = "Phone number is not a mobile number or is unreachable.";
          else if (errorCode === 21608) {
            friendlyError = "Cannot send to unverified number (Twilio trial account). Verify in Twilio Console → Verified Caller IDs.";
            isTrialError = true;
            isUnverifiedNumber = true;
          }
          else if (errorCode === 20429) friendlyError = "Rate limit exceeded. Please wait before sending more messages.";
          else if (errorCode === 20003 || errorCode === 401) friendlyError = "Twilio authentication failed. Check your Account SID and Auth Token.";
          else if (errorMessage.toLowerCase().includes("trial")) {
            friendlyError = "Twilio trial account limitation. Verify recipient numbers in Twilio Console → Verified Caller IDs.";
            isTrialError = true;
          } else if (errorMessage.toLowerCase().includes("unverified")) {
            friendlyError = "Recipient number not verified for trial account. Verify in Twilio Console → Verified Caller IDs.";
            isTrialError = true;
            isUnverifiedNumber = true;
          }

          results.push({
            phone: normalizedPhone,
            originalPhone: phone,
            success: false,
            error: friendlyError,
            code: errorCode,
            isTrialError,
            isUnverifiedNumber,
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

function normalizePhoneNumber(phone: string): string {
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.substring(2);
  if (cleaned.length === 10 && /^[6-9]\d{9}$/.test(cleaned)) return '+91' + cleaned;
  if (cleaned.length === 10) return '+1' + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return '+' + cleaned;
  if (cleaned.length >= 11) return '+' + cleaned;
  return '+' + cleaned;
}