-- ============================================================================
--  Fix H1 — scope sim_order_applications so a consultant can only see/modify
--  their OWN orders' application records (ID doc paths, ID numbers, income,
--  signatures). The current policy has no per-consultant filter, so any
--  consultant can read every customer's most sensitive PII.
--  Mirrors the (correct) sim_order_items policy.
--  Run in the Supabase SQL editor (role: postgres).
-- ============================================================================

drop policy if exists consultant_own on public.sim_order_applications;

create policy consultant_own on public.sim_order_applications
  for all to authenticated
  using (
    public.my_role() = 'consultant'
    and order_id in (
      select id from public.sim_orders
      where consultant_name = public.my_consultant()
    )
  )
  with check (
    public.my_role() = 'consultant'
    and order_id in (
      select id from public.sim_orders
      where consultant_name = public.my_consultant()
    )
  );

-- (Staff policies on this table are unchanged — is_staff() still sees all.)
-- Verify:
-- select policyname, roles, cmd, qual, with_check
-- from pg_policies where schemaname='public' and tablename='sim_order_applications';
