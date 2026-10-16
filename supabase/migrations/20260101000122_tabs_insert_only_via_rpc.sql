-- =============================================================================
-- DB-6 / 0122 — Comanda só nasce por open_tab.
-- Remove o INSERT direto de clientes em public.tabs (policy + GRANT). open_tab
-- (SECURITY DEFINER, dono postgres com BYPASSRLS) e service_role não são afetados.
-- =============================================================================
drop policy if exists tabs_insert on public.tabs;
revoke insert on public.tabs from authenticated;
