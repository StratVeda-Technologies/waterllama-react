import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { to, message, from, messagingServiceSid } = await req.json();

    if (!to || !message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: to, message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Twilio credentials from environment
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const fromNumber = from || Deno.env.get("TWILIO_PHONE_NUMBER");
    const serviceSid = messagingServiceSid || Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");

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

    // Normalize phone number to E.164 format
    const normalizedTo = normalizePhoneNumber(to);

    // Build Twilio API request
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const body = new URLSearchParams();
    body.append("To", normalizedTo);
    body.append("Body", message);
    if (serviceSid) {
      body.append("MessagingServiceSid", serviceSid);
    } else {
      body.append("From", fromNumber);
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(`${accountSid}:${authToken}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const data = await response.json();

    if (!response.ok) {
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

      return new Response(
        JSON.stringify({
          success: false,
          error: friendlyError,
          code: errorCode,
          isTrialError,
          isUnverifiedNumber,
          // Twilio returns 201 for accepted messages, but delivery is async
          // For trial accounts with unverified numbers, message is accepted but never delivered
          warning: isTrialError ? "Message accepted by Twilio but will NOT be delivered due to trial account limitation. Verify the number or upgrade your Twilio account." : undefined
        }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Twilio returns 201 for accepted messages, but delivery is asynchronous
    // For trial accounts, warn about potential delivery issues
    const isTrialAccount = accountSid && accountSid.startsWith("AC");
    const isDelivered = data.status === "delivered" || data.status === "sent";

    return new Response(
      JSON.stringify({
        success: true,           // Message accepted by Twilio
        delivered: isDelivered,  // Actually delivered to handset
        sid: data.sid,
        // Important: Twilio "success" means message was accepted for delivery, NOT delivered
        status: data.status, // "queued", "sent", "failed", "delivered", "undelivered"
        note: data.status === "queued" || data.status === "sent"
          ? "Message accepted by Twilio for delivery. Actual delivery is asynchronous - check Twilio console for delivery status."
          : data.status === "delivered"
            ? "Message delivered to recipient's handset."
            : data.status === "failed" || data.status === "undelivered"
              ? "Message failed or was undelivered. Check Twilio console for details."
              : undefined,
        // Trial account warning
        trialWarning: isTrialAccount && !serviceSid
          ? "Using Twilio trial account? You can ONLY send to verified numbers. Add recipient in Twilio Console → Phone Numbers → Verified Caller IDs, or upgrade your Twilio account."
          : undefined
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Send SMS error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
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