-- ============================================================================
--  Simtec loyalty — AAA RATING + STREAK/REFERRER BADGES (run once, after engine)
--  Computed live from payment history — no stored/synced state to drift.
--   * current_streak = consecutive cleared payments since the last dishonour
--   * max_streak     = the longest clean run ever (badges, once earned, stay)
--   * rating: AAA / AA / A from the CURRENT streak (forgiving — a clean run
--     climbs you back up, so it rewards getting back on track)
--   * streak badges at 10/25/50/100; referrer badges at 1/5/10/25 buyers
--  Dishonours link to a customer via the order's ezidebit_payer_ref; a referral
--  counts once its converted_order_id is set.
-- ============================================================================

-- rating thresholds (office-tunable)
insert into public.loyalty_config(key,value) values ('ratingAAAStreak',12),('ratingAAStreak',4),('refMinPayments',2)
on conflict (key) do nothing;

-- customer_rating(id): the customer themselves, or office, may read it ----------
create or replace function public.customer_rating(p_cust uuid) returns json
language plpgsql security definer set search_path=public stable as $$
declare
  rec record; cur int:=0; mx int:=0; paidn int:=0; disn int:=0; refs int;
  aaa int; aa int; refmin int; rating text; tier text;
begin
  if p_cust is null or not (p_cust = current_customer_id() or is_office()) then
    return json_build_object('error','not allowed');
  end if;

  aaa := coalesce((select value::int from loyalty_config where key='ratingAAAStreak'),12);
  aa  := coalesce((select value::int from loyalty_config where key='ratingAAStreak'),4);
  refmin := coalesce((select value::int from loyalty_config where key='refMinPayments'),2);

  for rec in
    select d, ispaid from (
      select p.payment_date::date as d, 1 as ispaid
        from sim_payments p join sim_orders o on o.id = p.order_id
        where o.customer_id = p_cust and p.result = 'paid'
      union all
      select dh.dishonour_date as d, 0 as ispaid
        from sim_dishonours dh
        where dh.payer_ref in (select ezidebit_payer_ref from sim_orders
                               where customer_id = p_cust and ezidebit_payer_ref is not null)
    ) e
    order by d nulls last, ispaid desc      -- chronological; same day, count the payment then the dishonour
  loop
    if rec.ispaid = 1 then
      cur := cur + 1; paidn := paidn + 1; if cur > mx then mx := cur; end if;
    else
      cur := 0; disn := disn + 1;
    end if;
  end loop;

  -- LIFETIME AAA: paid-in-full customers hold AAA permanently (Nigel 2 Aug)
  if exists(select 1 from milestone_awards where customer_id=p_cust and milestone='paidfull') then
    rating := 'AAA';
  else
    rating := case when cur >= aaa then 'AAA' when cur >= aa then 'AA' else 'A' end;
  end if;

  -- ANTI-GAMING: a referral only counts once the referred BUYER has made >= refMinPayments
  -- cleared payments — proves the sale is real and sticky before the referrer is rewarded.
  refs := coalesce((select count(*) from referrals r
                    where r.referrer_customer_id = p_cust
                      and r.converted_order_id is not null
                      and (select count(*) from sim_payments p2
                           where p2.order_id = r.converted_order_id and p2.result = 'paid') >= refmin),0);
  tier := case when refs >= 25 then 'Super Referrer'
               when refs >= 10 then '10+ buyers'
               when refs >= 5  then '5+ buyers'
               when refs >= 1  then 'Referrer' else null end;

  return json_build_object(
    'rating', rating,
    'current_streak', cur,
    'max_streak', mx,
    'paid', paidn,
    'dishonours', disn,
    'referrals_converted', refs,
    'referrer_tier', tier,
    'streak_badges',   array(select x from unnest(array[10,25,50,100]) x where mx  >= x),
    'referrer_badges', array(select x from unnest(array[1,5,10,25])    x where refs >= x)
  );
end $$;
grant execute on function public.customer_rating(uuid) to authenticated, anon;

-- my_status(): the signed-in customer's own rating + badges (for the app) -------
create or replace function public.my_status() returns json
language sql security definer set search_path=public stable as $$
  select customer_rating(current_customer_id());
$$;
grant execute on function public.my_status() to authenticated, anon;
