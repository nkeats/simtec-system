-- ============================================================================
--  Simtec loyalty — NOTIFICATIONS layer (run once, after loyalty_engine.sql)
--  Every notification ALWAYS lands in the customer's in-app inbox; on top of
--  that it can optionally go out on ONE external channel (push / email / sms),
--  gated by the customer's opt-out and a weekly SMS cap so you never spam or
--  overspend. System events enqueue via queue_notification(); a separate
--  dispatcher edge function actually sends the queued email/SMS.
--  Compliance: SMS = consent + sender ID + working unsubscribe (opt-out below).
-- ============================================================================

-- 1) notifications = in-app inbox + external send queue ----------------------
create table if not exists public.notifications (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references public.sim_customers(id) on delete cascade,
  category         text not null,               -- streak | points | draw | payment | referral | reward | digest | ...
  title            text not null,
  body             text,
  external_channel text,                         -- null = in-app only | push | email | sms
  external_status  text,                         -- null | queued | sent | failed | suppressed
  dedup_key        text,
  created_at       timestamptz not null default now(),
  read_at          timestamptz,
  sent_at          timestamptz
);
create index if not exists notif_cust_idx on public.notifications(customer_id, created_at desc);
create index if not exists notif_queue_idx on public.notifications(external_status) where external_status='queued';
create unique index if not exists notif_dedup on public.notifications(dedup_key) where dedup_key is not null;

alter table public.notifications enable row level security;
drop policy if exists notif_office on public.notifications;
drop policy if exists notif_self   on public.notifications;
create policy notif_office on public.notifications for all    using (is_office()) with check (is_office());
create policy notif_self   on public.notifications for select using (customer_id = current_customer_id());

-- 2) per-channel opt-out (a row = opted OUT of that channel) ------------------
create table if not exists public.notif_optout (
  customer_id uuid not null references public.sim_customers(id) on delete cascade,
  channel     text not null,                     -- push | email | sms
  created_at  timestamptz not null default now(),
  primary key (customer_id, channel)
);
alter table public.notif_optout enable row level security;
drop policy if exists optout_office on public.notif_optout;
drop policy if exists optout_self   on public.notif_optout;
create policy optout_office on public.notif_optout for all    using (is_office()) with check (is_office());
create policy optout_self   on public.notif_optout for select using (customer_id = current_customer_id());

-- weekly SMS cap (office-tunable)
insert into public.loyalty_config(key,value) values ('maxSmsPerWeek',2) on conflict (key) do nothing;

-- 3) enqueue (system events call this) — always in-app; external gated --------
create or replace function public.queue_notification(
  p_cust uuid, p_category text, p_title text, p_body text,
  p_channel text default null, p_dedup text default null
) returns json language plpgsql security definer set search_path=public as $$
declare v_status text; v_cap int; v_recent int;
begin
  if p_cust is null then return json_build_object('ok',false,'error','no customer'); end if;

  if p_channel is null then
    v_status := null;                                              -- in-app only
  elsif exists (select 1 from notif_optout where customer_id=p_cust and channel=p_channel) then
    v_status := 'suppressed';                                      -- customer opted out
  elsif p_channel = 'sms' then
    v_cap := coalesce((select value::int from loyalty_config where key='maxSmsPerWeek'),2);
    select count(*) into v_recent from notifications
      where customer_id=p_cust and external_channel='sms'
        and external_status in ('queued','sent') and created_at >= now() - interval '7 days';
    v_status := case when v_recent >= v_cap then 'suppressed' else 'queued' end;   -- hard weekly cap
  else
    v_status := 'queued';                                          -- push / email
  end if;

  insert into notifications(customer_id,category,title,body,external_channel,external_status,dedup_key)
    values (p_cust,p_category,p_title,p_body,p_channel,v_status,p_dedup)
    on conflict (dedup_key) where dedup_key is not null do nothing;
  if not found then return json_build_object('ok',false,'duplicate',true); end if;
  return json_build_object('ok',true,'external',coalesce(v_status,'inapp'));
exception when others then
  return json_build_object('ok',false,'error','queue failed');
end $$;
-- only the system (triggers / dispatcher / office edge fns via service role) enqueues
revoke all on function public.queue_notification(uuid,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.queue_notification(uuid,text,text,text,text,text) to service_role;

-- 4) app reads: inbox, unread count, mark read -------------------------------
create or replace function public.my_notifications() returns json
language sql security definer set search_path=public stable as $$
  select coalesce(json_agg(n order by n_created desc), '[]'::json) from (
    select json_build_object('id',id,'category',category,'title',title,'body',body,
                             'created_at',created_at,'read', read_at is not null) as n,
           created_at as n_created
    from notifications where customer_id = current_customer_id()
    order by created_at desc limit 50
  ) x;
$$;
grant execute on function public.my_notifications() to authenticated, anon;

create or replace function public.unread_count() returns int
language sql security definer set search_path=public stable as $$
  select count(*)::int from notifications where customer_id = current_customer_id() and read_at is null;
$$;
grant execute on function public.unread_count() to authenticated, anon;

create or replace function public.mark_notification_read(p_id uuid) returns json
language plpgsql security definer set search_path=public as $$
begin
  update notifications set read_at = now()
    where id = p_id and customer_id = current_customer_id() and read_at is null;
  return json_build_object('ok',true);
end $$;
grant execute on function public.mark_notification_read(uuid) to authenticated, anon;

-- 5) customer opt-out / opt-in for an external channel (the unsubscribe) ------
create or replace function public.set_notif_channel(p_channel text, p_enabled boolean) returns json
language plpgsql security definer set search_path=public as $$
declare v_cust uuid;
begin
  v_cust := current_customer_id();
  if v_cust is null then return json_build_object('ok',false,'error','not signed in'); end if;
  if p_channel not in ('push','email','sms') then return json_build_object('ok',false,'error','bad channel'); end if;
  if p_enabled then
    delete from notif_optout where customer_id=v_cust and channel=p_channel;
  else
    insert into notif_optout(customer_id,channel) values (v_cust,p_channel) on conflict do nothing;
  end if;
  return json_build_object('ok',true,'channel',p_channel,'enabled',p_enabled);
end $$;
grant execute on function public.set_notif_channel(text,boolean) to authenticated, anon;
