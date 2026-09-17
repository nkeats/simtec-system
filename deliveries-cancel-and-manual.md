# Deliveries — cancelling, and manual jobs

Two changes to the delivery module. **Nothing built yet.**

16 September 2026

---

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
