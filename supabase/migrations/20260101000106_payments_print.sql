-- =============================================================================
-- DB-2 / 0106 — Pagamentos e fila de impressão.
--
-- payments: dado financeiro. SELECT para reports.view (owner/manager) ou
--   payments.record (caixa); NÃO para kitchen/waiter. INSERT/UPDATE/DELETE
--   diretos NÃO têm policy: pagamento só é registrado por RPC record_payment
--   (SECURITY DEFINER, valida permissão e valores) ou webhook (service role).
-- print_jobs: um pedido de impressão é só uma REQUISIÇÃO. O status inicial é
--   sempre REQUESTED; 'PRINTED' nunca é automático nem pode ser definido por
--   cliente — exige ação explícita posterior (RPC/serviço de impressão).
-- =============================================================================

create table public.payments (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references public.restaurants (id) on delete cascade,
  order_id           uuid,
  tab_id             uuid,
  method             public.payment_method not null,
  amount_cents       integer not null check (amount_cents > 0),
  status             public.payment_status not null default 'PENDING',
  provider           text check (provider is null or length(provider) <= 60),
  provider_reference text check (provider_reference is null or length(provider_reference) <= 200),
  idempotency_key    text check (idempotency_key is null or length(idempotency_key) between 8 and 200),
  notes              text check (notes is null or length(notes) <= 500),
  recorded_by        uuid references auth.users (id) on delete set null,
  paid_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (restaurant_id, idempotency_key),
  foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id),
  foreign key (restaurant_id, tab_id)
    references public.tabs (restaurant_id, id),
  constraint payments_has_target check (order_id is not null or tab_id is not null),
  constraint payments_status_not_unpaid check (status <> 'UNPAID'),
  constraint payments_reference_needs_provider check (provider_reference is null or provider is not null),
  constraint payments_paid_at_consistent check (status <> 'PAID' or paid_at is not null)
);
-- Referência do gateway única (idempotência de webhook), quando existir.
create unique index payments_provider_reference_uidx
  on public.payments (provider, provider_reference) where provider_reference is not null;
create index payments_restaurant_created_idx on public.payments (restaurant_id, created_at desc);
create index payments_order_idx on public.payments (restaurant_id, order_id) where order_id is not null;
create index payments_tab_idx on public.payments (restaurant_id, tab_id) where tab_id is not null;

create table public.print_jobs (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  document_type  public.print_document_type not null,
  status         public.print_job_status not null default 'REQUESTED',
  order_id       uuid,
  tab_id         uuid,
  copies         integer not null default 1 check (copies between 1 and 10),
  printer_target text check (printer_target is null or length(printer_target) <= 80),
  payload        jsonb not null default '{}'::jsonb,   -- snapshot do documento no momento do pedido
  error_message  text,
  requested_by   uuid references auth.users (id) on delete set null,
  dispatched_at  timestamptz,
  printed_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, order_id)
    references public.orders (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, tab_id)
    references public.tabs (restaurant_id, id) on delete cascade,
  constraint print_jobs_has_target check (order_id is not null or tab_id is not null),
  constraint print_jobs_printed_consistent check ((status = 'PRINTED') = (printed_at is not null))
);
create index print_jobs_restaurant_status_created_idx on public.print_jobs (restaurant_id, status, created_at desc);
create index print_jobs_order_idx on public.print_jobs (restaurant_id, order_id) where order_id is not null;
create index print_jobs_tab_idx on public.print_jobs (restaurant_id, tab_id) where tab_id is not null;

create trigger payments_touch before update on public.payments
  for each row execute function public.set_updated_at();
create trigger print_jobs_touch before update on public.print_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.payments   enable row level security;
alter table public.print_jobs enable row level security;

create policy payments_select on public.payments
  for select to authenticated
  using (
    public.has_permission(restaurant_id, 'reports.view')
    or public.has_permission(restaurant_id, 'payments.record')
    or public.has_support_access(restaurant_id)
  );
-- (sem policies de INSERT/UPDATE/DELETE: somente RPC record_payment / service role)

create policy print_jobs_select on public.print_jobs
  for select to authenticated
  using (
    public.has_permission(restaurant_id, 'orders.view')
    or public.has_permission(restaurant_id, 'print.request')
    or public.has_support_access(restaurant_id)
  );
-- Requisição direta: só REQUESTED, em nome do próprio usuário, sem timestamps de
-- progresso. (A RPC request_print poderá enriquecer o payload.)
create policy print_jobs_insert on public.print_jobs
  for insert to authenticated
  with check (
    public.has_permission(restaurant_id, 'print.request')
    and status = 'REQUESTED'
    and requested_by = (select auth.uid())
    and dispatched_at is null and printed_at is null and error_message is null
  );
-- (sem UPDATE/DELETE para clientes: marcar impresso/falhou é ação de serviço/RPC)
