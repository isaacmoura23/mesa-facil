-- =============================================================================
-- DB-6 / 0120 — Mesas e impressão de conta (Fase 4).
--
--   public.set_table_status(p_table, p_to)            tables.operate | tables.manage
--   public.rotate_table_qr(p_table)                   tables.manage
--   public.request_tab_print(p_tab, p_document_type)  tabs.view + print.request
--
-- set_table_status (p_to = AVAILABLE | INACTIVE; OCCUPIED/CLEANING vêm só da comanda):
--   CLEANING -> AVAILABLE e OCCUPIED(sem comanda aberta) -> AVAILABLE : tables.operate
--   AVAILABLE|CLEANING -> INACTIVE e INACTIVE -> AVAILABLE            : tables.manage (F-12)
--   nunca com comanda aberta. Repetir o estado atual => {unchanged:true}.
-- rotate_table_qr: gera novo qr_token no servidor (128 bits) e o devolve; o token nunca
--   entra em audit_logs.
-- request_tab_print: PARTIAL_BILL (comanda OPEN) | FINAL_BILL (OPEN ou CLOSED); CANCELLED =>
--   TAB_NOT_BILLABLE. Payload montado no servidor SEM dados de cliente (sem telefone/e-mail/
--   nome de cliente de pedido); só consumo consolidado, pagamentos (forma/valor/troco) e saldo.
--   `tab.label` é a identificação digitada pela equipe (ex.: "Balcão João").
--
-- Erros: UNAUTHENTICATED, TABLE_NOT_FOUND / TAB_NOT_FOUND (inexistente ou outro restaurante),
--   FORBIDDEN, INVALID_TABLE_STATUS (p_to inválido), TABLE_INVALID_TRANSITION,
--   TABLE_HAS_OPEN_TAB, INVALID_DOCUMENT_TYPE, TAB_NOT_BILLABLE, TAB_NOT_OPEN (PARTIAL em comanda fechada).
-- =============================================================================

create or replace function public.set_table_status(p_table uuid, p_to text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_rid  uuid;
  v_to   public.table_status;
  v_t    public.restaurant_tables%rowtype;
  v_perm text;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  select t.restaurant_id into v_rid from public.restaurant_tables t where t.id = p_table;
  if v_rid is null or not public.is_member(v_rid) then
    raise exception 'TABLE_NOT_FOUND: mesa não encontrada' using errcode = 'P0002';
  end if;

  begin
    v_to := upper(btrim(coalesce(p_to, '')))::public.table_status;
  exception when others then
    v_to := null;
  end;
  if v_to is null or v_to not in ('AVAILABLE', 'INACTIVE') then
    raise exception 'INVALID_TABLE_STATUS: use AVAILABLE ou INACTIVE' using errcode = '22023';
  end if;

  select t.* into v_t from public.restaurant_tables t where t.id = p_table and t.restaurant_id = v_rid for update;

  if v_t.status = v_to then
    return jsonb_build_object('ok', true, 'unchanged', true, 'table', jsonb_build_object(
      'id', v_t.id, 'name', v_t.name, 'status', v_t.status));
  end if;

  v_perm := case when 'INACTIVE' in (v_t.status::text, v_to::text) then 'tables.manage' else 'tables.operate' end;
  if not public.has_permission(v_rid, v_perm) then
    raise exception 'FORBIDDEN: requer permissão %', v_perm using errcode = '42501';
  end if;

  if (v_t.status::text, v_to::text) not in
     (('CLEANING', 'AVAILABLE'), ('OCCUPIED', 'AVAILABLE'), ('AVAILABLE', 'INACTIVE'),
      ('CLEANING', 'INACTIVE'), ('INACTIVE', 'AVAILABLE')) then
    raise exception 'TABLE_INVALID_TRANSITION: % -> % não é permitido', v_t.status, v_to using errcode = 'P0001';
  end if;
  if exists (select 1 from public.tabs tb
             where tb.restaurant_id = v_rid and tb.table_id = p_table and tb.status = 'OPEN') then
    raise exception 'TABLE_HAS_OPEN_TAB: feche ou cancele a comanda antes' using errcode = 'P0001';
  end if;

  update public.restaurant_tables set status = v_to where id = p_table and restaurant_id = v_rid
  returning * into v_t;

  perform public.log_audit(v_rid, 'table.status_changed', 'restaurant_table', p_table,
    jsonb_build_object('to', v_to));

  return jsonb_build_object('ok', true, 'unchanged', false, 'table', jsonb_build_object(
    'id', v_t.id, 'name', v_t.name, 'status', v_t.status));
end;
$$;

create or replace function public.rotate_table_qr(p_table uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rid   uuid;
  v_token text;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  select t.restaurant_id into v_rid from public.restaurant_tables t where t.id = p_table;
  perform app_private.require_perm(v_rid, 'tables.manage', 'TABLE_NOT_FOUND');

  v_token := public.generate_public_code(16);
  update public.restaurant_tables set qr_token = v_token where id = p_table and restaurant_id = v_rid;

  perform public.log_audit(v_rid, 'table.qr_rotated', 'restaurant_table', p_table, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'table_id', p_table, 'qr_token', v_token);
end;
$$;

create or replace function public.request_tab_print(p_tab uuid, p_document_type text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_rid     uuid;
  v_type    public.print_document_type;
  v_tab     record;
  v_rest    record;
  v_tot     record;
  v_tz      text;
  v_orders  jsonb;
  v_items   jsonb;
  v_pays    jsonb;
  v_payload jsonb;
  v_job     uuid;

begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  select tb.restaurant_id into v_rid from public.tabs tb where tb.id = p_tab;
  if v_rid is null or not public.is_member(v_rid) or not public.has_permission(v_rid, 'tabs.view') then
    raise exception 'TAB_NOT_FOUND: comanda não encontrada' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_rid, 'print.request') then
    raise exception 'FORBIDDEN: requer permissão print.request' using errcode = '42501';
  end if;

  begin
    v_type := upper(btrim(coalesce(p_document_type, '')))::public.print_document_type;
  exception when others then
    v_type := null;
  end;
  if v_type is null or v_type not in ('PARTIAL_BILL', 'FINAL_BILL') then
    raise exception 'INVALID_DOCUMENT_TYPE: tipo de documento inválido para comanda' using errcode = '22023';
  end if;

  select tb.id, tb.status, tb.label, tb.guests, tb.opened_at, tb.closed_at, tb.total_cents,
         tb.unpaid_cents, rt.name as table_name
    into v_tab
  from public.tabs tb
  left join public.restaurant_tables rt on rt.restaurant_id = tb.restaurant_id and rt.id = tb.table_id
  where tb.id = p_tab and tb.restaurant_id = v_rid;

  if v_tab.status = 'CANCELLED' then
    raise exception 'TAB_NOT_BILLABLE: comanda cancelada não gera conta' using errcode = 'P0001';
  end if;
  if v_type = 'PARTIAL_BILL' and v_tab.status <> 'OPEN' then
    raise exception 'TAB_NOT_OPEN: conta parcial só para comanda aberta' using errcode = 'P0001';
  end if;

  select r.name, r.timezone into v_rest from public.restaurants r where r.id = v_rid;
  v_tz := coalesce(v_rest.timezone, 'America/Sao_Paulo');
  begin
    perform now() at time zone v_tz;
  exception when others then
    v_tz := 'America/Sao_Paulo';
  end;

  select * into v_tot from app_private.tab_totals(v_rid, p_tab);

  -- Pedidos que contam (sem cancelados/recusados), com itens (sem observações internas).
  select coalesce(jsonb_agg(jsonb_build_object(
           'order_number', o.order_number, 'status', o.status, 'total_cents', o.total_cents,
           'created_at_local', to_char(o.created_at at time zone v_tz, 'DD/MM/YYYY HH24:MI'),
           'items', app_private.order_items_json(o.restaurant_id, o.id, false))
         order by o.order_number), '[]'::jsonb)
    into v_orders
  from public.orders o
  where o.restaurant_id = v_rid and o.tab_id = p_tab and o.status not in ('CANCELLED', 'REJECTED');

  -- Itens consolidados (mesmo produto/variante/adicionais/preço somam quantidade).
  select coalesce(jsonb_agg(g.k || jsonb_build_object('quantity', g.qty, 'line_total_cents', g.total)
                            order by g.k ->> 'name', g.k ->> 'variant_name'), '[]'::jsonb)
    into v_items
  from (
    select (e.value - 'quantity' - 'line_total_cents' - 'notes') as k,
           sum((e.value ->> 'quantity')::integer) as qty,
           sum((e.value ->> 'line_total_cents')::integer) as total
    from jsonb_array_elements(v_orders) as ord(value),
         jsonb_array_elements(ord.value -> 'items') as e(value)
    group by 1
  ) g;

  select coalesce(jsonb_agg(jsonb_build_object(
           'method', p.method, 'amount_cents', p.amount_cents,
           'tendered_cents', p.tendered_cents,
           'change_cents', case when p.tendered_cents is not null then p.tendered_cents - p.amount_cents end,
           'paid_at_local', to_char(p.paid_at at time zone v_tz, 'DD/MM/YYYY HH24:MI'))
         order by p.paid_at, p.created_at, p.id), '[]'::jsonb)
    into v_pays
  from public.payments p
  where p.restaurant_id = v_rid and p.status = 'PAID'
    and (p.tab_id = p_tab
         or p.order_id in (select o.id from public.orders o where o.restaurant_id = v_rid and o.tab_id = p_tab));

  v_payload := jsonb_build_object(
    'document_type',    v_type,
    'restaurant_name',  v_rest.name,
    'timezone',         v_tz,
    'printed_at_local', to_char(now() at time zone v_tz, 'DD/MM/YYYY HH24:MI'),
    'tab', jsonb_build_object(
      'status', v_tab.status, 'label', v_tab.label, 'table_name', v_tab.table_name, 'guests', v_tab.guests,
      'opened_at_local', to_char(v_tab.opened_at at time zone v_tz, 'DD/MM/YYYY HH24:MI'),
      'closed_at_local', case when v_tab.closed_at is not null
                              then to_char(v_tab.closed_at at time zone v_tz, 'DD/MM/YYYY HH24:MI') end),
    'orders',           v_orders,
    'items',            v_items,
    'subtotal_cents',   v_tot.consumed_cents,
    'payments',         v_pays,
    'paid_cents',       v_tot.paid_cents,
    'remaining_cents',  greatest(v_tot.consumed_cents - v_tot.paid_cents, 0));
  if v_tab.status = 'CLOSED' then
    v_payload := v_payload || jsonb_build_object('total_cents', v_tab.total_cents, 'unpaid_cents', v_tab.unpaid_cents);
  end if;

  insert into public.print_jobs (restaurant_id, document_type, status, tab_id, payload, requested_by)
  values (v_rid, v_type, 'REQUESTED', p_tab, v_payload, v_uid)
  returning id into v_job;

  perform public.log_audit(v_rid, 'print.requested', 'print_job', v_job,
    jsonb_build_object('tab_id', p_tab, 'document_type', v_type));

  return jsonb_build_object('ok', true, 'job_id', v_job, 'status', 'REQUESTED', 'payload', v_payload);
end;
$$;

revoke all on function public.set_table_status(uuid, text)         from public, anon, authenticated;
revoke all on function public.rotate_table_qr(uuid)                from public, anon, authenticated;
revoke all on function public.request_tab_print(uuid, text)        from public, anon, authenticated;
grant execute on function public.set_table_status(uuid, text)      to authenticated;
grant execute on function public.rotate_table_qr(uuid)             to authenticated;
grant execute on function public.request_tab_print(uuid, text)     to authenticated;
