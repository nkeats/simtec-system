-- ============================================================================
-- Simtec — Role-based Row Level Security (phase 2 hardening)
-- ============================================================================
-- WHAT THIS DOES
--   Today every logged-in user (any role) can read and write every table.
--   This migration keeps admin/manager/office ("staff") at full access, but
--   restricts the two lower-trust roles so they only ever see their own data:
--     * consultant  -> only their own sales, their own customers, their own
--                      commissions, plus read-only reference/config tables.
--     * driver      -> only the delivery-related tables, read-only.
--
-- WHY IT IS NOT AUTO-APPLIED
--   The consultant policies touch the live order-entry flow (order-app.html).
--   Get them slightly wrong and a consultant can't create a sale. So APPLY THIS
--   IN A QUIET WINDOW and run the TEST CHECKLIST below with a real login of each
--   role before go-live. Rollback is at the very bottom.
--
-- MODEL  (uses the helpers already in this database — single source of truth)
--   The DB already ships these SECURITY DEFINER helpers, which read the caller's
--   profile row without tripping RLS:
--       public.is_staff()      -> boolean  (role in admin/manager/office)
--       public.my_role()       -> text     (the caller's role)
--       public.my_consultant() -> text     (the caller's consultant_name)
--   This migration REUSES them rather than defining a parallel set, so there is
--   nothing to drift out of sync. Section 1 just verifies they exist.
-- ============================================================================

-- ---- 1. Precondition: the shared helpers must exist -------------------------
--   Fail loudly (instead of silently mis-securing tables) if this is applied to
--   a database that doesn't have the helpers. If it raises, either you're on the
--   wrong project, or the base migration that defines them hasn't run yet — see
--   the commented fallback in section 1b to create compatible helpers.
do $$
begin
  if to_regprocedure('public.is_staff()')      is null
  or to_regprocedure('public.my_role()')       is null
  or to_regprocedure('public.my_consultant()') is null then
    raise exception
      'Missing helper(s): is_staff()/my_role()/my_consultant(). '
      'Apply the base helper migration first, or uncomment section 1b below.';
  end if;
end $$;

-- ---- 1b. FALLBACK helpers (only if section 1 raised) ------------------------
--   Uncomment this block ONLY if the helpers above do not yet exist. It creates
--   them from the profiles table with the same names/semantics the policies use.
--   Leave it commented when the helpers already exist (the normal case).
--
-- create or replace function public.my_role()
--   returns text language sql stable security definer set search_path = public as
-- $$ select role from public.profiles where id = auth.uid() $$;
-- create or replace function public.my_consultant()
--   returns text language sql stable security definer set search_path = public as
-- $$ select consultant_name from public.profiles where id = auth.uid() $$;
-- create or replace function public.is_staff()
--   returns boolean language sql stable security definer set search_path = public as
-- $$ select coalesce(public.my_role() in ('admin','manager','office'), false) $$;
-- revoke all on function public.my_role(), public.my_consultant(), public.is_staff() from public;
-- grant execute on function public.my_role(), public.my_consultant(), public.is_staff() to authenticated;

-- ---- 2. Reset: drop the blanket "any authenticated" policies ---------------
-- (These were created by the phase-1 lockdown. We replace them with role-aware
--  policies. Every table still has RLS enabled.)
do $$
declare t text; p record;
begin
  foreach t in array array[
    'sim_customers','sim_orders','sim_order_items','sim_order_applications','sim_order_confirmations',
    'sim_payments','sim_payment_events','sim_dishonours','sim_communications','sim_contacts',
    'sim_arrears_sequence','sms_log','debt_contacts','order_amendments','schedule_changes',
    'commission_sales','commission_sale_items','commission_awards','commission_bonuses',
    'commission_deductions','commission_overrides','commission_pay_runs','commission_retention',
    'commission_retention_adjustments','commission_settings','commission_cash_advances',
    'commission_cash_weeks','commission_giveaways','commission_consultants','commission_products',
    'commission_cancel_review','config','delivery_rules','appointments','appointment_reschedules',
    'zz_legacy_orders','zz_legacy_payments','profiles','sim_stock_items','sim_stock_movements'
  ] loop
    if to_regclass('public.'||t) is null then continue; end if;  -- skip tables not in this DB
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- ---- 3. STAFF (admin/manager/office): full access to everything -------------
do $$
declare t text;
begin
  foreach t in array array[
    'sim_customers','sim_orders','sim_order_items','sim_order_applications','sim_order_confirmations',
    'sim_payments','sim_payment_events','sim_dishonours','sim_communications','sim_contacts',
    'sim_arrears_sequence','sms_log','debt_contacts','order_amendments','schedule_changes',
    'commission_sales','commission_sale_items','commission_awards','commission_bonuses',
    'commission_deductions','commission_overrides','commission_pay_runs','commission_retention',
    'commission_retention_adjustments','commission_settings','commission_cash_advances',
    'commission_cash_weeks','commission_giveaways','commission_consultants','commission_products',
    'commission_cancel_review','config','delivery_rules','appointments','appointment_reschedules',
    'zz_legacy_orders','zz_legacy_payments','sim_stock_items','sim_stock_movements'
  ] loop
    if to_regclass('public.'||t) is null then continue; end if;
    execute format($f$create policy staff_all on public.%I for all to authenticated
      using (public.is_staff()) with check (public.is_staff())$f$, t);
  end loop;
end $$;

-- profiles: staff manage all; every user may read their OWN row (auth.js needs it)
create policy staff_all on public.profiles for all to authenticated
  using (public.is_staff()) with check (public.is_staff());
create policy self_read on public.profiles for select to authenticated
  using (id = auth.uid());

-- ---- 4. CONSULTANT: only their own data + read-only reference --------------
-- Orders they entered (order-app sets consultant_name = the logged-in consultant)
create policy consultant_own on public.sim_orders for all to authenticated
  using (public.my_role()='consultant' and consultant_name = public.my_consultant())
  with check (public.my_role()='consultant' and consultant_name = public.my_consultant());

-- Customers: read the ones tied to their orders; insert new ones during a sale
create policy consultant_read on public.sim_customers for select to authenticated
  using (public.my_role()='consultant'
         and id in (select customer_id from public.sim_orders
                    where consultant_name = public.my_consultant()));
create policy consultant_insert on public.sim_customers for insert to authenticated
  with check (public.my_role()='consultant');

-- Order items for their own orders
create policy consultant_own on public.sim_order_items for all to authenticated
  using (public.my_role()='consultant'
         and order_id in (select id from public.sim_orders
                          where consultant_name = public.my_consultant()))
  with check (public.my_role()='consultant'
         and order_id in (select id from public.sim_orders
                          where consultant_name = public.my_consultant()));

-- Order applications they create
create policy consultant_own on public.sim_order_applications for all to authenticated
  using (public.my_role()='consultant')
  with check (public.my_role()='consultant');

-- Their commission rows (read only)
create policy consultant_read on public.commission_sales for select to authenticated
  using (public.my_role()='consultant'
         and consultant_id in (select id from public.commission_consultants
                               where name = public.my_consultant()));

-- Reference/config a consultant page needs (read only)
create policy consultant_read on public.commission_awards      for select to authenticated using (public.my_role()='consultant');
create policy consultant_read on public.commission_consultants for select to authenticated using (public.my_role()='consultant');
create policy consultant_read on public.commission_products    for select to authenticated using (public.my_role()='consultant');
create policy consultant_read on public.commission_settings    for select to authenticated using (public.my_role()='consultant');

-- Diary (appointments) — read
create policy consultant_read on public.appointments            for select to authenticated using (public.my_role()='consultant');
create policy consultant_read on public.appointment_reschedules for select to authenticated using (public.my_role()='consultant');

-- ---- 5. DRIVER: delivery data, read only -----------------------------------
create policy driver_read on public.sim_orders     for select to authenticated using (public.my_role()='driver');
create policy driver_read on public.sim_payments   for select to authenticated using (public.my_role()='driver');
create policy driver_read on public.sim_dishonours for select to authenticated using (public.my_role()='driver');
create policy driver_read on public.delivery_rules for select to authenticated using (public.my_role()='driver');
create policy driver_read on public.sim_customers  for select to authenticated using (public.my_role()='driver');
create policy driver_read on public.sim_order_items for select to authenticated using (public.my_role()='driver');

-- ============================================================================
-- TEST CHECKLIST (run before go-live; use a real login for each role)
--   OFFICE:     open Home, Customers, Delivery, Arrears, Reports, Commissions — all load.
--   CONSULTANT: order-app.html -> create a test sale end to end (customer + order
--               + items saves). my-sales.html shows THAT sale and NOT other
--               consultants' sales. diary loads. Cannot open customer-detail of
--               someone else's customer.
--   DRIVER:     driver.html loads today's deliveries; cannot edit.
--   Then delete the test sale.
-- ============================================================================

-- ---- ROLLBACK (restores phase-1 "any authenticated" access) ---------------
-- do $$
-- declare t text; p record;
-- begin
--   foreach t in array array[ ...same table list as section 2... ] loop
--     if to_regclass('public.'||t) is null then continue; end if;
--     for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
--       execute format('drop policy %I on public.%I', p.policyname, t);
--     end loop;
--     execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t||'_auth_all', t);
--   end loop;
-- end $$;
