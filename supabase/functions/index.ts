// ============================================================================
//  ezidebit-reconcile — server-side payment reconciliation via Ezidebit's
//                       Non-PCI GetPayments web service.
// ----------------------------------------------------------------------------
//  WHAT IT DOES
//    Calls Ezidebit GetPayments for a settlement-date range (default: yesterday
//    NZ), then writes each result into the SAME tables the daily PDF import uses:
//      - Settled payments   -> sim_payments
//      - Dishonoured/failed  -> sim_dishonours
//    Both are de-duplicated on dedup_key = "ezi:<PaymentID>", so the API and the
//    PDF import converge on one key and can NEVER double-count. After writing, it
//    recomputes sim_orders.amount_paid_to_date for every affected order.
//
//  *** SAFETY — READ BEFORE DEPLOYING ***
//    1. INERT until you set EZIDEBIT_DIGITAL_KEY. Without it the function returns
//       {status:"disabled"} and touches nothing.
//    2. Read-only against Ezidebit (GetPayments only). No card/bank data is sent
//       or received, so this stays inside your non-PCI (SAQ-A) scope.
//    3. It only INSERTS payment/dishonour rows (skipping any dedup_key already
//       present) and UPDATES amount_paid_to_date. It never deletes.
//
//  *** VERIFY ON FIRST SANDBOX CALL (marked VERIFY below) ***
//    The SOAP namespace, the FromDate/ToDate format, and the exact field order
//    must match YOUR sandbox WSDL. Confirm against
//    https://api.demo.ezidebit.com.au/v3-5/nonpci?singleWsdl and adjust the three
//    VERIFY constants if the first call errors. Everything else (DB writes,
//    dedup, recompute) is final.
//
//  SECRETS (Supabase project settings -> Edge Functions -> Secrets)
//    EZIDEBIT_DIGITAL_KEY        <your sandbox Digital Key>   (required)
//    EZIDEBIT_NONPCI_URL         (optional; defaults to sandbox v3-5 nonpci)
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (auto-present in Edge Functions)
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- VERIFY #1: SOAP endpoint (swap to https://api.ezidebit.com.au/v3-5/nonpci for LIVE) ---
const NONPCI_URL =
  Deno.env.get("EZIDEBIT_NONPCI_URL") || "https://api.demo.ezidebit.com.au/v3-5/nonpci";
// --- VERIFY #2: SOAP namespace + SOAPAction host (from the WSDL <targetNamespace>) ---
const NS = "https://px.ezidebit.com.au/";
// --- VERIFY #3: date format for FromDate/ToDate. Ezidebit GetPayments has historically
//     used dd/MM/yyyy. If the call rejects the dates, switch fmtDate() to yyyy-MM-dd.
function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// pull the inner text of the first <tag> (namespace-agnostic) inside a block
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i"));
  return m ? m[1].trim() : "";
}
const num = (s: string) => {
  const n = parseFloat((s || "").replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
};
// Ezidebit dates come back as yyyy-MM-dd or dd/MM/yyyy -> normalise to yyyy-MM-dd
function isoDate(s: string): string | null {
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

serve(async (req) => {
  const digitalKey = Deno.env.get("EZIDEBIT_DIGITAL_KEY");
  if (!digitalKey) {
    return new Response(JSON.stringify({ status: "disabled", reason: "EZIDEBIT_DIGITAL_KEY not set" }), {
      headers: { "content-type": "application/json" },
    });
  }

  // Date range: body {fromDate,toDate} (yyyy-MM-dd) or default = yesterday (NZ ~ UTC+12/13; using UTC-1 day is close enough for a daily job, refine if needed)
  let fromD: Date, toD: Date;
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
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

  // --- Build + send the GetPayments SOAP request (settlement date range) ---
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:ezi="${NS}">` +
    `<soap:Body><ezi:GetPayments>` +
    `<ezi:DigitalKey>${xmlEscape(digitalKey)}</ezi:DigitalKey>` +
    `<ezi:PaymentType>ALL</ezi:PaymentType>` +
    `<ezi:PaymentMethod>ALL</ezi:PaymentMethod>` +
    `<ezi:PaymentSource>ALL</ezi:PaymentSource>` +
    `<ezi:PaymentReference></ezi:PaymentReference>` +
    `<ezi:EziDebitCustomerID></ezi:EziDebitCustomerID>` +
    `<ezi:YourSystemReference></ezi:YourSystemReference>` +
    `<ezi:FromDate>${fmtDate(fromD)}</ezi:FromDate>` +
    `<ezi:ToDate>${fmtDate(toD)}</ezi:ToDate>` +
    `<ezi:PaymentID></ezi:PaymentID>` +
    `<ezi:DateField>SETTLEMENT</ezi:DateField>` +
    `<ezi:Order>asc</ezi:Order>` +
    `<ezi:OrderBy>SettlementDate</ezi:OrderBy>` +
    `<ezi:PageNumber>0</ezi:PageNumber>` +
    `</ezi:GetPayments></soap:Body></soap:Envelope>`;

  let xml = "";
  try {
    const resp = await fetch(NONPCI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/soap+xml; charset=utf-8",
        "SOAPAction": `${NS}IEzidebitNonPCI/GetPayments`,
      },
      body: envelope,
    });
    xml = await resp.text();
    if (!resp.ok) {
      return new Response(JSON.stringify({ status: "error", stage: "soap", http: resp.status, body: xml.slice(0, 1200) }), {
        status: 502, headers: { "content-type": "application/json" },
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ status: "error", stage: "fetch", message: String(e) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }

  // Surface an Ezidebit-level error (Error != 0)
  const errCode = tag(xml, "Error");
  const errMsg = tag(xml, "ErrorMessage");
  if (errCode && errCode !== "0") {
    return new Response(JSON.stringify({ status: "ezidebit_error", code: errCode, message: errMsg || null }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  // --- Parse each <Payment> ---
  const blocks = xml.match(/<(?:\w+:)?Payment>[\s\S]*?<\/(?:\w+:)?Payment>/gi) || [];
  const settled: any[] = [];
  const dishonoured: any[] = [];
  for (const b of blocks) {
    const pid = tag(b, "PaymentID");
    if (!pid) continue;
    const dedup = "ezi:" + pid;
    const status = (tag(b, "PaymentStatus") || "").toUpperCase(); // S=settled, D/F=dishonour, W/P=pending
    const payerRef = tag(b, "EziDebitCustomerID");
    const yourRef = tag(b, "YourSystemReference");
    const settleDate = isoDate(tag(b, "SettlementDate"));
    const debitDate = isoDate(tag(b, "PaymentDate")) || isoDate(tag(b, "DebitDate"));
    const amount = num(tag(b, "PaymentAmount"));
    const scheduled = num(tag(b, "ScheduledAmount"));
    const fee = num(tag(b, "ClientFee") || tag(b, "TotalFees"));

    if (status === "S") {
      settled.push({
        payer_ref: payerRef || null,
        payment_date: debitDate,
        settlement_date: settleDate,
        amount,
        fees: fee || null,
        cleared: amount,
        result: "settled",
        source: "ezidebit-api",
        method: "DR",
        dedup_key: dedup,
        notes: yourRef || null,
        recorded_by: "ezidebit-reconcile",
      });
    } else if (status === "D" || status === "F") {
      dishonoured.push({
        payer_ref: payerRef || null,
        dishonour_date: settleDate || debitDate,
        settlement_date: settleDate,
        amount: scheduled || amount,
        failed_reason: tag(b, "BankFailedReason") || tag(b, "BankReturnCode") || null,
        dedup_key: dedup,
      });
    }
    // W/P (waiting/pending) are skipped — not final; a later run picks them up.
  }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // --- De-dup against what's already stored, then insert ---
  async function insertNew(table: string, rows: any[]) {
    if (!rows.length) return { inserted: 0, skipped: 0 };
    const keys = rows.map((r) => r.dedup_key);
    const { data: existing } = await supa.from(table).select("dedup_key").in("dedup_key", keys);
    const have = new Set((existing || []).map((e: any) => e.dedup_key));
    const fresh = rows.filter((r) => !have.has(r.dedup_key));
    if (fresh.length) {
      const { error } = await supa.from(table).insert(fresh);
      if (error) throw new Error(`${table}: ${error.message}`);
    }
    return { inserted: fresh.length, skipped: rows.length - fresh.length };
  }

  let payRes, disRes;
  try {
    // attach order_id to settled rows via payer_ref -> order lookup
    const refs = [...new Set(settled.map((s) => s.payer_ref).filter(Boolean))];
    if (refs.length) {
      const { data: ords } = await supa
        .from("sim_orders").select("id,ezidebit_payer_ref").in("ezidebit_payer_ref", refs);
      const byRef: Record<string, string> = {};
      (ords || []).forEach((o: any) => { if (o.ezidebit_payer_ref) byRef[o.ezidebit_payer_ref] = o.id; });
      settled.forEach((s) => { s.order_id = s.payer_ref ? (byRef[s.payer_ref] || null) : null; });
    }
    payRes = await insertNew("sim_payments", settled);
    disRes = await insertNew("sim_dishonours", dishonoured);
  } catch (e) {
    return new Response(JSON.stringify({ status: "error", stage: "write", message: String(e) }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }

  // --- Recompute amount_paid_to_date for orders that got a new settled payment ---
  let ordersUpdated = 0;
  try {
    const touched = [...new Set(settled.filter((s) => s.order_id).map((s) => s.order_id))];
    for (const oid of touched) {
      const { data: pays } = await supa.from("sim_payments").select("amount").eq("order_id", oid);
      const total = (pays || []).reduce((a: number, p: any) => a + (Number(p.amount) || 0), 0);
      const { error } = await supa.from("sim_orders").update({ amount_paid_to_date: total }).eq("id", oid);
      if (!error) ordersUpdated++;
    }
  } catch (_) { /* non-fatal — payments are recorded; totals can be re-derived */ }

  return new Response(JSON.stringify({
    status: "ok",
    range: { from: fmtDate(fromD), to: fmtDate(toD), dateField: "SETTLEMENT" },
    parsed: blocks.length,
    settled: payRes,
    dishonoured: disRes,
    ordersUpdated,
  }), { headers: { "content-type": "application/json" } });
});
