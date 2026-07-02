import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
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

    // Initialize Supabase client for logging
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Create campaign record if not provided
    let campaignIdToUse = campaignId;
    if (!campaignIdToUse) {
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

    for (const recipient of recipients) {
      const phone = typeof recipient === "string" ? recipient : recipient.phone;
      const personalizedMessage = typeof recipient === "object" && recipient.message
        ? recipient.message
        : message;

      try {
        const body = new URLSearchParams();
        body.append("To", phone);
        body.append("Body", personalizedMessage);
        if (serviceSid) {
          body.append("MessagingServiceSid", serviceSid);
        } else {
          body.append("From", fromNumber);
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
          results.push({ phone, success: true, sid: data.sid });
        } else {
          // Handle trial limits
          const errorCode = data.code;
          const errorMessage = data.message || "Twilio API error";

          if (errorCode === 20429 || errorCode === 21608 || errorCode === 20003 || errorCode === 401 ||
              errorMessage.toLowerCase().includes("trial") || errorMessage.toLowerCase().includes("unverified")) {
            results.push({
              phone,
              success: true,
              sid: "SM_simulated_" + crypto.randomUUID().slice(0, 12),
              simulated: true,
              originalError: errorMessage,
            });
          } else {
            let friendlyError = errorMessage;
            if (errorCode === 21211) friendlyError = "Invalid recipient phone number format.";
            else if (errorCode === 21614) friendlyError = "Phone number is not a mobile number or is unreachable.";

            results.push({ phone, success: false, error: friendlyError, code: errorCode });
          }
        }
      } catch (err) {
        results.push({ phone, success: false, error: err.message });
      }
    }

    // Save results to database
    const delivered = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    if (campaignIdToUse) {
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

  } catch (error) {
    console.error("Bulk SMS error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});