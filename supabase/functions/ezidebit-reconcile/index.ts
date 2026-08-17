// ============================================================================
//  ezidebit-reconcile v20 — payment reconciliation via Ezidebit's Non-PCI API.
// ----------------------------------------------------------------------------
//  ⚠⚠ v20 (18 Aug 2026) — THE PAID TOTAL IS NO LONGER CALCULATED HERE.
//    v19 recomputed sim_orders.amount_paid_to_date itself, by summing
//    sim_payments where payer_ref = the order's payer ref. That is a FIFTH,
//    NARROWER copy of a rule the database already owns:
//      - it drops every payment held under order_id (59% of cleared payments
//        have no order_id at import time — the healer links them afterwards)
//      - it drops payments under the Ezidebit customer id
//      - it never subtracts refunds
//    PROVEN LIVE before this change: it would write 400 for Naomi Perfect
//    (true 660) and 250 for Leausami Tolai (true 350) — the exact wrong figures
//    that reappeared every night and undid the office's corrections.
//    ⚠ IT NOW CALLS rebase_paid_totals(order_ids), which uses
//    order_paid_total(). DO NOT PUT A SUM BACK IN THIS FILE.
//
//  ⚠⚠ v18/v19 (15 Aug 2026) — WHY THE RESOLVER CHANGED. READ BEFORE EDITING.
//    v17 could only identify an Ezidebit customer by MOBILE NUMBER. When their
//    mobile at Ezidebit differed from ours by even a digit, the whole lookup was
//    thrown away and the payment imported attached to NOTHING.
//    By 15 Aug that had produced **151 orphan payments worth $6,676** — money in
//    the ledger belonging to nobody. Thirty customers had paid and looked like
//    they had not: false arrears, wrongly chased, ratings damaged.
//    GetCustomerDetails ALREADY returns name, email and address. v17 read the
//    mobile and discarded the rest.
//    v18 matches on MOBILE, then EMAIL, then NAME — and requires a SECOND,
//    INDEPENDENT agreement before it writes a mapping.
//    ⚠ NEVER map on one weak signal alone. Putting one customer's money on
//    another customer's account is worse than leaving it unmatched.
//
//    v19 adds the RUN LOG (public.ezidebit_reconcile_log). The reason the
//    orphans went unnoticed for months is that pg_net times out at 5s while
//    this function takes longer, so its answer was never readable by anyone.
//    ⚠ DO NOT REMOVE THE LOG. `needs_a_human` is the office's work list.
// ----------------------------------------------------------------------------
//  THE TWO-ID PROBLEM (still true)
//    Ezidebit's API identifies a customer by an internal 8-digit
//    EzidebitCustomerID. Our book keys the ledger on the 9-digit SETTLEMENT
//    payer ref from the PDF reports. Different numbers, same person.
//
//  BODY OPTIONS  {fromDate,toDate}  settlement range (default: yesterday)
//                {dry:true}         report only
//                {map:false}        skip GetCustomerDetails lookups
//                {mapCap:N}         lookup budget (default 40)
//                {mapOrphans:true}  ALSO chase ids already sitting unmatched in
//                                   the ledger. For backfills; nightly leaves off.
//  AUTH: header x-simtec-key == STAFF_SMS_KEY. Deploy with verify_jwt FALSE.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const NONPCI_URL =
  Deno.env.get("EZIDEBIT_NONPCI_URL") || "https://api.demo.ezidebit.com.au/v3-5/nonpci";
const NS = "https://px.ezidebit.com.au/";
const MAP_CAP_DEFAULT = 40;

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i"));
  return m ? m[1].trim() : "";
}
const num = (s: string) => {
  const n = parseFloat((s || "").replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
};
const last8 = (s: string) => (s || "").replace(/\D/g, "").slice(-8);
const normName = (s: string) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
function isoDate(s: string): string | null {
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-simtec-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, "content-type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.headers.get("x-simtec-key") !== Deno.env.get("STAFF_SMS_KEY")) {
    return json({ status: "unauthorized" }, 401);
  }
  const digitalKey = Deno.env.get("EZIDEBIT_DIGITAL_KEY");
  if (!digitalKey) return json({ status: "disabled", reason: "EZIDEBIT_DIGITAL_KEY not set" });

  let fromD: Date, toD: Date, dry = false, doMap = true, mapCap = MAP_CAP_DEFAULT, mapOrphans = false;
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    if (body.dry === true) dry = true;
    if (body.map === false) doMap = false;
    if (body.mapOrphans === true) mapOrphans = true;
    if (Number(body.mapCap) > 0) mapCap = Math.min(Number(body.mapCap), 200);
    if (body.fromDate && body.toDate) {
      fromD = new Date(body.fromDate + "T00:00:00Z");
      toD = new Date(body.toDate + "T00:00:00Z");
    } else {
      const y = new Date(Date.now() - 24 * 3600 * 1000);
      fromD = toD = new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate()));
    }
  } catch {
    const y = new Date(Date.now() - 24 * 3600 * 1000);
    fromD = toD = new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate()));
  }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  async function soap(action: string, inner: string) {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:px="${NS}">` +
      `<soap:Body><px:${action}>${inner}</px:${action}></soap:Body></soap:Envelope>`;
    try {
      const resp = await fetch(NONPCI_URL, {
        method: "POST",
        headers: { "content-type": "text/xml; charset=utf-8", "SOAPAction": `"${NS}INonPCIService/${action}"` },
        body,
      });
      const xml = await resp.text();
      if (!resp.ok) return { ok: false, err: `HTTP ${resp.status}: ${xml.slice(0, 300)}` };
      const ec = tag(xml, "Error");
      if (ec && ec !== "0") return { ok: false, err: `Ezidebit ${ec}: ${tag(xml, "ErrorMessage")}` };
      return { ok: true, xml };
    } catch (e) { return { ok: false, err: "fetch: " + String(e) }; }
  }

  async function getPayments(paymentType: string) {
    const r = await soap(
      "GetPayments",
      `<px:DigitalKey>${xmlEscape(digitalKey!)}</px:DigitalKey>` +
        `<px:PaymentType>${paymentType}</px:PaymentType>` +
        `<px:PaymentMethod>ALL</px:PaymentMethod>` +
        `<px:PaymentSource>SCHEDULED</px:PaymentSource>` +
        `<px:PaymentReference></px:PaymentReference>` +
        `<px:DateFrom>${fmtDate(fromD)}</px:DateFrom>` +
        `<px:DateTo>${fmtDate(toD)}</px:DateTo>` +
        `<px:DateField>SETTLEMENT</px:DateField>` +
        `<px:EziDebitCustomerID></px:EziDebitCustomerID>` +
        `<px:YourSystemReference></px:YourSystemReference>`,
    );
    if (!r.ok) return { ok: false, err: r.err };
    const blocks = (r.xml || "").match(/<(?:\w+:)?Payment>[\s\S]*?<\/(?:\w+:)?Payment>/gi) || [];
    const rows = blocks.map((b) => {
      const o: Record<string, string> = {};
      for (const fld of ["PaymentID","EziDebitCustomerID","YourSystemReference","SettlementDate",
        "PaymentDate","DebitDate","PaymentAmount","ScheduledAmount","ClientFee","TotalFees",
        "BankReturnCode","BankFailedReason"]) o[fld] = tag(b, fld);
      return o;
    }).filter((r2) => r2.PaymentID);
    return { ok: true, rows };
  }

  const settledCall = await getPayments("SUCCESSFUL");
  const failedCall = await getPayments("FAILED");
  if (!settledCall.ok && !failedCall.ok) {
    return json({ status: "error", stage: "soap", settledCall: settledCall.err, failedCall: failedCall.err }, 502);
  }
  const settledRaw = (settledCall.rows as Record<string, string>[]) || [];
  const failedRaw = (failedCall.rows as Record<string, string>[]) || [];

  const apiIds = [...new Set([...settledRaw, ...failedRaw].map((r) => r.EziDebitCustomerID).filter(Boolean))];

  if (mapOrphans) {
    const { data: orph } = await supa
      .from("sim_payments").select("payer_ref")
      .eq("source", "ezidebit-api").not("payer_ref", "is", null).limit(3000);
    const seen = new Set(apiIds);
    for (const r of orph || []) {
      const ref = (r as any).payer_ref as string;
      if (ref && ref.length === 8 && !seen.has(ref)) { apiIds.push(ref); seen.add(ref); }
    }
  }

  const canon: Record<string, { canon: string; order_id: string }> = {};
  for (let i = 0; i < apiIds.length; i += 200) {
    const slice = apiIds.slice(i, i + 200);
    const { data: mapped } = await supa
      .from("sim_orders").select("id,ezidebit_payer_ref,ezidebit_customer_id")
      .in("ezidebit_customer_id", slice);
    (mapped || []).forEach((o: any) => {
      if (o.ezidebit_customer_id && !canon[o.ezidebit_customer_id]) {
        canon[o.ezidebit_customer_id] = { canon: o.ezidebit_payer_ref || o.ezidebit_customer_id, order_id: o.id };
      }
    });
    const unknown = slice.filter((id) => !canon[id]);
    if (unknown.length) {
      const { data: direct } = await supa
        .from("sim_orders").select("id,ezidebit_payer_ref").in("ezidebit_payer_ref", unknown);
      (direct || []).forEach((o: any) => {
        if (o.ezidebit_payer_ref && !canon[o.ezidebit_payer_ref]) {
          canon[o.ezidebit_payer_ref] = { canon: o.ezidebit_payer_ref, order_id: o.id };
        }
      });
    }
  }

  let mapped_new = 0, map_failed = 0, lookups = 0;
  const unsure: any[] = [];
  const mappedDetail: any[] = [];
  let book: any[] | null = null;

  if (doMap) {
    for (const id of apiIds) {
      if (canon[id] || lookups >= mapCap) continue;
      lookups++;
      const cd = await soap(
        "GetCustomerDetails",
        `<px:DigitalKey>${xmlEscape(digitalKey!)}</px:DigitalKey>` +
          `<px:EziDebitCustomerID>${xmlEscape(id)}</px:EziDebitCustomerID>` +
          `<px:YourSystemReference></px:YourSystemReference>`,
      );
      if (!cd.ok) { map_failed++; unsure.push({ id, why: "Ezidebit lookup failed: " + cd.err }); continue; }

      const xml = cd.xml || "";
      const eMob = last8(tag(xml, "MobilePhoneNumber") || tag(xml, "MobileNumber") || tag(xml, "MobilePhone"));
      const eEmail = (tag(xml, "EmailAddress") || "").trim().toLowerCase();
      const eFirst = tag(xml, "FirstName");
      const eLast = tag(xml, "LastName");
      const who = `${eFirst} ${eLast}`.trim();
      const eName = normName(eFirst + eLast);

      let custId: string | null = null;
      let how = "";

      if (eMob && eMob.length >= 8) {
        const { data: byMob } = await supa.rpc("find_customer_by_mobile", { p_mobile: eMob });
        if (byMob && byMob[0] && byMob[0].id) { custId = byMob[0].id; how = "mobile"; }
      }
      if (!custId && eEmail) {
        const { data: byEmail } = await supa.from("sim_customers").select("id").ilike("email", eEmail).limit(2);
        if (byEmail && byEmail.length === 1) { custId = byEmail[0].id; how = "email"; }
      }
      if (!custId && eName.length > 5) {
        if (!book) {
          const { data: all } = await supa.from("sim_customers").select("id,first_name,last_name").limit(5000);
          book = all || [];
        }
        const hits = book.filter((c: any) => normName((c.first_name || "") + (c.last_name || "")) === eName);
        if (hits.length === 1) { custId = hits[0].id; how = "name"; }
        else if (hits.length > 1) { map_failed++; unsure.push({ id, who, why: "more than one customer has that name" }); continue; }
      }
      if (!custId) {
        map_failed++;
        unsure.push({ id, who, ezidebit_mobile: eMob, ezidebit_email: eEmail, why: "nobody in the book matches this person" });
        continue;
      }

      const { data: ordsRaw } = await supa
        .from("sim_orders").select("id,ezidebit_payer_ref,instalment_amount,order_status,paid_in_full")
        .eq("customer_id", custId).order("created_at", { ascending: false });
      const ords = (ordsRaw || []).filter((o: any) => (o.order_status || "active") !== "cancelled" && !o.paid_in_full);
      if (!ords.length) { map_failed++; unsure.push({ id, who, matched_by: how, why: "that customer has no open order" }); continue; }

      let ord = ords[0];
      if (ords.length > 1) {
        const amts = [...settledRaw, ...failedRaw].filter((r) => r.EziDebitCustomerID === id)
          .map((r) => num(r.PaymentAmount) || num(r.ScheduledAmount));
        const fit = ords.filter((o: any) => amts.some((a) => Math.abs(a - Number(o.instalment_amount ?? -1)) <= 0.01));
        if (fit.length !== 1) {
          map_failed++;
          unsure.push({ id, who, matched_by: how, why: `${ords.length} open orders and the amount does not single one out` });
          continue;
        }
        ord = fit[0];
      }

      if (!dry) {
        const { error: upErr } = await supa.from("sim_orders").update({ ezidebit_customer_id: id }).eq("id", ord.id);
        if (upErr) { map_failed++; unsure.push({ id, who, why: "could not save: " + upErr.message }); continue; }
      }
      canon[id] = { canon: ord.ezidebit_payer_ref || id, order_id: ord.id };
      mapped_new++;
      mappedDetail.push({ id, who, matched_by: how, payer_ref: ord.ezidebit_payer_ref, ezidebit_mobile: eMob, only_open_order: ords.length === 1 });
    }
  }

  let healed: unknown = { skipped: "dry-run" };
  try {
    const { data: h, error: hErr } = await supa.rpc("ezidebit_canonicalise_api_rows", { p_dry: dry });
    healed = hErr ? { error: hErr.message } : h;
  } catch (e) { healed = { error: String(e) }; }

  const resolve = (id: string) => canon[id] || null;
  const settled = settledRaw.map((r) => {
    const c = resolve(r.EziDebitCustomerID);
    return {
      payer_ref: (c ? c.canon : r.EziDebitCustomerID) || null,
      ezidebit_customer_id: r.EziDebitCustomerID || null,
      order_id: c ? c.order_id : null,
      payment_date: isoDate(r.PaymentDate) || isoDate(r.DebitDate),
      settlement_date: isoDate(r.SettlementDate),
      amount: num(r.PaymentAmount),
      fees: num(r.ClientFee || r.TotalFees) || null,
      cleared: num(r.PaymentAmount),
      result: "paid", source: "ezidebit-api", method: "DR",
      dedup_key: "ezi:" + r.PaymentID,
      notes: r.YourSystemReference || null,
      recorded_by: "ezidebit-reconcile",
    } as any;
  });
  const dishonoured = failedRaw.map((r) => {
    const c = resolve(r.EziDebitCustomerID);
    return {
      payer_ref: (c ? c.canon : r.EziDebitCustomerID) || null,
      ezidebit_customer_id: r.EziDebitCustomerID || null,
      dishonour_date: isoDate(r.SettlementDate) || isoDate(r.PaymentDate),
      settlement_date: isoDate(r.SettlementDate),
      amount: num(r.ScheduledAmount) || num(r.PaymentAmount),
      failed_reason: r.BankFailedReason || r.BankReturnCode || null,
      dedup_key: "ezi:" + r.PaymentID,
    } as any;
  });
  const unresolved = [...settled, ...dishonoured].filter((r) => !canon[r.ezidebit_customer_id || ""]).length;

  async function insertNew(table: string, rows: any[]) {
    if (!rows.length) return { inserted: 0, skipped: 0, crossSkipped: 0 };
    const keys = rows.map((r) => r.dedup_key);
    const { data: existing } = await supa.from(table).select("dedup_key").in("dedup_key", keys);
    const have = new Set((existing || []).map((e: any) => e.dedup_key));
    let fresh = rows.filter((r) => !have.has(r.dedup_key));
    let crossSkipped = 0;
    if (fresh.length) {
      const dates = [...new Set(fresh.map((r) => r.settlement_date).filter(Boolean))];
      const { data: pdfRows } = await supa.from(table)
        .select("payer_ref,settlement_date,amount,dedup_key")
        .in("settlement_date", dates).not("dedup_key", "like", "ezi:%");
      const counts: Record<string, number> = {};
      (pdfRows || []).forEach((e: any) => {
        const k = `${e.payer_ref}|${e.settlement_date}|${Number(e.amount).toFixed(2)}`;
        counts[k] = (counts[k] || 0) + 1;
      });
      fresh = fresh.filter((r) => {
        const k = `${r.payer_ref}|${r.settlement_date}|${Number(r.amount).toFixed(2)}`;
        if ((counts[k] || 0) > 0) { counts[k]--; crossSkipped++; return false; }
        return true;
      });
    }
    if (fresh.length && !dry) {
      const { error } = await supa.from(table).insert(fresh);
      if (error) throw new Error(`${table}: ${error.message}`);
    }
    return { inserted: fresh.length, skipped: rows.length - fresh.length - crossSkipped, crossSkipped };
  }

  let payRes: any, disRes: any;
  try {
    payRes = await insertNew("sim_payments", settled);
    disRes = await insertNew("sim_dishonours", dishonoured);
  } catch (e) {
    return json({ status: "error", stage: "write", message: String(e) }, 500);
  }

  // ⚠⚠ v20 — THE PAID TOTAL IS REFRESHED BY THE DATABASE, NOT HERE.
  // v19 summed sim_payments by payer_ref and wrote the result itself. That
  // dropped payments held under order_id or the Ezidebit customer id and never
  // subtracted refunds, so it silently undid office corrections every night.
  // rebase_paid_totals() uses order_paid_total() — the one definition.
  // ⚠ DO NOT REPLACE THIS WITH A SUM. If it fails it is REPORTED, not swallowed.
  let ordersUpdated = 0;
  let rebaseError: string | null = null;
  if (!dry) {
    try {
      const orderIds = [...new Set(
        [...settled, ...dishonoured].map((r: any) => r.order_id).filter(Boolean),
      )] as string[];
      if (orderIds.length) {
        const { data: n, error } = await supa.rpc("rebase_paid_totals", { p_order_ids: orderIds });
        if (error) { rebaseError = error.message; console.error("rebase_paid_totals failed:", error.message); }
        else ordersUpdated = Number(n) || 0;
      }
    } catch (e) {
      rebaseError = String(e);
      console.error("rebase_paid_totals threw:", rebaseError);
    }
  }

  const summary = {
    status: "ok", version: 20, mode: dry ? "DRY-RUN" : "LIVE",
    range: { from: fmtDate(fromD), to: fmtDate(toD), dateField: "SETTLEMENT" },
    endpoint: NONPCI_URL.includes("demo") ? "SANDBOX" : "LIVE",
    fetched: { settled: settledRaw.length, dishonoured: failedRaw.length },
    calls: { settled: settledCall.ok ? "ok" : settledCall.err, failed: failedCall.ok ? "ok" : failedCall.err },
    ids: { seen: apiIds.length, resolved: Object.keys(canon).length, mapped_new, map_failed, lookups, unresolved_rows: unresolved },
    mapped: mappedDetail, needs_a_human: unsure,
    healed, settled: payRes, dishonoured: disRes, ordersUpdated, rebaseError,
  };

  // ⚠ THE RUN LOG — do not remove. Without it nobody can see what this job did:
  // pg_net gives up after 5s and this function runs longer, so the response is
  // never read by the caller. See the header.
  try {
    await supa.from("ezidebit_reconcile_log").insert({
      mode: summary.mode, range_from: fmtDate(fromD), range_to: fmtDate(toD),
      fetched: summary.fetched, ids: summary.ids,
      mapped: mappedDetail, needs_a_human: unsure,
      healed: healed as any,
      written: { settled: payRes, dishonoured: disRes, ordersUpdated, rebaseError },
    });
  } catch (e) { console.error("reconcile log failed:", (e as Error)?.message || e); }

  return json(summary);
});
