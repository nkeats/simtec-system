-- ============================================================================
--  Simtec loyalty — MILESTONE LOOT (run once, after loyalty_engine.sql)
--  As a customer pays down their plan they unlock milestones:
--    25% paid       -> auto-award milestonePts25 (default 10,000 points)
--    50% paid       -> a free pillow   (recorded; office fulfils)
--    paid in full   -> Lifetime AAA + 10% off next order (recorded; office fulfils)
--  Idempotent + exception-safe; the 25% points award persists once.
-- ============================================================================

insert into public.loyalty_config(key,value) values ('milestonePts25',10000) on conflict (key) do nothing;

create table if not exists public.milestone_awards (
  customer_id    uuid not null references public.sim_customers(id) on delete cascade,
  milestone      text not null,                 -- pct25 | pct50 | paidfull
  points_awarded int  not null default 0,
  fulfilled      boolean not null default false, -- pillow / AAA+discount: office marks done
  created_at     timestamptz not null default now(),
  primary key (customer_id, milestone)
);
alter table public.milestone_awards enable row level security;
drop policy if exists ms_office on public.milestone_awards;
drop policy if exists ms_self   on public.milestone_awards;
create policy ms_office on public.milestone_awards for all    using (is_office()) with check (is_office());
create policy ms_self   on public.milestone_awards for select using (customer_id = current_customer_id());

create unique index if not exists points_ledger_milestone_ref on public.points_ledger(ref) where reason='milestone';

-- unlock milestones for a customer based on how much of their plan is paid --------
create or replace function public.sync_milestones(p_cust uuid) returns void
language plpgsql security definer set search_path=public as $$
declare v_contract numeric; v_paid numeric; v_pct numeric; v_25 int;
begin
  select coalesce(contract_value,0), coalesce(amount_paid_to_date,0)
    into v_contract, v_paid
    from sim_orders
    where customer_id=p_cust and paid_via_order_id is null
    order by created_at desc limit 1;
  if v_contract is null or v_contract <= 0 then return; end if;
  v_pct := v_paid / v_contract * 100;
  v_25  := coalesce((select value::int from loyalty_config where key='milestonePts25'),10000);

  if v_pct >= 25 and not exists (select 1 from milestone_awards where customer_id=p_cust and milestone='pct25') then
    insert into milestone_awards(customer_id,milestone,points_awarded) values (p_cust,'pct25',v_25) on conflict do nothing;
    insert into points_ledger(customer_id,delta,reason,ref) values (p_cust,v_25,'milestone','ms:pct25:'||p_cust::text) on conflict do nothing;
  end if;
  if v_pct >= 50 and not exists (select 1 from milestone_awards where customer_id=p_cust and milestone='pct50') then
    insert into milestone_awards(customer_id,milestone) values (p_cust,'pct50') on conflict do nothing;      -- free pillow
  end if;
  if v_pct >= 100 and not exists (select 1 from milestone_awards where customer_id=p_cust and milestone='paidfull') then
    insert into milestone_awards(customer_id,milestone) values (p_cust,'paidfull') on conflict do nothing;   -- Lifetime AAA + 10% off
  end if;
end $$;

create or replace function public.trg_sync_milestones() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_cust uuid;
begin
  select customer_id into v_cust from sim_orders where id = NEW.order_id;
  if v_cust is not null then perform sync_milestones(v_cust); end if;
  return NEW;
exception when others then return NEW;   -- never block a payment
end $$;
drop trigger if exists trg_milestones on public.sim_payments;
create trigger trg_milestones after insert on public.sim_payments
  for each row execute function public.trg_sync_milestones();

-- app: which milestones the signed-in customer has unlocked -------------------
create or replace function public.my_milestones() returns json
language sql security definer set search_path=public stable as $$
  select coalesce(json_agg(milestone), '[]'::json)
  from milestone_awards where customer_id = current_customer_id();
$$;
grant execute on function public.my_milestones() to authenticated, anon;

-- office fulfilment list: pillows + paid-off perks not yet actioned ------------
create or replace view public.v_milestone_fulfilment
  with (security_invoker = on) as
  select ma.customer_id, c.first_name, c.last_name, c.mobile, ma.milestone, ma.created_at
  from public.milestone_awards ma
  join public.sim_customers c on c.id = ma.customer_id
  where ma.milestone in ('pct50','paidfull') and ma.fulfilled = false
  order by ma.created_at;
