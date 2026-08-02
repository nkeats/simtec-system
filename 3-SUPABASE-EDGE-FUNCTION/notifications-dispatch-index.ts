// ============================================================================
//  notifications-dispatch — sends the QUEUED external notifications.
//  Deploy with verify_jwt = OFF. Meant to be called on a schedule (pg_cron +
//  pg_net, every few minutes). Each run takes a small BATCH of queued email/SMS
//  rows, sends them via Resend / TNZ, and marks them sent or failed. In-app
//  notifications need no dispatch (they're already in the inbox); push is a
//  later add (needs the PWA + subscriptions).
//
//  Secrets: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto), TNZ_AUTH_TOKEN,
//           RESEND_API_KEY + RESEND_FROM, and DISPATCH_SECRET (optional guard).
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TNZ          = Deno.env.get("TNZ_AUTH_TOKEN");
const RESEND_KEY   = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM  = Deno.env.get("RESEND_FROM") || "Simtec Therapeutic <noreply@simtectp.com>";
const GUARD        = Deno.env.get("DISPATCH_SECRET");   // if set, callers must send X-Dispatch-Key

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const BATCH = 50;

function toE164NZ(m: string) {
  let d = (m || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.startsWith("64")) return "+" + d;
  if (d.startsWith("0")) return "+64" + d.slice(1);
  return "+64" + d;
}
async function sendSms(to: string, msg: string) {
  if (!TNZ) return false;
  try {
    const r = await fetch("https://api.tnz.co.nz/api/v2.04/send/sms", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + TNZ },
      body: JSON.stringify({ MessageData: { Reference: "Simtec", Message: msg, Destinations: [{ Recipient: to }] } }),
    });
    return r.ok;
  } catch { return false; }
}
async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_KEY) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
    });
    return r.ok;
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (GUARD && req.headers.get("X-Dispatch-Key") !== GUARD) {
    return new Response("forbidden", { status: 403 });
  }

  const { data: rows } = await admin
    .from("notifications")
    .select("id,customer_id,title,body,external_channel")
    .eq("external_status", "queued")
    .in("external_channel", ["email", "sms"])
    .order("created_at", { ascending: true })
    .limit(BATCH);

  let sent = 0, failed = 0;
  for (const n of (rows || [])) {
    const { data: c } = await admin.from("sim_customers")
      .select("email,mobile,first_name").eq("id", n.customer_id).maybeSingle();
    let ok = false;
    if (n.external_channel === "email" && c?.email) {
      ok = await sendEmail(c.email, n.title,
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#0e2038">
           <h2 style="margin:0 0 8px">${n.title}</h2>
           <p style="margin:0;color:#51617a;line-height:1.5">${n.body || ""}</p>
         </div>`);
    } else if (n.external_channel === "sms" && c?.mobile) {
      ok = await sendSms(toE164NZ(c.mobile), `${n.title}${n.body ? ": " + n.body : ""}`);
    }
    await admin.from("notifications")
      .update({ external_status: ok ? "sent" : "failed", sent_at: ok ? new Date().toISOString() : null })
      .eq("id", n.id);
    ok ? sent++ : failed++;
  }

  return new Response(JSON.stringify({ ok: true, processed: (rows || []).length, sent, failed }),
    { headers: { "Content-Type": "application/json" } });
});
