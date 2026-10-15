-- =============================================================================
-- DB-5 / 0115 — Acompanhamento público e transição de status (Fase 3).
--
--   public.track_order(p_slug, p_public_code)                 anon + authenticated
--   public.transition_order_status(p_order, p_to, p_reason)   authenticated
--
-- track_order: leitura por código público (80 bits). Devolve NULL se não existe
--   (ou restaurante não-ativo, ou código mal formado). NUNCA devolve telefone,
--   e-mail, endereço completo (só bairro), nome do cliente, ids internos
--   (pedido/cliente/restaurante), observações, nem changed_by.
--
-- transition_order_status: a máquina de estados continua sendo a do banco
--   (order_status_transitions + trigger orders_before_update). A RPC apenas:
--   autentica, esconde a existência do pedido de quem não tem orders.view,
--   confere a permissão do estado de destino (aceitar=orders.accept,
--   recusar=orders.reject, cancelar=orders.cancel, demais=orders.update_status),
--   trava a linha (FOR UPDATE), delega o UPDATE ao trigger e formata o retorno.
--   Repetir o mesmo destino é idempotente: {ok:true, unchanged:true}.
--
-- Erros (exceções; o código é o prefixo da mensagem, "CODIGO: texto"):
--   UNAUTHENTICATED (28000)        sem sessão
--   INVALID_STATUS (22023)         destino não é um status conhecido
--   ORDER_NOT_FOUND (P0002)        pedido inexistente OU sem orders.view (indistinguíveis)
--   ORDER_INVALID_TRANSITION (P0001) transição não permitida para a modalidade
--   FORBIDDEN (42501)              sem a permissão exigida pelo destino
--   REASON_REQUIRED (P0001)        REJECTED/CANCELLED sem motivo
--   REASON_TOO_LONG (22023)        motivo com mais de 500 caracteres
-- =============================================================================

create or replace function public.track_order(p_slug text, p_public_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := translate(upper(btrim(coalesce(p_public_code, ''))), 'OIL', '011');  -- Crockford: O->0, I/L->1
  v_rest record;
  v_o    record;
  v_hist jsonb;
begin
  if v_code !~ '^[0-9A-Z]{8,32}$' then
    return null;
  end if;

  select r.id, r.name, r.slug, r.timezone into v_rest
  from public.restaurants r
  where r.slug = lower(btrim(coalesce(p_slug, ''))) and r.status = 'active';
  if not found then
    return null;
  end if;

  select o.* into v_o
  from public.orders o
  where o.restaurant_id = v_rest.id and o.public_code = v_code;
  if not found then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('to_status', h.to_status, 'at', h.created_at)
                            order by h.created_at, h.id), '[]'::jsonb)
    into v_hist
  from public.order_status_history h
  where h.restaurant_id = v_o.restaurant_id and h.order_id = v_o.id;

  return jsonb_build_object(
    'restaurant',         jsonb_build_object('name', v_rest.name, 'slug', v_rest.slug, 'timezone', v_rest.timezone),
    'public_code',        v_o.public_code,
    'order_number',       v_o.order_number,
    'fulfillment_type',   v_o.fulfillment_type,
    'status',             v_o.status,
    'status_message',     case when v_o.status in ('REJECTED', 'CANCELLED') then v_o.status_reason else null end,
    'payment_status',     v_o.payment_status,
    'payment_method',     v_o.payment_method_intent,
    'items',              app_private.order_items_json(v_o.restaurant_id, v_o.id, false),
    'subtotal_cents',     v_o.subtotal_cents,
    'delivery_fee_cents', v_o.delivery_fee_cents,
    'discount_cents',     v_o.discount_cents,
    'total_cents',        v_o.total_cents,
    'neighborhood',       case when v_o.fulfillment_type = 'DELIVERY' then v_o.delivery_address ->> 'neighborhood' else null end,
    'created_at',         v_o.created_at,
    'estimated_ready_at', v_o.estimated_ready_at,
    'status_history',     v_hist);
end;
$$;

revoke all on function public.track_order(text, text) from public, anon, authenticated;
grant execute on function public.track_order(text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
create or replace function public.transition_order_status(
  p_order  uuid,
  p_to     text,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_to     public.order_status;
  v_rid    uuid;
  v_o      public.orders%rowtype;
  v_perm   text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_prev   public.order_status;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;

  begin
    v_to := upper(btrim(coalesce(p_to, '')))::public.order_status;
  exception when others then
    raise exception 'INVALID_STATUS: status desconhecido' using errcode = '22023';
  end;

  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'REASON_TOO_LONG: o motivo deve ter no máximo 500 caracteres' using errcode = '22023';
  end if;

  -- Existência só é revelada a quem pode ver pedidos do restaurante.
  select o.restaurant_id into v_rid from public.orders o where o.id = p_order;
  if v_rid is null or not public.has_permission(v_rid, 'orders.view') then
    raise exception 'ORDER_NOT_FOUND: pedido não encontrado' using errcode = 'P0002';
  end if;

  -- Trava a linha: transições concorrentes do mesmo pedido são serializadas.
  select o.* into v_o from public.orders o where o.id = p_order for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: pedido não encontrado' using errcode = 'P0002';
  end if;

  -- Permissão do destino (cada status de destino tem uma única permissão na tabela).
  select min(t.required_permission) into v_perm
  from public.order_status_transitions t
  where t.fulfillment_type = v_o.fulfillment_type and t.to_status = v_to;
  if v_perm is null then
    raise exception 'ORDER_INVALID_TRANSITION: % -> % não é permitido para %',
      v_o.status, v_to, v_o.fulfillment_type using errcode = 'P0001';
  end if;
  if not public.has_permission(v_o.restaurant_id, v_perm) then
    raise exception 'FORBIDDEN: requer permissão %', v_perm using errcode = '42501';
  end if;

  -- Repetição do mesmo destino: nada a fazer.
  if v_o.status = v_to then
    return jsonb_build_object('ok', true, 'unchanged', true, 'order', jsonb_build_object(
      'id', v_o.id, 'order_number', v_o.order_number, 'fulfillment_type', v_o.fulfillment_type,
      'status', v_o.status, 'previous_status', null, 'status_reason', v_o.status_reason,
      'payment_status', v_o.payment_status, 'estimated_ready_at', v_o.estimated_ready_at,
      'confirmed_at', v_o.confirmed_at, 'completed_at', v_o.completed_at,
      'cancelled_at', v_o.cancelled_at, 'rejected_at', v_o.rejected_at, 'updated_at', v_o.updated_at));
  end if;

  v_prev := v_o.status;

  -- O trigger orders_before_update é a autoridade: valida a transição, exige o
  -- motivo (REASON_REQUIRED), reconfere a permissão e carimba os marcos de tempo.
  update public.orders
     set status = v_to,
         status_reason = case when v_to in ('REJECTED', 'CANCELLED') then v_reason else null end
   where id = v_o.id
  returning * into v_o;

  return jsonb_build_object('ok', true, 'unchanged', false, 'order', jsonb_build_object(
    'id', v_o.id, 'order_number', v_o.order_number, 'fulfillment_type', v_o.fulfillment_type,
    'status', v_o.status, 'previous_status', v_prev, 'status_reason', v_o.status_reason,
    'payment_status', v_o.payment_status, 'estimated_ready_at', v_o.estimated_ready_at,
    'confirmed_at', v_o.confirmed_at, 'completed_at', v_o.completed_at,
    'cancelled_at', v_o.cancelled_at, 'rejected_at', v_o.rejected_at, 'updated_at', v_o.updated_at));
end;
$$;

revoke all on function public.transition_order_status(uuid, text, text) from public, anon, authenticated;
grant execute on function public.transition_order_status(uuid, text, text) to authenticated;
