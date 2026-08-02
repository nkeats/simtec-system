-- ============================================================================
--  Simtec loyalty — MY_PLAN (run once, after loyalty_engine.sql)
--  Feeds the Home "race": the customer's own plan progress, delivery state, and
--  the shortfall to reach the deposit % (the Fast Track / early-delivery amount).
-- ============================================================================

insert into public.loyalty_config(key,value) values ('depositPct',10) on conflict (key) do nothing;

create or replace function public.my_plan() returns json
language plpgsql security definer set search_path=public stable as $$
declare v_cust uuid; o record; v_dep numeric; v_pct numeric; v_missed boolean;
begin
  v_cust := current_customer_id();
  if v_cust is null then return json_build_object('ok',false); end if;

  select id, coalesce(contract_value,0) as contract, coalesce(amount_paid_to_date,0) as paid, delivery_status, coalesce(delivery_authorised,false) as authorised
    into o
    from sim_orders
    where customer_id = v_cust and order_status='active'
      and coalesce(paid_in_full,false)=false and paid_via_order_id is null
    order by created_at desc limit 1;

  if o.id is null then return json_build_object('ok',true,'has_order',false); end if;

  v_pct := coalesce((select value from loyalty_config where key='depositPct'),10);
  v_dep := o.contract * v_pct/100.0;

  -- missed payment = a dishonour in the last 21 days not yet resolved by a later cleared payment
  select exists(
    select 1 from sim_dishonours dh
    where dh.payer_ref in (select ezidebit_payer_ref from sim_orders where customer_id=v_cust and ezidebit_payer_ref is not null)
      and dh.dishonour_date >= current_date - 21
      and dh.dishonour_date >= coalesce((select max(p.payment_date::date) from sim_payments p
                                          join sim_orders o2 on o2.id=p.order_id
                                          where o2.customer_id=v_cust and p.result='paid'),'1900-01-01'::date)
  ) into v_missed;

  return json_build_object(
    'ok', true, 'has_order', true,
    'contract', round(o.contract),
    'paid', round(o.paid),
    'owing', round(greatest(o.contract - o.paid,0)),
    'pct_paid', least(100, round(case when o.contract>0 then o.paid/o.contract*100 else 0 end)),
    'delivered', (o.delivery_status = 'delivered'),
    'authorised', o.authorised,
    'missed', coalesce(v_missed,false),
    'delivery_status', o.delivery_status,
    'deposit_amount', round(v_dep),
    'deposit_shortfall', round(greatest(v_dep - o.paid,0)),
    'pct_to_delivery', least(100, round(case when v_dep>0 then o.paid/v_dep*100 else 100 end))
  );
end $$;
grant execute on function public.my_plan() to authenticated, anon;
