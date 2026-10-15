-- =============================================================================
-- DB-2 / 0108 — Privilégios mínimos por tabela (defesa em profundidade).
-- O Supabase concede ALL a anon/authenticated por default privileges; aqui tudo
-- é revogado e só o necessário é devolvido. RLS continua sendo a barreira
-- principal; estes GRANTs impedem que um erro de policy abra comandos que o
-- produto nunca deve expor (ex.: UPDATE de total em orders, DELETE de payments).
-- service_role e o dono (postgres) não são afetados.
-- =============================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'menu_categories', 'products', 'modifier_groups', 'modifiers', 'product_modifier_groups',
    'restaurant_settings', 'business_hours', 'business_hour_exceptions', 'delivery_zones',
    'customers', 'customer_addresses',
    'restaurant_tables', 'tabs', 'tab_status_history',
    'order_counters', 'orders', 'order_items', 'order_item_modifiers',
    'order_status_history', 'order_status_transitions',
    'payments', 'print_jobs'
  ] loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end
$$;

-- Leitura pública (somente o que as policies de anon liberam, restaurante ativo).
grant select on
  public.menu_categories, public.products, public.modifier_groups, public.modifiers,
  public.product_modifier_groups, public.restaurant_settings, public.business_hours,
  public.business_hour_exceptions, public.delivery_zones
to anon;

-- Cardápio e operação: CRUD condicionado por policy (menu.manage / settings.manage).
grant select, insert, update, delete on
  public.menu_categories, public.products, public.modifier_groups, public.modifiers,
  public.product_modifier_groups, public.business_hours, public.business_hour_exceptions,
  public.delivery_zones
to authenticated;
grant select, insert, update on public.restaurant_settings to authenticated;

-- Clientes (LGPD): sem DELETE direto.
grant select, insert, update on public.customers to authenticated;
grant select, insert, update, delete on public.customer_addresses to authenticated;

-- Mesas e comandas.
grant select, insert, update, delete on public.restaurant_tables to authenticated;
grant select, insert on public.tabs to authenticated;
grant update (status, status_reason, label, guests) on public.tabs to authenticated;
grant select on public.tab_status_history to authenticated;

-- Pedidos: leitura + atualização apenas das colunas de fluxo (ver trigger 0107).
grant select on public.orders to authenticated;
grant update (status, status_reason, estimated_ready_at) on public.orders to authenticated;
grant select on public.order_items, public.order_item_modifiers,
                public.order_status_history, public.order_status_transitions to authenticated;
-- order_counters: nenhum grant (só next_order_number()).

-- Financeiro e impressão.
grant select on public.payments to authenticated;
grant select, insert on public.print_jobs to authenticated;
