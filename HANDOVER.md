# Simtec Order System — Handover

_Last updated: 25 July 2026_

**One-line status:** Order app is live and working end-to-end (submit → save → order PDF → GHL contact). Email delivery is being moved OFF the slow/unreliable GHL-Mailgun path ONTO Resend for both the verification code and the welcome email. We stopped mid-way through setting up a Resend account (Path B).

---

## ▶ IMMEDIATE NEXT ACTION — finish the Resend setup (Path B)

We are standing up a **new, self-owned Resend account** to send email fast (GHL/Mailgun was taking ~10 min or not delivering at all — unusable because the welcome email is confirmed on the immediate confirmation call).

Steps, in order:

1. Create a free account at **resend.com** (free tier is plenty).
2. Domains → Add Domain → enter **`tx.simtectp.com`** (the `tx` subdomain deliberately avoids clashing with the existing `resend._domainkey` and the `send`/`mail` records already in the zone). Pick the default region.
3. Resend shows DNS records (MX + SPF TXT + DKIM TXT). Add them at **Digital Pacific** DNS (same place we added the Mailgun records). Then click Verify in Resend. _Claude can verify each record is live via `https://dns.google/resolve?name=…&type=…` before you hit Verify._
4. Resend → API Keys → create one.
5. In Supabase → Edge Functions → **`send-verify-code`**: create the function (paste `supabase/functions/send-verify-code/index.ts`), deploy it, and set secrets:
   - `RESEND_API_KEY` = the key from step 4
   - `RESEND_FROM` = `Simtec Therapeutic <noreply@tx.simtectp.com>`
6. Push `order-app.html` (already updated). Test: on an order, "Send code" should email a 6-digit code that arrives in **seconds**.

**Then (still to build):** move the **welcome/confirmation email** onto Resend too, sent instantly by the edge function on order submit. This needs the T&Cs / 15-yr warranty / 30-day guarantee PDFs at public URLs (simplest: drop them in the repo). Once that's live, switch OFF the GHL confirmation-email workflow.

---

## What is LIVE and working

- **Order app** — `nkeats.github.io/simtec-system/order-app.html`. Staff-only login gate (`admin, manager, office`; consultants excluded until go-live). Full flow works: products → customer → ID → payment → sign → submit → saves to Supabase, generates a one-page order-summary PDF, pushes a GHL contact.
- **Email domain authentication** — `mg.simtectp.com` fully verified in GHL (SPF, DKIM, DMARC, both MX green). This authenticates the GHL sending path (which we're nonetheless retiring for speed).
- **Idempotency** — `ghl-order-push` edge function claims each order once (`sim_orders.ghl_pushed_at`), so one order = one GHL push, even if invoked multiple times.
- **Test data cleaned** — all app test orders + their commission rows removed from Supabase; figures back to normal.

## Changed this session — deploy status

| Change | Where | Deployed? |
|---|---|---|
| Multiple ID photos per applicant (auto-compressed) | order-app.html | in repo — **push to deploy** |
| 50% deposit → Ezidebit, with deposit-method logic | order-app.html | in repo — **push to deploy** |
| "Send code" calls `send-verify-code` (real email) | order-app.html | in repo — **push to deploy** |
| Visible submit errors (no more dead button) | order-app.html | LIVE |
| Idempotency guard | ghl-order-push/index.ts | LIVE (redeployed) |
| `send-verify-code` function | new edge function | **not yet created in Supabase** (inert until RESEND_API_KEY set) |
| `ghl_pushed_at` column | sim_orders | LIVE (SQL run) |

_Note: `order-app.html` in the repo has several unpushed changes bundled together — one push deploys them all._

### Deposit-method logic (for reference)
- **Unsolicited sale + 50% deposit** → locked to Ezidebit one-off (5-day cooling-off means no upfront money); Ezidebit covers 100% (one-off 50% + plan 50%).
- **Solicited sale + 50% deposit** → consultant chooses: Bank transfer (Ezidebit covers remaining 50%) OR Ezidebit one-off (covers 100%).

## Full pending list

1. **Finish Resend (Path B)** — see top of doc. Unblocks all fast email.
2. **Welcome email → Resend** — build the instant send; retire the GHL workflow email.
3. **Push `order-app.html`** — deploys the multiple-photos, deposit, and code-sender changes.
4. **Ezidebit production switch** (currently SANDBOX): in `order-app.html`, `EZI_EDDR_BASE` demo→`secure.ezidebit.com.au`, `EZI_PUBLIC_KEY`→live key; whitelist the return URL with Ezidebit; verify payer-ref matching (cref vs uref).
5. **Delete GHL test contacts** (cosmetic) — search `nigel+`, `nigelkeats3004`, and leftover "Test"/"TEST3" contacts; bulk-delete.
6. **Consultant go-live** — add `,consultant` to the order-app `data-roles`, and add a "New Order" button to `my-sales.html`.

## Open issue / decision made
- **GHL/Mailgun email is unreliable** — sometimes ~10 min late, sometimes never delivered, even when the GHL contact is created correctly. Decision: stop using it for email; send both the code and the welcome email via **Resend** (direct transactional, instant). GHL keeps the **contact** (for the office's confirmation call), not the email.

---

## Technical reference

- **Repo:** `github.com/nkeats/simtec-system` — GitHub Pages auto-deploys static HTML on push. Local copy: `D:\SIMTEC\Simtec NZ\System Apps\GitHub\simtec-system`.
- **Edge functions do NOT auto-deploy** — deploy manually in the Supabase dashboard (Edge Functions → paste `index.ts` → Deploy).
- **Supabase project ref:** `jvqjoenaungubpoegyvf`. Publishable key: `sb_publishable_J4MYTdJJyEaWe-GadpwdYA_upPT2rKw`.
- **GHL:** agency "Matus", NZ location `s78O4hTnREBpEQAmR2aI` ("Simtec Therapeutic"). Isolation tag: `simtec-app-order`. Guarantee tag: `comfort-guarantee`.
- **DNS:** Digital Pacific (nameservers aussiedns.net.au). Root email on Microsoft 365.
- **Secrets to set on `send-verify-code`:** `RESEND_API_KEY`, `RESEND_FROM`. (`ghl-order-push` uses `GHL_NZ_TOKEN`, `GHL_NZ_LOCATION_ID`, `GHL_APP_TAG`, `GHL_GUARANTEE_TAG`.)

### Gotchas learned this session
- **Outlook/M365 does NOT support `+` (plus) addressing** — `nigel+test@simtectp.com` bounces. Gmail DOES. Use a fresh Gmail alias (`nigelkeats3004+t1@gmail.com`) for testing, and expect real customers on normal addresses.
- **A brand-new sending domain gets greylisted** by Gmail (delayed first emails) — one reason we're using Resend's warm IPs instead of the fresh Mailgun domain.
- **GHL "Contact Tag" workflows:** turn re-entry **ON** (so repeat customers get emails) and rely on the edge-function idempotency to prevent duplicates — NOT re-entry off (which blocks repeat customers and re-tests).
- **GHL & Supabase detail pages don't render in browser automation** (blank) — Claude can't "look" at them; needs screenshots or SQL/DNS queries instead.
- **Edge function auth:** validate the caller JWT with `getUser(token)` using the SERVICE_ROLE key (the anon key can be disabled on this project).
