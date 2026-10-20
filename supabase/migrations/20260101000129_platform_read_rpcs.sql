-- =============================================================================
-- 0129 · Fase 6 (DB-8) · RPCs de LEITURA da plataforma
--
-- SECURITY DEFINER, search_path = '', EXECUTE só authenticated (REVOKE de PUBLIC/anon).
-- Validação DENTRO: app_private.require_platform(): sem login -> UNAUTHENTICATED; qualquer não-admin de
-- plataforma (usuário comum, dono, gerente, equipe, anon via JWT inválido) -> FORBIDDEN idêntico.
--
--   platform_dashboard()                                                        superadmin|support
--   platform_list_restaurants(p_search, p_status, p_cursor, p_limit)            superadmin|support
--   platform_get_restaurant(p_restaurant)                                       superadmin|support
--   platform_list_subscriptions(p_status, p_cursor, p_limit)                    superadmin|support
--   platform_list_support_sessions(p_active_only, p_cursor, p_limit)            superadmin|support
--   platform_list_tickets(p_status, p_cursor, p_limit)                          superadmin|support
--   platform_list_audit_logs(p_actor, p_action_prefix, p_restaurant, p_from, p_to, p_cursor, p_limit)   SUPERADMIN
--   platform_get_settings()                                                     superadmin|support
--   platform_list_plans()   (extra, p/ UI de planos: planos + nº de assinaturas)  superadmin|support
--   platform_support_overview(p_session)                                        superadmin|support (sessão ATIVA própria)
--
-- Erros: UNAUTHENTICATED (28000) · FORBIDDEN (42501) · INVALID_CURSOR (22023) · INVALID_STATUS (22023)
--        INVALID_PERIOD (22023) · INVALID_PREFIX (22023) · RESTAURANT_NOT_FOUND (P0002)
--        SUPPORT_SESSION_INVALID (42501: sessão inexistente, de outro admin, expirada ou encerrada — idêntico)
--
-- Regras de privacidade: a plataforma NUNCA recebe pedidos individuais, clientes, telefones, endereços ou
-- e-mails de clientes. Apenas agregados/metadados. O e-mail do DONO só sai em platform_list_restaurants e
-- platform_get_restaurant. platform_support_overview (única visão com dados operacionais) exige sessão
-- de suporte ativa do próprio auth.uid() para aquele restaurante e omite nome/telefone/e-mail/endereço do cliente.
--
-- Decisões:
--   * Paginação keyset com cursor jsonb opaco {"t": ISO UTC, "id": uuid} (app_private.parse_cursor); qualquer
--     adulteração (tipo, chaves extras, valor não parseável) -> INVALID_CURSOR. p_limit: clamp 1..100 (padrão 25).
--     Ordem: created_at desc, id desc (sessões: started_at desc).
--   * Busca (nome/slug) com app_private.like_escape (% _ \ literais); filtros de status validados.
--   * Vocabulário de status de assinatura: trial|active|past_due|cancelled (entrada aceita também trialing|canceled).
--   * Dashboard: subscriptions.* contam TODAS as linhas por status (cancelled inclui histórico);
--     mrr_cents = soma de plans.price_cents das assinaturas 'active' (plano anual dividido por 12);
--     orders_30d = pedidos criados nos últimos 30 dias (todos os status); tickets_open = status 'open'
--     (+ tickets_in_progress como chave extra); support_sessions_active = não encerradas e não expiradas.
--   * platform_get_restaurant: equipe sem telefone/e-mail (papel, status, nome); auditoria: últimas 20
--     entradas, metadata sanitizado (segredos) e sem chaves de e-mail/telefone/endereço.
--   * Sessão de suporte: platform_support_overview NÃO usa has_support_access (que concede RLS) — valida a
--     sessão explicitamente. Rótulos de comanda são texto livre digitado pela equipe do restaurante
--     (podem conter nomes); incluídos conforme contrato.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- platform_dashboard
-- ---------------------------------------------------------------------------
create or replace function public.platform_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
begin
  perform app_private.require_platform(false);
  return jsonb_build_object(
    'restaurants', (
      select jsonb_build_object(
        'total', count(*),
        'pending', count(*) filter (where r.status = 'pending'),
        'active', count(*) filter (where r.status = 'active'),
        'suspended', count(*) filter (where r.status = 'suspended'),
        'new_30d', count(*) filter (where r.created_at >= v_now - interval '30 days'))
      from public.restaurants r),
    'subscriptions', (
      select jsonb_build_object(
        'active', count(*) filter (where s.status = 'active'),
        'trial', count(*) filter (where s.status = 'trialing'),
        'past_due', count(*) filter (where s.status = 'past_due'),
        'cancelled', count(*) filter (where s.status = 'canceled'))
      from public.subscriptions s),
    'mrr_cents', (
      select coalesce(sum(case when p.billing_interval = 'year' then round(p.price_cents / 12.0) else p.price_cents end), 0)::bigint
      from public.subscriptions s join public.plans p on p.id = s.plan_id
      where s.status = 'active'),
    'orders_30d', (select count(*) from public.orders o where o.created_at >= v_now - interval '30 days'),
    'tickets_open', (select count(*) from public.support_tickets t where t.status = 'open'),
    'tickets_in_progress', (select count(*) from public.support_tickets t where t.status = 'in_progress'),
    'support_sessions_active', (
      select count(*) from public.support_sessions ss where ss.ended_at is null and ss.expires_at > v_now)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_list_restaurants
-- ---------------------------------------------------------------------------
create or replace function public.platform_list_restaurants(
  p_search text default null,
  p_status text default null,
  p_cursor jsonb default null,
  p_limit  integer default 25
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
  v_status public.restaurant_status;
  v_ct     timestamptz;
  v_cid    uuid;
  v_has_c  boolean := false;
  v_rows   jsonb;
  v_n      integer;
  v_next   jsonb := null;
begin
  perform app_private.require_platform(false);

  if nullif(btrim(coalesce(p_status, '')), '') is not null then
    if btrim(p_status) not in ('pending', 'active', 'suspended') then
      raise exception 'INVALID_STATUS: status inválido' using errcode = '22023';
    end if;
    v_status := btrim(p_status)::public.restaurant_status;
  end if;
  if v_search is not null then
    v_pat := '%' || app_private.like_escape(v_search) || '%';
  end if;
  if p_cursor is not null and p_cursor <> 'null'::jsonb then
    select pc.t, pc.id into v_ct, v_cid from app_private.parse_cursor(p_cursor) pc;
    v_has_c := true;
  end if;

  with page as (
    select r.*
      from public.restaurants r
     where (v_status is null or r.status = v_status)
       and (v_pat is null or r.name ilike v_pat escape '\' or r.slug ilike v_pat escape '\')
       and (not v_has_c or (r.created_at, r.id) < (v_ct, v_cid))
     order by r.created_at desc, r.id desc
     limit v_lim + 1
  )
  select count(*)::integer,
         coalesce(jsonb_agg(
           jsonb_build_object(
             'id', pg.id, 'slug', pg.slug, 'name', pg.name, 'status', pg.status, 'created_at', pg.created_at,
             'plan_name', sub.plan_name,
             'subscription_status', sub.status,
             'members_count', (select count(*) from public.restaurant_memberships m
                                where m.restaurant_id = pg.id and m.status = 'active'),
             'owner_name', own.full_name,
             'owner_email', own.email)
           order by pg.created_at desc, pg.id desc), '[]'::jsonb)
    into v_n, v_rows
    from page pg
    left join lateral (
      select p.name as plan_name, app_private.sub_status_out(s.status) as status
        from public.subscriptions s
        join public.plans p on p.id = s.plan_id
       where s.restaurant_id = pg.id
       order by (s.status in ('trialing', 'active', 'past_due')) desc, s.created_at desc, s.id desc
       limit 1
    ) sub on true
    left join lateral (
      select pr.full_name, u.email::text as email
        from public.restaurant_memberships m
        left join public.profiles pr on pr.id = m.user_id
        left join auth.users u on u.id = m.user_id
       where m.restaurant_id = pg.id and m.role = 'owner' and m.status = 'active'
       limit 1
    ) own on true;

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
-- platform_get_restaurant
-- ---------------------------------------------------------------------------
create or replace function public.platform_get_restaurant(p_restaurant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_r     public.restaurants%rowtype;
  v_owner jsonb;
  v_sub   jsonb;
  v_team  jsonb;
  v_audit jsonb;
begin
  perform app_private.require_platform(false);

  select r.* into v_r from public.restaurants r where r.id = p_restaurant;
  if not found then
    raise exception 'RESTAURANT_NOT_FOUND: não encontrado' using errcode = 'P0002';
  end if;

  select jsonb_build_object('name', pr.full_name, 'email', u.email::text) into v_owner
    from public.restaurant_memberships m
    left join public.profiles pr on pr.id = m.user_id
    left join auth.users u on u.id = m.user_id
   where m.restaurant_id = v_r.id and m.role = 'owner' and m.status = 'active'
   limit 1;

  select jsonb_build_object(
           'id', s.id, 'plan_id', s.plan_id, 'plan_code', p.code, 'plan_name', p.name,
           'price_cents', p.price_cents, 'currency', p.currency,
           'status', app_private.sub_status_out(s.status),
           'trial_ends_at', s.trial_ends_at, 'current_period_start', s.current_period_start,
           'current_period_end', s.current_period_end, 'cancel_at_period_end', s.cancel_at_period_end,
           'limits', p.limits) into v_sub
    from public.subscriptions s join public.plans p on p.id = s.plan_id
   where s.restaurant_id = v_r.id
   order by (s.status in ('trialing', 'active', 'past_due')) desc, s.created_at desc, s.id desc
   limit 1;

  select coalesce(jsonb_agg(
           jsonb_build_object('membership_id', m.id, 'role', m.role, 'status', m.status,
                              'full_name', pr.full_name, 'created_at', m.created_at)
           order by m.created_at, m.id), '[]'::jsonb) into v_team
    from public.restaurant_memberships m
    left join public.profiles pr on pr.id = m.user_id
   where m.restaurant_id = v_r.id;

  select coalesce(jsonb_agg(
           jsonb_build_object('id', a.id, 'created_at', a.created_at, 'actor_id', a.actor_id,
                              'action', a.action, 'resource_type', a.resource_type,
                              'resource_id', a.resource_id,
                              'metadata', app_private.platform_audit_metadata(a.metadata))
           order by a.created_at desc, a.id desc), '[]'::jsonb) into v_audit
    from (select * from public.audit_logs l where l.restaurant_id = v_r.id
           order by l.created_at desc, l.id desc limit 20) a;

  return jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', v_r.id, 'slug', v_r.slug, 'name', v_r.name, 'status', v_r.status, 'timezone', v_r.timezone,
      'created_at', v_r.created_at, 'updated_at', v_r.updated_at,
      'owner_name', v_owner ->> 'name', 'owner_email', v_owner ->> 'email'),
    'subscription', v_sub,
    'team', v_team,
    'audit', v_audit);
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_list_subscriptions
-- ---------------------------------------------------------------------------
create or replace function public.platform_list_subscriptions(
  p_status text default null,
  p_cursor jsonb default null,
  p_limit  integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim    integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_status public.subscription_status;
  v_ct     timestamptz;
  v_cid    uuid;
  v_has_c  boolean := false;
  v_rows   jsonb;
  v_n      integer;
  v_next   jsonb := null;
begin
  perform app_private.require_platform(false);

  if nullif(btrim(coalesce(p_status, '')), '') is not null then
    v_status := app_private.sub_status_in(p_status);
    if v_status is null then
      raise exception 'INVALID_STATUS: status inválido' using errcode = '22023';
    end if;
  end if;
  if p_cursor is not null and p_cursor <> 'null'::jsonb then
    select pc.t, pc.id into v_ct, v_cid from app_private.parse_cursor(p_cursor) pc;
    v_has_c := true;
  end if;

  with page as (
    select s.*
      from public.subscriptions s
     where (v_status is null or s.status = v_status)
       and (not v_has_c or (s.created_at, s.id) < (v_ct, v_cid))
     order by s.created_at desc, s.id desc
     limit v_lim + 1
  )
  select count(*)::integer,
         coalesce(jsonb_agg(
           jsonb_build_object(
             'id', pg.id, 'restaurant_id', pg.restaurant_id,
             'restaurant_name', r.name, 'restaurant_slug', r.slug, 'restaurant_status', r.status,
             'plan_id', pg.plan_id, 'plan_code', p.code, 'plan_name', p.name, 'price_cents', p.price_cents,
             'status', app_private.sub_status_out(pg.status),
             'trial_ends_at', pg.trial_ends_at, 'current_period_start', pg.current_period_start,
             'current_period_end', pg.current_period_end, 'cancel_at_period_end', pg.cancel_at_period_end,
             'created_at', pg.created_at, 'updated_at', pg.updated_at)
           order by pg.created_at desc, pg.id desc), '[]'::jsonb)
    into v_n, v_rows
    from page pg
    join public.restaurants r on r.id = pg.restaurant_id
    join public.plans p on p.id = pg.plan_id;

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
-- platform_list_support_sessions
-- ---------------------------------------------------------------------------
create or replace function public.platform_list_support_sessions(
  p_active_only boolean default false,
  p_cursor      jsonb default null,
  p_limit       integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim   integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_now   timestamptz := pg_catalog.now();
  v_ct    timestamptz;
  v_cid   uuid;
  v_has_c boolean := false;
  v_rows  jsonb;
  v_n     integer;
  v_next  jsonb := null;
begin
  perform app_private.require_platform(false);

  if p_cursor is not null and p_cursor <> 'null'::jsonb then
    select pc.t, pc.id into v_ct, v_cid from app_private.parse_cursor(p_cursor) pc;
    v_has_c := true;
  end if;

  with page as (
    select s.*
      from public.support_sessions s
     where (not coalesce(p_active_only, false) or (s.ended_at is null and s.expires_at > v_now))
       and (not v_has_c or (s.started_at, s.id) < (v_ct, v_cid))
     order by s.started_at desc, s.id desc
     limit v_lim + 1
  )
  select count(*)::integer,
         coalesce(jsonb_agg(
           jsonb_build_object(
             'id', pg.id, 'restaurant_id', pg.restaurant_id,
             'restaurant_name', r.name, 'restaurant_slug', r.slug,
             'admin_id', pg.admin_id, 'admin_name', pr.full_name,
             'reason', pg.reason, 'started_at', pg.started_at, 'expires_at', pg.expires_at,
             'ended_at', pg.ended_at,
             'active', (pg.ended_at is null and pg.expires_at > v_now),
             'created_at', pg.started_at)
           order by pg.started_at desc, pg.id desc), '[]'::jsonb)
    into v_n, v_rows
    from page pg
    join public.restaurants r on r.id = pg.restaurant_id
    left join public.profiles pr on pr.id = pg.admin_id;

  if v_n > v_lim then
    v_rows := v_rows - v_lim;
    v_next := jsonb_build_object(
      't', app_private.cursor_ts(((v_rows -> (v_lim - 1)) ->> 'started_at')::timestamptz),
      'id', (v_rows -> (v_lim - 1)) ->> 'id');
  end if;
  return jsonb_build_object('rows', v_rows, 'next_cursor', v_next);
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_list_tickets
-- ---------------------------------------------------------------------------
create or replace function public.platform_list_tickets(
  p_status text default null,
  p_cursor jsonb default null,
  p_limit  integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim    integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_status public.support_ticket_status;
  v_ct     timestamptz;
  v_cid    uuid;
  v_has_c  boolean := false;
  v_rows   jsonb;
  v_n      integer;
  v_next   jsonb := null;
begin
  perform app_private.require_platform(false);

  if nullif(btrim(coalesce(p_status, '')), '') is not null then
    if btrim(p_status) not in ('open', 'in_progress', 'resolved', 'closed') then
      raise exception 'INVALID_STATUS: status inválido' using errcode = '22023';
    end if;
    v_status := btrim(p_status)::public.support_ticket_status;
  end if;
  if p_cursor is not null and p_cursor <> 'null'::jsonb then
    select pc.t, pc.id into v_ct, v_cid from app_private.parse_cursor(p_cursor) pc;
    v_has_c := true;
  end if;

  with page as (
    select t.*
      from public.support_tickets t
     where (v_status is null or t.status = v_status)
       and (not v_has_c or (t.created_at, t.id) < (v_ct, v_cid))
     order by t.created_at desc, t.id desc
     limit v_lim + 1
  )
  select count(*)::integer,
         coalesce(jsonb_agg(
           jsonb_build_object(
             'id', pg.id, 'restaurant_id', pg.restaurant_id,
             'restaurant_name', r.name, 'restaurant_slug', r.slug,
             'opened_by', pg.opened_by, 'opened_by_name', pr.full_name,
             'subject', pg.subject, 'body', pg.body, 'status', pg.status,
             'created_at', pg.created_at, 'updated_at', pg.updated_at)
           order by pg.created_at desc, pg.id desc), '[]'::jsonb)
    into v_n, v_rows
    from page pg
    left join public.restaurants r on r.id = pg.restaurant_id
    left join public.profiles pr on pr.id = pg.opened_by;

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
-- platform_list_audit_logs (SUPERADMIN)
-- ---------------------------------------------------------------------------
create or replace function public.platform_list_audit_logs(
  p_actor         uuid default null,
  p_action_prefix text default null,
  p_restaurant    uuid default null,
  p_from          timestamptz default null,
  p_to            timestamptz default null,
  p_cursor        jsonb default null,
  p_limit         integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim    integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_prefix text := nullif(btrim(coalesce(p_action_prefix, '')), '');
  v_pat    text;
  v_ct     timestamptz;
  v_cid    uuid;
  v_has_c  boolean := false;
  v_rows   jsonb;
  v_n      integer;
  v_next   jsonb := null;
begin
  perform app_private.require_platform(true);

  if p_from is not null and p_to is not null and p_from >= p_to then
    raise exception 'INVALID_PERIOD: período inválido' using errcode = '22023';
  end if;
  if v_prefix is not null then
    if length(v_prefix) > 64 then
      raise exception 'INVALID_PREFIX: prefixo muito longo' using errcode = '22023';
    end if;
    v_pat := app_private.like_escape(v_prefix) || '%';
  end if;
  if p_cursor is not null and p_cursor <> 'null'::jsonb then
    select pc.t, pc.id into v_ct, v_cid from app_private.parse_cursor(p_cursor) pc;
    v_has_c := true;
  end if;

  with page as (
    select l.*
      from public.audit_logs l
     where (p_actor is null or l.actor_id = p_actor)
       and (p_restaurant is null or l.restaurant_id = p_restaurant)
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
             'id', pg.id, 'created_at', pg.created_at,
             'restaurant_id', pg.restaurant_id, 'restaurant_name', r.name,
             'actor_id', pg.actor_id, 'actor_name', pr.full_name,
             'action', pg.action, 'resource_type', pg.resource_type, 'resource_id', pg.resource_id,
             'metadata', app_private.sanitize_audit_metadata(pg.metadata))
           order by pg.created_at desc, pg.id desc), '[]'::jsonb)
    into v_n, v_rows
    from page pg
    left join public.restaurants r on r.id = pg.restaurant_id
    left join public.profiles pr on pr.id = pg.actor_id;

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
-- platform_get_settings
-- ---------------------------------------------------------------------------
create or replace function public.platform_get_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app_private.require_platform(false);
  return jsonb_build_object(
    'registration_enabled', app_private.platform_setting('registration_enabled'),
    'default_trial_days', app_private.platform_setting('default_trial_days'),
    'support_email', app_private.platform_setting('support_email'),
    'maintenance_message', app_private.platform_setting('maintenance_message'),
    'updated_at', (select max(s.updated_at) from public.platform_settings s));
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_list_plans (extra): todos os planos + quantidade de assinaturas vigentes/total
-- ---------------------------------------------------------------------------
create or replace function public.platform_list_plans()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  perform app_private.require_platform(false);
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', p.id, 'code', p.code, 'name', p.name, 'description', p.description,
             'price_cents', p.price_cents, 'currency', p.currency, 'billing_interval', p.billing_interval,
             'limits', p.limits, 'features', p.features, 'is_active', p.is_active, 'sort_order', p.sort_order,
             'subscriptions_total', (select count(*) from public.subscriptions s where s.plan_id = p.id),
             'subscriptions_live', (select count(*) from public.subscriptions s
                                     where s.plan_id = p.id and s.status in ('trialing', 'active', 'past_due')))
           order by p.sort_order, p.code), '[]'::jsonb)
    into v_rows
    from public.plans p;
  return jsonb_build_object('rows', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_support_overview: visão somente leitura SOB SESSÃO DE SUPORTE ATIVA do próprio admin
-- ---------------------------------------------------------------------------
create or replace function public.platform_support_overview(p_session uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_s    public.support_sessions%rowtype;
  v_r    public.restaurants%rowtype;
  v_set  public.restaurant_settings%rowtype;
  v_menu jsonb;
  v_team jsonb;
  v_ord  jsonb;
  v_tabs jsonb;
begin
  perform app_private.require_platform(false);

  select s.* into v_s
    from public.support_sessions s
   where s.id = p_session
     and s.admin_id = v_uid
     and s.ended_at is null
     and s.expires_at > pg_catalog.now();
  if not found then
    raise exception 'SUPPORT_SESSION_INVALID: sessão de suporte inexistente, expirada ou encerrada' using errcode = '42501';
  end if;

  select r.* into v_r from public.restaurants r where r.id = v_s.restaurant_id;
  if not found then
    raise exception 'RESTAURANT_NOT_FOUND: não encontrado' using errcode = 'P0002';
  end if;
  select rs.* into v_set from public.restaurant_settings rs where rs.restaurant_id = v_r.id;

  select jsonb_build_object(
           'categories', (select count(*) from public.menu_categories c where c.restaurant_id = v_r.id),
           'categories_active', (select count(*) from public.menu_categories c where c.restaurant_id = v_r.id and c.is_active),
           'products', (select count(*) from public.products p where p.restaurant_id = v_r.id),
           'products_active', (select count(*) from public.products p where p.restaurant_id = v_r.id and p.is_active),
           'products_available', (select count(*) from public.products p
                                   where p.restaurant_id = v_r.id and p.is_active and p.is_available),
           'tables', (select count(*) from public.restaurant_tables t where t.restaurant_id = v_r.id))
    into v_menu;

  select coalesce(jsonb_agg(
           jsonb_build_object('role', m.role, 'status', m.status, 'full_name', pr.full_name)
           order by m.created_at, m.id), '[]'::jsonb) into v_team
    from public.restaurant_memberships m
    left join public.profiles pr on pr.id = m.user_id
   where m.restaurant_id = v_r.id;

  select coalesce(jsonb_agg(
           jsonb_build_object('order_number', o.order_number, 'status', o.status,
                              'fulfillment_type', o.fulfillment_type, 'payment_status', o.payment_status,
                              'total_cents', o.total_cents, 'created_at', o.created_at)
           order by o.created_at desc, o.id desc), '[]'::jsonb) into v_ord
    from (select * from public.orders x where x.restaurant_id = v_r.id
           order by x.created_at desc, x.id desc limit 50) o;

  select coalesce(jsonb_agg(
           jsonb_build_object('label', t.label, 'total_cents', t.total_cents, 'opened_at', t.opened_at)
           order by t.opened_at desc, t.id desc), '[]'::jsonb) into v_tabs
    from public.tabs t
   where t.restaurant_id = v_r.id and t.status = 'OPEN';

  perform public.log_audit(
    v_r.id, 'support.overview_viewed', 'support_session', v_s.id,
    jsonb_build_object('session_id', v_s.id));

  return jsonb_build_object(
    'session', jsonb_build_object('id', v_s.id, 'restaurant_id', v_s.restaurant_id, 'reason', v_s.reason,
                                  'started_at', v_s.started_at, 'expires_at', v_s.expires_at),
    'restaurant', jsonb_build_object('id', v_r.id, 'slug', v_r.slug, 'name', v_r.name, 'status', v_r.status,
                                     'timezone', v_r.timezone, 'created_at', v_r.created_at),
    'menu', v_menu,
    'settings', case when v_set.restaurant_id is null then null else jsonb_build_object(
      'accepts_orders', v_set.accepts_orders, 'prep_time_minutes', v_set.prep_time_minutes,
      'min_order_cents', v_set.min_order_cents, 'enabled_fulfillment_types', v_set.enabled_fulfillment_types,
      'single_tab_per_table', v_set.single_tab_per_table, 'pickup_instructions', v_set.pickup_instructions,
      'whatsapp', v_set.whatsapp, 'phone', v_set.phone, 'address_text', v_set.address_text,
      'storefront_url', v_set.storefront_url) end,
    'team', v_team,
    'recent_orders', v_ord,
    'open_tabs', v_tabs);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.platform_dashboard() from public, anon, authenticated;
revoke all on function public.platform_list_restaurants(text, text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.platform_get_restaurant(uuid) from public, anon, authenticated;
revoke all on function public.platform_list_subscriptions(text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.platform_list_support_sessions(boolean, jsonb, integer) from public, anon, authenticated;
revoke all on function public.platform_list_tickets(text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.platform_list_audit_logs(uuid, text, uuid, timestamptz, timestamptz, jsonb, integer) from public, anon, authenticated;
revoke all on function public.platform_get_settings() from public, anon, authenticated;
revoke all on function public.platform_list_plans() from public, anon, authenticated;
revoke all on function public.platform_support_overview(uuid) from public, anon, authenticated;

grant execute on function public.platform_dashboard() to authenticated;
grant execute on function public.platform_list_restaurants(text, text, jsonb, integer) to authenticated;
grant execute on function public.platform_get_restaurant(uuid) to authenticated;
grant execute on function public.platform_list_subscriptions(text, jsonb, integer) to authenticated;
grant execute on function public.platform_list_support_sessions(boolean, jsonb, integer) to authenticated;
grant execute on function public.platform_list_tickets(text, jsonb, integer) to authenticated;
grant execute on function public.platform_list_audit_logs(uuid, text, uuid, timestamptz, timestamptz, jsonb, integer) to authenticated;
grant execute on function public.platform_get_settings() to authenticated;
grant execute on function public.platform_list_plans() to authenticated;
grant execute on function public.platform_support_overview(uuid) to authenticated;
