-- =============================================================================
-- DB-6 / 0121 — Ciclo de vida de comanda e mesa SÓ por RPC.
--
-- Antes: UPDATE direto de tabs.status (CLOSED/CANCELLED) contornava TAB_UNPAID,
-- TAB_HAS_OPEN_ORDERS e a auditoria; UPDATE direto de restaurant_tables.status
-- contornava set_table_status.
-- Agora (authenticated):
--   tabs              UPDATE só em label, guests   (status/status_reason/total/closed_*/unpaid_* =>
--                     42501 permission denied; use close_tab / cancel_tab)
--   restaurant_tables INSERT (id, restaurant_id, name, area, capacity, sort_order) e
--                     UPDATE (name, area, capacity, sort_order); status só via set_table_status
--                     (e triggers da comanda). Mesa nasce AVAILABLE (default).
-- RPCs SECURITY DEFINER (dono postgres), triggers e service_role não são afetados
-- (privilégios de coluna só valem para o papel que executa a instrução).
-- =============================================================================
revoke update on public.tabs from authenticated;
grant update (label, guests) on public.tabs to authenticated;

revoke insert, update on public.restaurant_tables from authenticated;
grant insert (id, restaurant_id, name, area, capacity, sort_order) on public.restaurant_tables to authenticated;
grant update (name, area, capacity, sort_order) on public.restaurant_tables to authenticated;
