-- ============================================================================
--  Simtec loyalty — GO-LIVE BACKFILL (run ONCE, at rollout)
--
--  ORDER MATTERS — the full go-live sequence is:
--    1. Run the numbered SQL files 01–09 first (engine + cards + spins + rating
--       + my_plan + milestones + draw + notifications + leaderboard).
--    2. Run THIS file (seeds points, cards, milestones from payment history).
--    3. Run notification_events.sql LAST — installing it before this backfill
--       would fire a "Payment cleared" notification for every historic payment.
--
--  Safe to re-run: every step is idempotent (no double points, no double cards).
-- ============================================================================

-- 1) Points from historical cleared payments --------------------------------
insert into public.points_ledger(customer_id,delta,reason,ref)
select o.customer_id,
       (select value::int from loyalty_config where key = case when p.source='stripe' then 'extraPts' else 'payPts' end),
       'payment', p.id::text
from public.sim_payments p join public.sim_orders o on o.id = p.order_id
where p.result='paid' and o.customer_id is not null
on conflict (ref) where reason='payment' do nothing;

-- 2) Milestones (25% -> 10k pts, 50% pillow, paid-in-full) where already earned
do $$
declare c record;
begin
  for c in select distinct customer_id from public.sim_orders where customer_id is not null loop
    begin
      perform public.sync_milestones(c.customer_id);
    exception when others then null;  -- never let one customer block the rest
    end;
  end loop;
end $$;

-- 3) $50 reward cards for anyone already over a 50k-point milestone ----------
do $$
declare c record;
begin
  for c in select distinct customer_id from public.points_ledger loop
    begin
      perform public.sync_reward_cards(c.customer_id);
    exception when others then null;
    end;
  end loop;
end $$;

-- 4) Quick sanity readout ----------------------------------------------------
select
  (select count(*) from points_ledger where reason='payment')   as payment_point_rows,
  (select coalesce(sum(delta),0) from points_ledger)            as total_points_in_ledger,
  (select count(distinct customer_id) from points_ledger)       as customers_with_points,
  (select count(*) from milestone_awards)                       as milestone_awards,
  (select count(*) from reward_cards)                           as reward_cards;
