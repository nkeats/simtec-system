// ============================================================================
//  ghl-au-contacts — pull the Australian GHL contacts for the arrears page
// ----------------------------------------------------------------------------
//  Secrets (supabase secrets set ...):
//     GHL_AU_TOKEN        — GHL Private Integration token for the AU account
//     GHL_AU_LOCATION_ID  — AU sub-account (location) id
//     ALLOWED_ORIGIN      — (optional) exact origin of the Simtec app, e.g.
//                           https://app.simtec.co.nz  — used to scope CORS.
//
//  SECURITY (phase-2 hardening):
//   * Keep verify_jwt ON so only a logged-in user can reach the function.
//   * PLUS an explicit role check below: only admin/manager/office may call it,
//     so a `consultant` login cannot dump every AU contact.
//   * CORS is scoped to ALLOWED_ORIGIN when set (falls back to * only if unset).
//   * Upstream GHL errors and the field-schema debug view are logged server-side
//     and NOT returned verbatim to the browser.
//
//  Deploy:  supabase functions deploy ghl-au-contacts
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GHL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Vary": "Origin",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Only these roles may call this function.
const STAFF = new Set(["admin", "manager", "office"]);

async function requireStaff(req: Request): Promise<{ ok: true } | { ok: false; res: Response }> {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader) return { ok: false, res: json({ error: "unauthorized" }, 401) };
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return { ok: false, res: json({ error: "unauthorized" }, 401) };
  const { data: prof } = await supa.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!prof || !STAFF.has(prof.role)) return { ok: false, res: json({ error: "forbidden" }, 403) };
  return { ok: true };
}

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

async function fieldMap(token: string, loc: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const res = await ghl(`/locations/${loc}/customFields`, token);
  const defs = res.body?.customFields || res.body?.customField || [];
  for (const f of defs) if (f?.id) map[f.id] = (f.name || f.fieldKey || f.id);
  return map;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // --- authorization: logged-in AND staff role -------------------------------
  const gate = await requireStaff(req);
  if (!gate.ok) return gate.res;

  const token = Deno.env.get("GHL_AU_TOKEN");
  const loc = Deno.env.get("GHL_AU_LOCATION_ID");
  if (!token || !loc) return json({ error: "server not configured" }, 500);

  const url = new URL(req.url);
  try {
    if (url.searchParams.get("debug") === "fields") {
      const res = await ghl(`/locations/${loc}/customFields`, token);
      // staff-only, but still avoid dumping the raw schema — return names only
      const names = (res.body?.customFields || res.body?.customField || []).map((f: any) => f?.name || f?.fieldKey).filter(Boolean);
      return json({ status: res.status, fieldNames: names }, res.ok ? 200 : 502);
    }

    const fmap = await fieldMap(token, loc);

    const out: any[] = [];
    let searchAfter: any = null;
    let guard = 0;
    while (guard++ < 500) {
      const payload: any = { locationId: loc, pageLimit: 100 };
      if (searchAfter) payload.searchAfter = searchAfter;
      const res = await ghl(`/contacts/search`, token, { method: "POST", body: JSON.stringify(payload) });
      if (!res.ok) {
        console.error("GHL search failed", res.status, JSON.stringify(res.body));  // log, don't leak
        return json({ error: "upstream error", gotSoFar: out.length }, 502);
      }
      const contacts = res.body?.contacts || res.body?.data || [];
      for (const c of contacts) {
        const fields: Record<string, string> = {};
        for (const cf of (c.customFields || c.customField || [])) {
          const name = fmap[cf.id] || cf.id;
          const value = cf.value ?? cf.field_value ?? cf.fieldValue ?? "";
          if (value !== "" && value != null) fields[name] = String(value);
        }
        out.push({
          id: c.id,
          name: (c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.fullNameLowerCase || "").trim(),
          firstName: c.firstName || "",
          lastName: c.lastName || "",
          phone: c.phone || "",
          email: c.email || "",
          tags: c.tags || [],
          fields,
        });
      }
      const last = contacts[contacts.length - 1];
      searchAfter = res.body?.searchAfter || (last && last.searchAfter) || null;
      if (!contacts.length || contacts.length < 100 || !searchAfter) break;
    }

    return json({ count: out.length, fieldNames: Object.values(fmap), contacts: out });
  } catch (e) {
    console.error("ghl-au-contacts error", e);
    return json({ error: "internal error" }, 500);
  }
});
