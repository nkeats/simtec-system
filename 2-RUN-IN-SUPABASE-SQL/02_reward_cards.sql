-- ============================================================================
--  Simtec loyalty — REWARD CARDS + REDEMPTION (run once, AFTER loyalty_engine.sql)
--  * A $50 card is earned each time lifetime points cross a 50,000 milestone
--    (cardEvery / cardValue in loyalty_config). Points are NOT spent — the
--    leaderboard score stays; the card is the reward.
--  * A customer redeems an available card three ways:
--      giftcard    -> office fulfils a $50 gift card (shows in a pending list)
--      plan_credit -> $50 comes off their plan (a 'reward' credit on their order)
--      donation    -> $50 to their active affiliated group
--  SAFETY: issuance + redemption are idempotent and exception-wrapped; the
--  plan-credit uses source='reward' and the payment hook is updated to IGNORE
--  that source, so a credit can never award more points.
-- ============================================================================

-- 0) update the payment hook to skip reward credits (safe to re-run) -----------
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
exception when others then return NEW;
end $$;

-- 1) reward_cards table --------------------------------------------------------
create table if not exists public.reward_cards (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.sim_customers(id) on delete cascade,
  seq          int  not null,                      -- Nth card earned (at seq * cardEvery points)
  value        numeric not null,
  status       text not null default 'available',  -- available | redeemed
  redeemed_as  text,                               -- giftcard | plan_credit | donation
  redeemed_at  timestamptz,
  fulfilled_at timestamptz,                         -- office marks a gift card sent
  created_at   timestamptz not null default now(),
  unique (customer_id, seq)                         -- idempotent issuance
);
create index if not exists reward_cards_cust_idx on public.reward_cards(customer_id, status);

alter table public.reward_cards enable row level security;
drop policy if exists rewardcards_office on public.reward_cards;
drop policy if exists rewardcards_self   on public.reward_cards;
create policy rewardcards_office on public.reward_cards for all    using (is_office()) with check (is_office());
create policy rewardcards_self   on public.reward_cards for select using (customer_id = current_customer_id());

-- 2) issue cards up to floor(lifetime points / cardEvery) ----------------------
create or replace function public.sync_reward_cards(p_cust uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_every int; v_val numeric; v_earned int; v_have int; i int;
begin
  v_every := coalesce((select value::int from loyalty_config where key='cardEvery'),50000);
  v_val   := coalesce((select value    from loyalty_config where key='cardValue'),50);
  if v_every <= 0 then return; end if;
  v_earned := floor( greatest(coalesce((select sum(delta) from points_ledger where customer_id=p_cust),0),0) / v_every );
  select coalesce(max(seq),0) into v_have from reward_cards where customer_id=p_cust;
  while v_have < v_earned loop
    v_have := v_have + 1;
    insert into reward_cards(customer_id,seq,value) values (p_cust, v_have, v_val)
      on conflict (customer_id,seq) do nothing;
  end loop;
end $$;

create or replace function public.trg_sync_cards() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform sync_reward_cards(NEW.customer_id);
  return NEW;
exception when others then return NEW;   -- never block a points award
end $$;
drop trigger if exists trg_reward_cards on public.points_ledger;
create trigger trg_reward_cards after insert on public.points_ledger
  for each row execute function public.trg_sync_cards();

-- 3) redeem a card (customer's own, available only) ----------------------------
create or replace function public.redeem_reward_card(p_card uuid, p_how text) returns json
language plpgsql security definer set search_path = public as $$
declare v_cust uuid; v_val numeric; v_order uuid; v_affil uuid; v_astatus text;
begin
  if p_how not in ('giftcard','plan_credit','donation') then
    return json_build_object('ok',false,'error','bad option');
  end if;
  select customer_id, value into v_cust, v_val from reward_cards
    where id=p_card and status='available' and customer_id = current_customer_id();
  if v_cust is null then return json_build_object('ok',false,'error','card not found or already used'); end if;

  if p_how='donation' then
    select affiliation_id into v_affil from sim_customers where id=v_cust;
    if v_affil is null then return json_build_object('ok',false,'error','no group to donate to'); end if;
    select status into v_astatus from affiliations where id=v_affil;
    if coalesce(v_astatus,'') <> 'active' then return json_build_object('ok',false,'error','group not active'); end if;
  end if;

  -- claim the card atomically (guards double-redeem)
  update reward_cards set status='redeemed', redeemed_as=p_how, redeemed_at=now()
    where id=p_card and status='available';
  if not found then return json_build_object('ok',false,'error','already used'); end if;

  if p_how='plan_credit' then
    select id into v_order from sim_orders where customer_id=v_cust and order_status='active' order by created_at desc limit 1;
    if v_order is not null then
      insert into sim_payments(order_id,amount,cleared,method,source,result,payment_date,dedup_key,recorded_by,notes)
        values (v_order, v_val, v_val, 'credit','reward','paid',current_date,'rewardcard:'||p_card::text,'rewards','Reward card credit ($'||v_val||' off plan)')
        on conflict do nothing;
      update sim_orders set amount_paid_to_date = coalesce(amount_paid_to_date,0)+v_val where id=v_order;
    end if;
  elsif p_how='donation' then
    insert into affiliation_donations(id,affiliation_id,customer_id,amount,source,status,reward_card_id,notes)
      values (gen_random_uuid(), v_affil, v_cust, v_val, 'reward_card', 'pending', p_card, 'Reward card donation');
  end if;
  -- giftcard: nothing further; office fulfils from the pending list below.

  return json_build_object('ok',true,'how',p_how,'value',v_val);
exception when others then
  return json_build_object('ok',false,'error','redeem failed');
end $$;
grant execute on function public.redeem_reward_card(uuid,text) to authenticated, anon;

-- 4) app helper: the signed-in customer's cards --------------------------------
create or replace function public.my_cards() returns json
language sql security definer set search_path = public stable as $$
  select coalesce(json_agg(json_build_object(
           'id',id,'value',value,'status',status,'redeemed_as',redeemed_as,'seq',seq
         ) order by seq), '[]'::json)
  from reward_cards where customer_id = current_customer_id();
$$;
grant execute on function public.my_cards() to authenticated, anon;

-- 5) office fulfilment list: gift cards redeemed but not yet sent ---------------
create or replace view public.v_reward_giftcards_pending
  with (security_invoker = on) as
  select rc.id, rc.customer_id, c.first_name, c.last_name, c.email, c.mobile,
         rc.value, rc.redeemed_at
  from public.reward_cards rc
  join public.sim_customers c on c.id = rc.customer_id
  where rc.status='redeemed' and rc.redeemed_as='giftcard' and rc.fulfilled_at is null
  order by rc.redeemed_at;
