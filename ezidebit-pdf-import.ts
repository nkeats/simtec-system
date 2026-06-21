// Edge Function: ezidebit-pdf-import
// Receives a base64-encoded Ezidebit "Payment Settlement Report" PDF,
// extracts the transaction table, matches rows to orders by ezidebit_id,
// and writes results into the payments table.
//
// Deploy via Supabase dashboard (Edge Functions > New Function > ezidebit-pdf-import)
// or `supabase functions deploy ezidebit-pdf-import`
//
// NOTE: this function has not been run against a live Supabase project yet.
// The PDF column-boundary calibration was tested and confirmed against your
// sample report (see chat), but pdfjs-dist's behaviour inside the Deno Edge
// runtime should be smoke-tested with one real file before relying on it —
// worth uploading one report and checking the "unmatched" / "errors" counts
// in the response look sane before trusting it for go-live volumes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as pdfjsLib from "https://esm.sh/pdfjs-dist@4.0.379/legacy/build/pdf.mjs";

// deno-lint-ignore no-explicit-any
(pdfjsLib as any).GlobalWorkerOptions.workerSrc = "";

const HEADER_LABELS = [
  "Trans. Date",
  "Settlement Date",
  "Ezidebit Payer ID",
  "Payer Name",
  "Client Contract Ref",
  "Client Payment Ref",
  "Result",
  "Failed Reason",
  "Payment Amt",
  "Fees",
  "Amt Cleared",
];

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;

interface Word { text: string; x: number; y: number; page: number }
interface Row {
  trans_date: string;
  settlement_date: string;
  ezidebit_payer_id: string;
  payer_name: string;
  contract_ref: string;
  result: string;
  failed_reason: string;
  payment_amt: number;
  fees: number;
  amt_cleared: number;
}

function ddmmyyyyToIso(d: string): string | null {
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseMoney(s: string): number {
  if (!s) return 0;
  const neg = s.includes("-");
  const num = parseFloat(s.replace(/[^0-9.]/g, "")) || 0;
  return neg ? -num : num;
}

async function extractWords(pdfBytes: Uint8Array): Promise<Word[]> {
  const doc = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const words: Word[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items as any[]) {
      const str = (item.str || "").trim();
      if (!str) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      // pdfjs may give multi-word strings in one item — split on whitespace
      // but keep them as one "word" if they're a single token (no internal space)
      words.push({ text: str, x, y, page: p });
    }
  }
  return words;
}

function buildColumnBoundaries(words: Word[]): { label: string; x: number }[] {
  // Find the header line (first page, contains "Trans." and "Date")
  const headerWords = words.filter((w) => w.page === 1 && w.text === "Trans.");
  if (!headerWords.length) throw new Error("Could not find header row in PDF — layout may have changed");
  const headerY = headerWords[0].y;
  const tolerance = 4;
  const onHeaderLine = words.filter((w) => w.page === 1 && Math.abs(w.y - headerY) <= tolerance);

  // Known starting x for each column, derived from label first-word position
  const starts: { label: string; x: number }[] = [
    { label: "trans_date", x: minX(onHeaderLine, ["Trans."]) },
    { label: "settlement_date", x: minX(onHeaderLine, ["Settlement"]) },
    { label: "ezidebit_payer_id", x: minX(onHeaderLine, ["Ezidebit"]) },
    { label: "payer_name", x: minX(onHeaderLine, ["Payer", "Name"], "Ezidebit") },
    { label: "contract_ref", x: minX(onHeaderLine, ["Client", "Contract"]) },
    { label: "payment_ref", x: minX(onHeaderLine, ["Client", "Payment"]) },
    { label: "result", x: minX(onHeaderLine, ["Result"]) },
    { label: "failed_reason", x: minX(onHeaderLine, ["Failed"]) },
    { label: "payment_amt", x: minX(onHeaderLine, ["Payment", "Amt"], "Client") },
    { label: "fees", x: minX(onHeaderLine, ["Fees"]) },
    { label: "amt_cleared", x: minX(onHeaderLine, ["Amt", "Cleared"]) },
  ].filter((s) => s.x !== null) as { label: string; x: number }[];

  return starts.sort((a, b) => a.x - b.x);
}

function minX(line: Word[], candidates: string[], excludeAfter?: string): number {
  const matches = line.filter((w) => candidates.includes(w.text));
  if (!matches.length) return NaN;
  return Math.min(...matches.map((w) => w.x));
}

function assignColumn(x: number, boundaries: { label: string; x: number }[]): string {
  let col = boundaries[0].label;
  for (const b of boundaries) {
    if (x >= b.x - 8) col = b.label;
  }
  return col;
}

function parseRows(words: Word[], boundaries: { label: string; x: number }[]): Row[] {
  // Skip header + title area (top of page 1) and any repeated header on later pages
  const dataWords = words.filter((w) => !(w.y > 750 && w.page === 1));
  const leftBoundaryX = boundaries[0].x;

  // Group into visual lines by y (within a small tolerance), per page
  const lines: Word[][] = [];
  const sorted = [...dataWords].sort((a, b) => (a.page - b.page) || (b.y - a.y));
  let current: Word[] = [];
  let lastY: number | null = null;
  let lastPage: number | null = null;
  for (const w of sorted) {
    if (lastY === null || w.page !== lastPage || Math.abs(w.y - lastY) > 4) {
      if (current.length) lines.push(current);
      current = [w];
    } else {
      current.push(w);
    }
    lastY = w.y;
    lastPage = w.page;
  }
  if (current.length) lines.push(current);

  // Drop lines that are header repeats or page furniture
  const cleanLines = lines.filter((line) => {
    const text = line.map((w) => w.text).join(" ");
    if (HEADER_LABELS.some((h) => text.includes(h))) return false;
    if (text.includes("PAYMENT SETTLEMENT REPORT")) return false;
    if (text.includes("Direct Debit") || text.includes("Page") || text.includes("SimTec")) return false;
    return true;
  });

  // Group lines into records: a new record starts when a word matching
  // DATE_RE appears in the leftmost column position
  const records: Word[][] = [];
  let recordLines: Word[] = [];
  for (const line of cleanLines) {
    const leftWord = line.find((w) => Math.abs(w.x - leftBoundaryX) <= 10);
    const startsRecord = leftWord && DATE_RE.test(leftWord.text);
    if (startsRecord) {
      if (recordLines.length) records.push(recordLines);
      recordLines = [...line];
    } else {
      recordLines.push(...line);
    }
  }
  if (recordLines.length) records.push(recordLines);

  // Build each row by bucketing words into columns
  const rows: Row[] = [];
  for (const rec of records) {
    const cols: Record<string, string[]> = {};
    for (const w of rec) {
      const col = assignColumn(w.x, boundaries);
      (cols[col] ||= []).push(w.text);
    }
    const get = (k: string) => (cols[k] || []).join(" ").trim();
    const trans_date = get("trans_date");
    if (!DATE_RE.test(trans_date)) continue; // skip anything that didn't parse cleanly

    rows.push({
      trans_date,
      settlement_date: get("settlement_date"),
      ezidebit_payer_id: get("ezidebit_payer_id"),
      payer_name: get("payer_name").replace(/\s*,\s*/, ", "),
      contract_ref: get("contract_ref").replace(/\s+/g, ""),
      result: get("result"),
      failed_reason: get("failed_reason"),
      payment_amt: parseMoney(get("payment_amt")),
      fees: parseMoney(get("fees")),
      amt_cleared: parseMoney(get("amt_cleared")),
    });
  }
  return rows;
}

Deno.serve(async (req: Request) => {
  try {
    const { file_base64 } = await req.json();
    if (!file_base64) {
      return new Response(JSON.stringify({ error: "file_base64 is required" }), { status: 400 });
    }

    const bytes = Uint8Array.from(atob(file_base64), (c) => c.charCodeAt(0));
    const words = await extractWords(bytes);
    const boundaries = buildColumnBoundaries(words);
    const rows = parseRows(words, boundaries);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const summary = {
      total_rows: rows.length,
      paid_imported: 0,
      failed_imported: 0,
      duplicates_skipped: 0,
      unmatched: [] as Row[],
      errors: [] as string[],
    };

    for (const row of rows) {
      const { data: order, error: lookupErr } = await supabase
        .from("orders")
        .select("id, payment_follow_up_status")
        .eq("ezidebit_id", row.ezidebit_payer_id)
        .maybeSingle();

      if (lookupErr) {
        summary.errors.push(`Lookup failed for ${row.ezidebit_payer_id}: ${lookupErr.message}`);
        continue;
      }
      if (!order) {
        summary.unmatched.push(row);
        continue;
      }

      const isPaid = row.result === "Paid";
      const { error: insertErr } = await supabase.from("payments").insert([{
        order_id: order.id,
        customer_name: row.payer_name,
        amount: row.payment_amt,
        due_date: ddmmyyyyToIso(row.trans_date),
        paid_date: isPaid ? ddmmyyyyToIso(row.settlement_date) : null,
        status: isPaid ? "on_time" : "dishonoured",
        fee: row.fees,
        amount_cleared: row.amt_cleared,
        failed_reason: isPaid ? null : row.failed_reason,
        source: "manual_import",
      }]);

      if (insertErr) {
        // unique index on (order_id, due_date, amount) means duplicates land here
        if (insertErr.message.includes("duplicate") || insertErr.code === "23505") {
          summary.duplicates_skipped++;
        } else {
          summary.errors.push(`Insert failed for ${row.ezidebit_payer_id}: ${insertErr.message}`);
        }
        continue;
      }

      if (isPaid) {
        summary.paid_imported++;
      } else {
        summary.failed_imported++;
        // Only escalate to follow-up if not already mid-resolution
        if (!order.payment_follow_up_status || order.payment_follow_up_status === "resolved") {
          await supabase.from("orders").update({
            payment_failed_at: new Date().toISOString(),
            payment_failure_reason: row.failed_reason,
            payment_follow_up_status: "pending_contact",
          }).eq("id", order.id);
        }
      }
    }

    return new Response(JSON.stringify(summary), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
