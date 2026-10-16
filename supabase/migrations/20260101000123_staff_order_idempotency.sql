-- =============================================================================
-- DB-6 / 0123 — create_staff_order idempotente.
-- Nova assinatura: create_staff_order(p_tab, p_items, p_notes default null,
--   p_idempotency_key default null). Chamada antiga de 3 argumentos segue valendo.
-- Chave (8..80 chars) vira orders.idempotency_key = 'STAFF:<tab>:<chave>' (UNIQUE por
-- restaurante; prefixo distinto das chaves públicas). Repetição devolve o pedido original
-- com idempotent_replay:true e o balance atual, mesmo se a comanda já fechou.
-- Concorrência: advisory lock transacional por (restaurante, chave) => 1 pedido.
-- Novo erro: INVALID_IDEMPOTENCY_KEY (22023).
-- =============================================================================
drop function if exists public.create_staff_order(uuid, jsonb, text);

create or replace function public.create_staff_order(
  p_tab   uuid,
  p_items jsonb,
  p_notes text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_rid     uuid;
  v_tab     public.tabs%rowtype;
  v_rstatus public.restaurant_status;
  v_tname   text;
  v_notes   text;
  v_price   jsonb;
  v_prep    integer;
  v_order   uuid;
  v_item    jsonb;
  v_item_id uuid;
  v_mod     jsonb;
  v_o       public.orders%rowtype;
  v_key     text;
  v_replay  boolean := false;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;

  select tb.restaurant_id into v_rid from public.tabs tb where tb.id = p_tab;
  perform app_private.require_perm(v_rid, 'orders.create', 'TAB_NOT_FOUND');
  perform app_private.require_perm(v_rid, 'tabs.manage',   'TAB_NOT_FOUND');

  -- Idempotência (retry após falha de rede): chave 8..80 chars, prefixada por comanda para
  -- nunca colidir com chaves públicas nem entre comandas. Advisory lock serializa o mesmo (comanda, chave).
  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 80 or p_idempotency_key ~ '[[:cntrl:]]' then
      raise exception 'INVALID_IDEMPOTENCY_KEY: a chave deve ter de 8 a 80 caracteres' using errcode = '22023';
    end if;
    v_key := 'STAFF:' || p_tab::text || ':' || p_idempotency_key;
    perform pg_advisory_xact_lock(hashtextextended(v_rid::text || v_key, 0));
    select o.* into v_o from public.orders o where o.restaurant_id = v_rid and o.idempotency_key = v_key;
    if found then
      return jsonb_build_object(
        'ok', true, 'idempotent_replay', true,
        'order', jsonb_build_object(
          'id', v_o.id, 'order_number', v_o.order_number, 'status', v_o.status,
          'fulfillment_type', v_o.fulfillment_type, 'source', v_o.source,
          'tab_id', v_o.tab_id, 'table_id', v_o.table_id, 'table_label', v_o.table_label,
          'subtotal_cents', v_o.subtotal_cents, 'total_cents', v_o.total_cents,
          'notes', v_o.notes, 'created_at', v_o.created_at,
          'items', app_private.order_items_json(v_rid, v_o.id, true)),
        'balance', app_private.tab_balance_json(v_rid, p_tab));
    end if;
  end if;

  -- FOR SHARE: pedidos concorrentes compartilham; o fechamento (NO KEY UPDATE) espera.
  select tb.* into v_tab from public.tabs tb where tb.id = p_tab and tb.restaurant_id = v_rid for share;
  if v_tab.status is distinct from 'OPEN' then
    raise exception 'TAB_NOT_OPEN: a comanda não está aberta' using errcode = 'P0001';
  end if;

  select r.status into v_rstatus from public.restaurants r where r.id = v_rid;
  if v_rstatus is distinct from 'active' then
    raise exception 'RESTAURANT_UNAVAILABLE: restaurante indisponível' using errcode = 'P0001';
  end if;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  if v_notes is not null and (char_length(v_notes) > 1000 or v_notes ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]') then
    raise exception 'INVALID_NOTES: observação inválida (máx. 1000 caracteres)' using errcode = '22023';
  end if;

  -- Preço/validação: fonte única, modo equipe (ignora aberto/fechado, pausa e mínimo).
  v_price := app_private.price_cart_core(v_rid, 'DINE_IN', p_items, null, true);
  if not coalesce((v_price ->> 'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'errors', coalesce(v_price -> 'errors', '[]'::jsonb));
  end if;

  if v_tab.table_id is not null then
    select t.name into v_tname from public.restaurant_tables t
    where t.id = v_tab.table_id and t.restaurant_id = v_rid;
  end if;
  select s.prep_time_minutes into v_prep from public.restaurant_settings s where s.restaurant_id = v_rid;

  -- Pedido do salão nasce CONFIRMED (a equipe já aceitou). Inserção direta em CONFIRMED:
  -- o histórico (trigger) registra null -> CONFIRMED por auth.uid(); a máquina de estados
  -- continua valendo para todo UPDATE posterior.
  insert into public.orders (
    restaurant_id, order_number, source, fulfillment_type, status, payment_status,
    table_id, table_label, tab_id, subtotal_cents, delivery_fee_cents, discount_cents, total_cents,
    notes, created_by, confirmed_at, estimated_ready_at, idempotency_key)
  values (
    v_rid, public.next_order_number(v_rid), 'STAFF', 'DINE_IN', 'CONFIRMED', 'UNPAID',
    v_tab.table_id, coalesce(v_tname, v_tab.label), v_tab.id,
    (v_price ->> 'subtotal_cents')::integer, 0, 0, (v_price ->> 'total_cents')::integer,
    v_notes, v_uid, now(), now() + make_interval(mins => coalesce(v_prep, 30)), v_key)
  returning id into v_order;

  for v_item in
    select e.value from jsonb_array_elements(v_price -> 'items') with ordinality as e(value, ord) order by e.ord
  loop
    insert into public.order_items (
      restaurant_id, order_id, product_id, product_name, unit_price_cents, modifiers_cents,
      quantity, line_total_cents, notes, variant_id, variant_name_snapshot, created_at)
    values (
      v_rid, v_order, (v_item ->> 'product_id')::uuid, v_item ->> 'name',
      (v_item ->> 'unit_price_cents')::integer, (v_item ->> 'modifiers_cents')::integer,
      (v_item ->> 'quantity')::integer, (v_item ->> 'line_total_cents')::integer, v_item ->> 'notes',
      case when jsonb_typeof(v_item -> 'variant') = 'object' then (v_item -> 'variant' ->> 'id')::uuid end,
      case when jsonb_typeof(v_item -> 'variant') = 'object' then v_item -> 'variant' ->> 'name' end,
      clock_timestamp())
    returning id into v_item_id;

    for v_mod in select e.value from jsonb_array_elements(v_item -> 'modifiers') as e(value) loop
      insert into public.order_item_modifiers (
        restaurant_id, order_item_id, modifier_id, group_name, modifier_name, price_delta_cents, quantity)
      values (
        v_rid, v_item_id, (v_mod ->> 'id')::uuid, v_mod ->> 'group_name', v_mod ->> 'name',
        (v_mod ->> 'price_delta_cents')::integer, 1);
    end loop;
  end loop;

  select o.* into v_o from public.orders o where o.id = v_order;

  perform public.log_audit(v_rid, 'order.staff_created', 'order', v_order,
    jsonb_build_object('tab_id', v_tab.id, 'order_number', v_o.order_number, 'total_cents', v_o.total_cents));

  return jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'order', jsonb_build_object(
      'id', v_o.id, 'order_number', v_o.order_number, 'status', v_o.status,
      'fulfillment_type', v_o.fulfillment_type, 'source', v_o.source,
      'tab_id', v_o.tab_id, 'table_id', v_o.table_id, 'table_label', v_o.table_label,
      'subtotal_cents', v_o.subtotal_cents, 'total_cents', v_o.total_cents,
      'notes', v_o.notes, 'created_at', v_o.created_at,
      'items', app_private.order_items_json(v_rid, v_o.id, true)),
    'balance', app_private.tab_balance_json(v_rid, v_tab.id));
end;
$$;

revoke all on function public.create_staff_order(uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.create_staff_order(uuid, jsonb, text, text) to authenticated;
