# Deliveries — cancelling, and manual jobs

Two changes to the delivery module. Planned 16 September 2026; **built 17 September 2026.**
The plan below is kept as it was written. This section records what was built and
where it departed from the plan.

---

## Built — 17 September 2026

**Cancelling.** `Cancel delivery` sits beside Reschedule on the Booked tab of
`delivery.html`. It asks for a reason and calls `cancel_delivery(p_order, p_reason)`,
which owns the rules: it insists on a reason, refuses an order that is delivered
or has no booking, and leaves a stop the driver has already completed alone. The
page shows the RPC's message or error verbatim and refreshes the list either way —
a refusal for "already delivered" or "no booking" means the list on screen was stale.

**Booking a truck job.** `Book a truck job` on `customer-detail.html` (admin, manager,
office): job type, what the driver should do, the date, an optional different address.
It calls `book_truck_job()`, which finds the run by **date, not by person** with the
same ordering `tg_order_rebooked_moves_stop` uses, creates one if none, locks the run
row and appends the seq — never renumbers. It writes `driver_stops` only. **It never
writes `sim_orders.delivery_date` or `delivery_status`** — `test_truck_jobs()` proves it.

**What the driver sees.** `v_driver_stops` gained `job_type`, `job_note` and
`job_address`; a job address replaces the customer's address, suburb and coordinates
(the driver app then navigates by the written address). `driver-day.html`,
`driver-runs.html` (day table, map, printed run sheet) and `driver.html` show a solid
`PICKUP` / `SWAP` / `JOB` label a driver can read at a glance, the office's note in
full, and no items for a job. Completing a stop is unchanged: signature and photo.

**The visit list.** `Truck visits` on the customer page: every `driver_stops` row
against the customer's orders, in date order — date, type (the delivery drawn distinct
from the jobs), note, outcome, and whether a signature is on file.

**Tests.** `test_truck_jobs()` — 9 cases on a run dated 2099-01-01, registered with
`run_tests_and_report()`.

### Three departures from the plan, worth recording

1. **`delivery` is not a job type.** The plan listed `delivery · pickup · swap · other`.
   The original delivery is booked on the delivery screen, and a second route to it
   is a trap — `driver_complete_stop` treats any `job_type = 'delivery'` stop as the
   one that clears the order. Removed from the form **and refused by the RPC**, so
   the form is not the only thing standing in the way.

2. **The Delivered and Docket buttons are hidden on a job in `driver.html`.** That
   Delivered button calls `mark_delivered(order)`. On a pickup it would mark the
   customer's order delivered and fire the pillow charge. A job is completed in the
   driver app, where the signature and photo are. The docket is a delivery document,
   so it is not offered on a job either.

3. **`cancel_delivery` returns a stable code** — `cancelled | no_reason |
   already_delivered | no_booking | stop_completed` — alongside its message, so a
   page never has to match on the wording. ⚠ A page that needs to branch does so on
   the code, never on the text. `delivery.html` today needs no branch — it shows the
   message verbatim and refreshes on every outcome.

### One rule the test found that the plan did not know about

`driver_stops_one_per_order` is a unique index on `(run_id, order_id)`: **one stop per
order per run.** It is what stops a delivery being loaded twice, so it stays. The
consequence is that a job cannot share a day with that order's delivery, and two jobs
for one order cannot share a day. `book_truck_job()` refuses these in words
("… already has a pickup on the run for Thursday 01 Jan. One stop per customer per
day — add to that stop's note, or pick another day.") rather than letting the office
see a "duplicate key". If that ever needs relaxing, the index is the thing to discuss.

### What the database gained beyond the spec

- **A `job_eta` SMS template**, and `driver_next_stop` picks it for anything that is
  not a delivery — so a customer expecting a collection is not told their mattress is
  on its way.
- **`driver_run_sheet(p_date)` returns the day's truck jobs as well as its deliveries**,
  with `job_type`, `job_note` and `stop_id`, so the older order-based run sheet
  (`driver.html`) shows them too.
- **A delivery with no ticked product lines is not counted as complete.**
  `driver_complete_stop` only calls `mark_delivered` when every line on the stop is
  ticked; a stop with no lines at all warns *"No product lines were ticked, so the
  order has not been marked delivered"* rather than clearing the order on no evidence.

---

## The plan as written — 16 September 2026

## 0. ⚠⚠ Cancelling already works. It needs a button, not a build.

**`tg_order_rebooked_moves_stop` already handles it.** Its rule 3 reads *"no booking, no stop"* — and clearing `sim_orders.delivery_date` already:

- **deletes the driver stop**
- **logs it to `driver_stop_moves`** as `removed`, with the reason and who did it
- **leaves the order on `v_ready_to_deliver`**, because that view filters on `delivery_status <> 'delivered'` and `order_status = 'active'` and nothing else

⚠ **And it already refuses to do damage:** a stop that is `done` or `failed` is left alone as history, and a stop on a run that is already finished is left in place with a note saying so.

> **So the whole of change one is: a Cancel button that sets `delivery_date = null`, plus a reason, plus telling the office what just happened.**

### What to build

**On the booking screen, beside Reschedule: `Cancel delivery`.**

**It asks for a reason** — a short free text, and the office should be made to type something. The reason goes into `driver_stop_moves.reason` so the trail reads properly.

**Then it says plainly what happened:**
> *"Booking cancelled. Taken off Thursday's run. [Customer] is back on the ready-to-deliver list."*

⚠ **Never a bare "done".** The office needs to know the customer went back on the list, or they will wonder whether to re-add them by hand.

⚠ **If the stop was already `done` or `failed`, say so instead:** *"That delivery has already been completed — nothing was changed."* The trigger protects this; the screen should explain it.

**Also needed:** `delivery_status` must be cleared if the booking set it to anything. ⚠ **Check what booking writes before building — if it sets `delivery_status = 'booked'`, cancel must unset it or the ready list will still be wrong.**

---

## 1. Manual jobs

**The truck gets used for things that are not the original delivery:** an extra product bought later, a mattress swap, a collection, a warehouse move.

### ⚠ Decided

**Everything stays on the customer record.** A swap is part of that customer's history. **So a manual job always carries `order_id`** — which is already nullable but will be populated.

**The driver sees whatever the office types.** No template, no inference — a free-text description written by the person who knows why the truck is going.

**A signature every time.** ⚠ **Including collections.** The signature means *the job was done to the customer's satisfaction*, which matters as much when taking something away as when leaving it.

### The schema

```sql
alter table public.driver_stops
  add column job_type    text not null default 'delivery',
  add column job_note    text,
  add column job_address text,
  add column created_by  uuid references auth.users(id);
```

**`job_type`** — `delivery` · `pickup` · `swap` · `other`
⚠ **Default `delivery`** so every existing stop keeps behaving exactly as it does now.

**`job_note`** — what the driver reads. *"Collect the Queen, leave the Super King. Customer knows."*
**`job_address`** — only when it differs from the order's address. ⚠ **Null means use the order's address**, so nothing is duplicated and nothing goes stale.
**`created_by`** — who booked it.

### Booking one

**From the customer's page**, because that is where the office already is when the reason arises.

**A short form:** what kind of job · what the driver should do · which date · a different address if needed.

**It creates a `driver_stops` row** on that date's run — reusing the existing run-finding logic from the rebooking trigger, which already picks the run by **date, not by person**, and creates one if none exists. ⚠ **And appends the seq, never renumbers.**

### ⚠ What a manual job must NOT touch

**Not `sim_orders.delivery_date`.** That field means *when the original delivery is booked*. A swap three months later must not overwrite it, or the trigger will move the wrong stop and the delivery history will be wrong.

> ### THE RULE
> **`delivery_date` is the original delivery only. Every other truck visit is a stop with a job type and nothing more.**

**Not `delivery_status`.** A completed swap does not re-deliver the order.

**Not the commission, the pillow charge, or the payment position.** ⚠ **`tg_pillow_charge_on_delivery` fires on delivery** — check it is scoped so a manual job cannot trigger it a second time.

### On the customer page

**A single list of every truck visit**, in date order: the delivery, then any manual jobs, each with its type, its note, its outcome and its signature.

⚠ **The original delivery must stay visually distinct.** It is the one that clears the order; the rest are visits.

---

## 2. What the driver sees

**On the run sheet, a manual job shows:**
- the customer's name and address, as now
- ⚠ **the job type as a clear label** — *PICKUP*, *SWAP* — so a driver glancing at the list cannot mistake it for a delivery
- **the office's note, in full, unabbreviated**

**Completing it is the same flow as a delivery: outcome, notes, signature.**

⚠ **`driver_complete_stop` already takes a signature.** Confirm it does not assume an order-delivery outcome — if it calls `mark_delivered` or similar, **that must not fire for a manual job.**

---

## 3. Build order

| | | |
|---|---|---|
| 1 | **The Cancel button** — smallest, and the capability already exists | half a day |
| 2 | **The schema** — four columns, all defaulted so nothing changes | an hour |
| 3 | **Booking a manual job** from the customer page | half a day |
| 4 | **The run sheet and driver app** showing job type and note | half a day |
| 5 | **The visit list** on the customer page | a couple of hours |

⚠ **Check before step 2:** what `tg_pillow_charge_on_delivery` and `driver_complete_stop` do on completion, and whether either would fire wrongly for a manual job. **That is the one place this can cause real damage** — a second pillow charge or a re-delivered order.

---

## 4. Before it ships

- Does Cancel say **where the customer went**, not just that it worked?
- Does Cancel **refuse politely** on a completed stop?
- Does `delivery_status` get **cleared** if booking set it?
- Can a manual job **ever touch `delivery_date`**? It must not.
- Can completing a manual job **fire the pillow charge, the commission, or mark the order delivered**? It must not.
- Does the driver see the **job type clearly enough** not to mistake a pickup for a delivery?
- Is the **signature captured on a collection** as well as a delivery?
- Does the customer page show **every visit**, with the original delivery distinct?
