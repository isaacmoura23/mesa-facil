-- =============================================================================
-- 0138 · "Comanda completa" (documento de impressão ORDER_FULL)
-- =============================================================================
-- Documento para quem atende (balcão/entrega), no estilo do cupom de delivery: cliente, telefone, código de
-- acompanhamento, prazo esperado, hora do aceite, endereço, itens com preço, totais e PAGAMENTO REAL
-- (forma, valor, valor recebido e troco). A "Comanda de preparo" continua sem preços e sem dados pessoais.
-- Permissão: orders.view + print.request (como os outros) E payments.record (gerente e caixa), porque
-- mostra telefone e pagamentos. Nada é gravado além do print_job (requisição), como nos outros documentos.
-- =============================================================================
alter type public.print_document_type add value if not exists 'ORDER_FULL';

create or replace function app_private.local_ts(p_ts timestamptz, p_tz text)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_ts is null then
    return null;
  end if;
  begin
    return pg_catalog.to_char(p_ts at time zone p_tz, 'DD/MM/YYYY HH24:MI');
  exception when others then
    return pg_catalog.to_char(p_ts at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI');
  end;
end;
$$;
revoke all on function app_private.local_ts(timestamptz, text) from public, anon, authenticated;

create or replace function public.request_print(p_order uuid, p_document_type text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_type    public.print_document_type;
  v_o       public.orders%rowtype;
  v_rest    record;
  v_tab     text;
  v_local   text;
  v_payload jsonb;
  v_job     uuid;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;

  begin
    v_type := upper(btrim(coalesce(p_document_type, '')))::public.print_document_type;
  exception when others then
    v_type := null;
  end;
  if v_type is null or v_type::text not in ('KITCHEN_TICKET', 'ORDER_RECEIPT', 'ORDER_FULL') then
    raise exception 'INVALID_DOCUMENT_TYPE: tipo de documento inválido para pedido' using errcode = '22023';
  end if;

  select o.* into v_o from public.orders o where o.id = p_order;
  if not found or not public.has_permission(v_o.restaurant_id, 'orders.view') then
    raise exception 'ORDER_NOT_FOUND: pedido não encontrado' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_o.restaurant_id, 'print.request') then
    raise exception 'FORBIDDEN: requer permissão print.request' using errcode = '42501';
  end if;
  if v_type::text = 'ORDER_FULL' and not public.has_permission(v_o.restaurant_id, 'payments.record') then
    raise exception 'FORBIDDEN: a comanda completa requer permissão payments.record' using errcode = '42501';
  end if;

  select r.name, r.timezone into v_rest from public.restaurants r where r.id = v_o.restaurant_id;
  v_local := app_private.local_ts(v_o.created_at, v_rest.timezone);
  if v_o.tab_id is not null then
    select t.label into v_tab from public.tabs t where t.restaurant_id = v_o.restaurant_id and t.id = v_o.tab_id;
  end if;

  v_payload := jsonb_build_object(
    'document_type',    v_type,
    'restaurant_name',  v_rest.name,
    'order_number',     v_o.order_number,
    'fulfillment_type', v_o.fulfillment_type,
    'created_at',       v_o.created_at,
    'created_at_local', v_local,
    'timezone',         v_rest.timezone,
    'table_label',      v_o.table_label,
    'tab_label',        v_tab,
    'notes',            v_o.notes,
    'items',            app_private.order_items_json(v_o.restaurant_id, v_o.id, true));

  if v_type::text = 'KITCHEN_TICKET' then
    if v_o.fulfillment_type <> 'DINE_IN' and v_o.customer_name is not null then
      v_payload := v_payload || jsonb_build_object('customer_first_name', split_part(btrim(v_o.customer_name), ' ', 1));
    end if;
  else
    v_payload := v_payload || jsonb_build_object(
      'customer_name',      v_o.customer_name,
      'subtotal_cents',     v_o.subtotal_cents,
      'delivery_fee_cents', v_o.delivery_fee_cents,
      'discount_cents',     v_o.discount_cents,
      'total_cents',        v_o.total_cents,
      'payment_status',     v_o.payment_status,
      'payment_method',     v_o.payment_method_intent,
      'change_for_cents',   v_o.change_for_cents);
    if v_o.fulfillment_type = 'DELIVERY' then
      v_payload := v_payload || jsonb_build_object('delivery_address', v_o.delivery_address);
    end if;
    if v_type::text = 'ORDER_FULL' then
      v_payload := v_payload || jsonb_build_object(
        'customer_phone',           v_o.customer_phone,
        'public_code',              v_o.public_code,
        'estimated_ready_at_local', app_private.local_ts(v_o.estimated_ready_at, v_rest.timezone),
        'confirmed_at_local',       app_private.local_ts(v_o.confirmed_at, v_rest.timezone),
        'payments', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'method', p.method,
                   'amount_cents', p.amount_cents,
                   'tendered_cents', p.tendered_cents,
                   'change_cents', case when p.method = 'CASH' and p.tendered_cents is not null
                                        then greatest(p.tendered_cents - p.amount_cents, 0) end,
                   'paid_at_local', app_private.local_ts(p.paid_at, v_rest.timezone)) order by p.created_at, p.id)
            from public.payments p
           where p.restaurant_id = v_o.restaurant_id and p.order_id = v_o.id and p.status = 'PAID'), '[]'::jsonb));
    end if;
  end if;

  insert into public.print_jobs (restaurant_id, document_type, status, order_id, payload, requested_by)
  values (v_o.restaurant_id, v_type, 'REQUESTED', v_o.id, v_payload, v_uid)
  returning id into v_job;

  perform public.log_audit(v_o.restaurant_id, 'print.requested', 'print_job', v_job,
    jsonb_build_object('order_id', v_o.id, 'document_type', v_type));

  return jsonb_build_object('ok', true, 'job_id', v_job, 'status', 'REQUESTED', 'payload', v_payload);
end;
$$;

revoke all on function public.request_print(uuid, text) from public, anon, authenticated;
grant execute on function public.request_print(uuid, text) to authenticated;
