-- =============================================================================
-- 0125 · Fase 5 (DB-7) · list_customers, get_customer, list_team, list_audit_logs
--
-- SECURITY DEFINER, search_path = '', EXECUTE só authenticated (REVOKE de PUBLIC/anon).
-- auth.uid() + is_member + has_permission DENTRO da função. Quem não é membro ativo do
-- restaurante (outro tenant, sem vínculo, suspenso, inexistente) recebe RESTAURANT_NOT_FOUND,
-- idêntico ao restaurante inexistente. Sem permissão -> FORBIDDEN.
--
--   list_customers(p_restaurant, p_search, p_cursor, p_limit)   reports.view OU orders.view
--   get_customer(p_restaurant, p_customer)                      idem; grava audit 'customer.viewed'
--   list_team(p_restaurant)                                     team.manage
--   list_audit_logs(p_restaurant, p_action_prefix, p_from, p_to, p_limit, p_before)   team.manage
--
-- Erros: UNAUTHENTICATED (28000) · RESTAURANT_NOT_FOUND (P0002) · CUSTOMER_NOT_FOUND (P0002)
--        FORBIDDEN (42501) · INVALID_CURSOR (22023) · INVALID_PERIOD (22023) · INVALID_PREFIX (22023)
--
-- Decisões:
--   * list_customers/get_customer: o contrato diz "reports.view ou orders.view". Como orders.view
--     é de TODOS os papéis (a RLS de customers já permite o SELECT direto a eles), cashier/kitchen/
--     waiter também passam. Para restringir a owner/manager basta trocar o helper
--     app_private.require_customer_access para exigir apenas reports.view.
--   * Cursor opaco jsonb {"t": "<timestamptz ISO UTC>", "id": "<uuid>"}; qualquer outra forma,
--     chaves extras, tipos errados ou valores não parseáveis -> INVALID_CURSOR.
--   * list_customers: ordem por sort_at desc, id desc onde sort_at = coalesce(último pedido,
--     created_at do cliente) (clientes sem pedido ordenam por cadastro, sem NULL no keyset).
--     orders_count = TODOS os pedidos do cliente; total_spent_cents exclui CANCELLED/REJECTED.
--     p_limit: clamp 1..100 (padrão 25). Busca: nome/telefone (ilike com % _ \ escapados;
--     busca de telefone também por dígitos, >= 3).
--   * get_customer: últimos 200 pedidos; audit_logs 'customer.viewed' sem PII no metadata.
--   * list_team: e-mail (auth.users) só chega a quem tem team.manage (única condição de entrada).
--     permissions = efetivas (mesma regra de has_permission: owner nunca operacional; team.manage
--     só do papel; overrides só para não-owner); vazio se o vínculo não está 'active'.
--   * list_audit_logs: limite 200/página; metadata sanitizado por
--     app_private.sanitize_audit_metadata (remove recursivamente chaves com token/secret/senha/
--     api key/authorization/cookie/jwt/credencial e mascara strings que parecem JWT);
--     actor_name = nome do membro; atores de plataforma não-membros aparecem como 'Plataforma'.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helpers internos
-- ---------------------------------------------------------------------------
create or replace function app_private.require_customer_access(p_rid uuid)
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
    raise exception 'RESTAURANT_NOT_FOUND: não encontrado' using errcode = 'P0002';
  end if;
  if not (public.has_permission(p_rid, 'reports.view') or public.has_permission(p_rid, 'orders.view')) then
    raise exception 'FORBIDDEN: requer permissão reports.view ou orders.view' using errcode = '42501';
  end if;
end;
$$;

-- Parser de cursor keyset {"t","id"}; devolve (t, id) ou levanta INVALID_CURSOR.
create or replace function app_private.parse_cursor(p_cursor jsonb)
returns table (t timestamptz, id uuid)
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_cursor is null or p_cursor = 'null'::jsonb then
    return;  -- SQL NULL e jsonb 'null' = sem cursor
  end if;
  begin
    if jsonb_typeof(p_cursor) is distinct from 'object'
       or (select count(*) from jsonb_object_keys(p_cursor)) <> 2
       or jsonb_typeof(p_cursor -> 't') is distinct from 'string'
       or jsonb_typeof(p_cursor -> 'id') is distinct from 'string'
       or length(p_cursor ->> 't') > 40 then
      raise exception 'bad';
    end if;
    t := (p_cursor ->> 't')::timestamptz;
    id := (p_cursor ->> 'id')::uuid;
  exception when others then
    raise exception 'INVALID_CURSOR: cursor inválido' using errcode = '22023';
  end;
  return next;
end;
$$;

create or replace function app_private.cursor_ts(p timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

create or replace function app_private.like_escape(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_');
$$;

create or replace function app_private.sanitize_audit_metadata(p jsonb, p_depth integer default 0)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  k   text;
  v   jsonb;
  res jsonb;
begin
  if p is null then
    return null;
  end if;
  if p_depth > 8 then
    return '"[truncado]"'::jsonb;
  end if;
  case jsonb_typeof(p)
    when 'object' then
      res := '{}'::jsonb;
      for k, v in select e.key, e.value from jsonb_each(p) e loop
        if k ~* '(token|secret|passw|pwd|api[_-]?key|authorization|credential|cookie|jwt|bearer|signature|private[_-]?key)' then
          continue;
        end if;
        res := res || jsonb_build_object(k, app_private.sanitize_audit_metadata(v, p_depth + 1));
      end loop;
      return res;
    when 'array' then
      select coalesce(jsonb_agg(app_private.sanitize_audit_metadata(e, p_depth + 1)), '[]'::jsonb)
        into res from jsonb_array_elements(p) e;
      return res;
    when 'string' then
      if (p #>> '{}') ~ '^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.' then
        return '"[removido]"'::jsonb;
      end if;
      return p;
    else
      return p;
  end case;
end;
$$;

revoke all on function app_private.require_customer_access(uuid) from public, anon, authenticated;
revoke all on function app_private.parse_cursor(jsonb) from public, anon, authenticated;
revoke all on function app_private.cursor_ts(timestamptz) from public, anon, authenticated;
revoke all on function app_private.like_escape(text) from public, anon, authenticated;
revoke all on function app_private.sanitize_audit_metadata(jsonb, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- list_customers
-- ---------------------------------------------------------------------------
create or replace function public.list_customers(
  p_restaurant uuid,
  p_search     text default null,
  p_cursor     jsonb default null,
  p_limit      integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim    integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_search text := nullif(btrim(left(coalesce(p_search, ''), 100)), '');
  v_pat    text;
  v_dpat   text;
  v_digits text;
  v_ct     timestamptz;
  v_cid    uuid;
  v_has_c  boolean := false;
  v_rows   jsonb;
  v_n      integer;
  v_next   jsonb := null;
begin
  perform app_private.require_customer_access(p_restaurant);

  if p_cursor is not null and p_cursor <> 'null'::jsonb then
    select pc.t, pc.id into v_ct, v_cid from app_private.parse_cursor(p_cursor) pc;
    v_has_c := true;
  end if;

  if v_search is not null then
    v_pat := '%' || app_private.like_escape(v_search) || '%';
    v_digits := regexp_replace(v_search, '\D', '', 'g');
    if length(v_digits) >= 3 then
      v_dpat := '%' || v_digits || '%';
    end if;
  end if;

  with agg as (
    select o.customer_id,
           count(*)::bigint as cnt,
           max(o.created_at) as last_at,
           coalesce(sum(o.total_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')), 0)::bigint as spent
      from public.orders o
     where o.restaurant_id = p_restaurant and o.customer_id is not null
     group by o.customer_id
  ), base as (
    select c.id, c.name, c.phone, c.email,
           coalesce(a.cnt, 0) as cnt, a.last_at, coalesce(a.spent, 0) as spent,
           coalesce(a.last_at, c.created_at) as sort_at
      from public.customers c
      left join agg a on a.customer_id = c.id
     where c.restaurant_id = p_restaurant
       and (v_pat is null
            or c.name ilike v_pat escape '\'
            or c.phone ilike v_pat escape '\'
            or (v_dpat is not null and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like v_dpat))
  ), page as (
    select b.*
      from base b
     where not v_has_c or (b.sort_at, b.id) < (v_ct, v_cid)
     order by b.sort_at desc, b.id desc
     limit v_lim + 1
  )
  select count(*)::integer,
         coalesce(jsonb_agg(
           jsonb_build_object('id', pg.id, 'name', pg.name, 'phone', pg.phone, 'email', pg.email,
                              'orders_count', pg.cnt, 'last_order_at', pg.last_at,
                              'total_spent_cents', pg.spent,
                              '_sort_at', pg.sort_at)
           order by pg.sort_at desc, pg.id desc), '[]'::jsonb)
    into v_n, v_rows
    from page pg;

  if v_n > v_lim then
    v_rows := v_rows - v_lim;  -- descarta a linha extra (índice v_lim)
    v_next := jsonb_build_object(
      't', app_private.cursor_ts(((v_rows -> (v_lim - 1)) ->> '_sort_at')::timestamptz),
      'id', (v_rows -> (v_lim - 1)) ->> 'id');
  end if;

  select coalesce(jsonb_agg(e - '_sort_at'), '[]'::jsonb) into v_rows from jsonb_array_elements(v_rows) e;
  return jsonb_build_object('rows', v_rows, 'next_cursor', v_next);
end;
$$;

-- ---------------------------------------------------------------------------
-- get_customer (volatile: grava auditoria LGPD)
-- ---------------------------------------------------------------------------
create or replace function public.get_customer(p_restaurant uuid, p_customer uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_c      public.customers%rowtype;
  v_addr   jsonb;
  v_orders jsonb;
  v_stats  jsonb;
begin
  perform app_private.require_customer_access(p_restaurant);

  select c.* into v_c
    from public.customers c
   where c.id = p_customer and c.restaurant_id = p_restaurant;
  if not found then
    raise exception 'CUSTOMER_NOT_FOUND: cliente não encontrado' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'label', a.label, 'postal_code', a.postal_code, 'street', a.street,
           'number', a.number, 'complement', a.complement, 'neighborhood', a.neighborhood,
           'city', a.city, 'state', a.state, 'reference', a.reference, 'is_default', a.is_default)
         order by a.is_default desc, a.created_at, a.id), '[]'::jsonb)
    into v_addr
    from public.customer_addresses a
   where a.restaurant_id = p_restaurant and a.customer_id = p_customer;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'order_number', x.order_number, 'created_at', x.created_at,
           'fulfillment_type', x.fulfillment_type, 'status', x.status, 'total_cents', x.total_cents)
         order by x.created_at desc, x.id desc), '[]'::jsonb)
    into v_orders
    from (
      select o.id, o.order_number, o.created_at, o.fulfillment_type::text as fulfillment_type,
             o.status::text as status, o.total_cents
        from public.orders o
       where o.restaurant_id = p_restaurant and o.customer_id = p_customer
       order by o.created_at desc, o.id desc
       limit 200
    ) x;

  select jsonb_build_object(
           'orders_count', count(*),
           'total_spent_cents', coalesce(sum(o.total_cents) filter (where o.status not in ('CANCELLED', 'REJECTED')), 0),
           'last_order_at', max(o.created_at))
    into v_stats
    from public.orders o
   where o.restaurant_id = p_restaurant and o.customer_id = p_customer;

  perform public.log_audit(p_restaurant, 'customer.viewed', 'customer', p_customer, '{}'::jsonb);

  return jsonb_build_object(
    'customer', jsonb_build_object('id', v_c.id, 'name', v_c.name, 'phone', v_c.phone, 'email', v_c.email,
                                   'notes', v_c.notes, 'created_at', v_c.created_at),
    'addresses', v_addr,
    'orders', v_orders,
    'stats', v_stats
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- list_team
-- ---------------------------------------------------------------------------
create or replace function public.list_team(p_restaurant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  perform app_private.require_perm(p_restaurant, 'team.manage', 'RESTAURANT_NOT_FOUND');

  select coalesce(jsonb_agg(to_jsonb(t) - 'ord' order by t.ord, t.created_at, t.membership_id), '[]'::jsonb)
    into v_rows
    from (
      select m.id as membership_id,
             m.user_id,
             pr.full_name,
             coalesce(u.email::text, m.invited_email) as email,
             m.role::text as role,
             m.status::text as status,
             m.invited_email,
             case when m.status = 'active' then
               coalesce((
                 select jsonb_agg(pm.key order by pm.key)
                   from public.permissions pm
                  where not (m.role = 'owner' and pm.is_operational)
                    and case
                          when m.role = 'owner' or pm.key = 'team.manage' then
                            exists (select 1 from public.role_permissions rp
                                     where rp.role = m.role and rp.permission_key = pm.key)
                          else
                            coalesce(
                              (select o.granted from public.membership_permission_overrides o
                                where o.membership_id = m.id and o.permission_key = pm.key),
                              exists (select 1 from public.role_permissions rp
                                       where rp.role = m.role and rp.permission_key = pm.key))
                        end
               ), '[]'::jsonb)
             else '[]'::jsonb end as permissions,
             coalesce((
               select jsonb_agg(jsonb_build_object('permission', o.permission_key, 'granted', o.granted)
                                order by o.permission_key)
                 from public.membership_permission_overrides o
                where o.membership_id = m.id
             ), '[]'::jsonb) as overrides,
             m.created_at,
             u.last_sign_in_at,
             case m.role when 'owner' then 0 when 'manager' then 1 else 2 end as ord
        from public.restaurant_memberships m
        left join public.profiles pr on pr.id = m.user_id
        left join auth.users u on u.id = m.user_id
       where m.restaurant_id = p_restaurant
    ) t;

  return jsonb_build_object('rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- list_audit_logs
-- ---------------------------------------------------------------------------
create or replace function public.list_audit_logs(
  p_restaurant    uuid,
  p_action_prefix text default null,
  p_from          timestamptz default null,
  p_to            timestamptz default null,
  p_limit         integer default 50,
  p_before        jsonb default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim    integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_prefix text := nullif(btrim(coalesce(p_action_prefix, '')), '');
  v_pat    text;
  v_ct     timestamptz;
  v_cid    uuid;
  v_has_c  boolean := false;
  v_rows   jsonb;
  v_n      integer;
  v_next   jsonb := null;
begin
  perform app_private.require_perm(p_restaurant, 'team.manage', 'RESTAURANT_NOT_FOUND');

  if p_from is not null and p_to is not null and p_from >= p_to then
    raise exception 'INVALID_PERIOD: período inválido' using errcode = '22023';
  end if;
  if v_prefix is not null then
    if length(v_prefix) > 64 then
      raise exception 'INVALID_PREFIX: prefixo muito longo' using errcode = '22023';
    end if;
    v_pat := app_private.like_escape(v_prefix) || '%';
  end if;
  if p_before is not null and p_before <> 'null'::jsonb then
    select pc.t, pc.id into v_ct, v_cid from app_private.parse_cursor(p_before) pc;
    v_has_c := true;
  end if;

  with page as (
    select l.*
      from public.audit_logs l
     where l.restaurant_id = p_restaurant
       and (v_pat is null or l.action like v_pat escape '\')
       and (p_from is null or l.created_at >= p_from)
       and (p_to is null or l.created_at < p_to)
       and (not v_has_c or (l.created_at, l.id) < (v_ct, v_cid))
     order by l.created_at desc, l.id desc
     limit v_lim + 1
  )
  select count(*)::integer,
         coalesce(jsonb_agg(
           jsonb_build_object(
             'id', pg.id, 'created_at', pg.created_at, 'actor_id', pg.actor_id,
             'actor_name',
               case
                 when pg.actor_id is null then null
                 else coalesce(
                   (select pr.full_name from public.profiles pr
                     where pr.id = pg.actor_id
                       and exists (select 1 from public.restaurant_memberships m
                                    where m.restaurant_id = p_restaurant and m.user_id = pg.actor_id)),
                   case when exists (select 1 from public.platform_admins pa where pa.user_id = pg.actor_id)
                        then 'Plataforma' end)
               end,
             'action', pg.action, 'resource_type', pg.resource_type, 'resource_id', pg.resource_id,
             'metadata', app_private.sanitize_audit_metadata(pg.metadata))
           order by pg.created_at desc, pg.id desc), '[]'::jsonb)
    into v_n, v_rows
    from page pg;

  if v_n > v_lim then
    v_rows := v_rows - v_lim;
    v_next := jsonb_build_object(
      't', app_private.cursor_ts(((v_rows -> (v_lim - 1)) ->> 'created_at')::timestamptz),
      'id', (v_rows -> (v_lim - 1)) ->> 'id');
  end if;

  return jsonb_build_object('rows', v_rows, 'next_cursor', v_next);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.list_customers(uuid, text, jsonb, integer) from public, anon;
revoke all on function public.get_customer(uuid, uuid) from public, anon;
revoke all on function public.list_team(uuid) from public, anon;
revoke all on function public.list_audit_logs(uuid, text, timestamptz, timestamptz, integer, jsonb) from public, anon;
grant execute on function public.list_customers(uuid, text, jsonb, integer) to authenticated;
grant execute on function public.get_customer(uuid, uuid) to authenticated;
grant execute on function public.list_team(uuid) to authenticated;
grant execute on function public.list_audit_logs(uuid, text, timestamptz, timestamptz, integer, jsonb) to authenticated;
