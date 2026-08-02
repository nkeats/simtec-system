-- ============================================================================
--  Simtec loyalty — LEADERBOARD (run once, after loyalty_engine.sql)
--  All-time ranking by lifetime points. OPT-IN only (Privacy Act): a customer
--  appears only if they've turned it on. First name only (no suburb field yet).
-- ============================================================================

alter table public.sim_customers add column if not exists leaderboard_optin boolean not null default false;

-- customer joins / leaves the leaderboard ------------------------------------
create or replace function public.set_leaderboard_optin(p_on boolean) returns json
language plpgsql security definer set search_path=public as $$
declare v_cust uuid;
begin
  v_cust := current_customer_id();
  if v_cust is null then return json_build_object('ok',false,'error','not signed in'); end if;
  update sim_customers set leaderboard_optin = coalesce(p_on,false) where id = v_cust;
  return json_build_object('ok',true,'opted_in',coalesce(p_on,false));
end $$;
grant execute on function public.set_leaderboard_optin(boolean) to authenticated, anon;

-- the board: top 20 opted-in + the caller's own rank ------------------------
create or replace function public.leaderboard() returns json
language plpgsql security definer set search_path=public stable as $$
declare v_cust uuid; v_optin boolean; v_top json; v_mypts bigint := 0; v_myrank int;
begin
  v_cust := current_customer_id();
  select coalesce(leaderboard_optin,false) into v_optin from sim_customers where id = v_cust;

  with scored as (
    select c.id, c.first_name, coalesce(sum(pl.delta),0)::bigint as pts
    from sim_customers c
    left join points_ledger pl on pl.customer_id = c.id
    where c.leaderboard_optin = true
    group by c.id, c.first_name
  )
  select json_agg(obj order by rnk)
    into v_top
    from (
      select json_build_object('rank', row_number() over (order by pts desc, first_name),
                               'name', first_name, 'points', pts, 'me', (id = v_cust)) as obj,
             row_number() over (order by pts desc, first_name) as rnk
      from scored order by pts desc, first_name limit 20
    ) q;

  if v_optin then
    select coalesce(sum(delta),0) into v_mypts from points_ledger where customer_id = v_cust;
    with scored as (
      select c.id, coalesce(sum(pl.delta),0)::bigint as pts
      from sim_customers c left join points_ledger pl on pl.customer_id = c.id
      where c.leaderboard_optin = true group by c.id
    )
    select count(*) + 1 into v_myrank from scored where pts > v_mypts;
  end if;

  return json_build_object('opted_in', coalesce(v_optin,false),
                           'top', coalesce(v_top,'[]'::json),
                           'my_rank', v_myrank, 'my_points', v_mypts);
end $$;
grant execute on function public.leaderboard() to authenticated, anon;
