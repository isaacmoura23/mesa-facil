-- =============================================================================
-- DB-6 / 0119 — RPCs de comanda e pagamento manual (Fase 4).
--
--   public.open_tab(p_restaurant, p_table_id, p_label, p_guests)
--   public.create_staff_order(p_tab, p_items, p_notes)
--   public.get_tab_balance(p_tab)
--   public.record_payment(p_tab, p_order, p_method, p_amount_cents, p_tendered_cents, p_reference)
--   public.close_tab(p_tab, p_unpaid_reason)
--   public.cancel_tab(p_tab, p_reason)
--   app_private.require_perm / tab_totals / tab_balance_json / payment_json   (internos)
--
-- Todas: SECURITY DEFINER, search_path = '', EXECUTE só para authenticated
-- (REVOKE de PUBLIC/anon), auth.uid() + has_permission DENTRO da função.
-- O papel owner nunca opera (has_permission já o nega para permissões operacionais).
--
-- Erros = exceção "CODIGO: texto" (código estável no início da mensagem):
--   UNAUTHENTICATED (28000)   sem sessão
--   *_NOT_FOUND (P0002)       RESTAURANT_/TAB_/TABLE_/ORDER_NOT_FOUND: inexistente OU de restaurante
--                             do qual o chamador não é membro ativo (indistinguíveis)
--   FORBIDDEN (42501)         membro sem a permissão exigida (inclui owner em ações operacionais)
--   RESTAURANT_UNAVAILABLE    restaurante não está active
--   INVALID_LABEL / INVALID_GUESTS / LABEL_REQUIRED          (open_tab)
--   TABLE_INACTIVE / TABLE_HAS_OPEN_TAB / TABLE_NOT_AVAILABLE (open_tab; só AVAILABLE abre comanda)
--   TAB_NOT_OPEN              comanda não está OPEN (pedido/pagamento/cancelamento nela)
--   INVALID_NOTES             observação > 1000 caracteres ou com caractere de controle (create_staff_order)
--   INVALID_TARGET            record_payment: exatamente um entre p_tab e p_order
--   INVALID_METHOD / INVALID_AMOUNT / INVALID_TENDERED / INVALID_REFERENCE   (record_payment)
--   ORDER_NOT_PAYABLE         pedido cancelado/recusado
--   OVERPAYMENT               valor > saldo restante (DETAIL: remaining_cents=N)
--   IDEMPOTENCY_CONFLICT      mesma p_reference já usada com outro alvo/forma/valor
--   TAB_HAS_OPEN_ORDERS       close_tab: há pedido fora de COMPLETED/CANCELLED/REJECTED
--   TAB_UNPAID                close_tab: saldo restante > 0 sem justificativa
--   INVALID_UNPAID_REASON     close_tab: justificativa presente mas fora de 10..500 caracteres
--   REASON_REQUIRED           cancel_tab sem motivo
--   TAB_HAS_ORDERS / TAB_HAS_PAYMENTS   cancel_tab: comanda com consumo / pagamentos
--
-- Validação de carrinho (create_staff_order) NÃO é exceção: devolve
--   {ok:false, errors:[{code,item_index?,message}]} sem gravar (mesmos códigos de validate_cart).
--
-- Concorrência (lição F-05/F-06):
--   * record_payment e close_tab/cancel_tab travam a comanda com FOR NO KEY UPDATE;
--     create_staff_order e o trigger de pedido usam FOR SHARE => pagamento x fechamento x
--     novo pedido se serializam, sem ciclo (a FK de payments/orders segura só KEY SHARE,
--     compatível com NO KEY UPDATE). Ordem de locks sempre: comanda -> pedido.
--   * payments_sync_order (trigger) segue como autoridade de orders.payment_status; ele
--     trava o pedido com FOR NO KEY UPDATE, o mesmo nível que record_payment já segura.
--   * Duas aberturas na mesma mesa: o índice único parcial serializa; a perdedora recebe
--     TABLE_HAS_OPEN_TAB.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helpers internos
-- ---------------------------------------------------------------------------
create or replace function app_private.require_perm(p_rid uuid, p_perm text, p_nf text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  if p_rid is null or not public.is_member(p_rid) then
    raise exception '%: não encontrado', p_nf using errcode = 'P0002';
  end if;
  if not public.has_permission(p_rid, p_perm) then
    raise exception 'FORBIDDEN: requer permissão %', p_perm using errcode = '42501';
  end if;
end;
$$;

create or replace function app_private.tab_totals(p_rid uuid, p_tab uuid)
returns table (consumed_cents integer, paid_cents integer, open_orders integer)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((select sum(o.total_cents) from public.orders o
              where o.restaurant_id = p_rid and o.tab_id = p_tab
                and o.status not in ('CANCELLED', 'REJECTED')), 0)::integer,
    coalesce((select sum(p.amount_cents) from public.payments p
              where p.restaurant_id = p_rid and p.status = 'PAID'
                and (p.tab_id = p_tab
                     or p.order_id in (select o.id from public.orders o
                                       where o.restaurant_id = p_rid and o.tab_id = p_tab))), 0)::integer,
    (select count(*) from public.orders o
      where o.restaurant_id = p_rid and o.tab_id = p_tab
        and o.status not in ('COMPLETED', 'CANCELLED', 'REJECTED'))::integer;
$$;

create or replace function app_private.payment_json(p public.payments)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id',             p.id,
    'method',         p.method,
    'amount_cents',   p.amount_cents,
    'tendered_cents', p.tendered_cents,
    'change_cents',   case when p.tendered_cents is not null then p.tendered_cents - p.amount_cents end,
    'status',         p.status,
    'paid_at',        p.paid_at,
    'tab_id',         p.tab_id,
    'order_id',       p.order_id,
    'reference',      case when p.idempotency_key like 'MANUAL:%' then substr(p.idempotency_key, 8) end);
$$;

create or replace function app_private.tab_balance_json(p_rid uuid, p_tab uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t      record;
  v_tot    record;
  v_orders jsonb;
  v_pays   jsonb;
begin
  select tb.id, tb.table_id, rt.name as table_name, tb.label, tb.guests, tb.status,
         tb.opened_at, tb.closed_at, tb.total_cents, tb.unpaid_cents, tb.unpaid_reason
    into v_t
  from public.tabs tb
  left join public.restaurant_tables rt on rt.restaurant_id = tb.restaurant_id and rt.id = tb.table_id
  where tb.restaurant_id = p_rid and tb.id = p_tab;
  if not found then
    return null;
  end if;

  select * into v_tot from app_private.tab_totals(p_rid, p_tab);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', o.id, 'order_number', o.order_number, 'status', o.status,
           'payment_status', o.payment_status, 'total_cents', o.total_cents,
           'created_at', o.created_at,
           'counts_toward_total', o.status not in ('CANCELLED', 'REJECTED'))
         order by o.order_number), '[]'::jsonb)
    into v_orders
  from public.orders o where o.restaurant_id = p_rid and o.tab_id = p_tab;

  select coalesce(jsonb_agg(app_private.payment_json(p) order by p.paid_at, p.created_at, p.id), '[]'::jsonb)
    into v_pays
  from public.payments p
  where p.restaurant_id = p_rid
    and (p.tab_id = p_tab
         or p.order_id in (select o.id from public.orders o where o.restaurant_id = p_rid and o.tab_id = p_tab));

  return jsonb_build_object(
    'tab', jsonb_build_object(
      'id', v_t.id, 'table_id', v_t.table_id, 'table_name', v_t.table_name, 'label', v_t.label,
      'guests', v_t.guests, 'status', v_t.status, 'opened_at', v_t.opened_at, 'closed_at', v_t.closed_at,
      'total_cents', v_t.total_cents, 'unpaid_cents', v_t.unpaid_cents, 'unpaid_reason', v_t.unpaid_reason),
    'orders',            v_orders,
    'consumed_cents',    v_tot.consumed_cents,
    'paid_cents',        v_tot.paid_cents,
    'remaining_cents',   greatest(v_tot.consumed_cents - v_tot.paid_cents, 0),
    'overpaid_cents',    greatest(v_tot.paid_cents - v_tot.consumed_cents, 0),
    'open_orders_count', v_tot.open_orders,
    'payments',          v_pays);
end;
$$;

revoke all on function app_private.require_perm(uuid, text, text)     from public, anon, authenticated;
revoke all on function app_private.tab_totals(uuid, uuid)             from public, anon, authenticated;
revoke all on function app_private.payment_json(public.payments)      from public, anon, authenticated;
revoke all on function app_private.tab_balance_json(uuid, uuid)       from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- open_tab
-- ---------------------------------------------------------------------------
create or replace function public.open_tab(
  p_restaurant uuid,
  p_table_id   uuid default null,
  p_label      text default null,
  p_guests     integer default null
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
  v_single  boolean;
  v_label   text;
  v_table   record;
  v_tname   text;
  v_after   public.table_status;
  v_tab     public.tabs%rowtype;
  v_constr  text;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  perform app_private.require_perm(p_restaurant, 'tabs.manage', 'RESTAURANT_NOT_FOUND');

  select r.status into v_rstatus from public.restaurants r where r.id = p_restaurant;
  if v_rstatus is distinct from 'active' then
    raise exception 'RESTAURANT_UNAVAILABLE: restaurante indisponível' using errcode = 'P0001';
  end if;

  v_label := nullif(btrim(coalesce(p_label, '')), '');
  if v_label is not null and (char_length(v_label) > 80 or v_label ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]') then
    raise exception 'INVALID_LABEL: identificação inválida (máx. 80 caracteres)' using errcode = '22023';
  end if;
  if p_guests is not null and (p_guests < 1 or p_guests > 999) then
    raise exception 'INVALID_GUESTS: número de pessoas inválido' using errcode = '22023';
  end if;
  if p_table_id is null and v_label is null then
    raise exception 'LABEL_REQUIRED: comanda de balcão exige uma identificação' using errcode = '22023';
  end if;

  if p_table_id is not null then
    select t.id, t.name, t.status into v_table
    from public.restaurant_tables t
    where t.id = p_table_id and t.restaurant_id = p_restaurant;
    if not found then
      raise exception 'TABLE_NOT_FOUND: mesa não encontrada' using errcode = 'P0002';
    end if;
    v_tname := v_table.name;
    select coalesce(s.single_tab_per_table, true) into v_single
    from public.restaurant_settings s where s.restaurant_id = p_restaurant;
    v_single := coalesce(v_single, true);

    if v_table.status = 'INACTIVE' then
      raise exception 'TABLE_INACTIVE: mesa desativada' using errcode = 'P0001';
    elsif v_table.status = 'OCCUPIED' and v_single then
      raise exception 'TABLE_HAS_OPEN_TAB: a mesa já tem uma comanda aberta' using errcode = 'P0001';
    elsif v_table.status = 'CLEANING' then
      raise exception 'TABLE_NOT_AVAILABLE: a mesa está em limpeza' using errcode = 'P0001';
    end if;
  end if;

  begin
    insert into public.tabs (restaurant_id, table_id, label, guests, opened_by)
    values (p_restaurant, p_table_id, v_label, p_guests, v_uid)
    returning * into v_tab;
  exception when unique_violation then
    get stacked diagnostics v_constr = constraint_name;
    if v_constr is distinct from 'tabs_one_open_per_table_uidx' then
      raise;
    end if;
    raise exception 'TABLE_HAS_OPEN_TAB: a mesa já tem uma comanda aberta' using errcode = 'P0001';
  end;

  -- A mesa pode ter sido desativada em paralelo (a FK esperou o lock dela): relê.
  if p_table_id is not null then
    select t.status into v_after from public.restaurant_tables t where t.id = p_table_id;
    if v_after = 'INACTIVE' then
      raise exception 'TABLE_INACTIVE: mesa desativada' using errcode = 'P0001';
    end if;
  end if;

  perform public.log_audit(p_restaurant, 'tab.opened', 'tab', v_tab.id,
    jsonb_build_object('table_id', p_table_id, 'label', v_label, 'guests', p_guests));

  return jsonb_build_object('ok', true, 'tab', jsonb_build_object(
    'id', v_tab.id, 'restaurant_id', v_tab.restaurant_id, 'table_id', v_tab.table_id,
    'table_name', v_tname, 'label', v_tab.label, 'guests', v_tab.guests,
    'status', v_tab.status, 'opened_at', v_tab.opened_at, 'opened_by', v_tab.opened_by));
end;
$$;

-- ---------------------------------------------------------------------------
-- create_staff_order
-- ---------------------------------------------------------------------------
create or replace function public.create_staff_order(
  p_tab   uuid,
  p_items jsonb,
  p_notes text default null
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
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;

  select tb.restaurant_id into v_rid from public.tabs tb where tb.id = p_tab;
  perform app_private.require_perm(v_rid, 'orders.create', 'TAB_NOT_FOUND');
  perform app_private.require_perm(v_rid, 'tabs.manage',   'TAB_NOT_FOUND');

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
    notes, created_by, confirmed_at, estimated_ready_at)
  values (
    v_rid, public.next_order_number(v_rid), 'STAFF', 'DINE_IN', 'CONFIRMED', 'UNPAID',
    v_tab.table_id, coalesce(v_tname, v_tab.label), v_tab.id,
    (v_price ->> 'subtotal_cents')::integer, 0, 0, (v_price ->> 'total_cents')::integer,
    v_notes, v_uid, now(), now() + make_interval(mins => coalesce(v_prep, 30)))
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
    'ok', true,
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

-- ---------------------------------------------------------------------------
-- get_tab_balance
-- ---------------------------------------------------------------------------
create or replace function public.get_tab_balance(p_tab uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  select tb.restaurant_id into v_rid from public.tabs tb where tb.id = p_tab;
  perform app_private.require_perm(v_rid, 'tabs.view', 'TAB_NOT_FOUND');
  return app_private.tab_balance_json(v_rid, p_tab);
end;
$$;

-- ---------------------------------------------------------------------------
-- record_payment
-- ---------------------------------------------------------------------------
create or replace function public.record_payment(
  p_tab            uuid default null,
  p_order          uuid default null,
  p_method         text default null,
  p_amount_cents   integer default null,
  p_tendered_cents integer default null,
  p_reference      text default null
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
  v_tab_id  uuid;
  v_ord     public.orders%rowtype;
  v_tabrow  public.tabs%rowtype;
  v_method  public.payment_method;
  v_ref     text;
  v_key     text;
  v_pay     public.payments%rowtype;
  v_tot     record;
  v_rem     integer;
  v_ord_paid integer;
  v_ord_rem  integer;
  v_replay  boolean := false;
  v_constr  text;
  v_out     jsonb;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  if (p_tab is null) = (p_order is null) then
    raise exception 'INVALID_TARGET: informe exatamente uma comanda OU um pedido' using errcode = '22023';
  end if;

  -- Resolve restaurante/comanda (sem lock) e confere permissão.
  if p_tab is not null then
    select tb.restaurant_id into v_rid from public.tabs tb where tb.id = p_tab;
    perform app_private.require_perm(v_rid, 'payments.record', 'TAB_NOT_FOUND');
    v_tab_id := p_tab;
  else
    select o.restaurant_id, o.tab_id into v_rid, v_tab_id from public.orders o where o.id = p_order;
    perform app_private.require_perm(v_rid, 'payments.record', 'ORDER_NOT_FOUND');
  end if;

  -- Validação dos parâmetros (antes de travar qualquer coisa).
  begin
    v_method := upper(btrim(coalesce(p_method, '')))::public.payment_method;
  exception when others then
    v_method := null;
  end;
  if v_method is null then
    raise exception 'INVALID_METHOD: forma de pagamento inválida (CASH, PIX, CREDIT, DEBIT, VOUCHER, OTHER)' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'INVALID_AMOUNT: o valor deve ser maior que zero' using errcode = '22023';
  end if;
  if p_tendered_cents is not null and (v_method <> 'CASH' or p_tendered_cents < p_amount_cents) then
    raise exception 'INVALID_TENDERED: valor entregue só se aplica a dinheiro e deve cobrir o valor pago' using errcode = '22023';
  end if;
  v_ref := nullif(btrim(coalesce(p_reference, '')), '');
  if v_ref is not null and (char_length(v_ref) > 150 or v_ref ~ '[\x01-\x1f\x7f]') then
    raise exception 'INVALID_REFERENCE: referência inválida (máx. 150 caracteres)' using errcode = '22023';
  end if;
  v_key := case when v_ref is not null then 'MANUAL:' || v_ref end;

  -- Locks: comanda (NO KEY UPDATE) -> pedido (NO KEY UPDATE). Mesma ordem em close_tab.
  if v_tab_id is not null then
    select tb.* into v_tabrow from public.tabs tb
    where tb.id = v_tab_id and tb.restaurant_id = v_rid for no key update;
  end if;
  if p_order is not null then
    select o.* into v_ord from public.orders o
    where o.id = p_order and o.restaurant_id = v_rid for no key update;
  end if;

  -- Idempotência por (restaurante, MANUAL, referência): antes das checagens de estado/saldo,
  -- para a repetição devolver o mesmo pagamento mesmo se a comanda já fechou ou o saldo zerou.
  if v_key is not null then
    select p.* into v_pay from public.payments p
    where p.restaurant_id = v_rid and p.idempotency_key = v_key;
    if found then
      if v_pay.order_id is distinct from p_order or v_pay.method <> v_method
         or v_pay.amount_cents <> p_amount_cents
         or (p_tab is not null and v_pay.tab_id is distinct from p_tab) then
        raise exception 'IDEMPOTENCY_CONFLICT: a referência já foi usada em outro pagamento' using errcode = 'P0001';
      end if;
      v_replay := true;
    end if;
  end if;

  if not v_replay then
    if v_tab_id is not null and v_tabrow.status is distinct from 'OPEN' then
      raise exception 'TAB_NOT_OPEN: a comanda não está aberta' using errcode = 'P0001';
    end if;
    if p_order is not null and v_ord.status in ('CANCELLED', 'REJECTED') then
      raise exception 'ORDER_NOT_PAYABLE: pedido cancelado ou recusado' using errcode = 'P0001';
    end if;

    -- Saldo restante (alvo): o valor nunca passa dele.
    if p_order is not null then
      select coalesce(sum(p.amount_cents), 0)::integer into v_ord_paid
      from public.payments p
      where p.restaurant_id = v_rid and p.order_id = p_order and p.status = 'PAID';
      v_rem := greatest(v_ord.total_cents - v_ord_paid, 0);
    end if;
    if v_tab_id is not null then
      select * into v_tot from app_private.tab_totals(v_rid, v_tab_id);
      v_rem := case when v_rem is null then greatest(v_tot.consumed_cents - v_tot.paid_cents, 0)
                    else least(v_rem, greatest(v_tot.consumed_cents - v_tot.paid_cents, 0)) end;
    end if;
    if p_amount_cents > v_rem then
      raise exception 'OVERPAYMENT: o valor excede o saldo restante' using errcode = 'P0001',
        detail = 'remaining_cents=' || v_rem;
    end if;

    begin
      insert into public.payments (
        restaurant_id, order_id, tab_id, method, amount_cents, status, provider,
        idempotency_key, tendered_cents, recorded_by, paid_at)
      values (
        v_rid, p_order, v_tab_id, v_method, p_amount_cents, 'PAID', 'MANUAL',
        v_key, p_tendered_cents, v_uid, now())
      returning * into v_pay;
    exception when unique_violation then
      get stacked diagnostics v_constr = constraint_name;
      if v_key is null or v_constr is distinct from 'payments_restaurant_id_idempotency_key_key' then
        raise;
      end if;
      -- Corrida com a mesma referência em outro alvo/comanda: repete a leitura.
      select p.* into v_pay from public.payments p
      where p.restaurant_id = v_rid and p.idempotency_key = v_key;
      if not found or v_pay.order_id is distinct from p_order or v_pay.method <> v_method
         or v_pay.amount_cents <> p_amount_cents
         or (p_tab is not null and v_pay.tab_id is distinct from p_tab) then
        raise exception 'IDEMPOTENCY_CONFLICT: a referência já foi usada em outro pagamento' using errcode = 'P0001';
      end if;
      v_replay := true;
    end;

    if not v_replay then
      perform public.log_audit(v_rid, 'payment.recorded', 'payment', v_pay.id,
        jsonb_build_object('tab_id', v_tab_id, 'order_id', p_order, 'method', v_method,
                           'amount_cents', p_amount_cents, 'tendered_cents', p_tendered_cents));
    end if;
  end if;

  v_out := jsonb_build_object(
    'ok', true,
    'idempotent_replay', v_replay,
    'payment', app_private.payment_json(v_pay));

  if v_pay.tab_id is not null then
    select * into v_tot from app_private.tab_totals(v_rid, v_pay.tab_id);
    v_out := v_out || jsonb_build_object('balance', jsonb_build_object(
      'tab_id', v_pay.tab_id,
      'consumed_cents', v_tot.consumed_cents, 'paid_cents', v_tot.paid_cents,
      'remaining_cents', greatest(v_tot.consumed_cents - v_tot.paid_cents, 0)));
  end if;
  if v_pay.order_id is not null then
    select o.* into v_ord from public.orders o where o.id = v_pay.order_id;
    select coalesce(sum(p.amount_cents), 0)::integer into v_ord_paid
    from public.payments p
    where p.restaurant_id = v_rid and p.order_id = v_ord.id and p.status = 'PAID';
    v_out := v_out || jsonb_build_object('order', jsonb_build_object(
      'id', v_ord.id, 'order_number', v_ord.order_number, 'total_cents', v_ord.total_cents,
      'paid_cents', v_ord_paid, 'remaining_cents', greatest(v_ord.total_cents - v_ord_paid, 0),
      'payment_status', v_ord.payment_status));
  end if;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- close_tab
-- ---------------------------------------------------------------------------
create or replace function public.close_tab(p_tab uuid, p_unpaid_reason text default null)
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
  v_reason  text;
  v_tot     record;
  v_unpaid  integer;
  v_tstatus public.table_status;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  select tb.restaurant_id into v_rid from public.tabs tb where tb.id = p_tab;
  perform app_private.require_perm(v_rid, 'tabs.manage', 'TAB_NOT_FOUND');

  v_reason := nullif(btrim(coalesce(p_unpaid_reason, '')), '');
  if v_reason is not null and (char_length(v_reason) < 10 or char_length(v_reason) > 500) then
    raise exception 'INVALID_UNPAID_REASON: a justificativa deve ter de 10 a 500 caracteres' using errcode = '22023';
  end if;

  select tb.* into v_tab from public.tabs tb
  where tb.id = p_tab and tb.restaurant_id = v_rid for no key update;

  if v_tab.status = 'CLOSED' then      -- idempotente
    return jsonb_build_object('ok', true, 'unchanged', true, 'unpaid_cents', v_tab.unpaid_cents,
                              'balance', app_private.tab_balance_json(v_rid, p_tab));
  end if;
  if v_tab.status <> 'OPEN' then
    raise exception 'TAB_NOT_OPEN: a comanda não está aberta' using errcode = 'P0001';
  end if;

  select * into v_tot from app_private.tab_totals(v_rid, p_tab);
  if v_tot.open_orders > 0 then
    raise exception 'TAB_HAS_OPEN_ORDERS: há % pedido(s) ainda em andamento', v_tot.open_orders using errcode = 'P0001';
  end if;

  v_unpaid := greatest(v_tot.consumed_cents - v_tot.paid_cents, 0);
  if v_unpaid > 0 then
    if v_reason is null then
      raise exception 'TAB_UNPAID: saldo em aberto; registre o pagamento ou informe a justificativa' using errcode = 'P0001',
        detail = 'remaining_cents=' || v_unpaid;
    end if;
    if not public.has_permission(v_rid, 'payments.record') then
      raise exception 'FORBIDDEN: fechar com saldo em aberto requer permissão payments.record' using errcode = '42501';
    end if;
  else
    v_reason := null;      -- sem saldo: a justificativa não se aplica
  end if;

  update public.tabs
     set status = 'CLOSED', unpaid_cents = v_unpaid, unpaid_reason = v_reason
   where id = p_tab and restaurant_id = v_rid
  returning * into v_tab;

  if v_tab.table_id is not null then
    select t.status into v_tstatus from public.restaurant_tables t where t.id = v_tab.table_id;
  end if;

  perform public.log_audit(v_rid, case when v_unpaid > 0 then 'tab.closed_unpaid' else 'tab.closed' end, 'tab', p_tab,
    jsonb_build_object('consumed_cents', v_tot.consumed_cents, 'paid_cents', v_tot.paid_cents,
                       'unpaid_cents', v_unpaid, 'unpaid_reason', v_reason, 'table_id', v_tab.table_id));

  return jsonb_build_object('ok', true, 'unchanged', false, 'unpaid_cents', v_unpaid,
                            'table_status', v_tstatus,
                            'balance', app_private.tab_balance_json(v_rid, p_tab));
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_tab
-- ---------------------------------------------------------------------------
create or replace function public.cancel_tab(p_tab uuid, p_reason text)
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
  v_reason  text;
  v_tstatus public.table_status;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  select tb.restaurant_id into v_rid from public.tabs tb where tb.id = p_tab;
  perform app_private.require_perm(v_rid, 'tabs.manage', 'TAB_NOT_FOUND');

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null or char_length(v_reason) > 500 then
    raise exception 'REASON_REQUIRED: informe o motivo do cancelamento (até 500 caracteres)' using errcode = 'P0001';
  end if;

  select tb.* into v_tab from public.tabs tb
  where tb.id = p_tab and tb.restaurant_id = v_rid for no key update;

  if v_tab.status = 'CANCELLED' then   -- idempotente
    return jsonb_build_object('ok', true, 'unchanged', true, 'tab_id', p_tab, 'status', 'CANCELLED');
  end if;
  if v_tab.status <> 'OPEN' then
    raise exception 'TAB_NOT_OPEN: a comanda não está aberta' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.orders o
             where o.restaurant_id = v_rid and o.tab_id = p_tab and o.status not in ('CANCELLED', 'REJECTED')) then
    raise exception 'TAB_HAS_ORDERS: a comanda tem pedidos; cancele-os ou feche a comanda' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.payments p
             where p.restaurant_id = v_rid
               and (p.tab_id = p_tab
                    or p.order_id in (select o.id from public.orders o where o.restaurant_id = v_rid and o.tab_id = p_tab))) then
    raise exception 'TAB_HAS_PAYMENTS: a comanda tem pagamentos registrados; feche a comanda' using errcode = 'P0001';
  end if;

  update public.tabs set status = 'CANCELLED', status_reason = v_reason
   where id = p_tab and restaurant_id = v_rid
  returning * into v_tab;

  -- O trigger da comanda leva a mesa a CLEANING; sem consumo não há o que limpar => AVAILABLE.
  if v_tab.table_id is not null then
    perform set_config('mesa.sync', 'tab', true);
    update public.restaurant_tables
       set status = 'AVAILABLE'
     where id = v_tab.table_id and restaurant_id = v_rid and status = 'CLEANING'
       and not exists (select 1 from public.tabs t2
                       where t2.restaurant_id = v_rid and t2.table_id = v_tab.table_id and t2.status = 'OPEN');
    perform set_config('mesa.sync', '', true);
    select t.status into v_tstatus from public.restaurant_tables t where t.id = v_tab.table_id;
  end if;

  perform public.log_audit(v_rid, 'tab.cancelled', 'tab', p_tab,
    jsonb_build_object('reason', v_reason, 'table_id', v_tab.table_id));

  return jsonb_build_object('ok', true, 'unchanged', false, 'tab_id', p_tab, 'status', v_tab.status,
                            'table_id', v_tab.table_id, 'table_status', v_tstatus);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
revoke all on function public.open_tab(uuid, uuid, text, integer)                         from public, anon, authenticated;
revoke all on function public.create_staff_order(uuid, jsonb, text)                       from public, anon, authenticated;
revoke all on function public.get_tab_balance(uuid)                                       from public, anon, authenticated;
revoke all on function public.record_payment(uuid, uuid, text, integer, integer, text)    from public, anon, authenticated;
revoke all on function public.close_tab(uuid, text)                                       from public, anon, authenticated;
revoke all on function public.cancel_tab(uuid, text)                                      from public, anon, authenticated;
grant execute on function public.open_tab(uuid, uuid, text, integer)                      to authenticated;
grant execute on function public.create_staff_order(uuid, jsonb, text)                    to authenticated;
grant execute on function public.get_tab_balance(uuid)                                    to authenticated;
grant execute on function public.record_payment(uuid, uuid, text, integer, integer, text) to authenticated;
grant execute on function public.close_tab(uuid, text)                                    to authenticated;
grant execute on function public.cancel_tab(uuid, text)                                   to authenticated;
