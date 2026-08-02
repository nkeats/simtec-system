-- ============================================================================
--  Simtec loyalty — SPIN + DAILY BONUS (run once, after loyalty_engine.sql)
--  * A SPIN spends one of the spins the payment hook awards, and pays out points.
--  * The DAILY BONUS is one free claim per NZ day.
--  Both are FREE to play (no staking of value → stays clear of the Gambling Act),
--  server-side and secure (the client can never award itself points), and the
--  odds are office-tunable. Prizes are POINTS ONLY, never cash.
-- ============================================================================

-- 1) prize table (office-tunable odds; shared by spin + daily) ----------------
create table if not exists public.spin_prizes (
  id     int generated always as identity primary key,
  label  text not null,
  points int  not null,
  weight int  not null default 1,      -- relative odds
  active boolean not null default true
);
insert into public.spin_prizes(label,points,weight)
select * from (values
  ('10 points',10,40),('25 points',25,25),('50 points',50,18),
  ('100 points',100,10),('250 points',250,5),('1,000 points!',1000,2)
) v(label,points,weight)
where not exists (select 1 from public.spin_prizes);

alter table public.spin_prizes enable row level security;
drop policy if exists spinprizes_office on public.spin_prizes;
drop policy if exists spinprizes_read   on public.spin_prizes;
create policy spinprizes_office on public.spin_prizes for all    using (is_office()) with check (is_office());
create policy spinprizes_read   on public.spin_prizes for select using (true);   -- app shows the wheel

-- 2) daily claims — one row per customer per NZ day ---------------------------
create table if not exists public.daily_claims (
  customer_id uuid not null references public.sim_customers(id) on delete cascade,
  claim_date  date not null,
  points      int  not null,
  created_at  timestamptz not null default now(),
  primary key (customer_id, claim_date)
);
alter table public.daily_claims enable row level security;
drop policy if exists daily_office on public.daily_claims;
drop policy if exists daily_self   on public.daily_claims;
create policy daily_office on public.daily_claims for all    using (is_office()) with check (is_office());
create policy daily_self   on public.daily_claims for select using (customer_id = current_customer_id());

-- 3) weighted prize picker (internal) ----------------------------------------
create or replace function public.pick_prize() returns table(label text, points int)
language plpgsql security definer set search_path=public as $$
#variable_conflict use_column
declare r numeric; t int;
begin
  select coalesce(sum(pz.weight),0) into t from spin_prizes pz where pz.active;
  if t <= 0 then return; end if;
  r := random() * t;                         -- ONE draw, then find which band it lands in
  return query
    select sp.label, sp.points
    from (select pz.label as label, pz.points as points, sum(pz.weight) over (order by pz.id) as cum
          from spin_prizes pz where pz.active) sp
    where sp.cum >= r
    order by sp.cum limit 1;
end $$;

-- 4) play a spin — spends one spin, pays out the prize ------------------------
create or replace function public.play_spin() returns json
language plpgsql security definer set search_path=public as $$
declare v_cust uuid; v_bal int; v_label text; v_points int;
begin
  v_cust := current_customer_id();
  if v_cust is null then return json_build_object('ok',false,'error','not signed in'); end if;
  perform pg_advisory_xact_lock(hashtext('spin:'||v_cust::text));   -- serialise this customer's spins (no overspend)
  select coalesce(sum(delta),0) into v_bal from spins_ledger where customer_id=v_cust;
  if v_bal <= 0 then return json_build_object('ok',false,'error','no spins left'); end if;
  insert into spins_ledger(customer_id,delta,reason) values(v_cust,-1,'spend');
  select label, points into v_label, v_points from pick_prize();
  insert into points_ledger(customer_id,delta,reason) values(v_cust, coalesce(v_points,0), 'spin');
  return json_build_object('ok',true,'label',v_label,'points',coalesce(v_points,0),'spins_left',v_bal-1);
exception when others then
  return json_build_object('ok',false,'error','spin failed');   -- rolls back the spend + award together
end $$;
grant execute on function public.play_spin() to authenticated, anon;

-- 5) claim the daily bonus — once per NZ day ---------------------------------
create or replace function public.claim_daily() returns json
language plpgsql security definer set search_path=public as $$
declare v_cust uuid; v_today date; v_label text; v_points int;
begin
  v_cust := current_customer_id();
  if v_cust is null then return json_build_object('ok',false,'error','not signed in'); end if;
  v_today := (now() at time zone 'Pacific/Auckland')::date;
  select label, points into v_label, v_points from pick_prize();
  insert into daily_claims(customer_id, claim_date, points)
    values(v_cust, v_today, coalesce(v_points,0))
    on conflict (customer_id, claim_date) do nothing;
  if not found then return json_build_object('ok',false,'already',true,'error','already claimed today'); end if;
  insert into points_ledger(customer_id,delta,reason) values(v_cust, coalesce(v_points,0), 'daily');
  return json_build_object('ok',true,'label',v_label,'points',coalesce(v_points,0));
exception when others then
  return json_build_object('ok',false,'error','claim failed');
end $$;
grant execute on function public.claim_daily() to authenticated, anon;

-- 6) refresh the app's totals helper to include spins + today's daily ---------
create or replace function public.my_rewards() returns json
language sql security definer set search_path=public stable as $$
  select json_build_object(
    'points', coalesce((select sum(delta) from points_ledger where customer_id=current_customer_id()),0),
    'spins',  coalesce((select sum(delta) from spins_ledger  where customer_id=current_customer_id()),0),
    'level',  floor(sqrt(greatest(coalesce((select sum(delta) from points_ledger where customer_id=current_customer_id()),0),0) / 650.0)),
    'daily_available', not exists (
      select 1 from daily_claims
      where customer_id=current_customer_id()
        and claim_date=(now() at time zone 'Pacific/Auckland')::date)
  );
$$;
grant execute on function public.my_rewards() to authenticated, anon;
