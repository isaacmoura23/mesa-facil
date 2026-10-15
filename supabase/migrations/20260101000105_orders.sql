-- =============================================================================
-- DB-2 / 0105 — Pedidos: orders, itens, modificadores (snapshots), histórico de
-- status, contador sequencial por restaurante e tabela de transições válidas.
--
-- Segurança:
--  * LEITURA: orders.view (o owner lê; não opera). Sessão de suporte: só SELECT.
--  * ESCRITA: orders/order_items/order_item_modifiers NÃO têm policy de INSERT —
--    pedidos nascem por RPC SECURITY DEFINER (create_public_order / pedido de
--    balcão), que recalcula preços no servidor. anon nunca toca estas tabelas.
--  * UPDATE direto em orders só para quem tem permissão operacional de status,
--    e o trigger (0107) congela todas as demais colunas para chamadas diretas.
--  * Sem DELETE: pedido é registro fiscal/financeiro.
-- =============================================================================

-- Contador sequencial por restaurante. Sem policies e sem grants: acessível
-- apenas via next_order_number() (UPDATE ... RETURNING atômico).
create table public.order_counters (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  last_number   bigint not null default 0
);

-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING é atômico: duas transações
-- concorrentes no mesmo restaurante serializam na linha do contador, sem
-- duplicar nem pular números (exceto rollback da transação do pedido, que
-- desfaz o incremento também).
create or replace function public.next_order_number(rid uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_number bigint;
begin
  insert into public.order_counters as c (restaurant_id, last_number)
  values (rid, 1)
  on conflict (restaurant_id) do update set last_number = c.last_number + 1
  returning c.last_number into v_number;
  return v_number::integer;
end;
$$;
revoke execute on function public.next_order_number(uuid) from public, anon, authenticated;

create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  restaurant_id      uuid not null references public.restaurants (id) on delete cascade,
  order_number       integer not null,
  -- Código público inadivinhável para acompanhamento (resolvido por RPC).
  public_code        text not null default public.generate_public_code() unique,
  source             text not null default 'PUBLIC_WEB' check (source in ('PUBLIC_WEB', 'STAFF')),
  fulfillment_type   public.fulfillment_type not null,
  status             public.order_status not null default 'RECEIVED',
  payment_status     public.payment_status not null default 'UNPAID',
  status_reason      text,

  customer_id        uuid,
  -- Snapshots: o pedido sobrevive à edição/remoção do cadastro do cliente.
  customer_name      text check (customer_name is null or length(customer_name) <= 160),
  customer_phone     text check (customer_phone is null or length(customer_phone) <= 20),
  customer_email     text check (customer_email is null or length(customer_email) <= 254),
  delivery_address   jsonb,
  table_id           uuid,
  table_label        text,   -- snapshot do nome da mesa (kitchen não tem tables.view)
  tab_id             uuid,

  subtotal_cents     integer not null check (subtotal_cents >= 0),
  delivery_fee_cents integer not null default 0 check (delivery_fee_cents >= 0),
  discount_cents     integer not null default 0 check (discount_cents >= 0),
  total_cents        integer not null check (total_cents >= 0),

  notes              text check (notes is null or length(notes) <= 1000),
  -- Única por restaurante: reenvio do mesmo checkout não duplica o pedido.
  idempotency_key    text check (idempotency_key is null or length(idempotency_key) between 8 and 200),
  created_by         uuid references auth.users (id) on delete set null,  -- staff que lançou (balcão)

  estimated_ready_at timestamptz,
  confirmed_at       timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  rejected_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (restaurant_id, id),
  unique (restaurant_id, order_number),
  unique (restaurant_id, idempotency_key),
  foreign key (restaurant_id, customer_id)
    references public.customers (restaurant_id, id) on delete set null (customer_id),
  foreign key (restaurant_id, table_id)
    references public.restaurant_tables (restaurant_id, id) on delete set null (table_id),
  foreign key (restaurant_id, tab_id)
    references public.tabs (restaurant_id, id) on delete set null (tab_id),

  constraint orders_total_matches check (total_cents = subtotal_cents + delivery_fee_cents - discount_cents),
  constraint orders_delivery_has_address check (fulfillment_type <> 'DELIVERY' or delivery_address is not null),
  constraint orders_fee_only_delivery check (fulfillment_type = 'DELIVERY' or delivery_fee_cents = 0),
  constraint orders_reason_required
    check (status not in ('REJECTED', 'CANCELLED') or length(btrim(coalesce(status_reason, ''))) > 0)
);
create index orders_restaurant_status_created_idx on public.orders (restaurant_id, status, created_at desc);
create index orders_restaurant_created_idx on public.orders (restaurant_id, created_at desc);
create index orders_customer_idx on public.orders (restaurant_id, customer_id) where customer_id is not null;
create index orders_tab_idx on public.orders (restaurant_id, tab_id) where tab_id is not null;
create index orders_table_idx on public.orders (restaurant_id, table_id) where table_id is not null;

create table public.order_items (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null,
  order_id            uuid not null,
  product_id          uuid,   -- SET NULL se o produto for removido; o snapshot abaixo preserva o histórico
  product_name        text not null check (length(btrim(product_name)) > 0),
  unit_price_cents    integer not null check (unit_price_cents >= 0),
  modifiers_cents     integer not null default 0 check (modifiers_cents >= 0),  -- soma dos modificadores por unidade
  quantity            integer not null check (quantity > 0),
  line_total_cents    integer not null check (line_total_cents >= 0),
  notes               text check (notes is null or length(notes) <= 500),
  created_at          timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, order_id) references public.orders (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, product_id)
    references public.products (restaurant_id, id) on delete set null (product_id),
  constraint order_items_line_total check (line_total_cents = (unit_price_cents + modifiers_cents) * quantity)
);
create index order_items_order_idx on public.order_items (restaurant_id, order_id);
create index order_items_product_idx on public.order_items (product_id) where product_id is not null;

create table public.order_item_modifiers (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     uuid not null,
  order_item_id     uuid not null,
  modifier_id       uuid,
  group_name        text,
  modifier_name     text not null check (length(btrim(modifier_name)) > 0),
  price_delta_cents integer not null default 0 check (price_delta_cents >= 0),
  quantity          integer not null default 1 check (quantity > 0),
  created_at        timestamptz not null default now(),
  foreign key (restaurant_id, order_item_id)
    references public.order_items (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, modifier_id)
    references public.modifiers (restaurant_id, id) on delete set null (modifier_id)
);
create index order_item_modifiers_item_idx on public.order_item_modifiers (restaurant_id, order_item_id);

create table public.order_status_history (
  id            bigint generated always as identity primary key,
  restaurant_id uuid not null,
  order_id      uuid not null,
  from_status   public.order_status,       -- null = criação
  to_status     public.order_status not null,
  changed_by    uuid references auth.users (id) on delete set null,  -- null = sistema/público
  reason        text,
  created_at    timestamptz not null default now(),
  foreign key (restaurant_id, order_id) references public.orders (restaurant_id, id) on delete cascade
);
create index order_status_history_order_idx on public.order_status_history (restaurant_id, order_id, created_at);

-- ---------------------------------------------------------------------------
-- Tabela de transições válidas (fonte única; o trigger e as RPCs consultam).
-- ---------------------------------------------------------------------------
create table public.order_status_transitions (
  fulfillment_type    public.fulfillment_type not null,
  from_status         public.order_status not null,
  to_status           public.order_status not null,
  required_permission text not null,
  primary key (fulfillment_type, from_status, to_status),
  constraint order_status_transitions_not_same check (from_status <> to_status)
);

insert into public.order_status_transitions (fulfillment_type, from_status, to_status, required_permission)
select ft, f, t, p
from (
  values
    -- fluxo feliz comum a todas as modalidades
    ('RECEIVED'::public.order_status,  'CONFIRMED'::public.order_status, 'orders.accept'),
    ('RECEIVED',                       'REJECTED',                       'orders.reject'),
    ('CONFIRMED',                      'PREPARING',                      'orders.update_status'),
    ('PREPARING',                      'READY',                          'orders.update_status')
) as base (f, t, p)
cross join unnest(enum_range(null::public.fulfillment_type)) as ft;

-- READY -> COMPLETED (retirada e consumo no local)
insert into public.order_status_transitions (fulfillment_type, from_status, to_status, required_permission)
values
  ('PICKUP',  'READY', 'COMPLETED', 'orders.update_status'),
  ('DINE_IN', 'READY', 'COMPLETED', 'orders.update_status'),
-- entrega: READY -> OUT_FOR_DELIVERY -> COMPLETED
  ('DELIVERY', 'READY',            'OUT_FOR_DELIVERY', 'orders.update_status'),
  ('DELIVERY', 'OUT_FOR_DELIVERY', 'COMPLETED',        'orders.update_status');

-- qualquer estado ativo -> CANCELLED (exige orders.cancel)
insert into public.order_status_transitions (fulfillment_type, from_status, to_status, required_permission)
select ft, s, 'CANCELLED', 'orders.cancel'
from unnest(enum_range(null::public.fulfillment_type)) as ft
cross join unnest(array['RECEIVED', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY']::public.order_status[]) as s
where not (s = 'OUT_FOR_DELIVERY' and ft <> 'DELIVERY');

create trigger orders_touch before update on public.orders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.order_counters           enable row level security;  -- sem policies: ninguém via API
alter table public.orders                   enable row level security;
alter table public.order_items              enable row level security;
alter table public.order_item_modifiers     enable row level security;
alter table public.order_status_history     enable row level security;
alter table public.order_status_transitions enable row level security;

create policy orders_select on public.orders
  for select to authenticated
  using (public.has_permission(restaurant_id, 'orders.view') or public.has_support_access(restaurant_id));

-- UPDATE: só quem tem alguma permissão operacional de status. O owner não tem
-- nenhuma => não consegue. O trigger valida a permissão exata da transição e
-- congela as outras colunas.
create policy orders_update on public.orders
  for update to authenticated
  using (
    public.has_permission(restaurant_id, 'orders.accept')
    or public.has_permission(restaurant_id, 'orders.reject')
    or public.has_permission(restaurant_id, 'orders.update_status')
    or public.has_permission(restaurant_id, 'orders.cancel')
  )
  with check (
    public.has_permission(restaurant_id, 'orders.accept')
    or public.has_permission(restaurant_id, 'orders.reject')
    or public.has_permission(restaurant_id, 'orders.update_status')
    or public.has_permission(restaurant_id, 'orders.cancel')
  );

create policy order_items_select on public.order_items
  for select to authenticated
  using (public.has_permission(restaurant_id, 'orders.view') or public.has_support_access(restaurant_id));

create policy order_item_modifiers_select on public.order_item_modifiers
  for select to authenticated
  using (public.has_permission(restaurant_id, 'orders.view') or public.has_support_access(restaurant_id));

create policy order_status_history_select on public.order_status_history
  for select to authenticated
  using (public.has_permission(restaurant_id, 'orders.view') or public.has_support_access(restaurant_id));

-- Dados de referência (sem tenant, sem dado pessoal): leitura para logados.
create policy order_status_transitions_select on public.order_status_transitions
  for select to authenticated
  using (true);
