-- =============================================================================
-- 0004 · Catálogo de permissões, matriz padrão e overrides por membro
-- =============================================================================

create table public.permissions (
  key            text primary key,
  description    text not null,
  -- Permissões operacionais NUNCA podem ser do papel owner (nem por override).
  is_operational boolean not null default false,
  created_at     timestamptz not null default now(),
  constraint permissions_key_format check (key ~ '^[a-z_]+(\.[a-z_]+)+$')
);

create table public.role_permissions (
  role            public.restaurant_role not null,
  permission_key  text not null references public.permissions (key) on update cascade on delete cascade,
  primary key (role, permission_key)
);

create index role_permissions_permission_idx on public.role_permissions (permission_key);

create table public.membership_permission_overrides (
  membership_id   uuid not null,
  restaurant_id   uuid not null,
  permission_key  text not null references public.permissions (key) on update cascade on delete cascade,
  granted         boolean not null,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  primary key (membership_id, permission_key),
  -- FK composta: garante que restaurant_id (usado nas policies) bate com o do vínculo.
  constraint membership_permission_overrides_membership_fk
    foreign key (membership_id, restaurant_id)
    references public.restaurant_memberships (id, restaurant_id) on delete cascade
);

create index membership_permission_overrides_restaurant_idx
  on public.membership_permission_overrides (restaurant_id);

comment on table public.membership_permission_overrides is
  'granted=true concede; granted=false remove a permissão padrão do papel. Nunca para owner nem para team.manage.';

-- ---------------------------------------------------------------------------
-- Trava: owner jamais recebe permissão operacional em role_permissions
-- (a mesma regra é aplicada em has_permission e em set_member_permission).
-- ---------------------------------------------------------------------------
create or replace function app_private.guard_role_permissions()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role = 'owner' and exists (
    select 1 from public.permissions p
    where p.key = new.permission_key and p.is_operational
  ) then
    raise exception 'owner_cannot_have_operational_permission: %', new.permission_key
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger role_permissions_guard
  before insert or update on public.role_permissions
  for each row execute function app_private.guard_role_permissions();

-- ---------------------------------------------------------------------------
-- Catálogo (contrato)
-- ---------------------------------------------------------------------------
insert into public.permissions (key, description, is_operational) values
  ('orders.view',                'Ver pedidos',                                         false),
  ('orders.create',              'Criar pedidos',                                       true),
  ('orders.accept',              'Aceitar pedidos',                                     true),
  ('orders.reject',              'Rejeitar pedidos',                                    true),
  ('orders.update_status',       'Atualizar status de pedidos',                         true),
  ('orders.cancel',              'Cancelar pedidos',                                    true),
  ('menu.manage',                'Gerenciar cardápio',                                  false),
  ('tables.view',                'Ver mesas',                                           false),
  ('tables.manage',              'Configurar/cadastrar mesas',                          false),
  ('tables.operate',             'Mudar estado operacional das mesas',                  true),
  ('tabs.view',                  'Ver comandas',                                        false),
  ('tabs.manage',                'Gerenciar comandas',                                  true),
  ('payments.record',            'Registrar pagamentos',                                true),
  ('print.request',              'Solicitar impressões',                                true),
  ('reports.view',               'Ver relatórios',                                      false),
  ('team.manage',                'Gerenciar equipe e permissões',                       false),
  ('restaurant.settings.manage', 'Gerenciar configurações do restaurante',              false);

-- ---------------------------------------------------------------------------
-- Matriz padrão EXATA do contrato (docs/CONTRACT.md)
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role, permission_key) values
  -- owner (somente leitura operacional + gestão)
  ('owner', 'orders.view'), ('owner', 'menu.manage'), ('owner', 'tables.view'), ('owner', 'tables.manage'),
  ('owner', 'tabs.view'), ('owner', 'reports.view'), ('owner', 'team.manage'), ('owner', 'restaurant.settings.manage'),
  -- manager (tudo, exceto team.manage)
  ('manager', 'orders.view'), ('manager', 'orders.create'), ('manager', 'orders.accept'), ('manager', 'orders.reject'),
  ('manager', 'orders.update_status'), ('manager', 'orders.cancel'), ('manager', 'menu.manage'),
  ('manager', 'tables.view'), ('manager', 'tables.manage'), ('manager', 'tables.operate'),
  ('manager', 'tabs.view'), ('manager', 'tabs.manage'), ('manager', 'payments.record'),
  ('manager', 'print.request'), ('manager', 'reports.view'), ('manager', 'restaurant.settings.manage'),
  -- cashier
  ('cashier', 'orders.view'), ('cashier', 'orders.create'), ('cashier', 'orders.accept'), ('cashier', 'orders.reject'),
  ('cashier', 'orders.update_status'), ('cashier', 'tables.view'), ('cashier', 'tables.operate'),
  ('cashier', 'tabs.view'), ('cashier', 'tabs.manage'), ('cashier', 'payments.record'), ('cashier', 'print.request'),
  -- kitchen
  ('kitchen', 'orders.view'), ('kitchen', 'orders.update_status'), ('kitchen', 'print.request'),
  -- waiter
  ('waiter', 'orders.view'), ('waiter', 'orders.create'), ('waiter', 'tables.view'), ('waiter', 'tables.operate'),
  ('waiter', 'tabs.view'), ('waiter', 'tabs.manage'), ('waiter', 'print.request');
