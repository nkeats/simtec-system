# Simtec Order System — Handover

_Last updated: 26 July 2026_

**Status:** Order-taking system is built and largely live. Email (verification codes + welcome email) runs on Resend, fast and reliable. A pre-go-live security review has been done and its fixes applied. The remaining milestone is the **Ezidebit production switch** (still on sandbox).

---

## ⚠ DEPLOYMENT STATUS — do these to be fully live

**1. PUSH `order-app.html`** — this is the important one. The live GitHub copy is **stale** (missing the full T&Cs, the Ezidebit schedule on the summary, the address fix, and the security fixes). The correct file is in the repo folder already — it just wasn't in the last push. Commit + push `order-app.html` (make sure it's ticked in GitHub Desktop's changes). Live should then be ~1333 lines and contain "Ezidebit payment schedule" and "Continuing Payment Obligation".

**2. Confirm the two SQL scripts ran** (run the verify queries at the bottom of each): `storage-policy-fix.sql` and `applications-rls-fix.sql`.

**3. Confirm the two edge functions were redeployed** in the Supabase dashboard (recent "deployed" timestamp): `ghl-order-push` and `send-verify-code` — both now role-gated.

**Confirmed live:** `customer-detail.html` (ID-document viewer) is deployed. RLS is enabled on all sensitive tables; the `order-documents` bucket is private.

---

## What the system does now

- **Order app** (`order-app.html`, iPad, staff-gated `admin/manager/office`): products → customer → **email verification (real code via Resend)** → ID docs (**multiple photos per applicant**, auto-compressed) → payment (full / **50% deposit** / Ezidebit) → **full T&Cs** (scroll-to-enable) → sign → submit → **Ezidebit step** (for deposit/DD) → Done. On Done it regenerates the order-summary PDF **with the Ezidebit schedule**, pushes a GHL contact, and sends the welcome email.
- **50% deposit logic:** unsolicited sale → deposit locked to an Ezidebit one-off (cooling-off); solicited → choose bank transfer or Ezidebit; Ezidebit finances the balance accordingly.
- **Email (all via Resend, instant):** the verification code (`send-verify-code`) and the welcome email (built into `ghl-order-push`) both go through Resend on the verified `simtectp.com` domain — NOT the old slow GHL/Mailgun path. The GHL confirmation-email workflow is OFF. GHL keeps the **contact** for the office's confirmation call. Welcome email attaches the order-summary PDF + T&Cs + 15-yr warranty, and the 30-day guarantee **only** for Mk III Queen / Super King.
- **Customer page** (`customer-detail.html`): admin/manager can view an order's **ID documents** (signed-URL viewer).
- **Idempotency:** one GHL push / one welcome email per order (`sim_orders.ghl_pushed_at` claim).

## Security posture (after the review + fixes)

Confirmed: RLS enabled on all sensitive tables; `order-documents` bucket private; storage reads locked to admin/manager; consultants scoped to their own orders (incl. the `sim_order_applications` fix); both edge functions role-gated to order-takers; welcome-email signed URL cut to 7 days; double-submit guard; Ezidebit schedule-save errors surfaced; `esc()` hardened; no bank data touches the app (hosted eDDR iframe).

See `SECURITY-REVIEW.md` for the full findings. Remaining, non-blocking items are listed there and below.

## Pending — Ezidebit production go-live (the last milestone)

Ezidebit is still on **sandbox**. You don't give Ezidebit access to your system — you get **production credentials from Ezidebit** and register your callback URL. Steps:

1. From Ezidebit (Ezionline portal / account manager): the **production Public Key** (for the eDDR form), the **production Digital Key** (server-side secret for API reconciliation), confirmation the **eDDR is enabled**, and your **return URL** (`ezidebit-return.html` on the GitHub Pages domain) **whitelisted**.
2. App switch: point the form at `secure.ezidebit.com.au` with the live public key (ideally behind a single `EZI_LIVE` flag so it can't be half-switched).
3. **Build server-side reconciliation** (the security-critical part, review finding H2): a small edge function that calls the Ezidebit API with the Digital Key to confirm the direct debit actually exists before the order is trusted as funded — because the current browser callback can be faked.
4. Test one real direct-debit setup end to end.

## Other pending (non-blocking, from the review)

- **Offline-synced (parked) orders** don't push to GHL / send the welcome email — they bypass the confirmation pipeline. (H4)
- **Abandoned orders** (saved at Submit, never reach Done) get no GHL contact / email; consider pushing the contact at save time + a server-side sweep. (H5)
- The park/offline flow can hit the iPad localStorage quota with many photos; move the queue to IndexedDB. (H3)
- Set `ALLOWED_ORIGIN` on the edge functions (currently defaults to `*`); add rate-limiting to `send-verify-code`; pull and review the `manage-users` edge function for a server-side admin check.
- Consultant go-live: add `,consultant` to the order-app `data-roles` + a "New Order" button on `my-sales.html`.
- Delete leftover GHL **test contacts** (cosmetic).

---

## Technical reference

- **Repo:** `github.com/nkeats/simtec-system` — GitHub Pages auto-deploys static HTML on push. Local: `D:\SIMTEC\Simtec NZ\System Apps\GitHub\simtec-system`. **Edge functions deploy manually** in the Supabase dashboard (paste `index.ts` → Deploy) — they do NOT deploy from git.
- **Supabase project:** `jvqjoenaungubpoegyvf`. Publishable (browser) key: `sb_publishable_J4MYTdJJyEaWe-GadpwdYA_upPT2rKw` (public by design).
- **Edge functions:** `ghl-order-push` (GHL contact + welcome email + idempotency), `send-verify-code` (Resend code), `ghl-au-contacts` (AU), plus a `manage-users` (referenced by users.html; review it).
- **Secrets (project-wide, in Supabase):** `RESEND_API_KEY`, `RESEND_FROM` (`Simtec Therapeutic <noreply@simtectp.com>`), `WELCOME_DOC_TERMS` / `WELCOME_DOC_WARRANTY` / `WELCOME_DOC_GUARANTEE` (GHL media URLs of the PDFs), `GHL_NZ_TOKEN` / `GHL_NZ_LOCATION_ID` / `GHL_APP_TAG` / `GHL_GUARANTEE_TAG`.
- **Resend:** account under `nigel@simtectp.com`; `simtectp.com` verified.
- **GHL:** NZ location `s78O4hTnREBpEQAmR2aI`. Isolation tag `simtec-app-order`, guarantee tag `comfort-guarantee`. Confirmation-email workflow is OFF (email moved to Resend).
- **Ezidebit (sandbox):** `order-app.html` `EZI_EDDR_BASE` (demo) + `EZI_PUBLIC_KEY` (sandbox). eDDR address params: `addr`=street, `suburb`=suburb, `state`=city, `pCode`=postcode. Reconciliation key `uRef` = order UUID.

### Gotchas learned
- **Outlook/M365 doesn't support `+` addressing** — test with a real Gmail alias (`nigelkeats3004+t1@gmail.com`); Gmail supports it.
- **New sending domains get greylisted** by Gmail (delayed first emails) — why email moved to Resend's warm IPs.
- **GHL & Supabase detail pages render blank in browser automation** — needs screenshots or SQL/DNS queries.
- **Supabase SQL editor commits per statement** — `create temp table ... on commit drop` gets dropped mid-script; use inline subqueries instead.
- **Windows opens `.ts` as video** — deliver edge-function code as `.txt` to open in Notepad.
- **Every app-pushed order has `ghl_pushed_at` set** — the clean way to identify app (test) orders vs real imported orders (which have it NULL).
