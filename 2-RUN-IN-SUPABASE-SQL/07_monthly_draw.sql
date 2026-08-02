-- ============================================================================
--  Simtec loyalty — MONTHLY REVIEW DRAW (run once, after loyalty_engine.sql)
--  Tapping "Review" enters this month's free draw (one entry per customer per
--  month). On the 1st a scheduled job picks ONE random winner from the month
--  that just ended, credits the prize (drawPts, default 10,000), and records it
--  so every phone can light up the winner (first name + suburb).
--  FREE entry, NEVER conditioned on a positive/public review (compliance).
-- ============================================================================

-- 1) entries — one per customer per NZ month --------------------------------
create table if not exists public.draw_entries (
  customer_id uuid not null references public.sim_customers(id) on delete cascade,
  draw_month  date not null,                 -- first of the month
  source      text not null default 'review',
  created_at  timestamptz not null default now(),
  primary key (customer_id, draw_month)
);
alter table public.draw_entries enable row level security;
drop policy if exists drawent_office on public.draw_entries;
drop policy if exists drawent_self   on public.draw_entries;
create policy drawent_office on public.draw_entries for all    using (is_office()) with check (is_office());
create policy drawent_self   on public.draw_entries for select using (customer_id = current_customer_id());

-- 2) results — one per month -------------------------------------------------
create table if not exists public.draw_results (
  draw_month         date primary key,
  winner_customer_id uuid references public.sim_customers(id) on delete set null,
  prize_points       int  not null default 0,
  entries_count      int  not null default 0,
  drawn_at           timestamptz not null default now(),
  winner_seen        boolean not null default false   -- winner has seen the congrats starburst
);
alter table public.draw_results enable row level security;
drop policy if exists drawres_office on public.draw_results;
drop policy if exists drawres_winner on public.draw_results;
create policy drawres_office on public.draw_results for all    using (is_office()) with check (is_office());
create policy drawres_winner on public.draw_results for select using (winner_customer_id = current_customer_id());

-- one points credit per draw (idempotent)
create unique index if not exists points_ledger_draw_ref on public.points_ledger(ref) where reason='draw';

-- 3) enter the draw (customer taps Review) -----------------------------------
create or replace function public.enter_draw() returns json
language plpgsql security definer set search_path=public as $$
declare v_cust uuid; v_month date;
begin
  v_cust := current_customer_id();
  if v_cust is null then return json_build_object('ok',false,'error','not signed in'); end if;
  v_month := date_trunc('month', (now() at time zone 'Pacific/Auckland'))::date;
  insert into draw_entries(customer_id, draw_month, source)
    values (v_cust, v_month, 'review') on conflict do nothing;
  return json_build_object('ok',true,'entered',true,'month',v_month);
end $$;
grant execute on function public.enter_draw() to authenticated, anon;

-- 4) run the draw for the month that just ended (scheduled on the 1st) --------
create or replace function public.run_monthly_draw() returns json
language plpgsql security definer set search_path=public as $$
declare v_month date; v_count int; v_winner uuid; v_prize int;
begin
  -- previous calendar month (robust to whether it runs on the 1st or 2nd)
  v_month := (date_trunc('month', (now() at time zone 'Pacific/Auckland')) - interval '1 month')::date;
  if exists (select 1 from draw_results where draw_month = v_month) then
    return json_build_object('ok',false,'already',true,'month',v_month);
  end if;
  select count(*) into v_count from draw_entries where draw_month = v_month;
  if v_count = 0 then
    insert into draw_results(draw_month, winner_customer_id, prize_points, entries_count)
      values (v_month, null, 0, 0);
    return json_build_object('ok',true,'no_entries',true,'month',v_month);
  end if;
  select customer_id into v_winner from draw_entries where draw_month = v_month order by random() limit 1;
  v_prize := coalesce((select value::int from loyalty_config where key='drawPts'),10000);
  insert into draw_results(draw_month, winner_customer_id, prize_points, entries_count)
    values (v_month, v_winner, v_prize, v_count);
  insert into points_ledger(customer_id, delta, reason, ref)
    values (v_winner, v_prize, 'draw', 'draw:'||v_month::text) on conflict do nothing;
  return json_build_object('ok',true,'winner',v_winner,'prize',v_prize,'entries',v_count,'month',v_month);
exception when others then
  return json_build_object('ok',false,'error','draw failed');
end $$;

-- 5) app status — did I enter this month, and who's the latest winner ---------
-- NOTE: winner shown by FIRST NAME only (sim_customers has no suburb field — just a
-- free-text address, too much to show publicly). To show "first name + suburb" (as
-- the leaderboard also wants), add a suburb column + populate it at order time.
create or replace function public.draw_status() returns json
language plpgsql security definer set search_path=public stable as $$
declare v_cust uuid; v_month date;
begin
  v_cust := current_customer_id();
  v_month := date_trunc('month', (now() at time zone 'Pacific/Auckland'))::date;
  return json_build_object(
    'entered_this_month', exists (select 1 from draw_entries where customer_id=v_cust and draw_month=v_month),
    'latest', (
      select json_build_object(
        'month', dr.draw_month, 'prize', dr.prize_points,
        'winner_first', c.first_name,
        'i_won', (dr.winner_customer_id = v_cust),
        'congrats_pending', (dr.winner_customer_id = v_cust and not dr.winner_seen)
      )
      from draw_results dr join sim_customers c on c.id = dr.winner_customer_id
      where dr.winner_customer_id is not null
      order by dr.draw_month desc limit 1
    )
  );
end $$;
grant execute on function public.draw_status() to authenticated, anon;

-- 6) winner dismisses the one-time congrats starburst ------------------------
create or replace function public.mark_draw_seen(p_month date) returns json
language plpgsql security definer set search_path=public as $$
begin
  update draw_results set winner_seen = true
    where draw_month = p_month and winner_customer_id = current_customer_id();
  return json_build_object('ok',true);
end $$;
grant execute on function public.mark_draw_seen(date) to authenticated, anon;

-- 7) schedule it on the 1st (draws the month that just ended) -----------------
--    Requires pg_cron (already used for the Ezidebit reconcile). Safe to re-run.
select cron.unschedule('monthly-review-draw') where exists (select 1 from cron.job where jobname='monthly-review-draw');
select cron.schedule('monthly-review-draw', '0 12 1 * *', 'select public.run_monthly_draw();');
