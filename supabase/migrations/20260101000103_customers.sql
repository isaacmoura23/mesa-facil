-- =============================================================================
-- DB-2 / 0103 — Clientes e endereços (DADOS PESSOAIS / LGPD).
-- anon NUNCA acessa estas tabelas. SELECT: orders.view ou reports.view (ou
-- sessão de suporte). Escrita: orders.create (cadastro no atendimento).
-- Sem policy de DELETE: apagamento/anonimização será via RPC auditada.
-- =============================================================================

create table public.customers (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 160),
  phone         text check (phone is null or length(phone) between 8 and 20),
  email         text check (email is null or length(email) <= 254),
  notes         text check (notes is null or length(notes) <= 1000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id)
);
-- Um telefone identifica um cliente por restaurante.
create unique index customers_restaurant_phone_uidx
  on public.customers (restaurant_id, phone) where phone is not null;
create index customers_restaurant_created_idx on public.customers (restaurant_id, created_at desc);

create table public.customer_addresses (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  customer_id   uuid not null,
  label         text check (label is null or length(label) <= 60),
  postal_code   text check (postal_code is null or length(postal_code) <= 12),
  street        text not null check (length(btrim(street)) between 1 and 200),
  number        text check (number is null or length(number) <= 20),
  complement    text check (complement is null or length(complement) <= 120),
  neighborhood  text check (neighborhood is null or length(neighborhood) <= 120),
  city          text check (city is null or length(city) <= 120),
  state         text check (state is null or length(state) <= 2),
  reference     text check (reference is null or length(reference) <= 200),
  is_default    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, customer_id)
    references public.customers (restaurant_id, id) on delete cascade
);
create index customer_addresses_customer_idx on public.customer_addresses (restaurant_id, customer_id);
create unique index customer_addresses_one_default_uidx
  on public.customer_addresses (customer_id) where is_default;

create trigger customers_touch before update on public.customers
  for each row execute function public.set_updated_at();
create trigger customer_addresses_touch before update on public.customer_addresses
  for each row execute function public.set_updated_at();

alter table public.customers          enable row level security;
alter table public.customer_addresses enable row level security;

create policy customers_select on public.customers
  for select to authenticated
  using (
    public.has_permission(restaurant_id, 'orders.view')
    or public.has_permission(restaurant_id, 'reports.view')
    or public.has_support_access(restaurant_id)
  );
create policy customers_insert on public.customers
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'orders.create'));
create policy customers_update on public.customers
  for update to authenticated
  using (public.has_permission(restaurant_id, 'orders.create'))
  with check (public.has_permission(restaurant_id, 'orders.create'));

create policy customer_addresses_select on public.customer_addresses
  for select to authenticated
  using (
    public.has_permission(restaurant_id, 'orders.view')
    or public.has_permission(restaurant_id, 'reports.view')
    or public.has_support_access(restaurant_id)
  );
create policy customer_addresses_insert on public.customer_addresses
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'orders.create'));
create policy customer_addresses_update on public.customer_addresses
  for update to authenticated
  using (public.has_permission(restaurant_id, 'orders.create'))
  with check (public.has_permission(restaurant_id, 'orders.create'));
create policy customer_addresses_delete on public.customer_addresses
  for delete to authenticated
  using (public.has_permission(restaurant_id, 'orders.create'));
