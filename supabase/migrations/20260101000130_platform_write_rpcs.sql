-- =============================================================================
-- 0130 · Fase 6 (DB-8) · RPCs de ESCRITA da plataforma
--
-- SECURITY DEFINER, search_path = '', EXECUTE só authenticated (REVOKE de PUBLIC/anon).
-- Validação DENTRO (app_private.require_platform): UNAUTHENTICATED / FORBIDDEN (idêntico para qualquer não-admin).
--
--   platform_create_restaurant(p_name, p_slug, p_owner_email)                         SUPERADMIN
--   platform_set_restaurant_status(p_restaurant, p_status, p_reason)                  SUPERADMIN
--   platform_upsert_plan(p_id, p_code, p_name, p_price_cents, p_limits, p_features, p_is_active)   SUPERADMIN
--   platform_set_subscription(p_restaurant, p_plan, p_status, p_period_end, p_note)   SUPERADMIN
--   platform_update_ticket(p_ticket, p_status, p_note)                                superadmin|support
--   platform_set_setting(p_key, p_value jsonb)                                        SUPERADMIN
--
-- Toda escrita grava public.log_audit (ator = auth.uid()). Ações: platform.restaurant_created,
-- platform.restaurant_status_changed, platform.plan_created|plan_updated, platform.subscription_changed,
-- platform.subscription_note, platform.ticket_updated, platform.ticket_note, platform.setting_updated
-- (além do 'restaurant.created'/'restaurant.updated_by_platform' já gravados por create_restaurant/triggers).
--
-- Erros: UNAUTHENTICATED (28000) · FORBIDDEN (42501)
--   create_restaurant: INVALID_NAME · INVALID_SLUG (23514) · SLUG_UNAVAILABLE (23505) · INVALID_EMAIL · OWNER_NOT_FOUND (P0002)
--   status:            RESTAURANT_NOT_FOUND (P0002) · INVALID_STATUS · REASON_REQUIRED (motivo >= 10 chars ao suspender)
--                      · INVALID_REASON (> 500) · INVALID_TRANSITION (pending só pode ir para active)
--   planos:            PLAN_NOT_FOUND (P0002) · INVALID_CODE · CODE_TAKEN (23505) · INVALID_NAME · INVALID_PRICE
--                      · INVALID_LIMITS · INVALID_FEATURES · PLAN_IN_USE (mudar código de plano em uso)
--                      · LAST_ACTIVE_PLAN (não inativar o último plano ativo)
--   assinaturas:       PLAN_INACTIVE · INVALID_STATUS · INVALID_PERIOD · INVALID_NOTE · SUBSCRIPTION_NOT_FOUND (cancelar sem vigente)
--   tickets:           TICKET_NOT_FOUND (P0002) · INVALID_STATUS · INVALID_NOTE
--   settings:          INVALID_SETTING_KEY · INVALID_SETTING_VALUE (todos 22023)
--
-- Decisões:
--   * platform_create_restaurant reaproveita public.create_restaurant (superadmin, owner ativo, auditoria
--     'restaurant.created') e acrescenta a assinatura trial do plano padrão (app_private.create_trial_subscription).
--     Retorna jsonb {id, slug, name, status, owner_id, subscription_id}. O dono precisa ter conta (e-mail,
--     comparação case-insensitive).
--   * Status: active<->suspended livres; pending só -> active; pending->suspended = INVALID_TRANSITION; ninguém
--     volta a 'pending'. Repetir o mesmo status é no-op (changed=false, sem auditoria). O motivo é gravado na auditoria.
--     A suspensão é imediata: is_member/has_permission já excluem restaurantes suspensos.
--   * Planos: sem DELETE (planos nunca são apagados por RPC; só inativados). Chaves de limits aceitas:
--     max_members, max_tables, max_products e as já usadas pelo seed (max_menu_items, max_print_jobs_per_month),
--     inteiros >= 0 ou null. Parâmetros NULL em plano existente = manter. Código imutável se o plano tem assinaturas.
--   * Assinatura: no máximo 1 vigente (trialing|active|past_due) por restaurante (índice único parcial);
--     a RPC atualiza a vigente em vez de criar outra, serializando por FOR UPDATE do restaurante. Se não há
--     vigente, cria nova linha (histórico preservado). p_period_end NULL = manter o fim atual (em nova linha = sem fim).
--     p_plan NULL só é aceito para cancelar ou para manter o plano da vigente. Cancelar sem vigente = SUBSCRIPTION_NOT_FOUND.
--     Status aceito: trial|active|past_due|cancelled (e trialing|canceled).
--   * Notas (p_note de assinatura/ticket) são INTERNAS: vão para uma entrada de auditoria separada com
--     restaurant_id NULL (visível só em platform_list_audit_logs), nunca para a auditoria do restaurante.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- platform_create_restaurant
-- ---------------------------------------------------------------------------
create or replace function public.platform_create_restaurant(
  p_name        text,
  p_slug        text,
  p_owner_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_owner_email, '')));
  v_owner uuid;
  v_id    uuid;
  v_slug  text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, '')));
  v_sub   uuid;
begin
  perform app_private.require_platform(true);

  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or pg_catalog.char_length(v_email) > 254 then
    raise exception 'INVALID_EMAIL: e-mail do dono inválido' using errcode = '22023';
  end if;
  select u.id into v_owner from auth.users u where pg_catalog.lower(u.email) = v_email order by u.created_at limit 1;
  if v_owner is null then
    raise exception 'OWNER_NOT_FOUND: o dono precisa ter uma conta' using errcode = 'P0002';
  end if;

  begin
    v_id := public.create_restaurant(p_name, v_slug, v_owner);
  exception when others then
    case sqlerrm
      when 'invalid_name' then raise exception 'INVALID_NAME: nome inválido' using errcode = '22023';
      when 'invalid_slug' then raise exception 'INVALID_SLUG: slug inválido' using errcode = '23514';
      when 'slug_unavailable' then raise exception 'SLUG_UNAVAILABLE: slug indisponível' using errcode = '23505';
      else raise;
    end case;
  end;

  v_sub := app_private.create_trial_subscription(v_id);

  perform public.log_audit(
    v_id, 'platform.restaurant_created', 'restaurant', v_id,
    jsonb_build_object('slug', v_slug, 'owner_id', v_owner, 'subscription_id', v_sub));

  return jsonb_build_object('id', v_id, 'slug', v_slug, 'name', pg_catalog.btrim(p_name), 'status', 'active',
                            'owner_id', v_owner, 'subscription_id', v_sub);
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_set_restaurant_status
-- ---------------------------------------------------------------------------
create or replace function public.platform_set_restaurant_status(
  p_restaurant uuid,
  p_status     text,
  p_reason     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new    public.restaurant_status;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_r      public.restaurants%rowtype;
begin
  perform app_private.require_platform(true);

  if pg_catalog.btrim(coalesce(p_status, '')) not in ('active', 'suspended') then
    raise exception 'INVALID_STATUS: use active ou suspended' using errcode = '22023';
  end if;
  v_new := pg_catalog.btrim(p_status)::public.restaurant_status;
  if v_reason is not null and pg_catalog.char_length(v_reason) > 500 then
    raise exception 'INVALID_REASON: motivo muito longo' using errcode = '22023';
  end if;
  if v_new = 'suspended' and (v_reason is null or pg_catalog.char_length(v_reason) < 10) then
    raise exception 'REASON_REQUIRED: informe o motivo da suspensão (mín. 10 caracteres)' using errcode = '22023';
  end if;

  select r.* into v_r from public.restaurants r where r.id = p_restaurant for update;
  if not found then
    raise exception 'RESTAURANT_NOT_FOUND: não encontrado' using errcode = 'P0002';
  end if;

  if v_r.status = v_new then
    return jsonb_build_object('id', v_r.id, 'status', v_r.status, 'previous_status', v_r.status, 'changed', false);
  end if;
  if v_r.status = 'pending' and v_new <> 'active' then
    raise exception 'INVALID_TRANSITION: restaurante pendente só pode ser ativado' using errcode = '22023';
  end if;

  update public.restaurants r set status = v_new where r.id = v_r.id;

  perform public.log_audit(
    v_r.id, 'platform.restaurant_status_changed', 'restaurant', v_r.id,
    jsonb_build_object('status_from', v_r.status, 'status_to', v_new, 'reason', v_reason));

  return jsonb_build_object('id', v_r.id, 'status', v_new, 'previous_status', v_r.status, 'changed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_upsert_plan
-- ---------------------------------------------------------------------------
create or replace function public.platform_upsert_plan(
  p_id          uuid,
  p_code        text,
  p_name        text,
  p_price_cents integer,
  p_limits      jsonb default null,
  p_features    jsonb default null,
  p_is_active   boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code   text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_code, ''))), '');
  v_name   text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  v_old    public.plans%rowtype;
  v_plan   public.plans%rowtype;
  v_k      text;
  v_v      jsonb;
  v_n      numeric;
  v_new    boolean := (p_id is null);
begin
  perform app_private.require_platform(true);

  if v_code is not null and v_code !~ '^[a-z0-9-]{2,40}$' then
    raise exception 'INVALID_CODE: código deve casar ^[a-z0-9-]{2,40}$' using errcode = '22023';
  end if;
  if v_name is not null and pg_catalog.char_length(v_name) not between 2 and 80 then
    raise exception 'INVALID_NAME: nome deve ter de 2 a 80 caracteres' using errcode = '22023';
  end if;
  if p_price_cents is not null and (p_price_cents < 0 or p_price_cents > 100000000) then
    raise exception 'INVALID_PRICE: preço inválido' using errcode = '22023';
  end if;

  if p_limits is not null then
    if pg_catalog.jsonb_typeof(p_limits) <> 'object' then
      raise exception 'INVALID_LIMITS: limits deve ser um objeto' using errcode = '22023';
    end if;
    for v_k, v_v in select e.key, e.value from pg_catalog.jsonb_each(p_limits) e loop
      if v_k not in ('max_members', 'max_tables', 'max_products', 'max_menu_items', 'max_print_jobs_per_month') then
        raise exception 'INVALID_LIMITS: chave não permitida (%)', left(v_k, 40) using errcode = '22023';
      end if;
      if pg_catalog.jsonb_typeof(v_v) = 'null' then
        continue;
      end if;
      if pg_catalog.jsonb_typeof(v_v) <> 'number' then
        raise exception 'INVALID_LIMITS: % deve ser inteiro >= 0 ou null', v_k using errcode = '22023';
      end if;
      v_n := (v_v #>> '{}')::numeric;
      if v_n < 0 or v_n <> pg_catalog.trunc(v_n) or v_n > 2147483647 then
        raise exception 'INVALID_LIMITS: % deve ser inteiro >= 0 ou null', v_k using errcode = '22023';
      end if;
    end loop;
  end if;
  if p_features is not null and (
       pg_catalog.jsonb_typeof(p_features) <> 'object' or pg_catalog.length(p_features::text) > 4000) then
    raise exception 'INVALID_FEATURES: features deve ser um objeto (até 4000 caracteres)' using errcode = '22023';
  end if;

  if v_new then
    if v_code is null then
      raise exception 'INVALID_CODE: código obrigatório' using errcode = '22023';
    end if;
    if v_name is null then
      raise exception 'INVALID_NAME: nome obrigatório' using errcode = '22023';
    end if;
    if p_price_cents is null then
      raise exception 'INVALID_PRICE: preço obrigatório' using errcode = '22023';
    end if;
    begin
      insert into public.plans (code, name, price_cents, limits, features, is_active, sort_order)
      values (v_code, v_name, p_price_cents, coalesce(p_limits, '{}'::jsonb), coalesce(p_features, '{}'::jsonb),
              coalesce(p_is_active, true),
              (select coalesce(max(p.sort_order), 0) + 10 from public.plans p))
      returning * into v_plan;
    exception when unique_violation then
      raise exception 'CODE_TAKEN: já existe um plano com esse código' using errcode = '23505';
    end;
    perform public.log_audit(null, 'platform.plan_created', 'plan', v_plan.id,
      jsonb_build_object('code', v_plan.code, 'name', v_plan.name, 'price_cents', v_plan.price_cents,
                         'limits', v_plan.limits, 'is_active', v_plan.is_active));
  else
    select p.* into v_old from public.plans p where p.id = p_id for update;
    if not found then
      raise exception 'PLAN_NOT_FOUND: plano não encontrado' using errcode = 'P0002';
    end if;
    if v_code is not null and v_code <> v_old.code
       and exists (select 1 from public.subscriptions s where s.plan_id = v_old.id) then
      raise exception 'PLAN_IN_USE: plano com assinaturas não pode mudar de código' using errcode = '22023';
    end if;
    if p_is_active is false and v_old.is_active
       and not exists (select 1 from public.plans p where p.is_active and p.id <> v_old.id) then
      raise exception 'LAST_ACTIVE_PLAN: mantenha ao menos um plano ativo' using errcode = '22023';
    end if;
    begin
      update public.plans p set
        code = coalesce(v_code, p.code),
        name = coalesce(v_name, p.name),
        price_cents = coalesce(p_price_cents, p.price_cents),
        limits = coalesce(p_limits, p.limits),
        features = coalesce(p_features, p.features),
        is_active = coalesce(p_is_active, p.is_active)
      where p.id = v_old.id
      returning * into v_plan;
    exception when unique_violation then
      raise exception 'CODE_TAKEN: já existe um plano com esse código' using errcode = '23505';
    end;
    perform public.log_audit(null, 'platform.plan_updated', 'plan', v_plan.id,
      jsonb_build_object('code', v_plan.code, 'name', v_plan.name, 'price_cents', v_plan.price_cents,
                         'limits', v_plan.limits, 'is_active', v_plan.is_active,
                         'previous', jsonb_build_object('code', v_old.code, 'name', v_old.name,
                                                        'price_cents', v_old.price_cents, 'limits', v_old.limits,
                                                        'is_active', v_old.is_active)));
  end if;

  return jsonb_build_object(
    'id', v_plan.id, 'code', v_plan.code, 'name', v_plan.name, 'description', v_plan.description,
    'price_cents', v_plan.price_cents, 'currency', v_plan.currency, 'billing_interval', v_plan.billing_interval,
    'limits', v_plan.limits, 'features', v_plan.features, 'is_active', v_plan.is_active,
    'sort_order', v_plan.sort_order, 'created', v_new);
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_set_subscription
-- ---------------------------------------------------------------------------
create or replace function public.platform_set_subscription(
  p_restaurant uuid,
  p_plan       uuid,
  p_status     text,
  p_period_end timestamptz default null,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.subscription_status;
  v_note   text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_plan   public.plans%rowtype;
  v_live   public.subscriptions%rowtype;
  v_sub    public.subscriptions%rowtype;
  v_before text;
  v_plan_before text;
  v_now    timestamptz := pg_catalog.now();
begin
  perform app_private.require_platform(true);

  v_status := app_private.sub_status_in(p_status);
  if v_status is null then
    raise exception 'INVALID_STATUS: use trial, active, past_due ou cancelled' using errcode = '22023';
  end if;
  if v_note is not null and pg_catalog.char_length(v_note) > 500 then
    raise exception 'INVALID_NOTE: nota muito longa (máx. 500)' using errcode = '22023';
  end if;

  perform 1 from public.restaurants r where r.id = p_restaurant for update;
  if not found then
    raise exception 'RESTAURANT_NOT_FOUND: não encontrado' using errcode = 'P0002';
  end if;

  select s.* into v_live from public.subscriptions s
   where s.restaurant_id = p_restaurant and s.status in ('trialing', 'active', 'past_due')
   for update;

  if p_plan is not null then
    select p.* into v_plan from public.plans p where p.id = p_plan;
    if not found then
      raise exception 'PLAN_NOT_FOUND: plano não encontrado' using errcode = 'P0002';
    end if;
    if not v_plan.is_active and (v_live.id is null or v_live.plan_id <> p_plan) and v_status <> 'canceled' then
      raise exception 'PLAN_INACTIVE: plano inativo' using errcode = '22023';
    end if;
  end if;

  if v_status = 'canceled' then
    if v_live.id is null then
      raise exception 'SUBSCRIPTION_NOT_FOUND: o restaurante não tem assinatura vigente' using errcode = 'P0002';
    end if;
    v_before := app_private.sub_status_out(v_live.status);
    v_plan_before := (select p.code from public.plans p where p.id = v_live.plan_id);
    update public.subscriptions s set
      status = 'canceled',
      plan_id = coalesce(p_plan, s.plan_id),
      cancel_at_period_end = false
    where s.id = v_live.id
    returning * into v_sub;
  elsif v_live.id is not null then
    if p_period_end is not null and p_period_end <= v_live.current_period_start then
      raise exception 'INVALID_PERIOD: o fim do período deve ser posterior ao início' using errcode = '22023';
    end if;
    if p_period_end is not null and p_period_end <= v_now and v_status in ('trialing', 'active') then
      raise exception 'INVALID_PERIOD: o fim do período deve estar no futuro' using errcode = '22023';
    end if;
    v_before := app_private.sub_status_out(v_live.status);
    v_plan_before := (select p.code from public.plans p where p.id = v_live.plan_id);
    update public.subscriptions s set
      status = v_status,
      plan_id = coalesce(p_plan, s.plan_id),
      current_period_end = coalesce(p_period_end, s.current_period_end),
      trial_ends_at = case when v_status = 'trialing' then coalesce(p_period_end, s.trial_ends_at) else s.trial_ends_at end,
      cancel_at_period_end = false
    where s.id = v_live.id
    returning * into v_sub;
  else
    if p_plan is null then
      raise exception 'PLAN_NOT_FOUND: informe o plano' using errcode = 'P0002';
    end if;
    if p_period_end is not null and p_period_end <= v_now then
      raise exception 'INVALID_PERIOD: o fim do período deve estar no futuro' using errcode = '22023';
    end if;
    insert into public.subscriptions (restaurant_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
    values (p_restaurant, p_plan, v_status,
            case when v_status = 'trialing' then p_period_end else null end,
            v_now, p_period_end)
    returning * into v_sub;
  end if;

  perform public.log_audit(
    p_restaurant, 'platform.subscription_changed', 'subscription', v_sub.id,
    jsonb_build_object(
      'status_from', v_before, 'status_to', app_private.sub_status_out(v_sub.status),
      'plan_from', v_plan_before, 'plan_to', (select p.code from public.plans p where p.id = v_sub.plan_id),
      'period_end', v_sub.current_period_end));
  if v_note is not null then
    perform public.log_audit(
      null, 'platform.subscription_note', 'subscription', v_sub.id,
      jsonb_build_object('restaurant_id', p_restaurant, 'note', v_note));
  end if;

  return jsonb_build_object(
    'id', v_sub.id, 'restaurant_id', v_sub.restaurant_id, 'plan_id', v_sub.plan_id,
    'plan_code', (select p.code from public.plans p where p.id = v_sub.plan_id),
    'status', app_private.sub_status_out(v_sub.status),
    'trial_ends_at', v_sub.trial_ends_at, 'current_period_start', v_sub.current_period_start,
    'current_period_end', v_sub.current_period_end, 'cancel_at_period_end', v_sub.cancel_at_period_end);
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_update_ticket (superadmin e support)
-- ---------------------------------------------------------------------------
create or replace function public.platform_update_ticket(
  p_ticket uuid,
  p_status text,
  p_note   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_old  public.support_tickets%rowtype;
  v_new  public.support_tickets%rowtype;
begin
  perform app_private.require_platform(false);

  if pg_catalog.btrim(coalesce(p_status, '')) not in ('open', 'in_progress', 'resolved', 'closed') then
    raise exception 'INVALID_STATUS: status inválido' using errcode = '22023';
  end if;
  if v_note is not null and pg_catalog.char_length(v_note) > 1000 then
    raise exception 'INVALID_NOTE: nota muito longa (máx. 1000)' using errcode = '22023';
  end if;

  select t.* into v_old from public.support_tickets t where t.id = p_ticket for update;
  if not found then
    raise exception 'TICKET_NOT_FOUND: chamado não encontrado' using errcode = 'P0002';
  end if;

  update public.support_tickets t set status = pg_catalog.btrim(p_status)::public.support_ticket_status
   where t.id = v_old.id
   returning * into v_new;

  perform public.log_audit(
    v_old.restaurant_id, 'platform.ticket_updated', 'support_ticket', v_old.id,
    jsonb_build_object('status_from', v_old.status, 'status_to', v_new.status));
  if v_note is not null then
    perform public.log_audit(
      null, 'platform.ticket_note', 'support_ticket', v_old.id,
      jsonb_build_object('restaurant_id', v_old.restaurant_id, 'note', v_note));
  end if;

  return jsonb_build_object('id', v_new.id, 'restaurant_id', v_new.restaurant_id, 'status', v_new.status,
                            'updated_at', v_new.updated_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_set_setting
-- ---------------------------------------------------------------------------
create or replace function public.platform_set_setting(p_key text, p_value jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key   text := pg_catalog.btrim(coalesce(p_key, ''));
  v_val   jsonb := p_value;
  v_text  text;
  v_n     numeric;
  v_old   jsonb;
begin
  perform app_private.require_platform(true);

  if v_key not in ('registration_enabled', 'default_trial_days', 'support_email', 'maintenance_message') then
    raise exception 'INVALID_SETTING_KEY: chave não permitida' using errcode = '22023';
  end if;

  case v_key
    when 'registration_enabled' then
      if v_val is null or pg_catalog.jsonb_typeof(v_val) <> 'boolean' then
        raise exception 'INVALID_SETTING_VALUE: registration_enabled deve ser booleano' using errcode = '22023';
      end if;
    when 'default_trial_days' then
      if v_val is null or pg_catalog.jsonb_typeof(v_val) <> 'number' then
        raise exception 'INVALID_SETTING_VALUE: default_trial_days deve ser inteiro de 0 a 365' using errcode = '22023';
      end if;
      v_n := (v_val #>> '{}')::numeric;
      if v_n < 0 or v_n > 365 or v_n <> pg_catalog.trunc(v_n) then
        raise exception 'INVALID_SETTING_VALUE: default_trial_days deve ser inteiro de 0 a 365' using errcode = '22023';
      end if;
      v_val := pg_catalog.to_jsonb(v_n::integer);
    when 'support_email' then
      if v_val is null or pg_catalog.jsonb_typeof(v_val) = 'null' then
        v_val := 'null'::jsonb;
      elsif pg_catalog.jsonb_typeof(v_val) <> 'string' then
        raise exception 'INVALID_SETTING_VALUE: support_email deve ser texto' using errcode = '22023';
      else
        v_text := pg_catalog.btrim(v_val #>> '{}');
        if pg_catalog.char_length(v_text) > 200 then
          raise exception 'INVALID_SETTING_VALUE: support_email excede 200 caracteres' using errcode = '22023';
        end if;
        v_val := case when v_text = '' then 'null'::jsonb else pg_catalog.to_jsonb(v_text) end;
      end if;
    when 'maintenance_message' then
      if v_val is null or pg_catalog.jsonb_typeof(v_val) = 'null' then
        v_val := 'null'::jsonb;
      elsif pg_catalog.jsonb_typeof(v_val) <> 'string' then
        raise exception 'INVALID_SETTING_VALUE: maintenance_message deve ser texto ou null' using errcode = '22023';
      else
        v_text := pg_catalog.btrim(v_val #>> '{}');
        if pg_catalog.char_length(v_text) > 300 then
          raise exception 'INVALID_SETTING_VALUE: maintenance_message excede 300 caracteres' using errcode = '22023';
        end if;
        v_val := case when v_text = '' then 'null'::jsonb else pg_catalog.to_jsonb(v_text) end;
      end if;
  end case;

  v_old := app_private.platform_setting(v_key);
  insert into public.platform_settings as s (key, value, updated_by, updated_at)
  values (v_key, v_val, auth.uid(), pg_catalog.now())
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  perform public.log_audit(
    null, 'platform.setting_updated', 'platform_setting', null,
    jsonb_build_object('key', v_key, 'from', v_old, 'to', v_val));

  return jsonb_build_object('key', v_key, 'value', v_val);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.platform_create_restaurant(text, text, text) from public, anon, authenticated;
revoke all on function public.platform_set_restaurant_status(uuid, text, text) from public, anon, authenticated;
revoke all on function public.platform_upsert_plan(uuid, text, text, integer, jsonb, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.platform_set_subscription(uuid, uuid, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.platform_update_ticket(uuid, text, text) from public, anon, authenticated;
revoke all on function public.platform_set_setting(text, jsonb) from public, anon, authenticated;

grant execute on function public.platform_create_restaurant(text, text, text) to authenticated;
grant execute on function public.platform_set_restaurant_status(uuid, text, text) to authenticated;
grant execute on function public.platform_upsert_plan(uuid, text, text, integer, jsonb, jsonb, boolean) to authenticated;
grant execute on function public.platform_set_subscription(uuid, uuid, text, timestamptz, text) to authenticated;
grant execute on function public.platform_update_ticket(uuid, text, text) to authenticated;
grant execute on function public.platform_set_setting(text, jsonb) to authenticated;
