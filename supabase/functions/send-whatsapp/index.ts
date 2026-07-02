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
    const { to, message, userId } = await req.json();

    if (!to || !message) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: to, message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Twilio credentials
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const whatsappFrom = Deno.env.get("TWILIO_WHATSAPP_FROM") || Deno.env.get("TWILIO_PHONE_NUMBER");

    if (!accountSid || !authToken || !whatsappFrom) {
      return new Response(
        JSON.stringify({ error: "Twilio WhatsApp credentials not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Format for Twilio WhatsApp: "whatsapp:+E164"
    const waTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;
    const waFrom = `whatsapp:${whatsappFrom}`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const body = new URLSearchParams();
    body.append("To", waTo);
    body.append("From", waFrom);
    body.append("Body", message);

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
      const errorMessage = data.message || "Twilio WhatsApp API error";
      console.error("WhatsApp send error:", errorMessage);

      // Log failed reminder if userId provided
      if (userId) {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        await supabase.from("reminder_logs").insert({
          user_id: userId,
          method: "WhatsApp",
          phone: to,
          message,
          status: "failed",
          error_message: errorMessage,
        });
      }

      return new Response(
        JSON.stringify({ ok: false, error: errorMessage }),
        { status: response.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Log successful reminder if userId provided
    if (userId) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      await supabase.from("reminder_logs").insert({
        user_id: userId,
        method: "WhatsApp",
        phone: to,
        message,
        status: "sent",
        provider_sid: data.sid,
      });
    }

    return new Response(
      JSON.stringify({ ok: true, sid: data.sid }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("WhatsApp error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});