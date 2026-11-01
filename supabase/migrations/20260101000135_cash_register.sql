-- =============================================================================
-- 0135 · Caixa (dinheiro): turnos, movimentos, retiradas com autorização do gerente
-- =============================================================================
-- Regras de negócio (definidas pelo CEO):
--   * UM caixa por restaurante (no máximo UM turno aberto por vez).
--   * Turno é OPCIONAL: vendas em dinheiro e lançamentos funcionam sem turno aberto
--     (session_id fica nulo e o histórico agrupa por dia).
--   * Entrada = suprimento (SUPPLY). Saída = pagamento feito pelo caixa (EXPENSE).
--     Retirada = sangria (WITHDRAWAL): o CAIXA só PEDE; o GERENTE aprova (nunca quem
--     pediu). O gerente também pode retirar direto.
--   * Venda em dinheiro (SALE) nasce SOZINHA quando um pagamento CASH é registrado
--     (gatilho em payments), guardando valor recebido e troco dado.
--   * Movimentos são IMUTÁVEIS (append-only). Erro se corrige com ESTORNO (REVERSAL),
--     feito só por quem tem cash.approve. Tudo vai para audit_logs.
-- Dinheiro esperado na gaveta = abertura + entradas - saídas (o troco já está embutido:
-- recebido - troco = valor da venda).
-- Escritas: SOMENTE por RPCs SECURITY DEFINER (e pelo gatilho). Clientes só leem (RLS).

-- ---------------------------------------------------------------------------
-- Permissões (o owner só ganha a de leitura; as outras são operacionais)
-- ---------------------------------------------------------------------------
insert into public.permissions (key, description, is_operational) values
  ('cash.view',    'Ver o caixa e o histórico do dinheiro', false),
  ('cash.operate', 'Operar o caixa: turno, entradas, saídas e pedir retirada', true),
  ('cash.approve', 'Aprovar retiradas do caixa, retirar direto e estornar lançamentos', true)
on conflict (key) do nothing;

insert into public.role_permissions (role, permission_key) values
  ('manager', 'cash.view'), ('manager', 'cash.operate'), ('manager', 'cash.approve'),
  ('cashier', 'cash.view'), ('cashier', 'cash.operate'),
  ('owner',   'cash.view')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Tipos e tabelas
-- ---------------------------------------------------------------------------
create type public.cash_session_status as enum ('OPEN', 'CLOSED');
create type public.cash_movement_kind   as enum ('SUPPLY', 'EXPENSE', 'WITHDRAWAL', 'SALE', 'REVERSAL');
create type public.cash_request_status  as enum ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

create table public.cash_sessions (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants (id) on delete restrict,
  status          public.cash_session_status not null default 'OPEN',
  opening_cents   integer not null check (opening_cents between 0 and 100000000),
  opened_by       uuid references auth.users (id) on delete set null,
  opened_at       timestamptz not null default now(),
  closed_by       uuid references auth.users (id) on delete set null,
  closed_at       timestamptz,
  expected_cents  integer,
  counted_cents   integer check (counted_cents is null or counted_cents between 0 and 100000000),
  difference_cents integer,
  notes           text check (notes is null or char_length(notes) <= 300),
  unique (id, restaurant_id),
  constraint cash_sessions_state_consistent check (
    (status = 'OPEN'   and closed_at is null and counted_cents is null and expected_cents is null and difference_cents is null)
    or
    (status = 'CLOSED' and closed_at is not null and counted_cents is not null and expected_cents is not null and difference_cents is not null)
  )
);
create unique index cash_sessions_one_open_per_restaurant on public.cash_sessions (restaurant_id) where status = 'OPEN';
create index cash_sessions_restaurant_opened_idx on public.cash_sessions (restaurant_id, opened_at desc);

create table public.cash_movements (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants (id) on delete restrict,
  session_id      uuid,
  kind            public.cash_movement_kind not null,
  direction       text not null check (direction in ('IN', 'OUT')),
  amount_cents    integer not null check (amount_cents between 1 and 100000000),
  tendered_cents  integer check (tendered_cents is null or tendered_cents between 1 and 100000000),
  change_cents    integer check (change_cents is null or change_cents between 0 and 100000000),
  reason          text check (reason is null or char_length(reason) between 1 and 300),
  payment_id      uuid references public.payments (id) on delete restrict,
  reverses        uuid references public.cash_movements (id) on delete restrict,
  idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_-]{16,100}$'),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint cash_movements_session_fk foreign key (session_id, restaurant_id)
    references public.cash_sessions (id, restaurant_id) on delete restrict,
  constraint cash_movements_direction_by_kind check (
    (kind in ('SUPPLY', 'SALE') and direction = 'IN')
    or (kind in ('EXPENSE', 'WITHDRAWAL') and direction = 'OUT')
    or (kind = 'REVERSAL' and reverses is not null)
  ),
  constraint cash_movements_sale_has_payment check ((kind = 'SALE') = (payment_id is not null)),
  constraint cash_movements_reversal_has_target check ((kind = 'REVERSAL') = (reverses is not null)),
  constraint cash_movements_tender_only_sales check (kind = 'SALE' or (tendered_cents is null and change_cents is null)),
  constraint cash_movements_change_consistent check (tendered_cents is null or change_cents = tendered_cents - amount_cents),
  constraint cash_movements_reason_required check (kind not in ('EXPENSE', 'WITHDRAWAL', 'REVERSAL') or reason is not null)
);
create unique index cash_movements_payment_uidx  on public.cash_movements (payment_id) where payment_id is not null;
create unique index cash_movements_reverses_uidx on public.cash_movements (reverses)   where reverses is not null;
create unique index cash_movements_idem_uidx     on public.cash_movements (restaurant_id, idempotency_key) where idempotency_key is not null;
create index cash_movements_restaurant_created_idx on public.cash_movements (restaurant_id, created_at desc);
create index cash_movements_session_idx on public.cash_movements (session_id) where session_id is not null;

create table public.cash_withdrawal_requests (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants (id) on delete restrict,
  amount_cents    integer not null check (amount_cents between 1 and 100000000),
  reason          text not null check (char_length(reason) between 3 and 300),
  status          public.cash_request_status not null default 'PENDING',
  requested_by    uuid references auth.users (id) on delete set null,
  requested_at    timestamptz not null default now(),
  decided_by      uuid references auth.users (id) on delete set null,
  decided_at      timestamptz,
  decision_note   text check (decision_note is null or char_length(decision_note) <= 300),
  movement_id     uuid references public.cash_movements (id) on delete restrict,
  idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_-]{16,100}$'),
  constraint cash_requests_state_consistent check (
    (status = 'PENDING' and decided_at is null and movement_id is null)
    or (status <> 'PENDING' and decided_at is not null)
  ),
  constraint cash_requests_approved_has_movement check ((status = 'APPROVED') = (movement_id is not null)),
  -- quem aprova nunca é quem pediu (cancelar o próprio pedido é permitido)
  constraint cash_requests_no_self_approval check (status <> 'APPROVED' or decided_by is distinct from requested_by)
);
create unique index cash_requests_idem_uidx on public.cash_withdrawal_requests (restaurant_id, idempotency_key) where idempotency_key is not null;
create index cash_requests_restaurant_status_idx on public.cash_withdrawal_requests (restaurant_id, status, requested_at desc);

-- ---------------------------------------------------------------------------
-- Imutabilidade / estados
-- ---------------------------------------------------------------------------
create or replace function app_private.cash_movements_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'cash_movements_are_append_only' using errcode = '42501';
end;
$$;
create trigger cash_movements_no_update_delete before update or delete on public.cash_movements
  for each row execute function app_private.cash_movements_immutable();
create trigger cash_movements_no_truncate before truncate on public.cash_movements
  for each statement execute function app_private.cash_movements_immutable();

create or replace function app_private.cash_sessions_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cash_sessions_cannot_be_deleted' using errcode = '42501';
  end if;
  if old.status = 'CLOSED' then
    raise exception 'cash_session_closed_is_immutable' using errcode = '42501';
  end if;
  if new.restaurant_id <> old.restaurant_id or new.opening_cents <> old.opening_cents
     or new.opened_at <> old.opened_at or new.opened_by is distinct from old.opened_by then
    raise exception 'cash_session_structural_columns_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger cash_sessions_guard_trg before update or delete on public.cash_sessions
  for each row execute function app_private.cash_sessions_guard();

create or replace function app_private.cash_requests_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cash_requests_cannot_be_deleted' using errcode = '42501';
  end if;
  if old.status <> 'PENDING' then
    raise exception 'cash_request_already_decided' using errcode = '42501';
  end if;
  if new.restaurant_id <> old.restaurant_id or new.amount_cents <> old.amount_cents
     or new.reason <> old.reason or new.requested_by is distinct from old.requested_by
     or new.requested_at <> old.requested_at then
    raise exception 'cash_request_structural_columns_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger cash_requests_guard_trg before update or delete on public.cash_withdrawal_requests
  for each row execute function app_private.cash_requests_guard();

-- ---------------------------------------------------------------------------
-- RLS: só leitura para quem tem cash.view; escrita só por RPC/gatilho (definer)
-- ---------------------------------------------------------------------------
alter table public.cash_sessions            enable row level security;
alter table public.cash_movements           enable row level security;
alter table public.cash_withdrawal_requests enable row level security;
alter table public.cash_sessions            force row level security;
alter table public.cash_movements           force row level security;
alter table public.cash_withdrawal_requests force row level security;

create policy cash_sessions_select on public.cash_sessions
  for select to authenticated using (public.has_permission(restaurant_id, 'cash.view'));
create policy cash_movements_select on public.cash_movements
  for select to authenticated using (public.has_permission(restaurant_id, 'cash.view'));
create policy cash_requests_select on public.cash_withdrawal_requests
  for select to authenticated using (public.has_permission(restaurant_id, 'cash.view'));

revoke all on table public.cash_sessions, public.cash_movements, public.cash_withdrawal_requests from public, anon, authenticated;
grant select on public.cash_sessions, public.cash_movements, public.cash_withdrawal_requests to authenticated;

-- Realtime (a RLS de SELECT vale): a tela do caixa e o selo de retiradas pendentes
do $$
declare t text;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['cash_movements', 'cash_withdrawal_requests', 'cash_sessions'] loop
      if not exists (select 1 from pg_catalog.pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Venda em dinheiro: nasce sozinha com o pagamento CASH (valor recebido e troco)
-- ---------------------------------------------------------------------------
create or replace function app_private.payments_cash_sale()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_session uuid;
begin
  if new.method <> 'CASH' or new.status <> 'PAID' then
    return new;
  end if;
  select s.id into v_session from public.cash_sessions s
   where s.restaurant_id = new.restaurant_id and s.status = 'OPEN';
  insert into public.cash_movements (restaurant_id, session_id, kind, direction, amount_cents,
                                     tendered_cents, change_cents, payment_id, created_by)
  values (new.restaurant_id, v_session, 'SALE', 'IN', new.amount_cents,
          new.tendered_cents,
          case when new.tendered_cents is not null then new.tendered_cents - new.amount_cents end,
          new.id, new.recorded_by);
  return new;
end;
$$;
create trigger payments_cash_sale_trg after insert on public.payments
  for each row execute function app_private.payments_cash_sale();
revoke all on function app_private.payments_cash_sale() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Funções de apoio
-- ---------------------------------------------------------------------------
create or replace function app_private.cash_open_session_id(p_rid uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.id from public.cash_sessions s where s.restaurant_id = p_rid and s.status = 'OPEN'
$$;

create or replace function app_private.cash_expected(p_session uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select (s.opening_cents + coalesce((
            select sum(case m.direction when 'IN' then m.amount_cents else -m.amount_cents end)
            from public.cash_movements m where m.session_id = s.id), 0))::integer
  from public.cash_sessions s where s.id = p_session
$$;

create or replace function app_private.cash_movement_json(m public.cash_movements)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', m.id, 'session_id', m.session_id, 'kind', m.kind, 'direction', m.direction,
    'amount_cents', m.amount_cents, 'tendered_cents', m.tendered_cents, 'change_cents', m.change_cents,
    'reason', m.reason, 'payment_id', m.payment_id, 'reverses', m.reverses,
    'created_by', m.created_by, 'created_at', m.created_at)
$$;

revoke all on function app_private.cash_open_session_id(uuid)        from public, anon, authenticated;
revoke all on function app_private.cash_expected(uuid)               from public, anon, authenticated;
revoke all on function app_private.cash_movement_json(public.cash_movements) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- cash_open_session / cash_close_session
-- ---------------------------------------------------------------------------
create or replace function public.cash_open_session(p_restaurant uuid, p_opening_cents integer default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  perform app_private.require_perm(p_restaurant, 'cash.operate', 'RESTAURANT_NOT_FOUND');
  if p_opening_cents is null or p_opening_cents < 0 or p_opening_cents > 100000000 then
    raise exception 'INVALID_AMOUNT: valor inicial inválido' using errcode = '22023';
  end if;
  begin
    insert into public.cash_sessions (restaurant_id, opening_cents, opened_by)
    values (p_restaurant, p_opening_cents, v_uid) returning id into v_id;
  exception when unique_violation then
    raise exception 'SESSION_ALREADY_OPEN: já existe um turno aberto' using errcode = 'P0001';
  end;
  perform public.log_audit(p_restaurant, 'cash.session_opened', 'cash_session', v_id,
                           jsonb_build_object('opening_cents', p_opening_cents));
  return jsonb_build_object('ok', true, 'session_id', v_id, 'opening_cents', p_opening_cents);
end;
$$;

create or replace function public.cash_close_session(p_session uuid, p_counted_cents integer, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_rid uuid; v_s public.cash_sessions%rowtype;
  v_expected integer; v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  select s.restaurant_id into v_rid from public.cash_sessions s where s.id = p_session;
  perform app_private.require_perm(v_rid, 'cash.operate', 'SESSION_NOT_FOUND');
  if p_counted_cents is null or p_counted_cents < 0 or p_counted_cents > 100000000 then
    raise exception 'INVALID_AMOUNT: valor contado inválido' using errcode = '22023';
  end if;
  if v_notes is not null and char_length(v_notes) > 300 then
    raise exception 'INVALID_NOTES: observação muito longa (máx. 300)' using errcode = '22023';
  end if;
  select * into v_s from public.cash_sessions s where s.id = p_session for update;
  if v_s.status <> 'OPEN' then
    raise exception 'SESSION_NOT_OPEN: o turno já foi fechado' using errcode = 'P0001';
  end if;
  v_expected := app_private.cash_expected(p_session);
  update public.cash_sessions
     set status = 'CLOSED', closed_by = v_uid, closed_at = now(), expected_cents = v_expected,
         counted_cents = p_counted_cents, difference_cents = p_counted_cents - v_expected, notes = v_notes
   where id = p_session;
  perform public.log_audit(v_rid, 'cash.session_closed', 'cash_session', p_session,
    jsonb_build_object('expected_cents', v_expected, 'counted_cents', p_counted_cents,
                       'difference_cents', p_counted_cents - v_expected));
  return jsonb_build_object('ok', true, 'session_id', p_session, 'expected_cents', v_expected,
                            'counted_cents', p_counted_cents, 'difference_cents', p_counted_cents - v_expected);
end;
$$;

-- ---------------------------------------------------------------------------
-- cash_record_movement: entrada (SUPPLY) e saída (EXPENSE)
-- ---------------------------------------------------------------------------
create or replace function public.cash_record_movement(
  p_restaurant uuid, p_kind text, p_amount_cents integer,
  p_reason text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_kind public.cash_movement_kind;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_m public.cash_movements%rowtype; v_replay boolean := false;
begin
  perform app_private.require_perm(p_restaurant, 'cash.operate', 'RESTAURANT_NOT_FOUND');
  v_kind := case upper(btrim(coalesce(p_kind, ''))) when 'SUPPLY' then 'SUPPLY' when 'EXPENSE' then 'EXPENSE' else null end;
  if v_kind is null then
    raise exception 'INVALID_KIND: use SUPPLY (entrada) ou EXPENSE (saída)' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > 100000000 then
    raise exception 'INVALID_AMOUNT: o valor deve ser maior que zero' using errcode = '22023';
  end if;
  if v_reason is not null and char_length(v_reason) > 300 then
    raise exception 'INVALID_REASON: motivo muito longo (máx. 300)' using errcode = '22023';
  end if;
  if v_kind = 'EXPENSE' and (v_reason is null or char_length(v_reason) < 3) then
    raise exception 'REASON_REQUIRED: informe o motivo da saída' using errcode = '22023';
  end if;
  if v_key is not null and v_key !~ '^[A-Za-z0-9_-]{16,100}$' then
    raise exception 'INVALID_IDEMPOTENCY_KEY: chave inválida' using errcode = '22023';
  end if;

  if v_key is not null then
    select * into v_m from public.cash_movements m where m.restaurant_id = p_restaurant and m.idempotency_key = v_key;
    if found then
      if v_m.kind <> v_kind or v_m.amount_cents <> p_amount_cents or v_m.reason is distinct from v_reason then
        raise exception 'IDEMPOTENCY_CONFLICT: a chave já foi usada em outro lançamento' using errcode = 'P0001';
      end if;
      v_replay := true;
    end if;
  end if;

  if not v_replay then
    insert into public.cash_movements (restaurant_id, session_id, kind, direction, amount_cents, reason, idempotency_key, created_by)
    values (p_restaurant, app_private.cash_open_session_id(p_restaurant), v_kind,
            case v_kind when 'SUPPLY' then 'IN' else 'OUT' end, p_amount_cents, v_reason, v_key, v_uid)
    returning * into v_m;
    perform public.log_audit(p_restaurant, case v_kind when 'SUPPLY' then 'cash.supply' else 'cash.expense' end,
      'cash_movement', v_m.id, jsonb_build_object('amount_cents', p_amount_cents, 'reason', v_reason));
  end if;
  return jsonb_build_object('ok', true, 'idempotent_replay', v_replay, 'movement', app_private.cash_movement_json(v_m));
end;
$$;

-- ---------------------------------------------------------------------------
-- Retiradas: o caixa pede, o gerente decide (nunca o mesmo usuário)
-- ---------------------------------------------------------------------------
create or replace function public.cash_request_withdrawal(
  p_restaurant uuid, p_amount_cents integer, p_reason text, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), ''); v_r public.cash_withdrawal_requests%rowtype;
  v_replay boolean := false;
begin
  perform app_private.require_perm(p_restaurant, 'cash.operate', 'RESTAURANT_NOT_FOUND');
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > 100000000 then
    raise exception 'INVALID_AMOUNT: o valor deve ser maior que zero' using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'REASON_REQUIRED: informe o motivo (3 a 300 caracteres)' using errcode = '22023';
  end if;
  if v_key is not null and v_key !~ '^[A-Za-z0-9_-]{16,100}$' then
    raise exception 'INVALID_IDEMPOTENCY_KEY: chave inválida' using errcode = '22023';
  end if;
  if v_key is not null then
    select * into v_r from public.cash_withdrawal_requests r where r.restaurant_id = p_restaurant and r.idempotency_key = v_key;
    if found then
      if v_r.amount_cents <> p_amount_cents or v_r.reason <> v_reason or v_r.requested_by is distinct from v_uid then
        raise exception 'IDEMPOTENCY_CONFLICT: a chave já foi usada em outro pedido' using errcode = 'P0001';
      end if;
      v_replay := true;
    end if;
  end if;
  if not v_replay then
    insert into public.cash_withdrawal_requests (restaurant_id, amount_cents, reason, requested_by, idempotency_key)
    values (p_restaurant, p_amount_cents, v_reason, v_uid, v_key) returning * into v_r;
    perform public.log_audit(p_restaurant, 'cash.withdrawal_requested', 'cash_withdrawal_request', v_r.id,
      jsonb_build_object('amount_cents', p_amount_cents, 'reason', v_reason));
  end if;
  return jsonb_build_object('ok', true, 'idempotent_replay', v_replay, 'request_id', v_r.id, 'status', v_r.status);
end;
$$;

create or replace function public.cash_decide_withdrawal(p_request uuid, p_action text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_rid uuid; v_r public.cash_withdrawal_requests%rowtype;
  v_action text := upper(btrim(coalesce(p_action, ''))); v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_m public.cash_movements%rowtype;
begin
  select r.restaurant_id into v_rid from public.cash_withdrawal_requests r where r.id = p_request;
  if v_action not in ('APPROVE', 'REJECT', 'CANCEL') then
    perform app_private.require_perm(v_rid, 'cash.view', 'REQUEST_NOT_FOUND');
    raise exception 'INVALID_ACTION: use APPROVE, REJECT ou CANCEL' using errcode = '22023';
  end if;
  if v_action = 'CANCEL' then
    perform app_private.require_perm(v_rid, 'cash.operate', 'REQUEST_NOT_FOUND');
  else
    perform app_private.require_perm(v_rid, 'cash.approve', 'REQUEST_NOT_FOUND');
  end if;
  if v_note is not null and char_length(v_note) > 300 then
    raise exception 'INVALID_NOTE: observação muito longa (máx. 300)' using errcode = '22023';
  end if;

  select * into v_r from public.cash_withdrawal_requests r where r.id = p_request for update;
  if v_r.status <> 'PENDING' then
    raise exception 'REQUEST_NOT_PENDING: este pedido já foi decidido' using errcode = 'P0001';
  end if;

  if v_action = 'CANCEL' then
    if v_r.requested_by is distinct from v_uid then
      raise exception 'FORBIDDEN: só quem pediu pode cancelar o pedido' using errcode = '42501';
    end if;
    update public.cash_withdrawal_requests set status = 'CANCELLED', decided_by = v_uid, decided_at = now(), decision_note = v_note where id = p_request;
    perform public.log_audit(v_rid, 'cash.withdrawal_cancelled', 'cash_withdrawal_request', p_request, '{}'::jsonb);
  elsif v_action = 'REJECT' then
    update public.cash_withdrawal_requests set status = 'REJECTED', decided_by = v_uid, decided_at = now(), decision_note = v_note where id = p_request;
    perform public.log_audit(v_rid, 'cash.withdrawal_rejected', 'cash_withdrawal_request', p_request,
      jsonb_build_object('note', v_note));
  else
    if v_r.requested_by is not distinct from v_uid then
      raise exception 'SELF_APPROVAL: quem pediu a retirada não pode aprová-la' using errcode = '42501';
    end if;
    insert into public.cash_movements (restaurant_id, session_id, kind, direction, amount_cents, reason, created_by)
    values (v_rid, app_private.cash_open_session_id(v_rid), 'WITHDRAWAL', 'OUT', v_r.amount_cents, v_r.reason, v_uid)
    returning * into v_m;
    update public.cash_withdrawal_requests set status = 'APPROVED', decided_by = v_uid, decided_at = now(),
           decision_note = v_note, movement_id = v_m.id where id = p_request;
    perform public.log_audit(v_rid, 'cash.withdrawal_approved', 'cash_withdrawal_request', p_request,
      jsonb_build_object('amount_cents', v_r.amount_cents, 'movement_id', v_m.id, 'requested_by', v_r.requested_by));
  end if;
  return jsonb_build_object('ok', true, 'request_id', p_request, 'status',
    case v_action when 'APPROVE' then 'APPROVED' when 'REJECT' then 'REJECTED' else 'CANCELLED' end,
    'movement_id', v_m.id);
end;
$$;

create or replace function public.cash_withdraw_direct(
  p_restaurant uuid, p_amount_cents integer, p_reason text, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), ''); v_m public.cash_movements%rowtype; v_replay boolean := false;
begin
  perform app_private.require_perm(p_restaurant, 'cash.approve', 'RESTAURANT_NOT_FOUND');
  if p_amount_cents is null or p_amount_cents < 1 or p_amount_cents > 100000000 then
    raise exception 'INVALID_AMOUNT: o valor deve ser maior que zero' using errcode = '22023';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 300 then
    raise exception 'REASON_REQUIRED: informe o motivo (3 a 300 caracteres)' using errcode = '22023';
  end if;
  if v_key is not null and v_key !~ '^[A-Za-z0-9_-]{16,100}$' then
    raise exception 'INVALID_IDEMPOTENCY_KEY: chave inválida' using errcode = '22023';
  end if;
  if v_key is not null then
    select * into v_m from public.cash_movements m where m.restaurant_id = p_restaurant and m.idempotency_key = v_key;
    if found then
      if v_m.kind <> 'WITHDRAWAL' or v_m.amount_cents <> p_amount_cents or v_m.reason is distinct from v_reason then
        raise exception 'IDEMPOTENCY_CONFLICT: a chave já foi usada em outro lançamento' using errcode = 'P0001';
      end if;
      v_replay := true;
    end if;
  end if;
  if not v_replay then
    insert into public.cash_movements (restaurant_id, session_id, kind, direction, amount_cents, reason, idempotency_key, created_by)
    values (p_restaurant, app_private.cash_open_session_id(p_restaurant), 'WITHDRAWAL', 'OUT', p_amount_cents, v_reason, v_key, v_uid)
    returning * into v_m;
    perform public.log_audit(p_restaurant, 'cash.withdrawal', 'cash_movement', v_m.id,
      jsonb_build_object('amount_cents', p_amount_cents, 'reason', v_reason));
  end if;
  return jsonb_build_object('ok', true, 'idempotent_replay', v_replay, 'movement', app_private.cash_movement_json(v_m));
end;
$$;

-- Estorno: lançamento contrário (o original nunca muda). Só entradas, saídas e retiradas.
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
  if v_o.kind not in ('SUPPLY', 'EXPENSE', 'WITHDRAWAL') then
    raise exception 'NOT_REVERSIBLE: só entradas, saídas e retiradas podem ser estornadas' using errcode = 'P0001';
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

-- ---------------------------------------------------------------------------
-- Leituras: resumo, histórico, pedidos de retirada, turnos
-- ---------------------------------------------------------------------------
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
                             where r.restaurant_id = p_restaurant and r.status = 'PENDING')::integer);
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
           exists (select 1 from public.cash_movements r where r.reverses = m.id) as reversed
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

create or replace function public.cash_list_requests(p_restaurant uuid, p_status text default 'PENDING', p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100); v_status public.cash_request_status; v_out jsonb;
begin
  perform app_private.require_perm(p_restaurant, 'cash.view', 'RESTAURANT_NOT_FOUND');
  if p_status is not null and btrim(p_status) <> '' then
    begin v_status := upper(btrim(p_status))::public.cash_request_status;
    exception when others then raise exception 'INVALID_STATUS: status inválido' using errcode = '22023'; end;
  end if;
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.requested_at desc, x.id), '[]'::jsonb) into v_out from (
    select r.id, r.amount_cents, r.reason, r.status, r.requested_by, r.requested_at, r.decided_by, r.decided_at, r.decision_note,
           coalesce(nullif(btrim(rp.full_name), ''), 'Usuário da equipe') as requested_by_name,
           coalesce(nullif(btrim(dp.full_name), ''), case when r.decided_by is null then null else 'Usuário da equipe' end) as decided_by_name
      from public.cash_withdrawal_requests r
      left join public.profiles rp on rp.id = r.requested_by
      left join public.profiles dp on dp.id = r.decided_by
     where r.restaurant_id = p_restaurant and (v_status is null or r.status = v_status)
     order by r.requested_at desc, r.id
     limit v_limit) x;
  return v_out;
end;
$$;

create or replace function public.cash_list_sessions(p_restaurant uuid, p_limit integer default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100); v_out jsonb;
begin
  perform app_private.require_perm(p_restaurant, 'cash.view', 'RESTAURANT_NOT_FOUND');
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.opened_at desc, x.id), '[]'::jsonb) into v_out from (
    select s.id, s.status, s.opening_cents, s.opened_at, s.closed_at, s.counted_cents, s.difference_cents, s.notes,
           case when s.status = 'OPEN' then app_private.cash_expected(s.id) else s.expected_cents end as expected_cents,
           coalesce(nullif(btrim(op.full_name), ''), 'Usuário da equipe') as opened_by_name,
           case when s.closed_by is null then null else coalesce(nullif(btrim(cp.full_name), ''), 'Usuário da equipe') end as closed_by_name
      from public.cash_sessions s
      left join public.profiles op on op.id = s.opened_by
      left join public.profiles cp on cp.id = s.closed_by
     where s.restaurant_id = p_restaurant
     order by s.opened_at desc, s.id
     limit v_limit) x;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: só usuários autenticados executam; as checagens de permissão são internas
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'cash_open_session(uuid, integer)', 'cash_close_session(uuid, integer, text)',
    'cash_record_movement(uuid, text, integer, text, text)', 'cash_request_withdrawal(uuid, integer, text, text)',
    'cash_decide_withdrawal(uuid, text, text)', 'cash_withdraw_direct(uuid, integer, text, text)',
    'cash_reverse_movement(uuid, text)', 'cash_summary(uuid, timestamptz, timestamptz)',
    'cash_list(uuid, timestamptz, timestamptz, text, uuid, integer, timestamptz)',
    'cash_list_requests(uuid, text, integer)', 'cash_list_sessions(uuid, integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end
$$;
