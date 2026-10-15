-- =============================================================================
-- DB-2 / 0102 — Operação do restaurante: horários, exceções (feriados),
-- zonas de entrega e configurações 1:1.
-- Dados públicos por natureza (o cliente precisa deles para pedir): anon pode
-- ler SOMENTE de restaurantes 'active'. Escrita: restaurant.settings.manage.
-- Nada sensível pode ser colocado nestas tabelas.
-- =============================================================================

create table public.restaurant_settings (
  restaurant_id             uuid primary key references public.restaurants (id) on delete cascade,
  accepts_orders            boolean not null default true,   -- "aceita_pedidos" (pausa geral)
  prep_time_minutes         integer not null default 30 check (prep_time_minutes between 1 and 600),
  min_order_cents           integer not null default 0 check (min_order_cents >= 0),
  enabled_fulfillment_types public.fulfillment_type[] not null
                              default array['DELIVERY', 'PICKUP']::public.fulfillment_type[],
  pickup_instructions       text check (pickup_instructions is null or length(pickup_instructions) <= 1000),
  -- Regra "uma comanda por mesa": copiada para tabs.single_per_table na abertura.
  single_tab_per_table      boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint restaurant_settings_has_fulfillment
    check (cardinality(enabled_fulfillment_types) >= 1)
);

create table public.business_hours (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  weekday       smallint not null check (weekday between 0 and 6),  -- 0 = domingo
  opens_at      time not null,
  -- closes_at < opens_at representa virada de dia (ex.: 18:00-02:00).
  closes_at     time not null,
  created_at    timestamptz not null default now(),
  constraint business_hours_distinct_times check (opens_at <> closes_at)
);
create index business_hours_restaurant_idx on public.business_hours (restaurant_id, weekday);

create table public.business_hour_exceptions (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  on_date       date not null,
  is_closed     boolean not null default true,
  opens_at      time,
  closes_at     time,
  description   text check (description is null or length(description) <= 200),
  created_at    timestamptz not null default now(),
  unique (restaurant_id, on_date),
  constraint business_hour_exceptions_times
    check (is_closed or (opens_at is not null and closes_at is not null and opens_at <> closes_at))
);

create table public.delivery_zones (
  id                   uuid primary key default gen_random_uuid(),
  restaurant_id        uuid not null references public.restaurants (id) on delete cascade,
  name                 text not null check (length(btrim(name)) between 1 and 120),
  fee_cents            integer not null default 0 check (fee_cents >= 0),
  min_order_cents      integer not null default 0 check (min_order_cents >= 0),
  estimated_minutes    integer check (estimated_minutes is null or estimated_minutes > 0),
  neighborhoods        text[] not null default '{}',
  postal_code_prefixes text[] not null default '{}',   -- prefixos de CEP (somente dígitos)
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (restaurant_id, id)
);
create index delivery_zones_restaurant_idx on public.delivery_zones (restaurant_id, is_active);

create trigger restaurant_settings_touch before update on public.restaurant_settings
  for each row execute function public.set_updated_at();
create trigger delivery_zones_touch before update on public.delivery_zones
  for each row execute function public.set_updated_at();

-- Toda configuração nasce junto com o restaurante (e backfill dos existentes).
-- SECURITY DEFINER: o INSERT em restaurants pode vir de RPC/serviço sem permissão de settings.
create or replace function public.create_restaurant_domain_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.restaurant_settings (restaurant_id) values (new.id)
  on conflict (restaurant_id) do nothing;
  return new;
end;
$$;
revoke execute on function public.create_restaurant_domain_defaults() from public, anon, authenticated;

create trigger restaurants_domain_defaults
  after insert on public.restaurants
  for each row execute function public.create_restaurant_domain_defaults();

insert into public.restaurant_settings (restaurant_id)
select r.id from public.restaurants r
on conflict (restaurant_id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.restaurant_settings      enable row level security;
alter table public.business_hours           enable row level security;
alter table public.business_hour_exceptions enable row level security;
alter table public.delivery_zones           enable row level security;

-- restaurant_settings
create policy restaurant_settings_select_public on public.restaurant_settings
  for select to anon, authenticated
  using (public.restaurant_is_public(restaurant_id));
create policy restaurant_settings_select_staff on public.restaurant_settings
  for select to authenticated
  using (public.is_member(restaurant_id) or public.has_support_access(restaurant_id));
create policy restaurant_settings_insert on public.restaurant_settings
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'restaurant.settings.manage'));
create policy restaurant_settings_update on public.restaurant_settings
  for update to authenticated
  using (public.has_permission(restaurant_id, 'restaurant.settings.manage'))
  with check (public.has_permission(restaurant_id, 'restaurant.settings.manage'));
-- sem policy de DELETE: a linha 1:1 só some com o restaurante (cascade).

-- business_hours
create policy business_hours_select_public on public.business_hours
  for select to anon, authenticated
  using (public.restaurant_is_public(restaurant_id));
create policy business_hours_select_staff on public.business_hours
  for select to authenticated
  using (public.is_member(restaurant_id) or public.has_support_access(restaurant_id));
create policy business_hours_insert on public.business_hours
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'restaurant.settings.manage'));
create policy business_hours_update on public.business_hours
  for update to authenticated
  using (public.has_permission(restaurant_id, 'restaurant.settings.manage'))
  with check (public.has_permission(restaurant_id, 'restaurant.settings.manage'));
create policy business_hours_delete on public.business_hours
  for delete to authenticated
  using (public.has_permission(restaurant_id, 'restaurant.settings.manage'));

-- business_hour_exceptions
create policy business_hour_exceptions_select_public on public.business_hour_exceptions
  for select to anon, authenticated
  using (public.restaurant_is_public(restaurant_id));
create policy business_hour_exceptions_select_staff on public.business_hour_exceptions
  for select to authenticated
  using (public.is_member(restaurant_id) or public.has_support_access(restaurant_id));
create policy business_hour_exceptions_insert on public.business_hour_exceptions
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'restaurant.settings.manage'));
create policy business_hour_exceptions_update on public.business_hour_exceptions
  for update to authenticated
  using (public.has_permission(restaurant_id, 'restaurant.settings.manage'))
  with check (public.has_permission(restaurant_id, 'restaurant.settings.manage'));
create policy business_hour_exceptions_delete on public.business_hour_exceptions
  for delete to authenticated
  using (public.has_permission(restaurant_id, 'restaurant.settings.manage'));

-- delivery_zones (público vê só zonas ativas)
create policy delivery_zones_select_public on public.delivery_zones
  for select to anon, authenticated
  using (is_active and public.restaurant_is_public(restaurant_id));
create policy delivery_zones_select_staff on public.delivery_zones
  for select to authenticated
  using (public.is_member(restaurant_id) or public.has_support_access(restaurant_id));
create policy delivery_zones_insert on public.delivery_zones
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'restaurant.settings.manage'));
create policy delivery_zones_update on public.delivery_zones
  for update to authenticated
  using (public.has_permission(restaurant_id, 'restaurant.settings.manage'))
  with check (public.has_permission(restaurant_id, 'restaurant.settings.manage'));
create policy delivery_zones_delete on public.delivery_zones
  for delete to authenticated
  using (public.has_permission(restaurant_id, 'restaurant.settings.manage'));
