-- 0131 — Planos e assinaturas aplicados (Fase 8, P8-DB)
--
-- Estados (app_private.subscription_state): active | trial | expired | past_due | cancelled | none
--   * trial: status 'trialing' e (trial_ends_at nulo ou futuro); vencido => expired
--   * active: status 'active' e (current_period_end nulo ou futuro); vencido => expired
--   * past_due: status 'past_due'; tolerância de 7 dias após current_period_end (sem fim: updated_at)
--   * cancelled: status 'canceled' (sem assinatura viva); none: restaurante sem assinatura (sem bloqueio, sem limites)
--   Sem cron: tudo é calculado na hora. A assinatura considerada é a "viva" (trialing/active/past_due) ou, na falta,
--   a mais recente.
-- Gate: create_public_order e create_staff_order recusam quando o estado é expired/cancelled/past_due fora da
--   tolerância (app_private.subscription_allows_orders).
--     create_public_order => {ok:false, errors:[{code:'SUBSCRIPTION_INACTIVE'}]};  create_staff_order => P0001 'SUBSCRIPTION_INACTIVE:'
--   Leituras e relatórios continuam.
-- Limites (plans.limits; chave ausente/nula/não numérica = ilimitado; restaurante sem assinatura = sem limites):
--   max_members (membros active+invited), max_tables, max_products (ou max_menu_items).
--   Triggers BEFORE INSERT (membros também na reativação via UPDATE de status) => P0001 'PLAN_LIMIT_REACHED:'.
--   Valem para qualquer papel (inclui service_role); para ampliar, mude o plano.
-- Abuso no pedido público: 60 pedidos/min por restaurante e 5/h por telefone normalizado =>
--   {ok:false, errors:[{code:'RATE_LIMITED'}]}. Telefone já existente NÃO tem o e-mail sobrescrito.
-- restaurant_subscription_status(p_restaurant): membros do restaurante; P0002 RESTAURANT_NOT_FOUND para os demais.
-- F-50: plans não pode mais ser apagado por DELETE direto (privilégio + policy removidos): só inativar (is_active=false).
-- F-54: default_trial_days=0 continua significando "sem trial": o trial nasce já vencido (restaurante precisa de
--   cobrança manual antes de receber pedidos). Com o gate ativo isso é intencional e fica documentado aqui.
-- S-12: support_tickets limitado a 20 criações/hora por usuário (P0001 'RATE_LIMITED:').

-- ---------------------------------------------------------------------------
-- Estado da assinatura
-- ---------------------------------------------------------------------------
create or replace function app_private.current_subscription(rid uuid)
returns public.subscriptions
language sql stable security definer set search_path = ''
as $$
  select s.* from public.subscriptions s
   where s.restaurant_id = rid
   order by (s.status in ('trialing', 'active', 'past_due')) desc, s.created_at desc
   limit 1;
$$;

create or replace function app_private.subscription_grace_ends(s public.subscriptions)
returns timestamptz
language sql immutable set search_path = ''
as $$
  select case when s.status = 'past_due'
              then coalesce(s.current_period_end, s.updated_at) + interval '7 days' end;
$$;

create or replace function app_private.subscription_state(rid uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
           when s.id is null then 'none'
           when s.status = 'canceled' then 'cancelled'
           when s.status = 'trialing' then
             case when s.trial_ends_at is null or s.trial_ends_at > now() then 'trial' else 'expired' end
           when s.status = 'active' then
             case when s.current_period_end is null or s.current_period_end > now() then 'active' else 'expired' end
           when s.status = 'past_due' then 'past_due'
           else 'none'
         end
  from (select 1) x
  left join lateral app_private.current_subscription(rid) s on true;
$$;

create or replace function app_private.subscription_allows_orders(rid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case app_private.subscription_state(rid)
           when 'none' then true
           when 'trial' then true
           when 'active' then true
           when 'past_due' then now() <= app_private.subscription_grace_ends(app_private.current_subscription(rid))
           else false
         end;
$$;

revoke all on function app_private.current_subscription(uuid) from public, anon, authenticated;
revoke all on function app_private.subscription_grace_ends(public.subscriptions) from public, anon, authenticated;
revoke all on function app_private.subscription_state(uuid) from public, anon, authenticated;
revoke all on function app_private.subscription_allows_orders(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Limites do plano
-- ---------------------------------------------------------------------------
create or replace function app_private.plan_limit(rid uuid, p_kind text)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select case when jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric >= 0 then (v #>> '{}')::numeric end
  from (
    select case p_kind
             when 'members'  then pl.limits -> 'max_members'
             when 'tables'   then pl.limits -> 'max_tables'
             when 'products' then coalesce(pl.limits -> 'max_products', pl.limits -> 'max_menu_items')
           end as v
    from app_private.current_subscription(rid) s
    join public.plans pl on pl.id = s.plan_id
  ) t;
$$;

create or replace function app_private.plan_usage(rid uuid, p_kind text)
returns integer
language sql stable security definer set search_path = ''
as $$
  select case p_kind
    when 'members'  then (select count(*)::int from public.restaurant_memberships m
                           where m.restaurant_id = rid and m.status in ('active', 'invited'))
    when 'tables'   then (select count(*)::int from public.restaurant_tables t where t.restaurant_id = rid)
    when 'products' then (select count(*)::int from public.products p where p.restaurant_id = rid)
  end;
$$;

create or replace function app_private.enforce_plan_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind  text := tg_argv[0];
  v_limit numeric;
  v_used  integer;
begin
  if v_kind = 'members' then
    if new.status not in ('active', 'invited') then
      return new;
    end if;
    if tg_op = 'UPDATE' and old.status in ('active', 'invited') then
      return new;
    end if;
  end if;

  v_limit := app_private.plan_limit(new.restaurant_id, v_kind);
  if v_limit is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('plan_limit:' || v_kind || ':' || new.restaurant_id::text, 0));
  v_used := app_private.plan_usage(new.restaurant_id, v_kind);
  if v_used >= v_limit then
    raise exception 'PLAN_LIMIT_REACHED: limite do plano atingido (% de %: %)', v_used, v_limit::int, v_kind
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function app_private.plan_limit(uuid, text) from public, anon, authenticated;
revoke all on function app_private.plan_usage(uuid, text) from public, anon, authenticated;
revoke all on function app_private.enforce_plan_limit() from public, anon, authenticated;

create trigger restaurant_memberships_plan_limit_ins before insert on public.restaurant_memberships
  for each row execute function app_private.enforce_plan_limit('members');
create trigger restaurant_memberships_plan_limit_upd before update of status on public.restaurant_memberships
  for each row execute function app_private.enforce_plan_limit('members');
create trigger restaurant_tables_plan_limit before insert on public.restaurant_tables
  for each row execute function app_private.enforce_plan_limit('tables');
create trigger products_plan_limit before insert on public.products
  for each row execute function app_private.enforce_plan_limit('products');

-- ---------------------------------------------------------------------------
-- restaurant_subscription_status
-- ---------------------------------------------------------------------------
create or replace function public.restaurant_subscription_status(p_restaurant uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_state text;
  v_s     public.subscriptions;
  v_plan  public.plans;
  v_end   timestamptz;
  v_grace timestamptz;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  if p_restaurant is null or not public.is_member(p_restaurant) then
    raise exception 'RESTAURANT_NOT_FOUND: não encontrado' using errcode = 'P0002';
  end if;

  v_state := app_private.subscription_state(p_restaurant);
  v_s := app_private.current_subscription(p_restaurant);
  if v_s.id is not null then
    select * into v_plan from public.plans where id = v_s.plan_id;
    v_grace := app_private.subscription_grace_ends(v_s);
    v_end := case when v_s.status = 'trialing' then v_s.trial_ends_at else v_s.current_period_end end;
  end if;

  return jsonb_build_object(
    'state', v_state,
    'blocked', not app_private.subscription_allows_orders(p_restaurant),
    'plan_code', v_plan.code,
    'plan_name', v_plan.name,
    'trial_ends_at', v_s.trial_ends_at,
    'current_period_end', v_s.current_period_end,
    'grace_ends_at', v_grace,
    'days_left', case when v_end is null then null else greatest(0, ceil(extract(epoch from (v_end - now())) / 86400))::int end,
    'limits', coalesce(v_plan.limits, '{}'::jsonb),
    'usage', jsonb_build_object(
      'members',  app_private.plan_usage(p_restaurant, 'members'),
      'tables',   app_private.plan_usage(p_restaurant, 'tables'),
      'products', app_private.plan_usage(p_restaurant, 'products'))
  );
end;
$$;
revoke all on function public.restaurant_subscription_status(uuid) from public, anon;
grant execute on function public.restaurant_subscription_status(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- F-50: plano nunca apagado por DELETE direto
-- ---------------------------------------------------------------------------
drop policy if exists plans_delete on public.plans;
revoke delete on public.plans from authenticated;

-- ---------------------------------------------------------------------------
-- S-12: teto de chamados por usuário
-- ---------------------------------------------------------------------------
create or replace function app_private.support_tickets_rate_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.opened_by is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tickets:' || new.opened_by::text, 0));
  if (select count(*) from public.support_tickets t
       where t.opened_by = new.opened_by and t.created_at > clock_timestamp() - interval '1 hour') >= 20 then
    raise exception 'RATE_LIMITED: muitos chamados na última hora' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function app_private.support_tickets_rate_limit() from public, anon, authenticated;
create trigger support_tickets_rate_limit before insert on public.support_tickets
  for each row execute function app_private.support_tickets_rate_limit();

-- ---------------------------------------------------------------------------
-- Índice de apoio aos tetos do pedido público
-- ---------------------------------------------------------------------------
create index orders_public_phone_recent_idx on public.orders (restaurant_id, customer_phone, created_at desc)
  where source = 'PUBLIC_WEB';

-- ---------------------------------------------------------------------------
-- create_public_order / create_staff_order (CREATE OR REPLACE; só gate, tetos e e-mail mudam)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_public_order(p_slug text, p_fulfillment text, p_items jsonb, p_customer jsonb, p_address jsonb, p_delivery_zone_id uuid, p_notes text, p_idempotency_key text, p_payment jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_n         integer;
begin
  -- Restaurante (inexistente e não-ativo são indistinguíveis).
  select r.id into v_rid
  from public.restaurants r
  where r.slug = lower(btrim(coalesce(p_slug, ''))) and r.status = 'active';
  if v_rid is null then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      app_private.err('RESTAURANT_UNAVAILABLE', null, 'Restaurante indisponível.')));
  end if;

  -- Assinatura (Fase 8): expirada/cancelada/past_due fora da tolerância => vitrine indisponível.
  if not app_private.subscription_allows_orders(v_rid) then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      app_private.err('SUBSCRIPTION_INACTIVE', null, 'Restaurante indisponível no momento.')));
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

  -- Tetos anti-abuso (Fase 8, S-04): contagem em orders por janela, serializada por advisory lock
  -- (a 2a requisição concorrente espera o commit da 1a e a enxerga). Réplicas idempotentes já
  -- retornaram acima e não contam. Constantes: 60 pedidos/min por restaurante; 5 pedidos/h por telefone.
  perform pg_advisory_xact_lock(hashtextextended('rl:r:' || v_rid::text, 0));
  select count(*) into v_n from public.orders o
   where o.restaurant_id = v_rid and o.source = 'PUBLIC_WEB'
     and o.created_at > clock_timestamp() - interval '1 minute';
  if v_n >= 60 then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      app_private.err('RATE_LIMITED', null, 'Muitos pedidos em pouco tempo. Tente novamente em instantes.')));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('rl:p:' || v_rid::text || ':' || v_phone, 0));
  select count(*) into v_n from public.orders o
   where o.restaurant_id = v_rid and o.source = 'PUBLIC_WEB' and o.customer_phone = v_phone
     and o.created_at > clock_timestamp() - interval '1 hour';
  if v_n >= 5 then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array(
      app_private.err('RATE_LIMITED', 'customer.phone', 'Muitos pedidos deste telefone na última hora. Tente mais tarde.')));
  end if;

  -- Gravação (tudo na transação da chamada) -----------------------------------
  select s.prep_time_minutes into v_prep from public.restaurant_settings s where s.restaurant_id = v_rid;

  begin
    insert into public.customers as c (restaurant_id, name, phone, email)
    values (v_rid, v_name, v_phone, v_email)
    on conflict (restaurant_id, phone) where phone is not null
    do update set email = c.email   -- S-04: telefone existente nunca tem o e-mail sobrescrito
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
$function$;
CREATE OR REPLACE FUNCTION public.create_staff_order(p_tab uuid, p_items jsonb, p_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- Assinatura (Fase 8): leitura/relatórios seguem liberados; criar pedido não.
  if not app_private.subscription_allows_orders(v_rid) then
    raise exception 'SUBSCRIPTION_INACTIVE: assinatura do restaurante inativa' using errcode = 'P0001';
  end if;

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
$function$;
