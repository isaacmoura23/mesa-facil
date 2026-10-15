-- =============================================================================
-- 0005 · plans e subscriptions
-- =============================================================================

create table public.plans (
  id               uuid primary key default gen_random_uuid(),
  code             text not null,
  name             text not null,
  description      text,
  price_cents      integer not null,
  currency         text not null default 'BRL',
  billing_interval text not null default 'month',
  limits           jsonb not null default '{}'::jsonb,
  features         jsonb not null default '{}'::jsonb,
  is_active        boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint plans_code_key unique (code),
  constraint plans_code_format check (code ~ '^[a-z0-9_-]+$'),
  constraint plans_price_nonneg check (price_cents >= 0),
  constraint plans_currency_chk check (currency ~ '^[A-Z]{3}$'),
  constraint plans_interval_chk check (billing_interval in ('month', 'year')),
  constraint plans_limits_object check (jsonb_typeof(limits) = 'object'),
  constraint plans_features_object check (jsonb_typeof(features) = 'object')
);

create index plans_active_sort_idx on public.plans (is_active, sort_order);

create trigger plans_set_updated_at
  before update on public.plans
  for each row execute function public.set_updated_at();

create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  restaurant_id          uuid not null references public.restaurants (id) on delete cascade,
  plan_id                uuid not null references public.plans (id) on delete restrict,
  status                 public.subscription_status not null default 'trialing',
  trial_ends_at          timestamptz,
  current_period_start   timestamptz not null default now(),
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint subscriptions_period_chk check (
    current_period_end is null or current_period_end > current_period_start
  )
);

-- No máximo uma assinatura vigente por restaurante.
create unique index subscriptions_one_live_per_restaurant_idx
  on public.subscriptions (restaurant_id)
  where status in ('trialing', 'active', 'past_due');

create index subscriptions_restaurant_status_idx on public.subscriptions (restaurant_id, status);
create index subscriptions_plan_idx on public.subscriptions (plan_id);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();
