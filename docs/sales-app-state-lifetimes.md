# State that outlives what it belongs to — sweep of 1 Oct 2026

The 30 Sep fault was one instance of a class: **state whose lifetime was assumed,
not enforced.** The order ids sat in `sessionStorage` because "sessionStorage dies
with the tab" — true in Safari, false in a Home-Screen web app, which is ONE tab
that iOS keeps and restores for days.

For every piece of state that can outlive a page, this records what ends its life,
and what happens when that ending never arrives. Swept: every `localStorage` /
`sessionStorage` key in the repository, the Sales App's in-memory sale state, and
the page-restore paths. **Nothing below has been changed** except where it says
"fixed" — the rest is reported first, as asked.

Two of these were **proved in the real page** with the regression harness
(`tests/sales-app`), not inferred from reading:

## Proved — serious

### A. A new sale inherits the last sale's direct-debit reference (offline "Start new order")
- **State:** `S.eziRef`, `S.eziRefBad`, `S.eziSkipped` / `eziSkipWhy` / `eziSkipPlan`, `S.cashTaken`, `S.referralId` — in memory, on the page.
- **Assumed end:** "Start new order". Online it reloads the page, which does end them.
- **Actual end when the browser says offline:** `resetForm()` resets the form in place and **does not reset these**.
- **When the ending never arrives:** sale 2 reaches the Ezidebit step already holding sale 1's reference, and the "a direct debit must be set up" check passes. **Proved:** sale 2 was finished without the Ezidebit form ever opening, and went to the office as `pending` with no payer reference. `S.referralId` would also credit sale 1's referral to sale 2.
- **Reachable:** whenever `navigator.onLine` says false at "Start new order" — genuinely offline, or iOS lying while the server is reachable.
- **Caught downstream?** `database_audit()` rule 18 flags a signed sale with no Ezidebit after **2 days**.

### B. An old Ezidebit return is applied to a new order
- **State:** `localStorage['simtec_ezidebit_return']`, written by `ezidebit-return.html`.
- **Assumed end:** read and removed by the app when it comes back from Ezidebit.
- **No expiry, and not tied to its sale.** `resumeFromEzidebit()` applies whatever is there to the order in the resume marker, without checking `params.uref` (the order it was for) against `mark.orderId`, or the return's time against the marker's.
- **When the ending never arrives** (the return page reached twice, or a return orphaned any other way): the next sale whose consultant comes back from Ezidebit WITHOUT a fresh return — back button, app switch, form abandoned — picks up the old one. **Proved:** the new order was given another customer's payer reference `987654321` and their $99 schedule, and the screen said "schedule stored on the order". That customer's payments would then be credited to this one.
- **Caught downstream?** Rule 3 ("credited to the WRONG customer") only if Ezidebit's notes disagree.

## Reported — not proved

| State | Where | What ends it | When the ending never arrives | Risk |
|---|---|---|---|---|
| Order ids `simtec_order_ids_v1` | sessionStorage | spent at Done; 8 h; **user change (fixed 1 Oct)** | — | fixed |
| Sale queue `simtec_parked_orders` | localStorage | successful upload only (by design, 1 Oct) | a permanent refusal keeps it on the iPad; rule 23 surfaces it | intended |
| Ezidebit resume marker `simtec_ezi_resume` | localStorage | read on return; 120-minute expiry | resumes into a fresh load within 120 min — see bfcache below | low |
| "Start new order" `navigator.onLine` gate | order-app `newOrder()` | — | iOS says online while offline → `location.reload()` with no signal → the Home-Screen app shows a blank "cannot open" page until signal returns. Says offline while online → finding A | medium |
| Page restored from back-forward cache | all pages | a fresh load runs the start-up code | returning from Ezidebit by the back button can restore the OLD page with its in-memory sale and skip `resumeFromEzidebit()`; the marker then waits for the next load (≤120 min), which may be a different sale | suspected, not proved |
| Profile cache `simtec_profile_<uid>` | sessionStorage (auth.js) | refreshed quietly each load; reloads on role/active change | a renamed consultant is shown — and saves orders — under the old name for one load; the insert policy then refuses it (now it queues and retries) | low |
| Update flag `simtec_update_tried:<page>` | sessionStorage (update.js) | commented "this launch only" | on a Home-Screen app it lives for days; keyed to build+fingerprint, so a new deploy still triggers a fresh attempt — the only effect is a "close and reopen" bar instead of a second reload | low |
| Catalogue cache `simtec_catalogue_v1` | localStorage | overwritten by every successful live load | used only offline, with a dated "prices as last loaded" banner | intended |
| Device owner `simtec_device_owner` | localStorage (auth.js) | an office sign-in | intended: binds the iPad | intended |
| Crew device `simtec_crew_device` | localStorage (driver-day) | never | intended: a device identity | intended |
| `simtec_sb_url` / `simtec_sb_key` | localStorage (app.js) | never | **app.js is loaded by no page** — dead code | none |
| Rewards / demo keys (`simtec_crossed`, `simtec_lvl`, `simtec_ver`, `simtec_install_snooze`, `demo_*`) | localStorage | per-feature | customer app display state only | none |
| Preferences (`simtec_order_sound`, `reorder_*`) | localStorage | user changes them | preferences | none |

## The pattern, and the rule it suggests

Every serious case is the same shape: **something that belongs to one sale is held
somewhere that outlives the sale, and the code that reads it does not check that it
belongs to the sale in front of it.** The ids now carry `at`, `spent` and `user`, and
are checked against all three. The two proved faults above are the same fix:

- **A:** "a new sale" should reset *all* of `S` from one definition of a blank sale,
  not a hand-maintained list — the list is what drifted.
- **B:** the Ezidebit return should carry the order it belongs to and be refused
  when it does not match the marker (`params.uref === mark.orderId`, and
  `ret.at >= mark.at`).

Neither is changed yet — awaiting the go-ahead.
