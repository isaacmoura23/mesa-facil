-- =============================================================================
-- DB-2 / 0107 — Máquinas de estado e triggers de integridade.
--
-- Princípios:
--  * A regra mora no banco: nem RPC nem UPDATE direto conseguem pular estados.
--  * Chamada DIRETA de cliente (role anon/authenticated => is_direct_client())
--    tem colunas sensíveis congeladas; RPCs SECURITY DEFINER (dono = postgres)
--    e service_role podem alterá-las, mas as transições continuam validadas.
--  * Sempre que há auth.uid(), a permissão exata da transição é reconferida
--    aqui (defesa em profundidade além da RPC/RLS). service_role (uid nulo)
--    é confiável.
--  * Códigos de erro estáveis no início da mensagem para o app mapear:
--    ORDER_INVALID_TRANSITION, REASON_REQUIRED, FORBIDDEN_FIELD, FORBIDDEN,
--    TAB_INVALID_TRANSITION, TABLE_INVALID_TRANSITION, TABLE_HAS_OPEN_TAB,
--    TABLE_INACTIVE, TAB_NOT_OPEN, IMMUTABLE_FIELD.
-- =============================================================================

-- ===========================================================================
-- PEDIDOS
-- ===========================================================================

-- INSERT: número sequencial por restaurante, snapshot do nome da mesa e
-- bloqueio de pedido em comanda que não está aberta.
create or replace function public.orders_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tab_status public.tab_status;
begin
  if new.order_number is null then
    new.order_number := public.next_order_number(new.restaurant_id);
  end if;

  if new.table_id is not null and new.table_label is null then
    select t.name into new.table_label
    from public.restaurant_tables t
    where t.id = new.table_id and t.restaurant_id = new.restaurant_id;
  end if;

  if new.tab_id is not null then
    select tb.status into v_tab_status
    from public.tabs tb
    where tb.id = new.tab_id and tb.restaurant_id = new.restaurant_id;
    if v_tab_status is distinct from 'OPEN' then
      raise exception 'TAB_NOT_OPEN: a comanda não está aberta' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;
revoke execute on function public.orders_before_insert() from public, anon, authenticated;

create trigger orders_a_before_insert
  before insert on public.orders
  for each row execute function public.orders_before_insert();

-- UPDATE: SECURITY INVOKER de propósito (precisa saber se quem chama é cliente direto).
create or replace function public.orders_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_perm   text;
  v_client boolean := public.is_direct_client();
  v_free   constant text[] := array['status', 'status_reason', 'estimated_ready_at', 'updated_at'];
begin
  -- Identidade do pedido é imutável para qualquer um.
  if new.id <> old.id or new.restaurant_id <> old.restaurant_id
     or new.order_number <> old.order_number or new.public_code <> old.public_code
     or new.fulfillment_type <> old.fulfillment_type or new.created_at <> old.created_at
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'IMMUTABLE_FIELD: campos de identidade do pedido não podem mudar' using errcode = '42501';
  end if;

  -- Cliente direto só altera status/motivo/previsão. Valores, itens, cliente,
  -- endereço, payment_status e timestamps de marco ficam congelados.
  if v_client and (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
    raise exception 'FORBIDDEN_FIELD: só status, motivo e previsão podem ser alterados diretamente' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    select t.required_permission into v_perm
    from public.order_status_transitions t
    where t.fulfillment_type = old.fulfillment_type
      and t.from_status = old.status
      and t.to_status = new.status;

    if v_perm is null then
      raise exception 'ORDER_INVALID_TRANSITION: % -> % não é permitido para %',
        old.status, new.status, old.fulfillment_type using errcode = 'P0001';
    end if;

    if new.status in ('REJECTED', 'CANCELLED') and length(btrim(coalesce(new.status_reason, ''))) = 0 then
      raise exception 'REASON_REQUIRED: informe o motivo para %', new.status using errcode = 'P0001';
    end if;

    if auth.uid() is not null and not public.has_permission(old.restaurant_id, v_perm) then
      raise exception 'FORBIDDEN: requer permissão %', v_perm using errcode = '42501';
    end if;

    -- Marcos de tempo são do servidor.
    if new.status = 'CONFIRMED' then new.confirmed_at := now();
    elsif new.status = 'COMPLETED' then new.completed_at := now();
    elsif new.status = 'CANCELLED' then new.cancelled_at := now();
    elsif new.status = 'REJECTED' then new.rejected_at := now();
    end if;

    -- O motivo só persiste em REJECTED/CANCELLED (o histórico guarda o resto).
    if new.status not in ('REJECTED', 'CANCELLED') then
      new.status_reason := null;
    end if;
  elsif new.status_reason is distinct from old.status_reason then
    raise exception 'FORBIDDEN_FIELD: o motivo só pode mudar junto com o status' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger orders_a_before_update
  before update on public.orders
  for each row execute function public.orders_before_update();

-- Histórico: escrito exclusivamente por trigger (sem policy de escrita).
create or replace function public.orders_after_write_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.order_status_history (restaurant_id, order_id, from_status, to_status, changed_by, reason)
    values (new.restaurant_id, new.id, null, new.status, auth.uid(), null);
  elsif new.status is distinct from old.status then
    insert into public.order_status_history (restaurant_id, order_id, from_status, to_status, changed_by, reason)
    values (new.restaurant_id, new.id, old.status, new.status, auth.uid(), new.status_reason);
  end if;
  return null;
end;
$$;
revoke execute on function public.orders_after_write_history() from public, anon, authenticated;

create trigger orders_z_history_insert
  after insert on public.orders
  for each row execute function public.orders_after_write_history();
create trigger orders_z_history_update
  after update of status on public.orders
  for each row when (old.status is distinct from new.status)
  execute function public.orders_after_write_history();

-- ===========================================================================
-- PAGAMENTOS -> orders.payment_status (derivado; nunca editável por cliente)
-- ===========================================================================
create or replace function public.payments_sync_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total    integer;
  v_paid     bigint;
  v_pending  boolean;
  v_refunded boolean;
  v_failed   boolean;
  v_new      public.payment_status;
begin
  if new.order_id is null then
    return null;
  end if;

  select o.total_cents into v_total
  from public.orders o where o.id = new.order_id and o.restaurant_id = new.restaurant_id;
  if v_total is null then
    return null;
  end if;

  select coalesce(sum(p.amount_cents) filter (where p.status = 'PAID'), 0),
         coalesce(bool_or(p.status = 'PENDING'), false),
         coalesce(bool_or(p.status = 'REFUNDED'), false),
         coalesce(bool_or(p.status = 'FAILED'), false)
    into v_paid, v_pending, v_refunded, v_failed
  from public.payments p
  where p.order_id = new.order_id and p.restaurant_id = new.restaurant_id;

  v_new := case
    when v_paid >= v_total and v_total > 0 then 'PAID'
    when v_paid > 0 or v_pending           then 'PENDING'   -- parcial ou aguardando confirmação
    when v_refunded                        then 'REFUNDED'
    when v_failed                          then 'FAILED'
    else 'UNPAID'
  end;

  update public.orders
     set payment_status = v_new
   where id = new.order_id and restaurant_id = new.restaurant_id
     and payment_status is distinct from v_new;
  return null;
end;
$$;
revoke execute on function public.payments_sync_order() from public, anon, authenticated;

create trigger payments_z_sync_order
  after insert or update of status, amount_cents on public.payments
  for each row execute function public.payments_sync_order();

-- ===========================================================================
-- MESAS
-- ===========================================================================
-- SECURITY DEFINER: precisa enxergar comandas mesmo de quem não tem tabs.view.
-- Usa auth.uid() (não is_direct_client) porque roda como dono.
create or replace function public.tables_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sync boolean := coalesce(current_setting('mesa.sync', true), '') = 'tab';
  v_need text;
begin
  if new.id <> old.id or new.restaurant_id <> old.restaurant_id then
    raise exception 'IMMUTABLE_FIELD: id/restaurante da mesa não mudam' using errcode = '42501';
  end if;

  -- Qualquer coisa além de status é configuração => tables.manage.
  if (to_jsonb(new) - array['status', 'updated_at']) is distinct from (to_jsonb(old) - array['status', 'updated_at'])
     and auth.uid() is not null
     and not public.has_permission(old.restaurant_id, 'tables.manage') then
    raise exception 'FORBIDDEN: alterar cadastro da mesa requer tables.manage' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if (old.status::text, new.status::text) not in (
         ('AVAILABLE', 'OCCUPIED'), ('AVAILABLE', 'INACTIVE'),
         ('OCCUPIED', 'CLEANING'),  ('OCCUPIED', 'AVAILABLE'),
         ('CLEANING', 'AVAILABLE'), ('CLEANING', 'OCCUPIED'), ('CLEANING', 'INACTIVE'),
         ('INACTIVE', 'AVAILABLE')) then
      raise exception 'TABLE_INVALID_TRANSITION: % -> %', old.status, new.status using errcode = 'P0001';
    end if;

    -- Não libera mesa que ainda tem comanda aberta.
    if old.status = 'OCCUPIED' and new.status in ('AVAILABLE', 'CLEANING')
       and exists (select 1 from public.tabs t
                   where t.restaurant_id = old.restaurant_id and t.table_id = old.id and t.status = 'OPEN') then
      raise exception 'TABLE_HAS_OPEN_TAB: feche ou cancele a comanda antes de liberar a mesa' using errcode = 'P0001';
    end if;

    -- Ativar/desativar é cadastro (manage); o resto é operação (operate).
    -- A sincronização automática vinda da comanda não exige permissão de mesa
    -- (quem abre/fecha comanda já passou por tabs.manage).
    if auth.uid() is not null and not v_sync then
      v_need := case when 'INACTIVE' in (old.status::text, new.status::text)
                     then 'tables.manage' else 'tables.operate' end;
      if not public.has_permission(old.restaurant_id, v_need) then
        raise exception 'FORBIDDEN: requer permissão %', v_need using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$$;
revoke execute on function public.tables_before_update() from public, anon, authenticated;

create trigger restaurant_tables_a_before_update
  before update on public.restaurant_tables
  for each row execute function public.tables_before_update();

-- ===========================================================================
-- COMANDAS
-- ===========================================================================
create or replace function public.tab_orders_total(p_restaurant uuid, p_tab uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(o.total_cents), 0)::integer
  from public.orders o
  where o.restaurant_id = p_restaurant and o.tab_id = p_tab
    and o.status not in ('CANCELLED', 'REJECTED');
$$;
revoke execute on function public.tab_orders_total(uuid, uuid) from public, anon, authenticated;

create or replace function public.tabs_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table_status public.table_status;
begin
  -- Autoria do servidor; a regra "uma comanda por mesa" vem das configurações
  -- do restaurante e o cliente não consegue desligá-la.
  if auth.uid() is not null then
    new.opened_by := auth.uid();
  end if;
  select coalesce(s.single_tab_per_table, true) into new.single_per_table
  from public.restaurant_settings s where s.restaurant_id = new.restaurant_id;
  new.single_per_table := coalesce(new.single_per_table, true);

  if new.table_id is not null then
    select t.status into v_table_status
    from public.restaurant_tables t
    where t.id = new.table_id and t.restaurant_id = new.restaurant_id;
    if v_table_status = 'INACTIVE' then
      raise exception 'TABLE_INACTIVE: mesa desativada' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.tabs_before_insert() from public, anon, authenticated;

create trigger tabs_a_before_insert
  before insert on public.tabs
  for each row execute function public.tabs_before_insert();

-- (1) Guarda de colunas — SECURITY INVOKER (precisa saber se é cliente direto).
create or replace function public.tabs_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_free constant text[] := array['status', 'status_reason', 'label', 'guests', 'updated_at'];
begin
  if new.id <> old.id or new.restaurant_id <> old.restaurant_id
     or new.opened_by is distinct from old.opened_by or new.opened_at <> old.opened_at then
    raise exception 'IMMUTABLE_FIELD: identidade da comanda não muda' using errcode = '42501';
  end if;

  if public.is_direct_client() and (to_jsonb(new) - v_free) is distinct from (to_jsonb(old) - v_free) then
    raise exception 'FORBIDDEN_FIELD: total, mesa e marcos são calculados pelo servidor' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger tabs_a_guard_update
  before update on public.tabs
  for each row execute function public.tabs_guard_update();

-- (2) Transição — SECURITY DEFINER (soma pedidos da comanda sem exigir orders.view
-- de quem fecha). Disparada depois da guarda (ordem alfabética dos triggers).
create or replace function public.tabs_transition_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status <> 'OPEN' then
    -- Comanda encerrada é registro financeiro: congelada. Única exceção: o
    -- ON DELETE SET NULL (table_id) quando uma mesa desativada é apagada.
    if (to_jsonb(new) - array['table_id', 'updated_at']) is distinct from (to_jsonb(old) - array['table_id', 'updated_at']) then
      raise exception 'TAB_INVALID_TRANSITION: comanda % já está encerrada', old.status using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status not in ('CLOSED', 'CANCELLED') then
      raise exception 'TAB_INVALID_TRANSITION: % -> %', old.status, new.status using errcode = 'P0001';
    end if;
    if new.status = 'CANCELLED' and length(btrim(coalesce(new.status_reason, ''))) = 0 then
      raise exception 'REASON_REQUIRED: informe o motivo do cancelamento' using errcode = 'P0001';
    end if;
    if auth.uid() is not null and not public.has_permission(old.restaurant_id, 'tabs.manage') then
      raise exception 'FORBIDDEN: requer permissão tabs.manage' using errcode = '42501';
    end if;

    new.closed_at := now();
    new.closed_by := coalesce(auth.uid(), new.closed_by);
    if new.status = 'CLOSED' then
      new.total_cents := public.tab_orders_total(old.restaurant_id, old.id);
      new.status_reason := null;
    end if;
  elsif new.status_reason is distinct from old.status_reason then
    raise exception 'FORBIDDEN_FIELD: o motivo só pode mudar junto com o status' using errcode = '42501';
  end if;

  return new;
end;
$$;
revoke execute on function public.tabs_transition_update() from public, anon, authenticated;

create trigger tabs_b_transition_update
  before update on public.tabs
  for each row execute function public.tabs_transition_update();

-- Histórico + sincronização com o estado da mesa.
create or replace function public.tabs_after_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.tab_status_history (restaurant_id, tab_id, from_status, to_status, changed_by)
    values (new.restaurant_id, new.id, null, new.status, auth.uid());

    if new.table_id is not null then
      perform set_config('mesa.sync', 'tab', true);
      update public.restaurant_tables
         set status = 'OCCUPIED'
       where id = new.table_id and restaurant_id = new.restaurant_id
         and status in ('AVAILABLE', 'CLEANING');
      perform set_config('mesa.sync', '', true);
    end if;

  elsif new.status is distinct from old.status then
    insert into public.tab_status_history (restaurant_id, tab_id, from_status, to_status, changed_by, reason)
    values (new.restaurant_id, new.id, old.status, new.status, auth.uid(), new.status_reason);

    -- Última comanda aberta da mesa encerrada => mesa vai para limpeza.
    if new.table_id is not null
       and not exists (select 1 from public.tabs t
                       where t.restaurant_id = new.restaurant_id and t.table_id = new.table_id
                         and t.status = 'OPEN') then
      perform set_config('mesa.sync', 'tab', true);
      update public.restaurant_tables
         set status = 'CLEANING'
       where id = new.table_id and restaurant_id = new.restaurant_id
         and status = 'OCCUPIED';
      perform set_config('mesa.sync', '', true);
    end if;
  end if;
  return null;
end;
$$;
revoke execute on function public.tabs_after_write() from public, anon, authenticated;

create trigger tabs_z_after_insert
  after insert on public.tabs
  for each row execute function public.tabs_after_write();
create trigger tabs_z_after_update
  after update of status on public.tabs
  for each row when (old.status is distinct from new.status)
  execute function public.tabs_after_write();
