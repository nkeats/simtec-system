-- ============================================================================
--  Simtec — Order-app enhancements
--  Adds: (1) consultant notes captured at order time (delivery / account set-up)
--        (2) the office confirmation-call checklist + management review queue
--
--  Run this in the Supabase SQL editor. It is idempotent — safe to run again.
--
--  ⚠ ASSUMES sim_orders.id is of type UUID (the Supabase default). If your
--    sim_orders.id is BIGINT instead, change `order_id uuid` to `order_id bigint`
--    in the table below before running. (Check: Table editor → sim_orders → id.)
-- ============================================================================

-- 1) Consultant notes + confirmation flag on the order ------------------------
alter table public.sim_orders add column if not exists consultant_account_note  text;
alter table public.sim_orders add column if not exists consultant_delivery_note text;
-- confirmation_status: null = not part of the confirmation flow (legacy / other entry paths)
--                      'pending'  = waiting for the office confirmation call
--                      'review'   = call done, not accepted → management review
--                      'accepted' = confirmed and accepted
--                      'cancelled'= management cancelled after review
alter table public.sim_orders add column if not exists confirmation_status text;

create index if not exists idx_sim_orders_confirmation_status
  on public.sim_orders (confirmation_status);

comment on column public.sim_orders.consultant_account_note  is 'Consultant note flagged to the office immediately (e.g. Ezidebit / account set-up).';
comment on column public.sim_orders.consultant_delivery_note is 'Consultant note surfaced to delivery once the order is ready for delivery.';
comment on column public.sim_orders.confirmation_status      is 'pending | review | accepted | cancelled (null = not in the confirmation flow).';

-- 2) Confirmation-call checklist (one row per order) --------------------------
create table if not exists public.sim_order_confirmations (
  order_id                   uuid primary key
                              references public.sim_orders(id) on delete cascade,
  confirmed_address          boolean not null default false,
  confirmed_income           boolean not null default false,
  confirmed_affordability    boolean not null default false,
  confirmed_understanding    boolean not null default false,
  confirmed_happy_consultant boolean not null default false,
  accepted                   boolean not null default false,
  status                     text    not null default 'pending',  -- pending|accepted|review|cancelled
  called_by                  text,
  called_at                  timestamptz,
  -- management review of a not-accepted order
  review_decision            text,          -- accepted | cancelled
  review_note                text,
  reviewed_by                text,
  reviewed_at                timestamptz,
  updated_at                 timestamptz not null default now()
);

comment on table public.sim_order_confirmations is
  'Office confirmation-call checklist + management accept/cancel decision. One row per sim_order.';

-- 3) RLS ----------------------------------------------------------------------
-- Matches the current system posture (authenticated users have access; the
-- page itself is gated to admin/manager/office via auth.js). Tighten in the
-- pending RLS Phase 2 if you want to scope writes to office roles only.
alter table public.sim_order_confirmations enable row level security;

drop policy if exists sim_order_confirmations_rw on public.sim_order_confirmations;
create policy sim_order_confirmations_rw
  on public.sim_order_confirmations
  for all
  to authenticated
  using (true)
  with check (true);

-- ============================================================================
--  Done. The order app writes consultant_account_note / consultant_delivery_note
--  and sets confirmation_status='pending' on save; confirmation.html reads them.
-- ============================================================================
