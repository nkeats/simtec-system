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
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader) return { ok: false, res: json({ error: "unauthorized" }, 401) };
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return { ok: false, res: json({ error: "unauthorized" }, 401) };
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

    // A time-limited signed link to the order-summary PDF the app uploaded. The
    // confirmation email links to this (GHL email attachments must be static, so
    // a per-order document is delivered as a link, not an attachment).
    let pdfLink = "";
    try {
      const { data: signed } = await admin.storage
        .from("order-documents")
        .createSignedUrl(`${orderId}/order-summary.pdf`, 60 * 60 * 24 * 180); // 180 days
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
      tags: [tag],
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

    return json({ status: "ok", contactId, tagged: true });
  } catch (e) {
    console.error("ghl-order-push error", (e as Error)?.message || e);
    return json({ error: "internal error" }, 500);
  }
});
