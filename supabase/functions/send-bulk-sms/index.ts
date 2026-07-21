// @ts-ignore - Deno imports work at runtime in Supabase Edge Functions
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// @ts-ignore - Deno imports work at runtime in Supabase Edge Functions
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// @ts-ignore - Deno global exists at runtime in Supabase Edge Functions
declare const Deno: { env: { get: (key: string) => string | undefined } };

// SMS provider: MSG91
// Priority for MSG91 credentials:
//   1. Passed in request body (_msg91AuthKey, _msg91SenderId, _msg91TemplateId)
//   2. Supabase secrets (MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_TEMPLATE_ID)

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
    const {
      recipients, message, senderName, campaignId,
      // MSG91 credentials
      _msg91AuthKey, _msg91SenderId, _msg91TemplateId, _msg91PeId,
    } = await req.json();

    if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
      return new Response(
        JSON.stringify({ error: "Request body must include recipients array and message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve MSG91 credentials
    const authKey    = _msg91AuthKey    || Deno.env.get("MSG91_AUTH_KEY");
    const senderId   = _msg91SenderId   || Deno.env.get("MSG91_SENDER_ID") || "8956455702";
    const templateId = _msg91TemplateId || Deno.env.get("MSG91_TEMPLATE_ID");
    const peId       = _msg91PeId       || Deno.env.get("MSG91_PE_ID");

    if (!authKey) {
      return new Response(
        JSON.stringify({ error: "MSG91 credentials not configured. Set MSG91_AUTH_KEY in Supabase secrets." }),
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
        // MSG91 expects number without leading + (e.g. 919876543210)
        const mobile = normalizedPhone.replace(/^\+/, '');

        const msg91Payload: any = {
          sender: senderId,
          route: "4",      // 4 = transactional
          country: "91",
          sms: [{ message: personalizedMessage, to: [mobile] }],
        };
        if (templateId) {
          msg91Payload.DLT_TE_ID = templateId;
        }
        if (peId) {
          msg91Payload.PE_ID = peId;
        }

        const response = await fetch("https://api.msg91.com/api/v2/sendsms", {
          method: "POST",
          headers: {
            "authkey": authKey,
            "content-type": "application/json",
          },
          body: JSON.stringify(msg91Payload),
        });

        const data = await response.json();
        console.log(`MSG91 response for ${mobile}:`, data);

        if (data.type === "success" || data.type === "Success") {
          results.push({
            phone: normalizedPhone,
            originalPhone: phone,
            success: true,
            delivered: false, // MSG91 doesn't confirm delivery immediately
            status: "sent",
            note: "Message accepted by MSG91 for delivery.",
          });
        } else {
          const errorMsg = data.message || data.error || "MSG91 API error";
          let friendlyError = errorMsg;

          // MSG91 error codes
          if (errorMsg.toLowerCase().includes("invalid mobile")) {
            friendlyError = "Invalid mobile number format. Use Indian format (e.g. 919876543210).";
          } else if (errorMsg.toLowerCase().includes("authkey")) {
            friendlyError = "Invalid MSG91 Auth Key. Check your credentials.";
          } else if (errorMsg.toLowerCase().includes("sender")) {
            friendlyError = "Invalid or unapproved Sender ID for MSG91.";
          } else if (errorMsg.toLowerCase().includes("balance") || errorMsg.toLowerCase().includes("credit")) {
            friendlyError = "Insufficient MSG91 credits. Recharge your account.";
          } else if (errorMsg.toLowerCase().includes("dnd")) {
            friendlyError = "Number is on DND (Do Not Disturb) list. Cannot deliver.";
          }

          results.push({
            phone: normalizedPhone,
            originalPhone: phone,
            success: false,
            error: friendlyError,
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
        provider_sid: r.status || null,
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