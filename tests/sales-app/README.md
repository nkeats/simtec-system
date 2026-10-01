# Sales App regression suite

Loads the **real** `order-app.html` from this folder's repository in headless Chromium
and drives whole sales through the real UI — the Next button, the T&C scroll gate,
signature strokes, the No-ID exit, the trip out to Ezidebit and back through
`ezidebit-return.html` — against a stubbed Supabase.

## Run it

```
python tests/sales-app/test_order_flow.py            # everything, ~2 minutes
python tests/sales-app/test_order_flow.py -k Parked  # one group
```

Needs Python with Playwright and its Chromium (`pip install playwright` then
`python -m playwright install chromium`). No Node, no pytest.

It tests the page **as it is in your working copy**, uncommitted edits included.
To test some other copy — what is live, or a deliberately broken one — point
`SALES_APP_ROOT` at a folder holding `order-app.html`, `auth.js`, `update.js`,
`client-errors.js` and `ezidebit-return.html`.

A failing test leaves a screenshot in `tests/sales-app/failures/` (not committed).

## What is real and what is not

| Real | Stubbed |
|---|---|
| order-app.html, auth.js, update.js, ezidebit-return.html | the database (`FakeDB` in `harness.py`) |
| Chromium, an iPad viewport and Safari user agent | Ezidebit's hosted form (sends the browser straight back to the callback) |
| sessionStorage, localStorage, reloads, online/offline | supabase-js (`stub_supabase.js`, served in place of the CDN copy) |
| jsPDF and the QR library (fetched from their CDNs) | |

The database lives in Python, outside the page, so it **survives a reload** the
way the real one does — the faults this suite exists for all happen across reloads.

`FakeDB` copies the two database behaviours the order lifecycle depends on:
upsert with `ignoreDuplicates` is `ON CONFLICT DO NOTHING`, and
`tg_id_belongs_to_one_sale` (a BEFORE trigger, so it fires before the conflict
check) refuses an id that already holds a different customer. Its messages are
copied from the live function. **If that trigger changes, change `FakeDB._trigger`.**

## What it covers

- a fresh sale mints a new customer id and order id, saved as a draft
- a reload after a failed save keeps the ids; the resubmit writes the same rows
- a reload after the draft save, before Ezidebit, keeps the ids and finishes the same order
- the Ezidebit round trip returns and completes the same order (uRef = order id)
- a finished sale's ids are never reused — via Start new order, and via the app simply reopening
- ids older than 8 hours are never reused; ids just under 8 hours still are
- ids with no mint time (written before the 30 Sep fix) are never reused
- a parked order replays under its own ids, including while the device holds another sale's
- an order parked offline uploads when the connection returns

Every test also fails if the page throws, or reports a fault to the office that
the test did not deliberately cause.

## Known faults

Tests marked `@unittest.expectedFailure` pin a fault that is real today. They
report "expected failure" while it is broken and **"unexpected success" the
moment it is fixed** — then remove the decorator.

## Proving it catches things

A suite that has never failed proves nothing. It was run against three broken
copies of the page (ids never retired at Done; the 8-hour limit removed; parked
orders replayed under the device's ids) and caught each one. Repeat that when
the harness changes.

## Adding a test

Each test is a fresh iPad with an empty database. `Sale(app).to_review()` gets to
the Sign step; `.submit()`, `.ezidebit()`, `.finish()` take it the rest of the
way; `.whole()` does all of it. `app.db` is the database, `app.stored_ids()` the
ids the iPad is holding. **A fix to the Sales App comes with a test here.**
