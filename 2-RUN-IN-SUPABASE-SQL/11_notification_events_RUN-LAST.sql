-- ============================================================================
--  Simtec loyalty — EVENT -> NOTIFICATION WIRING (run once, after notifications.sql)
--  Add-on triggers that fire the right notification off the points ledger,
--  reward cards, milestones, and dishonours — WITHOUT touching the existing
--  engine functions. Every trigger is exception-safe (never blocks the event).
--  Routing follows the strategy: routine = in-app; high-value = SMS.
-- ============================================================================

-- points ledger: a cleared payment, or a draw win --------------------------
create or replace function public.trg_notify_points() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if NEW.reason = 'payment' then
    perform queue_notification(NEW.customer_id, 'points', 'Payment cleared 💪',
      '+'||NEW.delta||' points and a free spin are yours.', null, 'notif:pay:'||NEW.id);
  elsif NEW.reason = 'draw' then
    perform queue_notification(NEW.customer_id, 'draw', '🎉 You won the monthly draw!',
      NEW.delta||' points are on your account — open the app to celebrate!', 'sms', 'notif:draw:'||NEW.id);
  end if;
  return NEW;
exception when others then return NEW;
end $$;
drop trigger if exists trg_notify_points on public.points_ledger;
create trigger trg_notify_points after insert on public.points_ledger
  for each row execute function public.trg_notify_points();

-- milestones: 25% / 50% / paid in full -------------------------------------
create or replace function public.trg_notify_milestone() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_t text; v_b text;
begin
  if    NEW.milestone='pct25'    then v_t:='🎯 25% paid off!';   v_b:='You''ve earned 10,000 bonus points. Keep going!';
  elsif NEW.milestone='pct50'    then v_t:='🎉 Halfway there!';  v_b:='You''ve reached 50% — a free pillow is yours. We''ll be in touch.';
  elsif NEW.milestone='paidfull' then v_t:='🏆 Paid in full!';   v_b:='Lifetime Triple-A status and 10% off your next order. Congratulations!';
  else return NEW; end if;
  perform queue_notification(NEW.customer_id, 'milestone', v_t, v_b, null, 'notif:ms:'||NEW.customer_id||':'||NEW.milestone);
  return NEW;
exception when others then return NEW;
end $$;
drop trigger if exists trg_notify_milestone on public.milestone_awards;
create trigger trg_notify_milestone after insert on public.milestone_awards
  for each row execute function public.trg_notify_milestone();

-- a $50 reward card earned --------------------------------------------------
create or replace function public.trg_notify_card() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  perform queue_notification(NEW.customer_id, 'reward', '🎁 You''ve earned a $'||NEW.value||' reward card!',
    'Open the app to use it — a gift card, money off your plan, or a donation to your group.', null, 'notif:card:'||NEW.id);
  return NEW;
exception when others then return NEW;
end $$;
drop trigger if exists trg_notify_card on public.reward_cards;
create trigger trg_notify_card after insert on public.reward_cards
  for each row execute function public.trg_notify_card();

-- missed payment (dishonour) -> a warm SMS (high-value/time-sensitive) -------
create or replace function public.trg_notify_dishonour() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_cust uuid; v_name text;
begin
  select o.customer_id into v_cust from sim_orders o
    where o.ezidebit_payer_ref = NEW.payer_ref and o.customer_id is not null limit 1;
  if v_cust is null then return NEW; end if;
  select first_name into v_name from sim_customers where id = v_cust;
  perform queue_notification(v_cust, 'payment', 'A payment didn''t go through',
    'Hi '||coalesce(v_name,'there')||', a Simtec payment didn''t clear. No stress — call us on 09 886 9897 and we''ll sort it out together. (Ezidebit charge an $11.50 fee on a miss.)',
    'sms', 'notif:dh:'||NEW.id);
  return NEW;
exception when others then return NEW;
end $$;
drop trigger if exists trg_notify_dishonour on public.sim_dishonours;
create trigger trg_notify_dishonour after insert on public.sim_dishonours
  for each row execute function public.trg_notify_dishonour();
