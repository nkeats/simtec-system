// ============================================================================
//  ghl-au-contacts — pull the Australian GHL contacts for the arrears page
// ----------------------------------------------------------------------------
//  Reads two Edge Function secrets:
//     GHL_AU_TOKEN        — a GHL Private Integration token for the AU account
//     GHL_AU_LOCATION_ID  — the AU sub-account (location) id
//
//  Returns every AU contact trimmed to what the follow-up list needs
//  (name, phone, email, tags) plus a flattened map of custom-field
//  name -> value, so au-arrears.html can match Ezidebit payers to contacts
//  by the Ezidebit payer ref / contract ref if that lives in GHL, else by name.
//
//  Deploy:
//     supabase functions deploy ghl-au-contacts
//     supabase secrets set GHL_AU_TOKEN=xxxxx GHL_AU_LOCATION_ID=xxxxx
//  Keep verify_jwt ON (default) so only a logged-in Simtec user can call it.
//
//  Handy first-run check:  GET .../ghl-au-contacts?debug=fields
//     → returns the AU custom-field definitions so we can see exactly which
//       field holds the Ezidebit payer ref / contract number.
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const GHL = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// custom-field definitions: id -> readable name (so per-contact {id,value} become named)
async function fieldMap(token: string, loc: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const res = await ghl(`/locations/${loc}/customFields`, token);
  const defs = res.body?.customFields || res.body?.customField || [];
  for (const f of defs) if (f?.id) map[f.id] = (f.name || f.fieldKey || f.id);
  return map;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const token = Deno.env.get("GHL_AU_TOKEN");
  const loc = Deno.env.get("GHL_AU_LOCATION_ID");
  if (!token || !loc) return json({ error: "Missing GHL_AU_TOKEN or GHL_AU_LOCATION_ID secret." }, 500);

  const url = new URL(req.url);
  try {
    // ---- diagnostic: list the AU custom-field definitions --------------------
    if (url.searchParams.get("debug") === "fields") {
      const res = await ghl(`/locations/${loc}/customFields`, token);
      return json({ status: res.status, customFields: res.body?.customFields ?? res.body }, res.ok ? 200 : 502);
    }

    const fmap = await fieldMap(token, loc);

    // ---- page through all AU contacts (GHL v2 search) ------------------------
    const out: any[] = [];
    let searchAfter: any = null;
    let guard = 0;
    while (guard++ < 500) {
      const payload: any = { locationId: loc, pageLimit: 100 };
      if (searchAfter) payload.searchAfter = searchAfter;
      const res = await ghl(`/contacts/search`, token, { method: "POST", body: JSON.stringify(payload) });
      if (!res.ok) {
        // surface the raw GHL error so we can fix token/location/endpoint fast
        return json({ error: `GHL ${res.status}`, detail: res.body, gotSoFar: out.length }, 502);
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
      // GHL returns the sort cursor on the last contact; fall back to page count
      const last = contacts[contacts.length - 1];
      searchAfter = res.body?.searchAfter || (last && last.searchAfter) || null;
      if (!contacts.length || contacts.length < 100 || !searchAfter) break;
    }

    return json({ count: out.length, fieldNames: Object.values(fmap), contacts: out });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
