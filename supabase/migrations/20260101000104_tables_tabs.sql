-- =============================================================================
-- DB-2 / 0104 — Mesas e comandas.
-- Visibilidade: tables.view / tabs.view (o owner só lê). Operação: tables.operate
-- / tabs.manage (o owner NÃO as tem). Máquinas de estado e colunas protegidas
-- ficam nos triggers da migração 0107.
-- Mesas/comandas NÃO são públicas (anon sem acesso); o cliente chega à mesa por
-- um token de QR resolvido dentro de RPC.
-- =============================================================================

create table public.restaurant_tables (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 60),
  area          text check (area is null or length(area) <= 60),
  capacity      integer check (capacity is null or capacity > 0),
  status        public.table_status not null default 'AVAILABLE',
  sort_order    integer not null default 0,
  -- Token aleatório para QR code da mesa (nunca o id sequencial/adivinhável).
  qr_token      text not null default public.generate_public_code(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (restaurant_id, name),
  unique (qr_token)
);
create index restaurant_tables_restaurant_status_idx on public.restaurant_tables (restaurant_id, status, sort_order);

create table public.tabs (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references public.restaurants (id) on delete cascade,
  table_id         uuid,                       -- null = comanda avulsa/balcão
  label            text check (label is null or length(label) <= 80),  -- nome do cliente/identificação
  guests           integer check (guests is null or guests > 0),
  status           public.tab_status not null default 'OPEN',
  status_reason    text,
  opened_by        uuid references auth.users (id) on delete set null,
  opened_at        timestamptz not null default now(),
  closed_by        uuid references auth.users (id) on delete set null,
  closed_at        timestamptz,
  total_cents      integer not null default 0 check (total_cents >= 0),
  -- Cópia de restaurant_settings.single_tab_per_table no momento da abertura
  -- (definida por trigger; o cliente não consegue forçar false).
  single_per_table boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, table_id)
    references public.restaurant_tables (restaurant_id, id) on delete set null (table_id),
  constraint tabs_closed_at_consistent check ((status = 'OPEN') = (closed_at is null)),
  constraint tabs_cancel_reason_required
    check (status <> 'CANCELLED' or length(btrim(coalesce(status_reason, ''))) > 0)
);
create index tabs_restaurant_status_created_idx on public.tabs (restaurant_id, status, created_at desc);
create index tabs_table_idx on public.tabs (restaurant_id, table_id) where table_id is not null;

-- No máximo UMA comanda aberta por mesa (quando a regra single_per_table vale,
-- que é o padrão). Concorrência: o índice único serializa aberturas simultâneas.
create unique index tabs_one_open_per_table_uidx
  on public.tabs (restaurant_id, table_id)
  where status = 'OPEN' and table_id is not null and single_per_table;

create table public.tab_status_history (
  id            bigint generated always as identity primary key,
  restaurant_id uuid not null,
  tab_id        uuid not null,
  from_status   public.tab_status,
  to_status     public.tab_status not null,
  changed_by    uuid references auth.users (id) on delete set null,
  reason        text,
  created_at    timestamptz not null default now(),
  foreign key (restaurant_id, tab_id) references public.tabs (restaurant_id, id) on delete cascade
);
create index tab_status_history_tab_idx on public.tab_status_history (restaurant_id, tab_id, created_at);

create trigger restaurant_tables_touch before update on public.restaurant_tables
  for each row execute function public.set_updated_at();
create trigger tabs_touch before update on public.tabs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.restaurant_tables enable row level security;
alter table public.tabs              enable row level security;
alter table public.tab_status_history enable row level security;

create policy restaurant_tables_select on public.restaurant_tables
  for select to authenticated
  using (public.has_permission(restaurant_id, 'tables.view') or public.has_support_access(restaurant_id));
create policy restaurant_tables_insert on public.restaurant_tables
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'tables.manage'));
-- UPDATE: configurar (tables.manage) OU mudar estado operacional (tables.operate).
-- O trigger separa o que cada permissão pode alterar (colunas x status).
create policy restaurant_tables_update on public.restaurant_tables
  for update to authenticated
  using (public.has_permission(restaurant_id, 'tables.manage') or public.has_permission(restaurant_id, 'tables.operate'))
  with check (public.has_permission(restaurant_id, 'tables.manage') or public.has_permission(restaurant_id, 'tables.operate'));
-- Só mesa desativada pode ser apagada (preserva histórico de comandas/pedidos).
create policy restaurant_tables_delete on public.restaurant_tables
  for delete to authenticated
  using (public.has_permission(restaurant_id, 'tables.manage') and status = 'INACTIVE');

create policy tabs_select on public.tabs
  for select to authenticated
  using (public.has_permission(restaurant_id, 'tabs.view') or public.has_support_access(restaurant_id));
-- A abertura direta só cria comanda OPEN, zerada, aberta pelo próprio usuário.
create policy tabs_insert on public.tabs
  for insert to authenticated
  with check (
    public.has_permission(restaurant_id, 'tabs.manage')
    and status = 'OPEN' and total_cents = 0 and closed_at is null
    and opened_by = (select auth.uid())
  );
create policy tabs_update on public.tabs
  for update to authenticated
  using (public.has_permission(restaurant_id, 'tabs.manage'))
  with check (public.has_permission(restaurant_id, 'tabs.manage'));
-- sem DELETE: comandas são registro financeiro; cancelar = status CANCELLED.

create policy tab_status_history_select on public.tab_status_history
  for select to authenticated
  using (public.has_permission(restaurant_id, 'tabs.view') or public.has_support_access(restaurant_id));
-- histórico é escrito só por trigger SECURITY DEFINER (sem policy de escrita).
