-- ============================================================================
--  Simtec loyalty engine — SPINE (run once in the Supabase SQL Editor)
--  Builds: office-tunable config, the points + spins ledgers, the automatic
--  "award on payment" hook, and a helper the app calls for a customer's totals.
--
--  SAFETY: the payment hook is exception-wrapped — if anything in the rewards
--  logic ever fails, it silently skips and the PAYMENT still records normally.
--  A rewards bug can never block or reverse a real payment.
--  Idempotent: each payment awards points/spins exactly once (keyed on its id).
-- ============================================================================

-- 1) Office-tunable config (point values, no code changes needed to tweak) ----
create table if not exists public.loyalty_config (
  key        text primary key,
  value      numeric not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.loyalty_config(key,value) values
  ('payPts',200),       -- points for a normal (direct-debit) payment
  ('extraPts',1000),    -- points for an extra/card payment (source='stripe')
  ('refPts',50000),     -- points for a referral that buys
  ('spinsPerPay',1),    -- free spins earned per payment
  ('cardEvery',50000),  -- points per $50 reward card
  ('cardValue',50),     -- $ value of a reward card
  ('drawPts',10000),    -- monthly review-draw prize
  ('surpriseOnTime',200),('surpriseExtra',500),('surpriseRefer',2000)
on conflict (key) do nothing;

-- 2) Points ledger — lifetime score = SUM(delta) --------------------------------
create table if not exists public.points_ledger (
  id          bigint generated always as identity primary key,
  customer_id uuid not null references public.sim_customers(id) on delete cascade,
  delta       int  not null,
  reason      text not null,   -- payment | extra | referral | milestone | spin | daily | draw | adjust
  ref         text,            -- source id (e.g. the payment id) for idempotency
  created_at  timestamptz not null default now()
);
create index if not exists points_ledger_cust_idx on public.points_ledger(customer_id);
create unique index if not exists points_ledger_payment_ref on public.points_ledger(ref) where reason='payment';

-- 3) Spins ledger — spins available = SUM(delta) --------------------------------
create table if not exists public.spins_ledger (
  id          bigint generated always as identity primary key,
  customer_id uuid not null references public.sim_customers(id) on delete cascade,
  delta       int  not null,
  reason      text not null,   -- payment | spend | adjust
  ref         text,
  created_at  timestamptz not null default now()
);
create index if not exists spins_ledger_cust_idx on public.spins_ledger(customer_id);
create unique index if not exists spins_ledger_payment_ref on public.spins_ledger(ref) where reason='payment';

-- 4) RLS: office full; customer reads only their own; config is world-readable --
alter table public.loyalty_config enable row level security;
alter table public.points_ledger  enable row level security;
alter table public.spins_ledger    enable row level security;

drop policy if exists loyaltycfg_office on public.loyalty_config;
drop policy if exists loyaltycfg_read   on public.loyalty_config;
drop policy if exists loyaltycfg_admin  on public.loyalty_config;
create policy loyaltycfg_read  on public.loyalty_config for select using (is_office());                              -- office can VIEW
create policy loyaltycfg_admin on public.loyalty_config for all    using (my_role()='admin') with check (my_role()='admin');  -- only ADMIN can change

drop policy if exists points_office on public.points_ledger;
drop policy if exists points_self   on public.points_ledger;
create policy points_office on public.points_ledger for all    using (is_office()) with check (is_office());
create policy points_self   on public.points_ledger for select using (customer_id = current_customer_id());

drop policy if exists spins_office on public.spins_ledger;
drop policy if exists spins_self   on public.spins_ledger;
create policy spins_office on public.spins_ledger for all    using (is_office()) with check (is_office());
create policy spins_self   on public.spins_ledger for select using (customer_id = current_customer_id());

-- 5) Award points + a spin whenever a payment clears (any source) --------------
create or replace function public.award_points_on_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_customer uuid; v_pts int; v_spins int;
begin
  if coalesce(NEW.result,'') <> 'paid' then return NEW; end if;
  if coalesce(NEW.source,'') = 'reward' then return NEW; end if;   -- reward-card credits don't earn points
  select customer_id into v_customer from sim_orders where id = NEW.order_id;
  if v_customer is null then return NEW; end if;

  v_pts   := (select value::int from loyalty_config where key = case when NEW.source='stripe' then 'extraPts' else 'payPts' end);
  v_spins := (select value::int from loyalty_config where key = 'spinsPerPay');

  insert into points_ledger(customer_id,delta,reason,ref)
    values (v_customer, coalesce(v_pts,500), 'payment', NEW.id::text)
    on conflict (ref) where reason='payment' do nothing;

  if coalesce(v_spins,1) > 0 then
    insert into spins_ledger(customer_id,delta,reason,ref)
      values (v_customer, coalesce(v_spins,1), 'payment', NEW.id::text)
      on conflict (ref) where reason='payment' do nothing;
  end if;

  return NEW;
exception when others then
  return NEW;   -- a rewards failure must NEVER affect the payment
end $$;

drop trigger if exists trg_award_points_on_payment on public.sim_payments;
create trigger trg_award_points_on_payment
  after insert on public.sim_payments
  for each row execute function public.award_points_on_payment();

-- 6) App helper: the signed-in customer's own totals (points, spins, level) -----
create or replace function public.my_rewards() returns json
language sql security definer set search_path = public stable as $$
  select json_build_object(
    'points', coalesce((select sum(delta) from points_ledger where customer_id = current_customer_id()),0),
    'spins',  coalesce((select sum(delta) from spins_ledger  where customer_id = current_customer_id()),0),
    'level',  floor(sqrt(greatest(coalesce((select sum(delta) from points_ledger where customer_id = current_customer_id()),0),0) / 650.0))
  );
$$;
grant execute on function public.my_rewards() to authenticated, anon;

-- ============================================================================
--  BACKFILL (do NOT run now — run at ROLLOUT to seed points from past payments):
--
--    insert into public.points_ledger(customer_id,delta,reason,ref)
--    select o.customer_id,
--           (select value::int from loyalty_config where key = case when p.source='stripe' then 'extraPts' else 'payPts' end),
--           'payment', p.id::text
--    from public.sim_payments p join public.sim_orders o on o.id = p.order_id
--    where p.result='paid' and o.customer_id is not null
--    on conflict (ref) where reason='payment' do nothing;
-- ============================================================================
