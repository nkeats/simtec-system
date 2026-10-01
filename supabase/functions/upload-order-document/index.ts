// ============================================================================
//  upload-order-document — the Sales App's paperwork goes through the SERVER.
//
//  WHY THIS EXISTS: order-app.html builds its own Supabase client, separate from
//  auth.js's, and its STORAGE calls were not carrying the session — so every
//  upload was refused with "new row violates row-level security policy" while the
//  database writes from the same page worked fine. Rather than chase a browser
//  session quirk, the check moves here: this function verifies the caller's JWT,
//  confirms the order is theirs, and then writes with the service role.
//
//  ⚠⚠ 27 Aug 2026 — THIS SILENTLY STOPPED WORKING WHEN THE APP MOVED DOMAIN.
//    The allowed origin was one hard-coded value, "https://nkeats.github.io".
//    Once the Sales App moved to https://app.simtectp.com the browser refused to
//    send the real request after the preflight, so EVERY signed document and ID
//    photo since the move failed to upload — 22 files across 5 orders. They were
//    not lost (the app parks them in the database as a fallback) but they never
//    reached storage, and the only outward sign was rows piling up in
//    sim_upload_failures that nobody was watching.
//
//    It now accepts a LIST of origins, including the old github.io address,
//    because an iPad that has not refreshed is still on it.
//    ⚠ IF THE APP EVER MOVES AGAIN, ADD THE NEW ADDRESS HERE FIRST.
//    ⚠ AND CHECK sim_upload_failures AFTER ANY DOMAIN CHANGE.
//
//  ⚠⚠ 1 Oct 2026 — NEVER ATTACH ONE SALE'S DOCUMENTS TO ANOTHER SALE'S ORDER.
//    Files live at {orderId}/… and are written with upsert, so an iPad holding
//    the previous sale's order id would OVERWRITE that customer's signature and
//    ID photos. The database trigger tg_id_belongs_to_one_sale stops the ROWS
//    landing on the wrong order; it cannot see files, and this function writes
//    with the service role. So the app now sends the customer id it is attaching
//    for, and an order that belongs to a different customer is refused with
//    code 'other_sale'. The app treats that as final — no fallback route.
//    customerId is OPTIONAL so a build that does not send it still uploads.
//
//  Deploy with verify_jwt = TRUE. Consultants may write to their OWN orders;
//  office/admin/manager to any.
//  This file is the source of version 9, deployed 1 Oct 2026 — keep the two in step.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_ORIGINS = [
  "https://app.simtectp.com",
  "https://nkeats.github.io",
];
const ALLOWED = (Deno.env.get("ALLOWED_ORIGIN") || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ORIGINS = ALLOWED.length ? ALLOWED : DEFAULT_ORIGINS;

function corsFor(req: Request) {
  const o = req.headers.get("Origin") || "";
  const allow = ORIGINS.includes(o) ? o : ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsFor(req), "Content-Type": "application/json" } });

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "application/pdf"];

function bytesFromBase64(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(req) });
  if (req.method !== "POST") return json(req, { error: "method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(req, { error: "not signed in" }, 401);
  const { data: { user }, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !user) return json(req, { error: "not signed in" }, 401);

  const { data: prof } = await admin.from("profiles")
    .select("role, consultant_name").eq("id", user.id).maybeSingle();
  const role = prof?.role || "";
  const isOffice = ["admin", "manager", "office"].includes(role);
  if (!isOffice && role !== "consultant") return json(req, { error: "not allowed" }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { return json(req, { error: "bad request" }, 400); }

  const orderId = String(body.orderId || "").trim();
  const customerId = String(body.customerId || "").trim();   // optional — see the 1 Oct note above
  const sub = String(body.path || "").trim().replace(/^\/+/, "");
  const contentType = String(body.contentType || "application/octet-stream");
  const data64 = String(body.data || "");

  if (!orderId || !sub || !data64) return json(req, { error: "orderId, path and data are required" }, 400);
  if (sub.includes("..")) return json(req, { error: "bad path" }, 400);
  const clean = sub.replace(/^.*?\//, (m) => (m === orderId + "/" ? "" : m));
  const path = `${orderId}/${clean.replace(/^\/+/, "")}`;
  if (path.includes("..")) return json(req, { error: "bad path" }, 400);
  if (!ALLOWED_TYPES.includes(contentType)) return json(req, { error: "file type not allowed" }, 400);

  const { data: order } = await admin.from("sim_orders")
    .select("id, consultant_name, customer_id").eq("id", orderId).maybeSingle();
  if (!order) return json(req, { error: "order not found" }, 404);
  if (!isOffice && order.consultant_name !== prof?.consultant_name) {
    return json(req, { error: "that is not your order" }, 403);
  }
  if (customerId && order.customer_id !== customerId) {
    try {
      await admin.from("sim_upload_failures").insert({
        order_id: orderId, path,
        message: "REFUSED — this order belongs to a different customer (" + order.customer_id +
                 "); the iPad was attaching for " + customerId + ". Nothing was written.",
        device: (req.headers.get("user-agent") || "").slice(0, 200),
      });
    } catch (_e) { /* logging must never make it worse */ }
    return json(req, { ok: false, code: "other_sale",
      error: "this order already belongs to a different sale, so its documents were not touched" }, 409);
  }

  let bytes: Uint8Array;
  try { bytes = bytesFromBase64(data64); }
  catch { return json(req, { error: "could not read the file" }, 400); }
  if (!bytes.length) return json(req, { error: "empty file" }, 400);
  if (bytes.length > MAX_BYTES) return json(req, { error: "file too large" }, 413);

  const { error: upErr } = await admin.storage
    .from("order-documents")
    .upload(path, bytes, { upsert: true, contentType });

  if (upErr) {
    try {
      await admin.from("sim_upload_failures").insert({
        order_id: orderId, path, message: "server upload: " + upErr.message,
        device: (req.headers.get("user-agent") || "").slice(0, 200),
      });
    } catch (_e) { /* logging must never make it worse */ }
    return json(req, { ok: false, error: upErr.message }, 502);
  }

  try {
    await admin.from("sim_document_fallback")
      .update({ moved_at: new Date().toISOString() })
      .eq("path", path).is("moved_at", null);
  } catch (_e) { /* nothing depends on this */ }

  return json(req, { ok: true, path, bytes: bytes.length });
});
