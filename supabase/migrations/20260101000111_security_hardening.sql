-- =============================================================================
-- 0111 — Endurecimento de segurança (achados F-01, F-02, F-05, F-06, F-07, F-10,
-- F-11 e F-13 de tests/FINDINGS.md). Migração nova: o histórico antigo não muda.
-- Cada função abaixo é CREATE OR REPLACE do corpo atual (0009/0107) alterando
-- somente o trecho indicado.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- F-05 · payments_sync_order: serializa pagamentos do mesmo pedido.
-- Sem o lock, dois pagamentos simultâneos agregam no snapshot da transação e
-- nenhum enxerga o outro (payment_status ficava PENDING). NO KEY UPDATE em vez
-- de UPDATE de propósito: a FK de payments já segura FOR KEY SHARE no pedido e
-- FOR UPDATE entraria em deadlock entre duas transações; NO KEY UPDATE
-- serializa igual (conflita com ele mesmo) e é compatível com KEY SHARE.
-- ---------------------------------------------------------------------------
create or replace function public.payments_sync_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total    integer;
  v_paid     bigint;
  v_pending  boolean;
  v_refunded boolean;
  v_failed   boolean;
  v_new      public.payment_status;
begin
  if new.order_id is null then
    return null;
  end if;

  -- F-05: trava o pedido; o agregado abaixo roda com snapshot novo após a espera.
  perform 1 from public.orders o
   where o.id = new.order_id and o.restaurant_id = new.restaurant_id
   for no key update;

  select o.total_cents into v_total
  from public.orders o where o.id = new.order_id and o.restaurant_id = new.restaurant_id;
  if v_total is null then
    return null;
  end if;

  select coalesce(sum(p.amount_cents) filter (where p.status = 'PAID'), 0),
         coalesce(bool_or(p.status = 'PENDING'), false),
         coalesce(bool_or(p.status = 'REFUNDED'), false),
         coalesce(bool_or(p.status = 'FAILED'), false)
    into v_paid, v_pending, v_refunded, v_failed
  from public.payments p
  where p.order_id = new.order_id and p.restaurant_id = new.restaurant_id;

  v_new := case
    when v_paid >= v_total and v_total > 0 then 'PAID'
    when v_paid > 0 or v_pending           then 'PENDING'   -- parcial ou aguardando confirmação
    when v_refunded                        then 'REFUNDED'
    when v_failed                          then 'FAILED'
    else 'UNPAID'
  end;

  update public.orders
     set payment_status = v_new
   where id = new.order_id and restaurant_id = new.restaurant_id
     and payment_status is distinct from v_new;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- F-06 · orders_before_insert: FOR SHARE na comanda.
-- Pedidos concorrentes compartilham o lock; o fechamento (UPDATE da comanda)
-- espera os pedidos em voo e depois soma o total com snapshot novo; um pedido
-- que chega durante/depois do fechamento vê CLOSED e é recusado. Não há ciclo:
-- o fechamento não trava pedidos nem pede lock em nada que o INSERT segure.
-- ---------------------------------------------------------------------------
create or replace function public.orders_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tab_status public.tab_status;
begin
  if new.order_number is null then
    new.order_number := public.next_order_number(new.restaurant_id);
  end if;

  if new.table_id is not null and new.table_label is null then
    select t.name into new.table_label
    from public.restaurant_tables t
    where t.id = new.table_id and t.restaurant_id = new.restaurant_id;
  end if;

  if new.tab_id is not null then
    select tb.status into v_tab_status
    from public.tabs tb
    where tb.id = new.tab_id and tb.restaurant_id = new.restaurant_id
    for share;   -- F-06
    if v_tab_status is distinct from 'OPEN' then
      raise exception 'TAB_NOT_OPEN: a comanda não está aberta' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- F-01 · tabs INSERT: colunas de auditoria são do servidor.
-- Mantém o grant de INSERT (fluxos/testes existentes enviam status/total_cents
-- explícitos e as policies/checks já os rejeitam quando inválidos); aqui
-- sobrescrevemos o que o cliente não deve decidir. A função é DEFINER, então a
-- distinção de cliente usa auth.uid() (mesmo critério de opened_by).
-- ---------------------------------------------------------------------------
create or replace function public.tabs_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table_status public.table_status;
begin
  -- Autoria do servidor; a regra "uma comanda por mesa" vem das configurações
  -- do restaurante e o cliente não consegue desligá-la.
  if auth.uid() is not null then
    new.opened_by    := auth.uid();
    -- F-01: carimbos e campos de encerramento não vêm do cliente.
    new.opened_at    := now();
    new.created_at   := now();
    new.updated_at   := now();
    new.closed_by    := null;
    new.status_reason := null;
  end if;
  select coalesce(s.single_tab_per_table, true) into new.single_per_table
  from public.restaurant_settings s where s.restaurant_id = new.restaurant_id;
  new.single_per_table := coalesce(new.single_per_table, true);

  if new.table_id is not null then
    select t.status into v_table_status
    from public.restaurant_tables t
    where t.id = new.table_id and t.restaurant_id = new.restaurant_id;
    if v_table_status = 'INACTIVE' then
      raise exception 'TABLE_INACTIVE: mesa desativada' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- F-07 · register_restaurant: serializa por usuário antes de contar.
-- ---------------------------------------------------------------------------
create or replace function public.register_restaurant(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := pg_catalog.btrim(coalesce(p_name, ''));
  v_slug  text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, '')));
  v_id    uuid;
  v_owned integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if pg_catalog.char_length(v_name) not between 2 and 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  -- F-07: chamadas simultâneas do mesmo usuário passam uma de cada vez.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text, 0));

  select pg_catalog.count(*) into v_owned
  from public.restaurant_memberships m
  where m.user_id = v_uid and m.role = 'owner' and m.status <> 'revoked';
  if v_owned >= 5 then
    raise exception 'restaurant_limit_reached' using errcode = '54000';
  end if;

  begin
    insert into public.restaurants (name, slug, status, created_by)
    values (v_name, v_slug, 'pending', v_uid)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'slug_unavailable' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_slug' using errcode = '23514';
  end;

  insert into public.restaurant_memberships (restaurant_id, user_id, role, status, invited_by)
  values (v_id, v_uid, 'owner', 'active', v_uid);

  perform public.log_audit(
    v_id, 'restaurant.registered', 'restaurant', v_id,
    jsonb_build_object('slug', v_slug, 'by', 'self_service')
  );
  return v_id;
end;
$$;

-- CREATE OR REPLACE preserva os GRANTs; reafirmados por clareza.
revoke execute on function public.register_restaurant(text, text) from public, anon, authenticated;
grant  execute on function public.register_restaurant(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- F-02 · image_path / logo_path presos ao prefixo do próprio restaurante.
-- Layout definido em 0109 (Storage): restaurants/<id>/products/... e /logo/...
-- ---------------------------------------------------------------------------
alter table public.products
  add constraint products_image_path_scope check (
    image_path is null or (
      image_path like 'restaurants/' || restaurant_id::text || '/products/%'
      and position('..' in image_path) = 0
    )
  );

alter table public.restaurants
  add constraint restaurants_logo_path_scope check (
    logo_path is null or (
      logo_path like 'restaurants/' || id::text || '/logo/%'
      and position('..' in logo_path) = 0
    )
  );

-- ---------------------------------------------------------------------------
-- F-10 · audit_logs: 'support' só lê com sessão de suporte ativa.
-- Superadmin lê tudo (inclui linhas sem restaurante); demais, por restaurante.
-- ---------------------------------------------------------------------------
drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (
    public.is_platform_superadmin()
    or (restaurant_id is not null and (
      public.has_permission(restaurant_id, 'team.manage')
      or public.has_support_access(restaurant_id)
    ))
  );

-- ---------------------------------------------------------------------------
-- F-11 · funções de trigger não precisam de EXECUTE para ninguém (o
-- EXECUTE só é checado na criação do trigger). service_role/postgres mantêm.
-- ---------------------------------------------------------------------------
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app_private')
      and p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- F-13 · FORCE ROW LEVEL SECURITY nas tabelas do domínio (DB-2).
-- Dono (postgres), service_role e as funções SECURITY DEFINER têm BYPASSRLS,
-- então nada muda para elas; protege contra um dono futuro sem BYPASSRLS.
-- ---------------------------------------------------------------------------
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
    execute format('alter table public.%I force row level security', t);
  end loop;
end
$$;
