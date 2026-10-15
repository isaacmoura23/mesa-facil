-- =============================================================================
-- DB-2 / 0110 — Realtime.
-- As tabelas entram na publicação supabase_realtime; o Realtime avalia as
-- policies de SELECT (RLS) de cada assinante, então só quem tem
-- orders.view / tables.view / tabs.view recebe eventos (anon nunca).
-- REPLICA IDENTITY FULL nas tabelas com UPDATE: o evento traz a linha antiga
-- completa (necessário para filtros por restaurant_id/status e para a UI
-- detectar a mudança de status). order_status_history é append-only (PK basta).
-- =============================================================================

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array['orders', 'order_status_history', 'tabs', 'restaurant_tables'] loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

alter table public.orders            replica identity full;
alter table public.tabs              replica identity full;
alter table public.restaurant_tables replica identity full;
