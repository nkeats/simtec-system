# CLAUDE.md — Simtec System

Static HTML on GitHub Pages at `app.simtectp.com` (repo `nkeats/simtec-system`).
Database, edge functions and storage: Supabase `jvqjoenaungubpoegyvf`.
Australia is a **different** project, `ftzxndwjghteklcrpfus`.

**Read `Simtec-System-Handover-2026-09-04.md` first.** This file is only the
rules that cost money when broken — it is not a summary of the system.

---

## THE RULE ABOVE ALL OTHERS

> ⚠ **NEVER ASSUME — ASK.** Do not build, change, deploy or "improve" anything
> without asking Nigel first, even when the next step looks obvious or is a
> small extra alongside what was asked for.

> ⚠ **ROBUST · SIMPLE · SECURE. Double check everything before changing
> anything.** Every time Nigel has had to repeat this, it was because something
> was changed — or asserted — on a first impression.

**Claude does not push.** Claude produces the file, Nigel pushes it via GitHub
Desktop. Verify what is live by fetching the raw file — never assume a push
happened, and never assume it didn't. Migrations and edge functions Claude does
apply directly.

---

## THE RULES THAT COST MONEY WHEN BROKEN

These are not style preferences. Each came from a real fault.

### ⚠⚠ One definition of what has been paid

`order_paid_total()` is it, and `rebase_paid_totals()` writes the cached
`amount_paid_to_date`. **Never write `amount_paid_to_date = amount_paid_to_date
+ x`.** That addition existed in the reconciler (v19) and in the reward-card
redemption, and both silently undid the office's corrections. **Two sources of
truth for one payment is the recurring money bug in this system.**

### ⚠⚠ A query in the SQL editor is not what the page sees

It runs as the owner, read-write, with no row security. This has cost days:

- a view joining `auth.users` worked perfectly and returned "permission denied"
  for every real user;
- a policy that queried another RLS-protected table saw nothing and refused
  every insert;
- `home_alerts_v2` was marked `STABLE`, so the browser ran it **read-only** and
  the self-test — which writes a probe row — failed continuously for three days
  while passing every time it was run in the editor. **Volatility changes
  behaviour between the editor and the page.**

**Test with `set local role authenticated` and real JWT claims.**

### ⚠ A silent failure is a bug, even when the code "works"

A greyed-out button that will not say why, a blank panel that looks identical to
an empty one, a "sent" that means "accepted by the API". **Say what happened.**

### ⚠ `exception when others` will disguise your own bug as a real fault

A migration referenced a column that does not exist; the handler reported it as
"the health check cannot record a finding" — 40 failures out of 40.

### ⚠ When a policy on a parent table changes, check the children

Loosening `sim_orders` without `sim_order_items` would have saved orders with no
products on them — worse than no order, and far harder to spot.

### ⚠ Bonus descriptions print on the consultant's invoice, verbatim

Seven people nearly received a tax document reading `__ACCREDITATION__`.

### ⚠ Look at the rendered thing

A missing font glyph, a ghost price drawn by a second text layer, the word
"bullet" printed over every line — none of these appear in any automated check.

---

## HOW THIS HAS GONE WRONG BEFORE

Everything below passed a check and was still wrong.

- **A stale check is worse than no check.** Files were twice reported as
  unpushed from a check run earlier and never repeated.
- **When Nigel says it is still there, it is still there.** He was right three
  times running on the self-test banner while every test said otherwise.
- **Grep can match your own comment.** Compare fingerprints, not text.
- **Parsing clean is not working.** A page whose JavaScript parsed perfectly
  could not run — no library loaded, no client created.
- **A test harness can lie.** Node silently kept its own user-agent and made
  every device look like an Android.
- **Extraction is not rendering.** The PDF that printed "bullet" over every line
  extracted perfectly.
- **Deploy the file, not a placeholder.** A stub was once deployed over the live
  reconciler.
- **Check the whole match set.** "Delivery" instead of "Delivery fee" produced a
  wrong sales figure within hours — a typo, and the report's rule was fragile
  enough to trip on it.
