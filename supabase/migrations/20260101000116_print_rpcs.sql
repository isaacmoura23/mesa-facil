-- =============================================================================
-- DB-5 / 0116 — Impressão pelo servidor (achado F-08).
--
--   public.request_print(p_order, p_document_type)   authenticated
--   public.mark_print_job(p_job, p_status)           authenticated
--
-- F-08: o INSERT direto em print_jobs por clientes é REMOVIDO (policy e grant).
-- print_jobs passa a ser escrita só por estas RPCs (e service_role); o payload é
-- montado no servidor a partir do pedido, nunca vindo do cliente. SELECT segue
-- como antes (orders.view / print.request).
--
-- request_print: exige orders.view (leitura do pedido) E print.request.
--   Documentos aceitos para pedido: KITCHEN_TICKET, ORDER_RECEIPT
--   (PARTIAL_BILL/FINAL_BILL pertencem a comanda, fora desta RPC).
--   Payload sem dados desnecessários do cliente:
--     KITCHEN_TICKET: só o primeiro nome (retirada/entrega); sem telefone/endereço.
--     ORDER_RECEIPT: nome, totais, forma de pagamento/troco e, em DELIVERY, o
--     endereço de entrega; telefone e e-mail NUNCA entram.
--
-- mark_print_job: somente o solicitante (requested_by = auth.uid(), ainda com
--   print.request) e somente para DISPATCHED (diálogo de impressão aberto) ou
--   FAILED. PRINTED nunca é definido por cliente. REQUESTED->DISPATCHED|FAILED,
--   DISPATCHED->FAILED; repetir o estado atual é idempotente (unchanged:true).
--
-- Erros (exceções; código = prefixo da mensagem):
--   UNAUTHENTICATED (28000), ORDER_NOT_FOUND (P0002; inexistente ou sem
--   orders.view), FORBIDDEN (42501; sem print.request), INVALID_DOCUMENT_TYPE
--   (22023), PRINT_JOB_NOT_FOUND (P0002; inexistente ou de outro usuário),
--   INVALID_PRINT_STATUS (22023; fora de DISPATCHED/FAILED), PRINT_INVALID_TRANSITION (P0001).
-- =============================================================================

-- F-08 · clientes não escrevem mais em print_jobs.
drop policy if exists print_jobs_insert on public.print_jobs;
revoke insert on public.print_jobs from authenticated;

-- ---------------------------------------------------------------------------
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
  if v_type is null or v_type not in ('KITCHEN_TICKET', 'ORDER_RECEIPT') then
    raise exception 'INVALID_DOCUMENT_TYPE: tipo de documento inválido para pedido' using errcode = '22023';
  end if;

  select o.* into v_o from public.orders o where o.id = p_order;
  if not found or not public.has_permission(v_o.restaurant_id, 'orders.view') then
    raise exception 'ORDER_NOT_FOUND: pedido não encontrado' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_o.restaurant_id, 'print.request') then
    raise exception 'FORBIDDEN: requer permissão print.request' using errcode = '42501';
  end if;

  select r.name, r.timezone into v_rest from public.restaurants r where r.id = v_o.restaurant_id;
  begin
    v_local := to_char(v_o.created_at at time zone v_rest.timezone, 'DD/MM/YYYY HH24:MI');
  exception when others then
    v_local := to_char(v_o.created_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI');
  end;
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

  if v_type = 'KITCHEN_TICKET' then
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
  end if;

  insert into public.print_jobs (restaurant_id, document_type, status, order_id, payload, requested_by)
  values (v_o.restaurant_id, v_type, 'REQUESTED', v_o.id, v_payload, v_uid)
  returning id into v_job;

  perform public.log_audit(v_o.restaurant_id, 'print.requested', 'print_job', v_job,
    jsonb_build_object('order_id', v_o.id, 'document_type', v_type));

  return jsonb_build_object('ok', true, 'job_id', v_job, 'status', 'REQUESTED', 'payload', v_payload);
end;
$$;

-- ---------------------------------------------------------------------------
create or replace function public.mark_print_job(p_job uuid, p_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_to  public.print_job_status;
  v_j   public.print_jobs%rowtype;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;

  begin
    v_to := upper(btrim(coalesce(p_status, '')))::public.print_job_status;
  exception when others then
    v_to := null;
  end;
  if v_to is null or v_to not in ('DISPATCHED', 'FAILED') then
    raise exception 'INVALID_PRINT_STATUS: só DISPATCHED ou FAILED' using errcode = '22023';
  end if;

  select j.* into v_j from public.print_jobs j where j.id = p_job for update;
  if not found or v_j.requested_by is distinct from v_uid
     or not public.has_permission(v_j.restaurant_id, 'print.request') then
    raise exception 'PRINT_JOB_NOT_FOUND: pedido de impressão não encontrado' using errcode = 'P0002';
  end if;

  if v_j.status = v_to then
    return jsonb_build_object('ok', true, 'unchanged', true, 'job_id', v_j.id, 'status', v_j.status);
  end if;

  if not ((v_j.status = 'REQUESTED' and v_to in ('DISPATCHED', 'FAILED'))
          or (v_j.status = 'DISPATCHED' and v_to = 'FAILED')) then
    raise exception 'PRINT_INVALID_TRANSITION: % -> % não é permitido', v_j.status, v_to using errcode = 'P0001';
  end if;

  update public.print_jobs
     set status = v_to,
         dispatched_at = case when v_to = 'DISPATCHED' then now() else dispatched_at end
   where id = v_j.id
  returning * into v_j;

  return jsonb_build_object('ok', true, 'unchanged', false, 'job_id', v_j.id, 'status', v_j.status);
end;
$$;

revoke all on function public.request_print(uuid, text)   from public, anon, authenticated;
revoke all on function public.mark_print_job(uuid, text)  from public, anon, authenticated;
grant execute on function public.request_print(uuid, text)  to authenticated;
grant execute on function public.mark_print_job(uuid, text) to authenticated;
