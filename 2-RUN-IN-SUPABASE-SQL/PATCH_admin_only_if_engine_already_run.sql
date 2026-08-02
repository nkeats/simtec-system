-- Make rewards-config changes ADMIN-ONLY.
-- Only needed if you ALREADY ran loyalty_engine.sql (the updated engine already
-- includes this). Office roles can still VIEW the values; only 'admin' can change them.
drop policy if exists loyaltycfg_office on public.loyalty_config;
drop policy if exists loyaltycfg_read   on public.loyalty_config;
drop policy if exists loyaltycfg_admin  on public.loyalty_config;
create policy loyaltycfg_read  on public.loyalty_config for select using (is_office());
create policy loyaltycfg_admin on public.loyalty_config for all    using (my_role()='admin') with check (my_role()='admin');
