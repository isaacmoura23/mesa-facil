-- =============================================================================
-- 0126 · Fase 5 (DB-7) · Endurecimento das tabelas de configuração
--
-- O que mudou (lacunas encontradas na auditoria de grants/validação):
--  restaurants
--   * [mantido] UPDATE por restaurant.settings.manage (policy 0013) e trigger guard_restaurants_update
--     já impedem não-superadmin de alterar status/slug; as colunas continuam concedidas porque o
--     superadmin atua pela role authenticated. Nada a revogar.
--   * [novo] trigger valida timezone contra pg_timezone_names (INVALID_TIMEZONE, 23514): antes
--     qualquer texto de 1..64 chars era aceito e quebraria "AT TIME ZONE" nos relatórios.
--  restaurant_settings
--   * [novo] UPDATE restrito às colunas editáveis (restaurant_id/created_at/updated_at não são mais
--     graváveis por clientes). INSERT segue igual (a UI cria a linha 1:1 se faltar).
--   * [novo] CHECKs: min_order_cents <= 10.000.000; no máx. 3 tipos de atendimento, sem NULL.
--  business_hours
--   * [novo] UPDATE só em weekday/opens_at/closes_at (restaurant_id/id imutáveis p/ clientes:
--     impede mover linha para outro restaurante). CHECK weekday 0..6 e opens_at <> closes_at já
--     existiam (closes_at < opens_at = virada de dia).
--   * [novo] trigger: máx. 6 faixas por dia da semana; faixas do mesmo dia não podem se sobrepor
--     (virada de dia conta como [abre, 24h+fecha)); o transbordo para o dia seguinte não é checado.
--     Erros: BUSINESS_HOURS_LIMIT / BUSINESS_HOURS_OVERLAP (23514).
--  business_hour_exceptions
--   * [novo] UPDATE só em on_date/is_closed/opens_at/closes_at/description.
--   * [novo] CHECK: exceção "fechado" não carrega horários; trigger: máx. 400 exceções (EXCEPTIONS_LIMIT).
--  delivery_zones
--   * [novo] UPDATE só nas colunas editáveis; CHECKs: fee_cents <= 100.000 (R$ 1.000), min_order_cents
--     <= 10.000.000, estimated_minutes <= 1440, neighborhoods <= 100 itens sem NULL, prefixos de CEP
--     <= 50, só dígitos (1..8), sem NULL; trigger: máx. 50 zonas por restaurante (ZONES_LIMIT).
--   (fee/min >= 0 e name 1..120 já existiam.)
-- Os triggers de limite/sobreposição só validam quando o chamador tem a permissão; sem ela a RLS
-- continua sendo a única resposta (erro de permissão, não vaza regra de negócio).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- restaurants.timezone
-- ---------------------------------------------------------------------------
create or replace function app_private.validate_restaurant_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.timezone is distinct from old.timezone then
    if not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = new.timezone) then
      raise exception 'INVALID_TIMEZONE: fuso horário desconhecido' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_restaurant_timezone() from public, anon, authenticated;

drop trigger if exists restaurants_validate_timezone on public.restaurants;
create trigger restaurants_validate_timezone
  before insert or update of timezone on public.restaurants
  for each row execute function app_private.validate_restaurant_timezone();

-- ---------------------------------------------------------------------------
-- restaurant_settings
-- ---------------------------------------------------------------------------
revoke update on public.restaurant_settings from authenticated;
grant update (accepts_orders, prep_time_minutes, min_order_cents, enabled_fulfillment_types,
              pickup_instructions, single_tab_per_table, whatsapp, phone, address_text,
              storefront_origins, storefront_url)
  on public.restaurant_settings to authenticated;

alter table public.restaurant_settings
  add constraint restaurant_settings_min_order_max check (min_order_cents <= 10000000),
  add constraint restaurant_settings_fulfillment_valid
    check (cardinality(enabled_fulfillment_types) <= 3 and array_position(enabled_fulfillment_types, null) is null);

-- ---------------------------------------------------------------------------
-- business_hours
-- ---------------------------------------------------------------------------
revoke update on public.business_hours from authenticated;
grant update (weekday, opens_at, closes_at) on public.business_hours to authenticated;

create or replace function app_private.validate_business_hours()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_s integer := (extract(epoch from new.opens_at) / 60)::integer;
  v_e integer := (extract(epoch from new.closes_at) / 60)::integer;
  v_n integer;
begin
  if current_user in ('anon', 'authenticated')
     and not public.has_permission(new.restaurant_id, 'restaurant.settings.manage') then
    return new;  -- a RLS decide
  end if;
  if v_e <= v_s then
    v_e := v_e + 1440;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('business_hours:' || new.restaurant_id::text, 0));

  select count(*) into v_n from public.business_hours h
   where h.restaurant_id = new.restaurant_id and h.weekday = new.weekday and h.id <> new.id;
  if v_n >= 6 then
    raise exception 'BUSINESS_HOURS_LIMIT: no máximo 6 faixas por dia' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.business_hours h
     where h.restaurant_id = new.restaurant_id and h.weekday = new.weekday and h.id <> new.id
       and (extract(epoch from h.opens_at) / 60)::integer < v_e
       and v_s < (extract(epoch from h.closes_at) / 60)::integer
                 + case when h.closes_at <= h.opens_at then 1440 else 0 end
  ) then
    raise exception 'BUSINESS_HOURS_OVERLAP: faixa sobrepõe outra do mesmo dia' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_business_hours() from public, anon, authenticated;

drop trigger if exists business_hours_validate on public.business_hours;
create trigger business_hours_validate
  before insert or update of weekday, opens_at, closes_at on public.business_hours
  for each row execute function app_private.validate_business_hours();

-- ---------------------------------------------------------------------------
-- business_hour_exceptions
-- ---------------------------------------------------------------------------
revoke update on public.business_hour_exceptions from authenticated;
grant update (on_date, is_closed, opens_at, closes_at, description) on public.business_hour_exceptions to authenticated;

alter table public.business_hour_exceptions
  add constraint business_hour_exceptions_closed_no_times
    check (not is_closed or (opens_at is null and closes_at is null));

create or replace function app_private.validate_hour_exceptions()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and not public.has_permission(new.restaurant_id, 'restaurant.settings.manage') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hour_exceptions:' || new.restaurant_id::text, 0));
  if (select count(*) from public.business_hour_exceptions e where e.restaurant_id = new.restaurant_id) >= 400 then
    raise exception 'EXCEPTIONS_LIMIT: máximo de 400 exceções' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_hour_exceptions() from public, anon, authenticated;

drop trigger if exists business_hour_exceptions_validate on public.business_hour_exceptions;
create trigger business_hour_exceptions_validate
  before insert on public.business_hour_exceptions
  for each row execute function app_private.validate_hour_exceptions();

-- ---------------------------------------------------------------------------
-- delivery_zones
-- ---------------------------------------------------------------------------
revoke update on public.delivery_zones from authenticated;
grant update (name, fee_cents, min_order_cents, estimated_minutes, neighborhoods, postal_code_prefixes, is_active)
  on public.delivery_zones to authenticated;

alter table public.delivery_zones
  add constraint delivery_zones_fee_max check (fee_cents <= 100000),
  add constraint delivery_zones_min_order_max check (min_order_cents <= 10000000),
  add constraint delivery_zones_eta_max check (estimated_minutes is null or estimated_minutes <= 1440),
  add constraint delivery_zones_neighborhoods_valid
    check (cardinality(neighborhoods) <= 100 and array_position(neighborhoods, null) is null
           and octet_length(array_to_string(neighborhoods, '|')) <= 6000),
  add constraint delivery_zones_prefixes_valid
    check (cardinality(postal_code_prefixes) <= 50 and array_position(postal_code_prefixes, null) is null
           and array_to_string(postal_code_prefixes, ',') ~ '^([0-9]{1,8}(,[0-9]{1,8})*)?$');

create or replace function app_private.validate_delivery_zones()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and not public.has_permission(new.restaurant_id, 'restaurant.settings.manage') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('delivery_zones:' || new.restaurant_id::text, 0));
  if (select count(*) from public.delivery_zones z where z.restaurant_id = new.restaurant_id) >= 50 then
    raise exception 'ZONES_LIMIT: máximo de 50 zonas de entrega' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app_private.validate_delivery_zones() from public, anon, authenticated;

drop trigger if exists delivery_zones_validate on public.delivery_zones;
create trigger delivery_zones_validate
  before insert on public.delivery_zones
  for each row execute function app_private.validate_delivery_zones();
