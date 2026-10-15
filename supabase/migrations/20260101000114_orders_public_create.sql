-- =============================================================================
-- DB-5 / 0114 — Criação pública de pedidos (Fase 3).
--
--   public.create_public_order(...)              EXECUTE: SOMENTE service_role
--   orders.payment_method_intent / change_for_cents  (+ CHECKs)
--   app_private.err / txt / txt_bad              helpers de validação (internos)
--   app_private.order_items_json                 itens + adicionais (snapshots) em JSON
--   app_private.order_receipt_json               resposta de sucesso (criação e replay)
--
-- Regras:
--  * Preço/valores: SEMPRE de app_private.price_cart (única fonte). Nada que o
--    cliente mande como preço é lido.
--  * Erro de validação NÃO grava nada e devolve {ok:false, errors:[{code,field?,
--    item_index?,message}]}. Falha inesperada (bug/infra) levanta exceção.
--  * Idempotência por (restaurant_id, idempotency_key): advisory lock transacional
--    por (restaurante, chave) + UNIQUE já existente em orders como rede de
--    segurança. Repetição devolve o mesmo pedido com idempotent_replay:true,
--    inclusive se o restaurante fechou/pausou depois (o pedido já existe).
--  * Pagamento NÃO existe: o cliente só declara a forma (CASH|PIX|CARD) a pagar na
--    entrega/retirada; payment_status nasce UNPAID.
--  * Cliente: upsert por (restaurant_id, telefone normalizado só dígitos). Telefone
--    existente NÃO tem o nome sobrescrito (evita que um pedido anônimo renomeie
--    outro cliente); o e-mail só é preenchido se estava vazio. O pedido guarda
--    seus próprios snapshots de nome/telefone/e-mail/endereço.
--  * DINE_IN sem mesa é aceito SE o restaurante habilitou a modalidade
--    (enabled_fulfillment_types, validado por price_cart); table_id fica nulo.
--
-- Códigos de erro de validação (ok:false) — create_public_order:
--   Vindos de price_cart: RESTAURANT_UNAVAILABLE, RESTAURANT_CLOSED,
--     FULFILLMENT_DISABLED, PRODUCT_UNAVAILABLE, MODIFIER_UNAVAILABLE,
--     MODIFIER_NOT_ALLOWED, MODIFIER_GROUP_MIN, MODIFIER_GROUP_MAX,
--     INVALID_QUANTITY, BELOW_MINIMUM, ZONE_REQUIRED, ZONE_UNAVAILABLE,
--     EMPTY_CART, VARIANT_REQUIRED, VARIANT_UNAVAILABLE, VARIANT_NOT_ALLOWED,
--     TOO_MANY_ITEMS, TOO_MANY_MODIFIERS, NOTES_TOO_LONG (nota de item).
--   Próprios: INVALID_IDEMPOTENCY_KEY, INVALID_CUSTOMER (objeto ausente),
--     INVALID_CUSTOMER_NAME (2-80), INVALID_CUSTOMER_PHONE (10-13 dígitos),
--     INVALID_CUSTOMER_EMAIL, ADDRESS_REQUIRED (DELIVERY sem endereço),
--     ADDRESS_INCOMPLETE (field = street|number|neighborhood|city),
--     ADDRESS_INVALID (field = campo com tamanho/tipo/caractere inválido),
--     INVALID_NOTES (> 500 ou caractere de controle), INVALID_PAYMENT_METHOD,
--     CHANGE_NOT_ALLOWED (troco sem CASH), INVALID_CHANGE (não inteiro/ <= 0),
--     CHANGE_BELOW_TOTAL (troco < total).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Colunas de intenção de pagamento
-- ---------------------------------------------------------------------------
alter table public.orders
  add column payment_method_intent text,
  add column change_for_cents integer;

alter table public.orders
  add constraint orders_payment_method_intent_check
    check (payment_method_intent is null or payment_method_intent in ('CASH', 'PIX', 'CARD')),
  add constraint orders_change_for_positive
    check (change_for_cents is null or change_for_cents > 0),
  add constraint orders_change_only_cash
    check (change_for_cents is null or payment_method_intent = 'CASH'),
  add constraint orders_change_covers_total
    check (change_for_cents is null or change_for_cents >= total_cents);

-- ---------------------------------------------------------------------------
-- Helpers internos
-- ---------------------------------------------------------------------------
create or replace function app_private.err(p_code text, p_field text, p_message text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_field is null
              then jsonb_build_object('code', p_code, 'message', p_message)
              else jsonb_build_object('code', p_code, 'field', p_field, 'message', p_message)
         end;
$$;

-- Valor escalar (string/number) de uma chave, aparado; NULL se ausente, nulo, vazio ou de outro tipo.
create or replace function app_private.txt(p_obj jsonb, p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(case jsonb_typeof(p_obj -> p_key)
                        when 'string' then p_obj ->> p_key
                        when 'number' then p_obj ->> p_key
                        else null end), '');
$$;

-- Chave presente, não nula e de tipo não escalar (objeto/array/booleano).
create or replace function app_private.txt_bad(p_obj jsonb, p_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_obj ? p_key
     and jsonb_typeof(p_obj -> p_key) not in ('null', 'string', 'number');
$$;

-- Itens do pedido com snapshots (nome, variante, adicionais). p_notes: incluir observações do item.
create or replace function app_private.order_items_json(p_restaurant uuid, p_order uuid, p_notes boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'name',             oi.product_name,
      'variant_name',     oi.variant_name_snapshot,
      'quantity',         oi.quantity,
      'unit_price_cents', oi.unit_price_cents,
      'modifiers_cents',  oi.modifiers_cents,
      'line_total_cents', oi.line_total_cents,
      'notes',            case when p_notes then oi.notes else null end,
      'modifiers', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'name', m.modifier_name,
                 'group_name', m.group_name,
                 'price_delta_cents', m.price_delta_cents,
                 'quantity', m.quantity)
               order by m.group_name nulls last, m.modifier_name, m.id)
        from public.order_item_modifiers m
        where m.restaurant_id = oi.restaurant_id and m.order_item_id = oi.id
      ), '[]'::jsonb)
    ) order by oi.created_at, oi.id), '[]'::jsonb)
  from public.order_items oi
  where oi.restaurant_id = p_restaurant and oi.order_id = p_order;
$$;

-- Resposta de sucesso de create_public_order (sem ids internos de cliente/pedido, sem PII).
create or replace function app_private.order_receipt_json(p_order uuid, p_replay boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ok',                 true,
    'idempotent_replay',  p_replay,
    'public_code',        o.public_code,
    'order_number',       o.order_number,
    'status',             o.status,
    'fulfillment_type',   o.fulfillment_type,
    'payment_status',     o.payment_status,
    'payment_method',     o.payment_method_intent,
    'change_for_cents',   o.change_for_cents,
    'subtotal_cents',     o.subtotal_cents,
    'delivery_fee_cents', o.delivery_fee_cents,
    'discount_cents',     o.discount_cents,
    'total_cents',        o.total_cents,
    'estimated_ready_at', o.estimated_ready_at,
    'created_at',         o.created_at,
    'items',              app_private.order_items_json(o.restaurant_id, o.id, true))
  from public.orders o
  where o.id = p_order;
$$;

revoke all on function app_private.err(text, text, text)                   from public, anon, authenticated;
revoke all on function app_private.txt(jsonb, text)                        from public, anon, authenticated;
revoke all on function app_private.txt_bad(jsonb, text)                    from public, anon, authenticated;
revoke all on function app_private.order_items_json(uuid, uuid, boolean)   from public, anon, authenticated;
revoke all on function app_private.order_receipt_json(uuid, boolean)       from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_public_order
-- ---------------------------------------------------------------------------
create or replace function public.create_public_order(
  p_slug             text,
  p_fulfillment      text,
  p_items            jsonb,
  p_customer         jsonb,
  p_address          jsonb,
  p_delivery_zone_id uuid,
  p_notes            text,
  p_idempotency_key  text,
  p_payment          jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- caracteres de controle: campos curtos rejeitam todos; notas aceitam \t e \n
  c_ctrl      constant text := '[\u0001-\u001f\u007f]';
  c_ctrl_note constant text := '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]';

  v_rid       uuid;
  v_key       text := p_idempotency_key;
  v_existing  uuid;
  v_ft        public.fulfillment_type;
  v_prep      integer;
  v_errors    jsonb := '[]'::jsonb;

  v_name      text;
  v_phone_raw text;
  v_phone     text;
  v_email     text;

  v_addr      jsonb := null;
  v_f         text;
  v_val       text;
  v_notes     text;

  v_method    text;
  v_change    integer := null;
  v_change_js jsonb;

  v_price     jsonb;
  v_total     integer;

  v_cust      uuid;
  v_order     uuid;
  v_item      jsonb;
  v_item_id   uuid;
  v_mod       jsonb;
begin
  -- Restaurante (inexistente e não-ativo são indistinguíveis).
  select r.id into v_rid
  from public.restaurants r
  where r.slug = lower(btrim(coalesce(p_slug, ''))) and r.status = 'active';
  if v_rid is null then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      app_private.err('RESTAURANT_UNAVAILABLE', null, 'Restaurante indisponível.')));
  end if;

  -- Chave de idempotência obrigatória: ASCII visível, 8..200.
  if v_key is null or v_key !~ '^[!-~]{8,200}$' then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      app_private.err('INVALID_IDEMPOTENCY_KEY', 'idempotency_key',
        'A chave de idempotência deve ter de 8 a 200 caracteres ASCII visíveis.')));
  end if;

  -- Serializa requisições com a mesma (restaurante, chave): a segunda espera o
  -- commit da primeira e então enxerga o pedido (novo snapshot por statement).
  perform pg_advisory_xact_lock(hashtextextended(v_rid::text || ':' || v_key, 0));

  select o.id into v_existing
  from public.orders o
  where o.restaurant_id = v_rid and o.idempotency_key = v_key;
  if found then
    return app_private.order_receipt_json(v_existing, true);
  end if;

  -- Modalidade (price_cart valida se está habilitada).
  begin
    v_ft := upper(btrim(coalesce(p_fulfillment, '')))::public.fulfillment_type;
  exception when others then
    v_ft := null;
  end;

  -- Cliente -----------------------------------------------------------------
  if p_customer is null or jsonb_typeof(p_customer) <> 'object' then
    v_errors := v_errors || app_private.err('INVALID_CUSTOMER', 'customer', 'Informe os dados do cliente.');
  else
    v_name := app_private.txt(p_customer, 'name');
    if v_name is null or app_private.txt_bad(p_customer, 'name')
       or char_length(v_name) not between 2 and 80 or v_name ~ c_ctrl then
      v_errors := v_errors || app_private.err('INVALID_CUSTOMER_NAME', 'customer.name',
        'O nome deve ter de 2 a 80 caracteres.');
    end if;

    v_phone_raw := app_private.txt(p_customer, 'phone');
    if v_phone_raw is null or app_private.txt_bad(p_customer, 'phone')
       or char_length(v_phone_raw) > 30 or v_phone_raw !~ '^[0-9+()\s.-]+$' then
      v_errors := v_errors || app_private.err('INVALID_CUSTOMER_PHONE', 'customer.phone',
        'Informe um telefone com DDD (10 a 13 dígitos).');
    else
      v_phone := regexp_replace(v_phone_raw, '\D', '', 'g');
      if char_length(v_phone) not between 10 and 13 then
        v_errors := v_errors || app_private.err('INVALID_CUSTOMER_PHONE', 'customer.phone',
          'Informe um telefone com DDD (10 a 13 dígitos).');
        v_phone := null;
      elsif char_length(v_phone) in (12, 13) and v_phone like '55%' then
        v_phone := substr(v_phone, 3);   -- canônico nacional: 55 + DDD + número => DDD + número
      end if;
    end if;

    v_email := lower(app_private.txt(p_customer, 'email'));
    if app_private.txt_bad(p_customer, 'email') or (v_email is not null and (
         char_length(v_email) > 254 or v_email ~ c_ctrl
         or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:].]+$')) then
      v_errors := v_errors || app_private.err('INVALID_CUSTOMER_EMAIL', 'customer.email', 'E-mail inválido.');
      v_email := null;
    end if;
  end if;

  -- Endereço (obrigatório e completo em DELIVERY; ignorado nas demais modalidades)
  if v_ft = 'DELIVERY' then
    if p_address is null or jsonb_typeof(p_address) <> 'object' then
      v_errors := v_errors || app_private.err('ADDRESS_REQUIRED', 'address', 'Informe o endereço de entrega.');
    else
      v_addr := '{}'::jsonb;
      foreach v_f in array array['street', 'number', 'neighborhood', 'city', 'postal_code', 'complement', 'instructions'] loop
        v_val := app_private.txt(p_address, v_f);
        if app_private.txt_bad(p_address, v_f) or (v_val is not null and (
             v_val ~ c_ctrl
             or char_length(v_val) > case v_f when 'street' then 200 when 'number' then 20
                                              when 'postal_code' then 12 when 'instructions' then 200
                                              else 120 end)) then
          v_errors := v_errors || app_private.err('ADDRESS_INVALID', 'address.' || v_f, 'Campo de endereço inválido.');
        elsif v_val is null and v_f in ('street', 'number', 'neighborhood', 'city') then
          v_errors := v_errors || app_private.err('ADDRESS_INCOMPLETE', 'address.' || v_f, 'Endereço incompleto.');
        else
          v_addr := v_addr || jsonb_build_object(v_f, v_val);
        end if;
      end loop;
    end if;
  end if;

  -- Observações do pedido
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  if v_notes is not null and (char_length(v_notes) > 500 or v_notes ~ c_ctrl_note) then
    v_errors := v_errors || app_private.err('INVALID_NOTES', 'notes', 'Observações: no máximo 500 caracteres.');
    v_notes := null;
  end if;

  -- Forma de pagamento declarada (nada é cobrado online)
  if p_payment is null or jsonb_typeof(p_payment) <> 'object' then
    v_errors := v_errors || app_private.err('INVALID_PAYMENT_METHOD', 'payment.method', 'Forma de pagamento inválida.');
  else
    v_method := upper(app_private.txt(p_payment, 'method'));
    if v_method is null or v_method not in ('CASH', 'PIX', 'CARD') then
      v_errors := v_errors || app_private.err('INVALID_PAYMENT_METHOD', 'payment.method', 'Forma de pagamento inválida.');
      v_method := null;
    end if;

    v_change_js := p_payment -> 'change_for_cents';
    if v_change_js is not null and jsonb_typeof(v_change_js) <> 'null' then
      if v_method is not null and v_method <> 'CASH' then
        v_errors := v_errors || app_private.err('CHANGE_NOT_ALLOWED', 'payment.change_for_cents',
          'Troco só se aplica a pagamento em dinheiro.');
      elsif jsonb_typeof(v_change_js) <> 'number' or (v_change_js #>> '{}') !~ '^[0-9]{1,9}$'
            or (v_change_js #>> '{}')::bigint = 0 then
        v_errors := v_errors || app_private.err('INVALID_CHANGE', 'payment.change_for_cents', 'Valor de troco inválido.');
      else
        v_change := (v_change_js #>> '{}')::integer;
      end if;
    end if;
  end if;

  -- Carrinho: fonte única de preço
  v_price := app_private.price_cart(v_rid, p_fulfillment, p_items, p_delivery_zone_id);
  v_errors := v_errors || coalesce(v_price -> 'errors', '[]'::jsonb);

  if (v_price ->> 'ok')::boolean and v_change is not null then
    v_total := (v_price ->> 'total_cents')::integer;
    if v_change < v_total then
      v_errors := v_errors || app_private.err('CHANGE_BELOW_TOTAL', 'payment.change_for_cents',
        'O valor para troco deve ser maior ou igual ao total do pedido.');
    end if;
  end if;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', false, 'errors', v_errors);
  end if;

  -- Gravação (tudo na transação da chamada) -----------------------------------
  select s.prep_time_minutes into v_prep from public.restaurant_settings s where s.restaurant_id = v_rid;

  begin
    insert into public.customers as c (restaurant_id, name, phone, email)
    values (v_rid, v_name, v_phone, v_email)
    on conflict (restaurant_id, phone) where phone is not null
    do update set email = coalesce(c.email, excluded.email)
    returning c.id into v_cust;

    insert into public.orders (
      restaurant_id, order_number, public_code, source, fulfillment_type, status, payment_status,
      customer_id, customer_name, customer_phone, customer_email, delivery_address,
      subtotal_cents, delivery_fee_cents, discount_cents, total_cents,
      notes, idempotency_key, payment_method_intent, change_for_cents, estimated_ready_at)
    values (
      v_rid, public.next_order_number(v_rid), public.generate_public_code(), 'PUBLIC_WEB', v_ft, 'RECEIVED', 'UNPAID',
      v_cust, v_name, v_phone, v_email, jsonb_strip_nulls(v_addr),
      (v_price ->> 'subtotal_cents')::integer, (v_price ->> 'delivery_fee_cents')::integer,
      (v_price ->> 'discount_cents')::integer, (v_price ->> 'total_cents')::integer,
      v_notes, v_key, v_method, v_change, now() + make_interval(mins => coalesce(v_prep, 30)))
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
        clock_timestamp())    -- preserva a ordem do carrinho
      returning id into v_item_id;

      for v_mod in select e.value from jsonb_array_elements(v_item -> 'modifiers') as e(value) loop
        insert into public.order_item_modifiers (
          restaurant_id, order_item_id, modifier_id, group_name, modifier_name, price_delta_cents, quantity)
        values (
          v_rid, v_item_id, (v_mod ->> 'id')::uuid, v_mod ->> 'group_name', v_mod ->> 'name',
          (v_mod ->> 'price_delta_cents')::integer, 1);
      end loop;
    end loop;
  exception when unique_violation then
    -- Rede de segurança da corrida (o advisory lock já a evita): outro request criou a mesma chave.
    select o.id into v_existing
    from public.orders o
    where o.restaurant_id = v_rid and o.idempotency_key = v_key;
    if found then
      return app_private.order_receipt_json(v_existing, true);
    end if;
    raise;
  end;

  return app_private.order_receipt_json(v_order, false);
end;
$$;

revoke all on function public.create_public_order(text, text, jsonb, jsonb, jsonb, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_public_order(text, text, jsonb, jsonb, jsonb, uuid, text, text, jsonb)
  to service_role;
