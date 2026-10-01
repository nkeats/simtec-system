# Sales App telemetry — design only (1 Oct 2026)

**Nothing here exists.** It touches staff data, so this is the design for a
decision, not a build.

## The gap it closes

`sim_client_errors` records a thrown exception, in a code path that already has a
reporter, when the iPad can reach the server. On 30 Sep it held **8 Sales App
entries**: one failed email-code send, and **seven from one stuck sale in seventy
seconds**. Consultants complained all day. Three orders were saved that day — two
of them on build `2026-09-16-01`, a fortnight old, on the day `2026-09-30-01`
shipped.

Everything that is not a thrown exception is invisible today: an iPad on an old
build, a sale started and never saved, a page iOS discarded mid-sale, a session that
simply stopped. Those are exactly what a consultant experiences as "the app is
playing up".

## The smallest honest thing: one row per app open

`sim_app_sessions` — one row each time the Sales App page loads.

| Field | Why |
|---|---|
| `id` | minted on the iPad at load; the key every later update uses |
| `user_id`, `consultant` | **taken from the sign-in on the server**, never from the iPad |
| `build` | `SIMTEC_BUILD` — which version actually ran |
| `device` | user agent, truncated; plus `standalone` (Home Screen vs Safari) and screen size |
| `opened_at`, `last_seen_at` | `last_seen_at` moves on each step change and every 5 minutes while visible |
| `furthest_step` | 0–9: how far a sale got |
| `sale` | `none` / `started` / `saved` / `parked` / `finished` |
| `order_id` | once one exists — links to the order, the queue and `sim_client_errors` |
| `queued_at_open` | how many sales were waiting on the iPad when it opened |
| `reloads` | page loads in this session that were reloads, or a return from Ezidebit |
| `offline_flips` | how often `navigator.onLine` changed — wording-only today, but a signal |
| `errors` | count of `report_client_error` calls this session (detail stays in that table) |
| `ended` | how it ended (below) |

**How it ended** is the field that matters most, and the hardest to get honestly.
iOS does not reliably deliver "goodbye" events. So:

- `done` / `new_order` / `signed_out` — recorded by the app when they happen.
- `hidden` — the last thing seen was the app going to the background (`pagehide`
  / `visibilitychange`, sent with `fetch(…, {keepalive:true})`; best-effort).
- `vanished` — **inferred at the next open**: the iPad remembers its previous
  session id, and if that session never recorded an ending, the next launch marks
  it `vanished` with the step it was on. A `vanished` mid-sale is a killed or
  discarded app. This is the signal nothing collects today.

## What it deliberately does NOT record

- **Nothing about the customer.** No name, phone, email, address, products, prices,
  photographs or signatures. Only the order id, which the office can already see.
- **No field values, keystrokes, taps, screen recordings or timings of individual
  actions.** Step changes only.
- **No location** — not the iPad's, not inferred from the network.
- **No IP address** in the table (Supabase's own logs already hold it; this does not
  copy it).
- Not a productivity measure. It must not be used to judge how long a consultant
  spends with a customer — that is a decision for you to make explicitly, and this
  design does not make it.

## Where it lives and who sees it

- Table `sim_app_sessions`, NZ project only. **Row security on at creation**, grants
  revoked from `anon` and `authenticated`, read policy for `is_office()` only.
- Written only through two `SECURITY DEFINER` functions — `app_session_open(...)` and
  `app_session_update(...)` — which take the consultant from the sign-in and accept
  only the fields above, clamped in length. `VOLATILE`, so the page can write.
- Kept **90 days**, then deleted by a scheduled job (the same pattern as
  `audit_history`).
- A consultant does not see other consultants' sessions. Whether they may see their
  own is your call.
- **Consultants should be told it exists** before it switches on (Privacy Act 2020,
  IPP 3: what is collected, why, and who sees it). One paragraph in the training notes.

## Cost

About one insert per open and a handful of small updates — for nine consultants, a
few hundred rows a day. Each write is fire-and-forget, the same rule as
`report_client_error`: reporting must never cause a fault, and a failed write
changes nothing on the iPad.

## What it would have shown on 30 September — and what it would not

**Would have shown**, by the morning, without anyone ringing:
- which iPads were open and on **which build** — two of the three saves that day came
  from a fortnight-old build; telemetry would have shown how many iPads were still on
  it, and whether `update.js` was failing to move them;
- every sale that **started and never saved** — today those leave no trace at all;
- every session that **vanished mid-sale**, and on which step — a discarded or killed
  app, the thing the queue now protects against, made countable;
- the stuck sale as one session with `queued_at_open > 0` and repeated errors,
  instead of seven separate error rows.

**Would not have shown:** what the complaints were *about* when nothing failed in the
app — slowness, a confusing screen, the Ezidebit form itself. Telemetry counts what
happened; it does not hear what people said. I was not told the content of the
30 Sep complaints, so I cannot claim this would have explained them — only that it
would have shown whether the app recorded anything at the same moments.

## Decisions for you

1. Build it, as designed or narrowed?
2. May consultants see their own sessions?
3. Retention — 90 days?
4. Who tells the consultants, and when?
