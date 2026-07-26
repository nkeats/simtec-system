// ============================================================================
//  send-verify-code — email a 6-digit verification code to a customer via
//                     Resend (fast transactional path, NOT the GHL/Mailgun
//                     workflow path, so codes arrive in seconds).
// ----------------------------------------------------------------------------
//  WHY RESEND (not GHL): the GHL confirmation email goes through the new
//  mg.simtectp.com sending domain, which Gmail greylists for a few minutes
//  while it earns reputation. That delay is fine for a confirmation the
//  customer reads later, but useless for a live verification code with a
//  consultant waiting. Resend is a dedicated transactional sender and your
//  domain is already DKIM-verified for it (resend._domainkey in DNS).
//
//  INERT until RESEND_API_KEY is set → returns {status:"disabled"} and sends
//  nothing, so deploying it changes nothing on its own.
//
//  SECRETS (Supabase → Edge Functions → send-verify-code → Secrets):
//     RESEND_API_KEY   — your Resend API key  (this is the ON switch)
//     RESEND_FROM      — verified sender, e.g. "Simtec Therapeutic <noreply@simtectp.com>"
//                        (defaults to noreply@simtectp.com if unset)
//     ALLOWED_ORIGIN   — (optional) exact app origin for CORS
//     SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — provided by the platform.
//
//  REQUEST (POST, requires a logged-in staff JWT):
//     { "email": "customer@example.com", "code": "123456" }
//  RESPONSE:
//     { status:"ok" }            sent
//     { status:"disabled" }      not configured (inert)
//     { error:"..." }            failure (details logged)
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";
const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Only a logged-in Simtec user may send codes (stops the endpoint being abused
// to blast emails). Validate the caller's JWT with the service-role key.
async function requireUser(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const { data: { user }, error } = await supa.auth.getUser(token);
  if (error || !user) return false;
  // Role gate: only order-taking staff/consultants may send codes (stops any
  // logged-in account blasting emails from the Simtec domain).
  const { data: prof } = await supa.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const role = prof?.role || null;
  return !!role && ["admin", "manager", "office", "consultant"].includes(role);
}

const escapeHtml = (s: string) =>
  String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // INERT until a Resend key is configured.
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return json({ status: "disabled" }, 200);

  if (!(await requireUser(req))) return json({ error: "unauthorized" }, 401);

  let email = "", code = "";
  try {
    const b = await req.json();
    email = String(b?.email || "").trim();
    code = String(b?.code || "").trim();
  } catch { /* ignore */ }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "invalid email" }, 400);
  if (!/^\d{4,8}$/.test(code)) return json({ error: "invalid code" }, 400);

  const from = Deno.env.get("RESEND_FROM") || "Simtec Therapeutic <noreply@simtectp.com>";
  const safeCode = escapeHtml(code);
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1b2a4a">
      <h2 style="margin:0 0 8px">Your Simtec verification code</h2>
      <p style="margin:0 0 16px;color:#5a6b8c">Please read this code back to your Simtec consultant to confirm your email address.</p>
      <div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#f2f5fb;border-radius:12px;padding:18px;text-align:center">${safeCode}</div>
      <p style="margin:16px 0 0;color:#8a97ad;font-size:13px">If you weren't expecting this, you can ignore it.</p>
    </div>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `Your Simtec verification code: ${code}`,
        html,
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      console.error("resend send failed", r.status, text);
      return json({ error: "send failed" }, 502);
    }
    return json({ status: "ok" });
  } catch (e) {
    console.error("send-verify-code error", (e as Error)?.message || e);
    return json({ error: "internal error" }, 500);
  }
});
