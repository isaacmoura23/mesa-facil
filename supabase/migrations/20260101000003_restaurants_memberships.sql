-- =============================================================================
-- 0003 · restaurants, restaurant_memberships, platform_admins
-- =============================================================================

create table public.restaurants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null,
  status      public.restaurant_status not null default 'pending',
  logo_path   text,
  timezone    text not null default 'America/Sao_Paulo',
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint restaurants_slug_key unique (slug),
  constraint restaurants_name_len check (char_length(btrim(name)) between 2 and 120),
  constraint restaurants_slug_format check (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 63
  ),
  -- Slugs que colidiriam com rotas fixas da aplicação / uso institucional.
  constraint restaurants_slug_reserved check (
    slug <> all (array[
      'admin', 'api', 'app', 'auth', 'login', 'logout', 'signup', 'register', 'cadastro', 'entrar',
      'dashboard', 'painel', 'plataforma', 'platform', 'suporte', 'support', 'settings',
      'static', 'public', 'assets', 'www', 'health', 'status', 'billing', 'planos', 'plans'
    ]::text[])
  ),
  constraint restaurants_timezone_not_blank check (char_length(btrim(timezone)) between 1 and 64),
  constraint restaurants_logo_path_len check (logo_path is null or char_length(logo_path) <= 500)
);

comment on table public.restaurants is 'Tenant. slug apenas identifica; autorização vem de memberships.';
comment on column public.restaurants.status is 'Só a plataforma altera (trigger guard_restaurants_update).';

create index restaurants_status_idx on public.restaurants (status);

create trigger restaurants_set_updated_at
  before update on public.restaurants
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Vínculos usuário <-> restaurante. Escrita SOMENTE via RPC (ver 0008/0012).
-- user_id é nulo enquanto o convite aponta apenas para um e-mail ainda sem conta.
-- ---------------------------------------------------------------------------
create table public.restaurant_memberships (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  user_id        uuid references auth.users (id) on delete cascade,
  role           public.restaurant_role not null,
  status         public.membership_status not null default 'invited',
  invited_email  text,
  invited_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint restaurant_memberships_restaurant_user_key unique (restaurant_id, user_id),
  -- Necessário para a FK composta de membership_permission_overrides (consistência do tenant).
  constraint restaurant_memberships_id_restaurant_key unique (id, restaurant_id),
  constraint restaurant_memberships_identity_chk check (user_id is not null or invited_email is not null),
  constraint restaurant_memberships_active_has_user_chk check (status <> 'active' or user_id is not null),
  constraint restaurant_memberships_email_chk check (
    invited_email is null or (
      invited_email = lower(invited_email)
      and char_length(invited_email) <= 254
      and invited_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    )
  )
);

comment on table public.restaurant_memberships is
  'Vínculos. SEM insert/update/delete direto para clientes: apenas RPCs SECURITY DEFINER (anti-escalonamento).';

-- Modelo de owner protegido: no máximo UM owner vigente (não revogado) por restaurante.
create unique index restaurant_memberships_one_owner_idx
  on public.restaurant_memberships (restaurant_id)
  where role = 'owner' and status <> 'revoked';

-- Um convite pendente por e-mail por restaurante (enquanto ainda não há user_id).
create unique index restaurant_memberships_pending_email_idx
  on public.restaurant_memberships (restaurant_id, invited_email)
  where status = 'invited' and user_id is null;

create index restaurant_memberships_user_idx
  on public.restaurant_memberships (user_id, status);
create index restaurant_memberships_restaurant_status_idx
  on public.restaurant_memberships (restaurant_id, status);
-- Busca de convites pelo e-mail do usuário logado.
create index restaurant_memberships_invited_email_idx
  on public.restaurant_memberships (invited_email)
  where user_id is null and status = 'invited';

create trigger restaurant_memberships_set_updated_at
  before update on public.restaurant_memberships
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Administradores da plataforma. Promoção SOMENTE via service role/migração.
-- ---------------------------------------------------------------------------
create table public.platform_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        public.platform_admin_role not null default 'support',
  created_at  timestamptz not null default now()
);

comment on table public.platform_admins is
  'Sem nenhuma policy/grant de escrita para clientes. Inserir via service role ou migração.';
