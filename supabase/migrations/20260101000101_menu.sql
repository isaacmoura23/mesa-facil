-- =============================================================================
-- DB-2 / 0101 — Cardápio: categorias, produtos, grupos de modificadores,
-- modificadores e vínculo produto<->grupo.
--
-- Isolamento entre tenants: toda tabela tem restaurant_id e as relações usam
-- FKs COMPOSTAS (restaurant_id, id) -> impossível ligar linhas de restaurantes
-- diferentes, mesmo com bug no app.
-- Soft-delete: is_active=false (nunca apagar o que já foi vendido).
-- =============================================================================

create table public.menu_categories (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 120),
  description   text check (description is null or length(description) <= 500),
  sort_order    integer not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id)
);
create index menu_categories_restaurant_idx on public.menu_categories (restaurant_id, sort_order);

create table public.products (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  category_id   uuid,
  name          text not null check (length(btrim(name)) between 1 and 160),
  description   text check (description is null or length(description) <= 1000),
  price_cents   integer not null check (price_cents >= 0),
  -- Caminho no bucket 'restaurant-public': restaurants/{restaurant_id}/products/...
  image_path    text check (image_path is null or length(image_path) <= 500),
  is_available  boolean not null default true,  -- em estoque agora (pode aparecer como "indisponível")
  is_active     boolean not null default true,  -- soft-delete / oculto do cardápio
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, category_id)
    references public.menu_categories (restaurant_id, id) on delete set null (category_id)
);
create index products_restaurant_category_idx on public.products (restaurant_id, category_id, sort_order);
create index products_category_fk_idx on public.products (category_id) where category_id is not null;

create table public.modifier_groups (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  name           text not null check (length(btrim(name)) between 1 and 120),
  min_selections integer not null default 0 check (min_selections >= 0),
  max_selections integer not null default 1 check (max_selections >= 1),
  is_active      boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, id),
  constraint modifier_groups_min_le_max check (min_selections <= max_selections)
);
create index modifier_groups_restaurant_idx on public.modifier_groups (restaurant_id, sort_order);

create table public.modifiers (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     uuid not null,
  group_id          uuid not null,
  name              text not null check (length(btrim(name)) between 1 and 120),
  price_delta_cents integer not null default 0 check (price_delta_cents >= 0),
  is_available      boolean not null default true,
  is_active         boolean not null default true,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, group_id)
    references public.modifier_groups (restaurant_id, id) on delete cascade
);
create index modifiers_group_idx on public.modifiers (restaurant_id, group_id, sort_order);

create table public.product_modifier_groups (
  restaurant_id uuid not null,
  product_id    uuid not null,
  group_id      uuid not null,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  primary key (product_id, group_id),
  foreign key (restaurant_id, product_id)
    references public.products (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, group_id)
    references public.modifier_groups (restaurant_id, id) on delete cascade
);
create index product_modifier_groups_group_idx on public.product_modifier_groups (restaurant_id, group_id);

create trigger menu_categories_touch before update on public.menu_categories
  for each row execute function public.set_updated_at();
create trigger products_touch before update on public.products
  for each row execute function public.set_updated_at();
create trigger modifier_groups_touch before update on public.modifier_groups
  for each row execute function public.set_updated_at();
create trigger modifiers_touch before update on public.modifiers
  for each row execute function public.set_updated_at();

-- Produto que já foi vendido nunca pode ser apagado (policy de DELETE usa isto).
-- order_items é criada em 0105; a função é plpgsql (corpo resolvido em execução).
create or replace function public.product_has_orders(pid uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Só responde a membros do restaurante dono do produto (não vaza dado entre tenants).
  return coalesce(
    (select public.is_member(p.restaurant_id)
            and exists (select 1 from public.order_items oi where oi.product_id = p.id)
       from public.products p where p.id = pid),
    false);
end;
$$;
revoke execute on function public.product_has_orders(uuid) from public, anon;
grant  execute on function public.product_has_orders(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- Leitura: (a) público/anon só do que está ativo em restaurante 'active';
--          (b) membros ativos do restaurante veem tudo (inclusive inativos);
--          (c) sessão de suporte (somente SELECT).
-- Escrita: exclusivamente menu.manage (o owner tem; kitchen/cashier/waiter não).
-- ---------------------------------------------------------------------------
alter table public.menu_categories       enable row level security;
alter table public.products              enable row level security;
alter table public.modifier_groups       enable row level security;
alter table public.modifiers             enable row level security;
alter table public.product_modifier_groups enable row level security;

-- menu_categories
create policy menu_categories_select_public on public.menu_categories
  for select to anon, authenticated
  using (is_active and public.restaurant_is_public(restaurant_id));
create policy menu_categories_select_staff on public.menu_categories
  for select to authenticated
  using (public.is_member(restaurant_id) or public.has_support_access(restaurant_id));
create policy menu_categories_insert on public.menu_categories
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'menu.manage'));
create policy menu_categories_update on public.menu_categories
  for update to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage'))
  with check (public.has_permission(restaurant_id, 'menu.manage'));
create policy menu_categories_delete on public.menu_categories
  for delete to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage'));

-- products
create policy products_select_public on public.products
  for select to anon, authenticated
  using (is_active and public.restaurant_is_public(restaurant_id));
create policy products_select_staff on public.products
  for select to authenticated
  using (public.is_member(restaurant_id) or public.has_support_access(restaurant_id));
create policy products_insert on public.products
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'menu.manage'));
create policy products_update on public.products
  for update to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage'))
  with check (public.has_permission(restaurant_id, 'menu.manage'));
-- DELETE físico só de produto jamais vendido; senão use is_active=false.
create policy products_delete on public.products
  for delete to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage') and not public.product_has_orders(id));

-- modifier_groups
create policy modifier_groups_select_public on public.modifier_groups
  for select to anon, authenticated
  using (is_active and public.restaurant_is_public(restaurant_id));
create policy modifier_groups_select_staff on public.modifier_groups
  for select to authenticated
  using (public.is_member(restaurant_id) or public.has_support_access(restaurant_id));
create policy modifier_groups_insert on public.modifier_groups
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'menu.manage'));
create policy modifier_groups_update on public.modifier_groups
  for update to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage'))
  with check (public.has_permission(restaurant_id, 'menu.manage'));
create policy modifier_groups_delete on public.modifier_groups
  for delete to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage'));

-- modifiers
create policy modifiers_select_public on public.modifiers
  for select to anon, authenticated
  using (is_active and public.restaurant_is_public(restaurant_id));
create policy modifiers_select_staff on public.modifiers
  for select to authenticated
  using (public.is_member(restaurant_id) or public.has_support_access(restaurant_id));
create policy modifiers_insert on public.modifiers
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'menu.manage'));
create policy modifiers_update on public.modifiers
  for update to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage'))
  with check (public.has_permission(restaurant_id, 'menu.manage'));
create policy modifiers_delete on public.modifiers
  for delete to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage'));

-- product_modifier_groups (vínculo; sem dado sensível)
create policy pmg_select_public on public.product_modifier_groups
  for select to anon, authenticated
  using (public.restaurant_is_public(restaurant_id));
create policy pmg_select_staff on public.product_modifier_groups
  for select to authenticated
  using (public.is_member(restaurant_id) or public.has_support_access(restaurant_id));
create policy pmg_insert on public.product_modifier_groups
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'menu.manage'));
create policy pmg_update on public.product_modifier_groups
  for update to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage'))
  with check (public.has_permission(restaurant_id, 'menu.manage'));
create policy pmg_delete on public.product_modifier_groups
  for delete to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage'));
