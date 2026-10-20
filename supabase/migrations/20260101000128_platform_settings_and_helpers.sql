-- =============================================================================
-- 0128 · Fase 6 (DB-8) · platform_settings, helpers internos, public_platform_flags,
--        register_restaurant (registration_enabled + trial padrão)
--
-- platform_settings(key pk, value jsonb, updated_by, updated_at): RLS habilitada e FORÇADA, SEM policies
-- e SEM grants para anon/authenticated -> só as RPCs SECURITY DEFINER leem/escrevem.
-- Chaves permitidas (CHECK): registration_enabled, default_trial_days, support_email, maintenance_message.
-- Valores validados na RPC platform_set_setting (migração 0130).
--
-- Funções (todas SECURITY DEFINER, search_path = ''):
--   public.public_platform_flags()            anon + authenticated -> {"registration_enabled": bool}
--   public.register_restaurant(text, text)    CREATE OR REPLACE (0111) + REGISTRATION_DISABLED + trial padrão
--   app_private.*                             helpers internos (sem EXECUTE para anon/authenticated/PUBLIC)
--
-- Erros novos: UNAUTHENTICATED (28000) · FORBIDDEN (42501) · REGISTRATION_DISABLED (P0001)
--              INVALID_STATUS (22023)
--
-- Decisões:
--   * Vocabulário de status de assinatura nas RPCs de plataforma: trial | active | past_due | cancelled
--     (contrato). O enum do banco é trialing | active | past_due | canceled; as entradas aceitam os dois
--     vocabulários, as SAÍDAS usam o do contrato.
--   * register_restaurant: o comportamento anterior (mensagens em minúsculas, limite de 5, advisory lock,
--     restaurante PENDING) é preservado. Acrescenta: (1) registration_enabled=false -> REGISTRATION_DISABLED
--     (logo após a autenticação); (2) assinatura trial no plano padrão (plano ativo de menor sort_order),
--     duração = default_trial_days (padrão 14; 0 => trial já vencido, sem current_period_end).
--     Sem plano ativo, nenhuma assinatura é criada (não bloqueia o cadastro).
-- =============================================================================

create table public.platform_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),
  constraint platform_settings_key_chk check (
    key in ('registration_enabled', 'default_trial_days', 'support_email', 'maintenance_message')
  )
);

alter table public.platform_settings enable row level security;
alter table public.platform_settings force row level security;
-- Sem policies: nenhum acesso direto por clientes (SELECT/INSERT/UPDATE/DELETE negados).
revoke all on public.platform_settings from public, anon, authenticated;

insert into public.platform_settings (key, value) values
  ('registration_enabled', 'true'::jsonb),
  ('default_trial_days', '14'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Helpers internos
-- ---------------------------------------------------------------------------
-- p_super = true  -> exige superadmin; false -> qualquer platform admin (superadmin ou support).
-- Todo não autorizado (usuário comum, dono, equipe, support em ação de superadmin) recebe FORBIDDEN idêntico.
create or replace function app_private.require_platform(p_super boolean default false)
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
  if not (case when p_super then public.is_platform_superadmin() else public.is_platform_admin() end) then
    raise exception 'FORBIDDEN: acesso restrito à plataforma' using errcode = '42501';
  end if;
end;
$$;

create or replace function app_private.sub_status_out(p public.subscription_status)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p::text when 'trialing' then 'trial' when 'canceled' then 'cancelled' else p::text end;
$$;

-- Aceita o vocabulário do contrato e o do enum; qualquer outro -> INVALID_STATUS.
create or replace function app_private.sub_status_in(p text)
returns public.subscription_status
language plpgsql
immutable
set search_path = ''
as $$
begin
  return case lower(btrim(coalesce(p, '')))
    when 'trial' then 'trialing'::public.subscription_status
    when 'trialing' then 'trialing'::public.subscription_status
    when 'active' then 'active'::public.subscription_status
    when 'past_due' then 'past_due'::public.subscription_status
    when 'cancelled' then 'canceled'::public.subscription_status
    when 'canceled' then 'canceled'::public.subscription_status
    else null
  end;
end;
$$;

create or replace function app_private.platform_setting(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.value from public.platform_settings s where s.key = p_key),
    case p_key
      when 'registration_enabled' then 'true'::jsonb
      when 'default_trial_days' then '14'::jsonb
      else 'null'::jsonb
    end
  );
$$;

-- Assinatura trial no plano padrão (ativo, menor sort_order). Retorna o id ou NULL se não há plano ativo.
create or replace function app_private.create_trial_subscription(p_restaurant uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan  uuid;
  v_days  integer;
  v_end   timestamptz;
  v_id    uuid;
begin
  select p.id into v_plan
  from public.plans p
  where p.is_active
  order by p.sort_order, p.created_at, p.code
  limit 1;
  if v_plan is null then
    return null;
  end if;

  begin
    v_days := least(greatest((app_private.platform_setting('default_trial_days') #>> '{}')::numeric, 0), 365)::integer;
  exception when others then
    v_days := 14;
  end;
  v_end := pg_catalog.now() + pg_catalog.make_interval(days => v_days);

  insert into public.subscriptions (restaurant_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
  values (
    p_restaurant, v_plan, 'trialing', v_end, pg_catalog.now(),
    case when v_days > 0 then v_end else null end
  )
  on conflict do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- Remove (recursivamente) chaves de contato/endereço do metadata de auditoria exibido à plataforma
-- sem sessão de suporte (além da sanitização de segredos).
create or replace function app_private.platform_audit_metadata(p jsonb, p_depth integer default 0)
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
  if p_depth = 0 then
    p := app_private.sanitize_audit_metadata(p);
  end if;
  if p_depth > 8 then
    return '"[truncado]"'::jsonb;
  end if;
  case jsonb_typeof(p)
    when 'object' then
      res := '{}'::jsonb;
      for k, v in select e.key, e.value from jsonb_each(p) e loop
        if k ~* '(e-?mail|phone|telefone|whats|address|endere|cpf|cnpj|customer_name|nome_cliente)' then
          continue;
        end if;
        res := res || jsonb_build_object(k, app_private.platform_audit_metadata(v, p_depth + 1));
      end loop;
      return res;
    when 'array' then
      select coalesce(jsonb_agg(app_private.platform_audit_metadata(e, p_depth + 1)), '[]'::jsonb)
        into res from jsonb_array_elements(p) e;
      return res;
    else
      return p;
  end case;
end;
$$;

revoke all on function app_private.require_platform(boolean) from public, anon, authenticated;
revoke all on function app_private.sub_status_out(public.subscription_status) from public, anon, authenticated;
revoke all on function app_private.sub_status_in(text) from public, anon, authenticated;
revoke all on function app_private.platform_setting(text) from public, anon, authenticated;
revoke all on function app_private.create_trial_subscription(uuid) from public, anon, authenticated;
revoke all on function app_private.platform_audit_metadata(jsonb, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- public_platform_flags (anon): somente registration_enabled
-- ---------------------------------------------------------------------------
create or replace function public.public_platform_flags()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'registration_enabled',
    coalesce((app_private.platform_setting('registration_enabled') #>> '{}')::boolean, true)
  );
$$;

revoke all on function public.public_platform_flags() from public, anon, authenticated;
grant execute on function public.public_platform_flags() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- register_restaurant (base: 0111) + REGISTRATION_DISABLED + trial padrão
-- ---------------------------------------------------------------------------
create or replace function public.register_restaurant(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := pg_catalog.btrim(coalesce(p_name, ''));
  v_slug  text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, '')));
  v_id    uuid;
  v_owned integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if coalesce((app_private.platform_setting('registration_enabled') #>> '{}')::boolean, true) is not true then
    raise exception 'REGISTRATION_DISABLED: novos cadastros estão temporariamente desativados' using errcode = 'P0001';
  end if;
  if pg_catalog.char_length(v_name) not between 2 and 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  -- F-07: chamadas simultâneas do mesmo usuário passam uma de cada vez.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text, 0));

  select pg_catalog.count(*) into v_owned
  from public.restaurant_memberships m
  where m.user_id = v_uid and m.role = 'owner' and m.status <> 'revoked';
  if v_owned >= 5 then
    raise exception 'restaurant_limit_reached' using errcode = '54000';
  end if;

  begin
    insert into public.restaurants (name, slug, status, created_by)
    values (v_name, v_slug, 'pending', v_uid)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'slug_unavailable' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_slug' using errcode = '23514';
  end;

  insert into public.restaurant_memberships (restaurant_id, user_id, role, status, invited_by)
  values (v_id, v_uid, 'owner', 'active', v_uid);

  perform app_private.create_trial_subscription(v_id);

  perform public.log_audit(
    v_id, 'restaurant.registered', 'restaurant', v_id,
    jsonb_build_object('slug', v_slug, 'by', 'self_service')
  );
  return v_id;
end;
$$;

revoke execute on function public.register_restaurant(text, text) from public, anon, authenticated;
grant  execute on function public.register_restaurant(text, text) to authenticated;
