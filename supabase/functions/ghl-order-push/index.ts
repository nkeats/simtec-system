// ============================================================================
//  ghl-order-push — create/update a GHL contact for an app order, tagged for
//                   isolated testing (Option B: tag-based within existing GHL).
// ----------------------------------------------------------------------------
//  WHY THIS EXISTS
//    When an order is submitted from the iPad app we want a matching contact in
//    GoHighLevel so the office can run (and record) the confirmation CALL against
//    it, and so a confirmation email can later be fired from a GHL workflow that
//    is keyed ONLY to our isolation tag. This keeps the app's test/live traffic
//    completely separate from the generic email that currently fires on the
//    existing paper QR-code order flow.
//
//  *** SAFETY — READ BEFORE DEPLOYING ***
//    1. This function is INERT until you set ALL THREE secrets below. With any
//       one missing it returns {status:"disabled"} and touches nothing — so
//       deploying it changes nothing on its own.
//    2. It creates contacts via the GHL API and applies GHL_APP_TAG. An API
//       contact upsert does NOT submit a GHL Form, so it will not fire a
//       form-submit notification. But before you switch it on, confirm what
//       actually triggers your live paper-order email (Form notification vs a
//       workflow/trigger vs another location) and make sure NOTHING is keyed to
//       "contact created" in the target location. As inspected on 2026-07-23 the
//       target NZ location had no Workflows, Campaigns or Triggers — verify this
//       is still true before enabling.
//    3. Build your confirmation-email workflow to trigger on Contact Tag ==
//       GHL_APP_TAG only. Do not reuse the paper-order trigger.
//
//  SECRETS (supabase secrets set ...):
//     GHL_NZ_TOKEN        — GHL Private Integration token for the NZ location
//     GHL_NZ_LOCATION_ID  — NZ sub-account (location) id
//     GHL_APP_TAG         — isolation tag applied to every app contact,
//                           e.g. "simtec-app-order"  (this is the ON switch)
//     ALLOWED_ORIGIN      — (optional) exact origin of the app for CORS scoping
//     SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY — provided
//                           automatically by the platform.
//
//  REQUEST (POST, requires a logged-in user JWT):
//     { "orderId": "<uuid of sim_orders row>" }
//  RESPONSE:
//     { status:"ok", contactId, tagged:true }         on success
//     { status:"disabled" }                            when not configured (inert)
//     { error:"..." }                                  on failure (details logged)
//
//  Deploy:
//     supabase functions deploy ghl-order-push
//     # then, only when you are ready to test the isolated flow:
//     supabase secrets set GHL_NZ_TOKEN=xxx GHL_NZ_LOCATION_ID=xxx GHL_APP_TAG=simtec-app-order
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GHL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function ghl(path: string, token: string, init: RequestInit = {}) {
  const r = await fetch(`${GHL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Version: VERSION, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

// Only a logged-in Simtec user may call this (consultants included — they create
// orders). We verify the caller's JWT with the anon client, then do the actual
// DB reads/writes with the service-role client so RLS never blocks the sync.
async function requireUser(req: Request): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  // Extract the JWT from the Authorization header and validate it EXPLICITLY.
  // getUser() with no argument reads from a stored session (none exists in an
  // edge function), so it must be passed the token — otherwise every call 401s.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, res: json({ error: "unauthorized" }, 401) };
  // Validate the caller's JWT with the SERVICE-ROLE key as the apikey. The legacy
  // anon key can be disabled on projects migrated to publishable/secret keys, which
  // makes an anon-keyed getUser() fail; the service-role key always validates.
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const { data: { user }, error } = await supa.auth.getUser(token);
  if (error || !user) return { ok: false, res: json({ error: "unauthorized" }, 401) };
  // Role gate: only order-taking roles may trigger a customer email + GHL push.
  const { data: prof } = await supa.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const role = prof?.role || null;
  if (!role || !["admin", "manager", "office", "consultant"].includes(role)) {
    return { ok: false, res: json({ error: "forbidden" }, 403) };
  }
  return { ok: true, userId: user.id };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // --- INERT GUARD: do nothing at all until all three secrets are set. --------
  const token = Deno.env.get("GHL_NZ_TOKEN");
  const loc = Deno.env.get("GHL_NZ_LOCATION_ID");
  const tag = Deno.env.get("GHL_APP_TAG");
  if (!token || !loc || !tag) return json({ status: "disabled" }, 200);

  // --- authorization ----------------------------------------------------------
  const gate = await requireUser(req);
  if (!gate.ok) return gate.res;

  let orderId = "";
  try { orderId = (await req.json())?.orderId || ""; } catch { /* ignore */ }
  if (!orderId) return json({ error: "orderId required" }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    // --- IDEMPOTENCY CLAIM -----------------------------------------------------
    // Atomically "claim" this order exactly once. The UPDATE ... WHERE
    // ghl_pushed_at IS NULL succeeds for only the FIRST invocation (Postgres row
    // lock); every later/duplicate call — whatever its source (client retry, a
    // GHL tag event firing more than once, etc.) — gets zero rows back and exits
    // WITHOUT re-tagging. That guarantees the confirmation-email workflow (keyed
    // to the tag we apply below) fires exactly once per order. Setting only
    // ghl_pushed_at leaves order_status untouched, so the cancel triggers no-op.
    const { data: claim, error: claimErr } = await admin
      .from("sim_orders")
      .update({ ghl_pushed_at: new Date().toISOString() })
      .eq("id", orderId)
      .is("ghl_pushed_at", null)
      .select("id");
    if (claimErr) { console.error("idempotency claim failed", claimErr.message); return json({ error: "claim failed" }, 500); }
    if (!claim || claim.length === 0) {
      console.info("ghl-order-push: order already pushed, skipping", orderId);
      return json({ status: "duplicate-skipped" }, 200);
    }

    // Pull the order + its customer (server-side; never trust client-supplied PII).
    const { data: order, error: oErr } = await admin
      .from("sim_orders")
      .select("id, customer_id, consultant_name, contract_value")
      .eq("id", orderId)
      .maybeSingle();
    if (oErr) { console.error("order lookup failed", oErr.message); return json({ error: "lookup failed" }, 500); }
    if (!order) return json({ error: "order not found" }, 404);

    const { data: cust, error: cErr } = await admin
      .from("sim_customers")
      .select("id, first_name, last_name, mobile, email, address, ghl_contact_id")
      .eq("id", order.customer_id)
      .maybeSingle();
    if (cErr) { console.error("customer lookup failed", cErr.message); return json({ error: "lookup failed" }, 500); }
    if (!cust) return json({ error: "customer not found" }, 404);

    // Order line items -> a readable product summary for the email merge field.
    const { data: items } = await admin
      .from("sim_order_items")
      .select("product_name, quantity, unit_price")
      .eq("order_id", orderId)
      .order("line_no", { ascending: true });
    const productSummary = (items || [])
      .map((i: any) => `${i.product_name} x${i.quantity}`)
      .join(", ");

    // 30-day comfort guarantee applies only to these products (matches order-app's
    // GUARANTEE_PRODUCTS). When the order includes one, we add a second tag so the
    // workflow can attach the guarantee document ONLY for qualifying orders.
    const GUARANTEE_PRODUCTS = ["Mk III Queen", "Mk III Super King"];
    const hasGuarantee = (items || []).some((i: any) => GUARANTEE_PRODUCTS.includes(i.product_name));
    const guaranteeTag = Deno.env.get("GHL_GUARANTEE_TAG") || "comfort-guarantee";

    // A time-limited signed link to the order-summary PDF the app uploaded. The
    // confirmation email links to this (GHL email attachments must be static, so
    // a per-order document is delivered as a link, not an attachment).
    let pdfLink = "";
    try {
      const { data: signed } = await admin.storage
        .from("order-documents")
        .createSignedUrl(`${orderId}/order-summary.pdf`, 60 * 60 * 24 * 7); // 7 days (email attaches the file at send time; link is a convenience)
      pdfLink = signed?.signedUrl || "";
    } catch (e) { console.warn("pdf signed url pending:", (e as Error)?.message || e); }

    // Custom fields the confirmation-email workflow merges. These field KEYS must
    // exist in the GHL location (created during setup). Sent by key so no field
    // IDs are hard-coded here.
    const customFields = [
      { key: "order_id", field_value: orderId },
      { key: "order_value", field_value: order.contract_value != null ? String(order.contract_value) : "" },
      { key: "order_products", field_value: productSummary },
      { key: "order_consultant", field_value: order.consultant_name || "" },
      { key: "order_pdf_link", field_value: pdfLink },
    ].filter((f) => f.field_value !== "");

    // Build the GHL contact. Tag it so the confirmation-email workflow (keyed to
    // GHL_APP_TAG) can pick it up in isolation from the paper-order flow.
    const payload: Record<string, unknown> = {
      locationId: loc,
      firstName: cust.first_name || "",
      lastName: cust.last_name || "",
      name: [cust.first_name, cust.last_name].filter(Boolean).join(" ").trim() || "(no name)",
      email: cust.email || undefined,
      phone: cust.mobile || undefined,
      address1: cust.address || undefined,
      tags: hasGuarantee ? [tag, guaranteeTag] : [tag],
      source: "Simtec app order",
      customFields,
    };

    // GHL v2 upsert: matches on email/phone within the location, else creates.
    const up = await ghl(`/contacts/upsert`, token, { method: "POST", body: JSON.stringify(payload) });
    if (!up.ok) {
      console.error("GHL upsert failed", up.status, JSON.stringify(up.body));
      return json({ error: "upstream error" }, 502);
    }
    const contactId = up.body?.contact?.id || up.body?.id || null;
    if (!contactId) {
      console.error("GHL upsert returned no contact id", JSON.stringify(up.body));
      return json({ error: "no contact id" }, 502);
    }

    // Persist the link so the confirmation call can be recorded against it and we
    // never create a duplicate on a re-push.
    const { error: wErr } = await admin
      .from("sim_customers")
      .update({ ghl_contact_id: contactId })
      .eq("id", cust.id);
    if (wErr) console.error("ghl_contact_id writeback failed", wErr.message); // non-fatal

    // --- INSTANT WELCOME EMAIL via Resend --------------------------------------
    // Sent directly here (not via a GHL workflow) so it lands in the customer's
    // inbox in seconds — before the office's confirmation call connects. Attaches
    // the per-order summary PDF plus the static docs (T&Cs, warranty, and the
    // 30-day guarantee only when the order qualifies). Best-effort: a mail failure
    // is logged but never fails the order or the GHL sync.
    //   SECRETS: RESEND_API_KEY, RESEND_FROM   (shared with send-verify-code)
    //   DOC URLS (optional): WELCOME_DOC_TERMS, WELCOME_DOC_WARRANTY, WELCOME_DOC_GUARANTEE
    let emailed = false;
    try {
      const resendKey = Deno.env.get("RESEND_API_KEY");
      if (resendKey && cust.email) {
        const from = Deno.env.get("RESEND_FROM") || "Simtec Therapeutic <noreply@simtectp.com>";
        const first = cust.first_name || "there";
        const attach: Array<{ path: string; filename: string }> = [];
        if (pdfLink) attach.push({ path: pdfLink, filename: "Order-Summary.pdf" });
        const terms = Deno.env.get("WELCOME_DOC_TERMS");
        const warranty = Deno.env.get("WELCOME_DOC_WARRANTY");
        const guarantee = Deno.env.get("WELCOME_DOC_GUARANTEE");
        if (terms) attach.push({ path: terms, filename: "Terms-and-Conditions.pdf" });
        if (warranty) attach.push({ path: warranty, filename: "15-Year-Warranty.pdf" });
        if (hasGuarantee && guarantee) attach.push({ path: guarantee, filename: "30-Day-Comfort-Guarantee.pdf" });

        const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));
        const rows = [
          ["Order reference", orderId],
          ["Products", productSummary || "—"],
          ["Order value", order.contract_value != null ? `$${Number(order.contract_value).toFixed(2)}` : "—"],
          ["Your consultant", order.consultant_name || "—"],
        ].map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#5a6b8c">${esc(k)}</td><td style="padding:4px 0;font-weight:600">${esc(v)}</td></tr>`).join("");
        const html = `
          <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1b2a4a">
            <h2 style="margin:0 0 6px">Thanks for your order, ${esc(first)}</h2>
            <p style="margin:0 0 16px;color:#5a6b8c">We've received your order and our team will call you shortly to confirm the details.</p>
            <table style="border-collapse:collapse;margin:0 0 16px">${rows}</table>
            <p style="margin:0 0 16px">Your order summary${attach.length > 1 ? ", Terms &amp; Conditions and 15-year warranty are" : " is"} attached to this email.</p>
            <p style="margin:0;color:#8a97ad;font-size:13px">Simtec Therapeutic Limited</p>
          </div>`;

        const mail = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [cust.email], subject: "Your Simtec order confirmation", html, attachments: attach }),
        });
        if (!mail.ok) console.error("welcome email failed", mail.status, await mail.text());
        else emailed = true;
      }
    } catch (e) {
      console.error("welcome email error", (e as Error)?.message || e);
    }

    return json({ status: "ok", contactId, tagged: true, emailed });
  } catch (e) {
    console.error("ghl-order-push error", (e as Error)?.message || e);
    return json({ error: "internal error" }, 500);
  }
});
