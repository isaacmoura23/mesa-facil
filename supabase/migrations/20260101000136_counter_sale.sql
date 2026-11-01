-- =============================================================================
-- 0136 · Venda de balcão (PDV): pedido + itens + pagamento em dinheiro numa só transação
-- =============================================================================
-- create_counter_sale(p_restaurant, p_items, p_tendered_cents, p_notes, p_idempotency_key)
--   * Exige orders.create E payments.record no restaurante (gerente e caixa).
--   * Preço e validação vêm do servidor (price_cart_core, modo equipe); o cliente só manda
--     produto/variação/adicionais/quantidade.
--   * Cria o pedido (source STAFF, PICKUP, sem comanda, já CONFIRMED => cai na cozinha) e o pagamento
--     CASH do valor total, com valor recebido (p_tendered_cents; null = valor exato). O gatilho do caixa
--     (0135) registra a venda e o troco no turno aberto, se houver.
--   * Tudo ou nada: se qualquer passo falhar, nada fica gravado (sem comanda órfã).
--   * Idempotente: p_idempotency_key (8..80 chars) -> orders.idempotency_key = 'COUNTER:<chave>'.
--     Repetir a chamada devolve o mesmo pedido (idempotent_replay:true).
-- Erros: UNAUTHENTICATED, FORBIDDEN/RESTAURANT_NOT_FOUND (require_perm), INVALID_IDEMPOTENCY_KEY,
--        RESTAURANT_UNAVAILABLE, INVALID_NOTES, INVALID_AMOUNT, INVALID_TENDERED.
--        Itens inválidos voltam como {ok:false, errors:[...]} (mesmo contrato de create_staff_order).
-- =============================================================================
create or replace function public.create_counter_sale(
  p_restaurant      uuid,
  p_items           jsonb,
  p_tendered_cents  integer default null,
  p_notes           text default null,
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
  v_rstatus public.restaurant_status;
  v_notes   text;
  v_key     text;
  v_price   jsonb;
  v_total   integer;
  v_prep    integer;
  v_order   uuid;
  v_item    jsonb;
  v_item_id uuid;
  v_mod     jsonb;
  v_o       public.orders%rowtype;
  v_pay     public.payments%rowtype;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  perform app_private.require_perm(p_restaurant, 'orders.create',   'RESTAURANT_NOT_FOUND');
  perform app_private.require_perm(p_restaurant, 'payments.record', 'RESTAURANT_NOT_FOUND');

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 80 or p_idempotency_key ~ '[[:cntrl:]]' then
      raise exception 'INVALID_IDEMPOTENCY_KEY: a chave deve ter de 8 a 80 caracteres' using errcode = '22023';
    end if;
    v_key := 'COUNTER:' || p_idempotency_key;
    perform pg_advisory_xact_lock(hashtextextended(p_restaurant::text || v_key, 0));
    select o.* into v_o from public.orders o where o.restaurant_id = p_restaurant and o.idempotency_key = v_key;
    if found then
      select p.* into v_pay from public.payments p
       where p.restaurant_id = p_restaurant and p.order_id = v_o.id and p.status = 'PAID'
       order by p.created_at limit 1;
      return jsonb_build_object(
        'ok', true, 'idempotent_replay', true,
        'order', jsonb_build_object(
          'id', v_o.id, 'order_number', v_o.order_number, 'status', v_o.status,
          'payment_status', v_o.payment_status, 'total_cents', v_o.total_cents,
          'created_at', v_o.created_at,
          'items', app_private.order_items_json(p_restaurant, v_o.id, true)),
        'payment', case when v_pay.id is not null then app_private.payment_json(v_pay) end,
        'change_cents', case when v_pay.tendered_cents is not null then v_pay.tendered_cents - v_pay.amount_cents else 0 end);
    end if;
  end if;

  select r.status into v_rstatus from public.restaurants r where r.id = p_restaurant;
  if v_rstatus is distinct from 'active' then
    raise exception 'RESTAURANT_UNAVAILABLE: restaurante indisponível' using errcode = 'P0001';
  end if;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  if v_notes is not null and (char_length(v_notes) > 1000 or v_notes ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]') then
    raise exception 'INVALID_NOTES: observação inválida (máx. 1000 caracteres)' using errcode = '22023';
  end if;

  v_price := app_private.price_cart_core(p_restaurant, 'PICKUP', p_items, null, true);
  if not coalesce((v_price ->> 'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'errors', coalesce(v_price -> 'errors', '[]'::jsonb));
  end if;
  v_total := (v_price ->> 'total_cents')::integer;
  if v_total <= 0 then
    raise exception 'INVALID_AMOUNT: o total da venda deve ser maior que zero' using errcode = '22023';
  end if;
  if p_tendered_cents is not null and (p_tendered_cents < v_total or p_tendered_cents > 100000000) then
    raise exception 'INVALID_TENDERED: o valor recebido deve cobrir o total da venda' using errcode = '22023';
  end if;

  select s.prep_time_minutes into v_prep from public.restaurant_settings s where s.restaurant_id = p_restaurant;

  insert into public.orders (
    restaurant_id, order_number, source, fulfillment_type, status, payment_status,
    table_label, subtotal_cents, delivery_fee_cents, discount_cents, total_cents,
    notes, created_by, confirmed_at, estimated_ready_at, idempotency_key)
  values (
    p_restaurant, public.next_order_number(p_restaurant), 'STAFF', 'PICKUP', 'CONFIRMED', 'UNPAID',
    'Balcão', (v_price ->> 'subtotal_cents')::integer, 0, 0, v_total,
    v_notes, v_uid, now(), now() + make_interval(mins => coalesce(v_prep, 30)), v_key)
  returning id into v_order;

  for v_item in
    select e.value from jsonb_array_elements(v_price -> 'items') with ordinality as e(value, ord) order by e.ord
  loop
    insert into public.order_items (
      restaurant_id, order_id, product_id, product_name, unit_price_cents, modifiers_cents,
      quantity, line_total_cents, notes, variant_id, variant_name_snapshot, created_at)
    values (
      p_restaurant, v_order, (v_item ->> 'product_id')::uuid, v_item ->> 'name',
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
        p_restaurant, v_item_id, (v_mod ->> 'id')::uuid, v_mod ->> 'group_name', v_mod ->> 'name',
        (v_mod ->> 'price_delta_cents')::integer, 1);
    end loop;
  end loop;

  insert into public.payments (
    restaurant_id, order_id, tab_id, method, amount_cents, status, provider,
    idempotency_key, tendered_cents, recorded_by, paid_at)
  values (
    p_restaurant, v_order, null, 'CASH', v_total, 'PAID', 'MANUAL',
    v_key, coalesce(p_tendered_cents, v_total), v_uid, now())
  returning * into v_pay;

  select o.* into v_o from public.orders o where o.id = v_order;

  perform public.log_audit(p_restaurant, 'order.counter_sale', 'order', v_order,
    jsonb_build_object('order_number', v_o.order_number, 'total_cents', v_total,
                       'tendered_cents', v_pay.tendered_cents));

  return jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'order', jsonb_build_object(
      'id', v_o.id, 'order_number', v_o.order_number, 'status', v_o.status,
      'payment_status', v_o.payment_status, 'total_cents', v_o.total_cents,
      'created_at', v_o.created_at,
      'items', app_private.order_items_json(p_restaurant, v_o.id, true)),
    'payment', app_private.payment_json(v_pay),
    'change_cents', v_pay.tendered_cents - v_pay.amount_cents);
end;
$$;

revoke all on function public.create_counter_sale(uuid, jsonb, integer, text, text) from public, anon, authenticated;
grant execute on function public.create_counter_sale(uuid, jsonb, integer, text, text) to authenticated;
