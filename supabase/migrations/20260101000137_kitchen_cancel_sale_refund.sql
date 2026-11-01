-- =============================================================================
-- 0137 · Cozinha cancela o preparo; venda de pedido cancelado pode ser estornada
-- =============================================================================
-- * Papel `kitchen` ganha `orders.cancel` (a máquina de estados continua exigindo motivo e registra
--   quem cancelou no histórico do pedido). Vale para quem já é da cozinha, pois a permissão vem do papel.
-- * cash_reverse_movement: a venda em dinheiro (SALE) passa a poder ser estornada, mas SÓ quando o pedido
--   dela foi CANCELADO e só por quem tem cash.approve (gerente). Venda de pedido ativo segue não estornável.
-- * cash_summary: novo campo `pending_refunds` {count, amount_cents} = vendas de pedido cancelado sem estorno.
-- * cash_list: nova coluna `pending_refund` por lançamento.
-- Nada se move sozinho: cancelar o pedido NÃO mexe no caixa; o gerente estorna em Caixa.
-- =============================================================================
insert into public.role_permissions (role, permission_key) values ('kitchen', 'orders.cancel')
on conflict do nothing;

create or replace function public.cash_reverse_movement(p_movement uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_rid uuid; v_o public.cash_movements%rowtype; v_m public.cash_movements%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select m.restaurant_id into v_rid from public.cash_movements m where m.id = p_movement;
  perform app_private.require_perm(v_rid, 'cash.approve', 'MOVEMENT_NOT_FOUND');
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'REASON_REQUIRED: informe o motivo do estorno (3 a 300 caracteres)' using errcode = '22023';
  end if;
  select * into v_o from public.cash_movements m where m.id = p_movement;
  if v_o.kind = 'SALE' then
    -- Venda só é estornada quando o pedido foi CANCELADO (devolução do dinheiro ao cliente).
    if not exists (select 1 from public.payments pay join public.orders o on o.id = pay.order_id
                    where pay.id = v_o.payment_id and o.status = 'CANCELLED') then
      raise exception 'NOT_REVERSIBLE: a venda só pode ser estornada depois que o pedido for cancelado' using errcode = 'P0001';
    end if;
  elsif v_o.kind not in ('SUPPLY', 'EXPENSE', 'WITHDRAWAL') then
    raise exception 'NOT_REVERSIBLE: só entradas, saídas, retiradas e vendas de pedido cancelado podem ser estornadas' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.cash_movements r where r.reverses = p_movement) then
    raise exception 'ALREADY_REVERSED: este lançamento já foi estornado' using errcode = 'P0001';
  end if;
  begin
    insert into public.cash_movements (restaurant_id, session_id, kind, direction, amount_cents, reason, reverses, created_by)
    values (v_rid, app_private.cash_open_session_id(v_rid), 'REVERSAL',
            case v_o.direction when 'IN' then 'OUT' else 'IN' end, v_o.amount_cents, v_reason, p_movement, v_uid)
    returning * into v_m;
  exception when unique_violation then
    raise exception 'ALREADY_REVERSED: este lançamento já foi estornado' using errcode = 'P0001';
  end;
  perform public.log_audit(v_rid, 'cash.reversed', 'cash_movement', v_m.id,
    jsonb_build_object('reverses', p_movement, 'amount_cents', v_o.amount_cents, 'reason', v_reason));
  return jsonb_build_object('ok', true, 'movement', app_private.cash_movement_json(v_m));
end;
$$;

create or replace function public.cash_summary(p_restaurant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_sess public.cash_sessions%rowtype; v_by jsonb; v_in integer; v_out integer; v_change integer; v_tend integer; v_sales integer;
begin
  perform app_private.require_perm(p_restaurant, 'cash.view', 'RESTAURANT_NOT_FOUND');
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception 'INVALID_RANGE: período inválido (máx. 366 dias)' using errcode = '22023';
  end if;
  select coalesce(jsonb_object_agg(k.kind, jsonb_build_object('count', k.n, 'amount_cents', k.amt)), '{}'::jsonb)
    into v_by
    from (select m.kind, count(*)::integer n, sum(m.amount_cents)::integer amt
            from public.cash_movements m
           where m.restaurant_id = p_restaurant and m.created_at >= p_from and m.created_at < p_to
           group by m.kind) k;
  select coalesce(sum(m.amount_cents) filter (where m.direction = 'IN'), 0)::integer,
         coalesce(sum(m.amount_cents) filter (where m.direction = 'OUT'), 0)::integer,
         coalesce(sum(m.change_cents), 0)::integer, coalesce(sum(m.tendered_cents), 0)::integer,
         count(*) filter (where m.kind = 'SALE')::integer
    into v_in, v_out, v_change, v_tend, v_sales
    from public.cash_movements m
   where m.restaurant_id = p_restaurant and m.created_at >= p_from and m.created_at < p_to;
  select * into v_sess from public.cash_sessions s where s.restaurant_id = p_restaurant and s.status = 'OPEN';
  return jsonb_build_object(
    'in_cents', v_in, 'out_cents', v_out, 'net_cents', v_in - v_out,
    'sales_count', v_sales, 'tendered_cents', v_tend, 'change_given_cents', v_change,
    'by_kind', v_by,
    'open_session', case when v_sess.id is null then null else jsonb_build_object(
      'id', v_sess.id, 'opened_at', v_sess.opened_at, 'opening_cents', v_sess.opening_cents,
      'expected_cents', app_private.cash_expected(v_sess.id)) end,
    'pending_withdrawals', (select count(*) from public.cash_withdrawal_requests r
                             where r.restaurant_id = p_restaurant and r.status = 'PENDING')::integer,
    'pending_refunds', (select jsonb_build_object('count', count(*)::integer, 'amount_cents', coalesce(sum(m.amount_cents), 0)::integer)
                          from public.cash_movements m
                          join public.payments pay on pay.id = m.payment_id
                          join public.orders o on o.id = pay.order_id
                         where m.restaurant_id = p_restaurant and m.kind = 'SALE' and o.status = 'CANCELLED'
                           and not exists (select 1 from public.cash_movements r where r.reverses = m.id)));
end;
$$;

create or replace function public.cash_list(
  p_restaurant uuid, p_from timestamptz, p_to timestamptz,
  p_kind text default null, p_session uuid default null, p_limit integer default 100, p_before timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200); v_kind public.cash_movement_kind; v_out jsonb;
begin
  perform app_private.require_perm(p_restaurant, 'cash.view', 'RESTAURANT_NOT_FOUND');
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception 'INVALID_RANGE: período inválido (máx. 366 dias)' using errcode = '22023';
  end if;
  if p_kind is not null and btrim(p_kind) <> '' then
    begin v_kind := upper(btrim(p_kind))::public.cash_movement_kind;
    exception when others then raise exception 'INVALID_KIND: tipo inválido' using errcode = '22023'; end;
  end if;
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc, x.id), '[]'::jsonb) into v_out from (
    select m.id, m.session_id, m.kind, m.direction, m.amount_cents, m.tendered_cents, m.change_cents, m.reason,
           m.payment_id, m.reverses, m.created_at, m.created_by,
           coalesce(nullif(btrim(pr.full_name), ''), 'Usuário da equipe') as actor_name,
           o.order_number as order_number, tb.label as tab_label,
           exists (select 1 from public.cash_movements r where r.reverses = m.id) as reversed,
           (m.kind = 'SALE' and o.status = 'CANCELLED'
            and not exists (select 1 from public.cash_movements r where r.reverses = m.id)) as pending_refund
      from public.cash_movements m
      left join public.profiles pr on pr.id = m.created_by
      left join public.payments pay on pay.id = m.payment_id
      left join public.orders o on o.id = pay.order_id
      left join public.tabs tb on tb.id = pay.tab_id
     where m.restaurant_id = p_restaurant and m.created_at >= p_from and m.created_at < p_to
       and (v_kind is null or m.kind = v_kind)
       and (p_session is null or m.session_id = p_session)
       and (p_before is null or m.created_at < p_before)
     order by m.created_at desc, m.id
     limit v_limit) x;
  return v_out;
end;
$$;

revoke all on function public.cash_reverse_movement(uuid, text) from public, anon, authenticated;
grant execute on function public.cash_reverse_movement(uuid, text) to authenticated;
revoke all on function public.cash_summary(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.cash_summary(uuid, timestamptz, timestamptz) to authenticated;
revoke all on function public.cash_list(uuid, timestamptz, timestamptz, text, uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.cash_list(uuid, timestamptz, timestamptz, text, uuid, integer, timestamptz) to authenticated;
