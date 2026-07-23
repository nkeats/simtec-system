-- ============================================================================
-- Ezidebit daily-import — duplicate diagnostics & cleanup
-- Run these one block at a time in the Supabase SQL editor (role: postgres).
-- READ-ONLY except the clearly-marked CLEANUP block at the very bottom.
-- ============================================================================

-- 1) Is there a UNIQUE index on sim_payments.dedup_key?  (tells us whether a
--    duplicate key hard-fails the whole insert, which is the "duplicate value"
--    the admin is seeing.)
select indexname, indexdef
from pg_indexes
where schemaname='public' and tablename in ('sim_payments','sim_dishonours')
order by tablename, indexname;

-- 2) Any duplicate dedup_keys ALREADY stored?  (>0 means double-counted rows got
--    in at some point — balances for those payers may be overstated.)
select dedup_key, count(*) n
from public.sim_payments
where dedup_key is not null
group by dedup_key having count(*)>1
order by n desc
limit 50;

-- 3) Did yesterday's import give the SAME Ezidebit payer ref to more than one
--    order?  Shared payer refs are the classic cause of same-day/same-amount
--    collisions in a settlement report.
select ezidebit_payer_ref, count(*) n, array_agg(id) order_ids
from public.sim_orders
where ezidebit_payer_ref is not null and ezidebit_payer_ref <> ''
group by ezidebit_payer_ref having count(*)>1
order by n desc
limit 50;

-- 4) What has been imported recently, by settlement date and source?
select settlement_date, source, count(*) rows, sum(amount) total_amount
from public.sim_payments
group by settlement_date, source
order by settlement_date desc nulls last
limit 30;

-- 5) Payments whose payer ref matches NO order (these update nobody's balance).
select p.payer_ref, count(*) n, sum(p.amount) total
from public.sim_payments p
left join public.sim_orders o on o.ezidebit_payer_ref = p.payer_ref
where o.id is null
group by p.payer_ref
order by n desc
limit 50;

-- ============================================================================
-- CLEANUP (only if block 2 shows real duplicate rows you want to remove).
-- Keeps the earliest row of each dedup_key, deletes the rest, then the import
-- page will rebuild amount_paid_to_date correctly on the next upload.
-- REVIEW the SELECT first; run the DELETE only when you're happy.
-- ----------------------------------------------------------------------------
-- with ranked as (
--   select ctid, dedup_key,
--          row_number() over (partition by dedup_key order by ctid) rn
--   from public.sim_payments
--   where dedup_key is not null
-- )
-- -- preview what would be removed:
-- select * from public.sim_payments where ctid in (select ctid from ranked where rn>1);
-- -- when happy, delete:
-- -- delete from public.sim_payments where ctid in (select ctid from ranked where rn>1);
