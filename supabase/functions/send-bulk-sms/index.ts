// @ts-ignore - Deno imports work at runtime in Supabase Edge Functions
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// @ts-ignore - Deno imports work at runtime in Supabase Edge Functions
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Deno namespace types for TypeScript
/// <reference types="https://deno.land/x/deno/cli/types.d.ts" />

// @ts-ignore - Deno global exists at runtime in Supabase Edge Functions
declare const Deno: {
  env: {
    get: (key: string) => string | undefined;
  };
};

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
    const { recipients, message, senderName, campaignId } = await req.json();

    if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
      return new Response(
        JSON.stringify({ error: "Request body must include recipients array and message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Twilio credentials
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const fromNumber = Deno.env.get("TWILIO_PHONE_NUMBER");
    const serviceSid = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");

    if (!accountSid || !authToken) {
      return new Response(
        JSON.stringify({ error: "Twilio credentials not configured" }),
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

    // Create campaign record if not provided (only if Supabase client available)
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

    // Send SMS to each recipient
    const results = [];
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const authHeader = "Basic " + btoa(`${accountSid}:${authToken}`);

    // Check if using Twilio trial account (Account SIDs starting with "AC" can be trial or paid)
    // We can't definitively know trial status from SID alone, but we can warn
    const isLikelyTrialAccount = accountSid && accountSid.startsWith("AC");

    for (const recipient of recipients) {
      const phone = typeof recipient === "string" ? recipient : recipient.phone;
      const personalizedMessage = typeof recipient === "object" && recipient.message
        ? recipient.message
        : message;

      try {
        // Normalize phone number to E.164 format
        const normalizedPhone = normalizePhoneNumber(phone);

        const body = new URLSearchParams();
        body.append("To", normalizedPhone);
        body.append("Body", personalizedMessage);
        if (serviceSid) {
          body.append("MessagingServiceSid", serviceSid);
        } else {
          // fromNumber is guaranteed to exist due to check at line 50
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
          // Twilio returns 201 for accepted messages, but delivery is ASYNCHRONOUS
          // Status values: "queued", "sent", "failed", "delivered", "undelivered"
          // IMPORTANT: "queued" or "sent" means ACCEPTED for delivery, NOT delivered to phone
          const twilioStatus = data.status;
          const isActuallyDelivered = twilioStatus === "delivered" || twilioStatus === "sent";
          const isFailedOrUndelivered = twilioStatus === "failed" || twilioStatus === "undelivered";
          const isAccepted = twilioStatus === "queued";

          results.push({
            phone: normalizedPhone,
            originalPhone: phone,
            success: !isFailedOrUndelivered, // true for queued/sent/delivered
            delivered: isActuallyDelivered, // ONLY true if status === "delivered"
            sid: data.sid,
            status: twilioStatus,
            // IMPORTANT: Twilio "success" means ACCEPTED for delivery, NOT delivered to handset
            // For trial accounts: messages to unverified numbers are "accepted" but NEVER delivered
            note: isAccepted
              ? "Message accepted by Twilio for delivery. Actual delivery to phone is asynchronous and may fail (especially on trial accounts with unverified numbers)."
              : isActuallyDelivered
                ? "Message delivered to recipient's phone."
                : "Message failed or was undelivered.",
            // Trial account warning - CRITICAL for users not receiving SMS
            trialWarning: isLikelyTrialAccount && !serviceSid
              ? "⚠️ TWILIO TRIAL ACCOUNT LIMITATION: You can ONLY send SMS to VERIFIED numbers. Add recipient in Twilio Console → Phone Numbers → Verified Caller IDs, or upgrade your Twilio account. Messages to unverified numbers are 'accepted' but NEVER delivered."
              : undefined,
            // Provide guidance for checking actual delivery
            checkDelivery: isAccepted
              ? "Check actual delivery status in Twilio Console → Messaging → Logs, or set up a Status Callback URL to receive delivery receipts."
              : undefined
          });
        } else {
          // Return actual Twilio error - do NOT simulate success
          // Simulation was causing "successfully sent" UI but SMS never delivered
          const errorCode = data.code;
          const errorMessage = data.message || "Twilio API error";

          let friendlyError = errorMessage;
          let isTrialError = false;
          let isUnverifiedNumber = false;

          if (errorCode === 21211) friendlyError = "Invalid recipient phone number format. Use E.164 format (e.g., +919876543210).";
          else if (errorCode === 21614) friendlyError = "Phone number is not a mobile number or is unreachable.";
          else if (errorCode === 21608) {
            friendlyError = "Cannot send to unverified number (Twilio trial account limitation). Verify the number in Twilio Console → Phone Numbers → Verified Caller IDs, or upgrade your Twilio account.";
            isTrialError = true;
            isUnverifiedNumber = true;
          }
          else if (errorCode === 20429) friendlyError = "Rate limit exceeded. Please wait before sending more messages.";
          else if (errorCode === 20003 || errorCode === 401) friendlyError = "Twilio authentication failed. Check your Account SID and Auth Token.";
          else if (errorMessage.toLowerCase().includes("trial")) {
            friendlyError = "Twilio trial account limitation. Upgrade your Twilio account or verify recipient numbers in Twilio Console.";
            isTrialError = true;
          }
          else if (errorMessage.toLowerCase().includes("unverified")) {
            friendlyError = "Recipient number not verified for trial account. Verify in Twilio Console → Phone Numbers → Verified Caller IDs, or upgrade.";
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
            // Twilio returns 201 for accepted messages, but delivery is async
            // For trial accounts with unverified numbers, message is accepted but never delivered
            warning: isTrialError ? "Message accepted by Twilio but will NOT be delivered due to trial account limitation. Verify the number or upgrade your Twilio account." : undefined
          });
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        results.push({
          phone: normalizePhoneNumber(phone),
          originalPhone: phone,
          success: false,
          error: errorMessage
        });
      }
    }

    // Save results to database (non-fatal if Supabase logging is unavailable)
    const delivered = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    if (supabase && campaignIdToUse) {
      // Update campaign totals
      await supabase
        .from("campaigns")
        .update({
          total_sent: results.length,
          total_delivered: delivered,
          total_failed: failed,
        })
        .eq("id", campaignIdToUse);

      // Insert individual results
      const resultsToInsert = results.map(r => ({
        campaign_id: campaignIdToUse,
        phone: r.phone,
        success: r.success,
        provider_sid: r.sid || null,
        error_message: r.error || null,
      }));

      await supabase.from("campaign_results").insert(resultsToInsert);
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

// Normalize phone number to E.164 format
function normalizePhoneNumber(phone: string): string {
  // Remove all non-digits except +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // If already has + prefix, return as-is (assuming valid E.164)
  if (cleaned.startsWith('+')) {
    return cleaned;
  }

  // If starts with 00, replace with +
  if (cleaned.startsWith('00')) {
    return '+' + cleaned.substring(2);
  }

  // If starts with country code but no +, add it
  // Common patterns: 91xxxxxxxxxx (India), 1xxxxxxxxxx (US/Canada)
  if (cleaned.length >= 10) {
    // India numbers: 10 digits starting with 6-9
    if (cleaned.length === 10 && /^[6-9]\d{9}$/.test(cleaned)) {
      return '+91' + cleaned;
    }
    // US/Canada: 10 digits or 11 digits starting with 1
    if (cleaned.length === 10) {
      return '+1' + cleaned; // Default to US
    }
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
      return '+' + cleaned;
    }
    // If 12+ digits, assume it has country code
    if (cleaned.length >= 11) {
      return '+' + cleaned;
    }
  }

  // Default: assume it's a local number, prepend +
  return '+' + cleaned;
}