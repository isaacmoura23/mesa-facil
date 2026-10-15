-- =============================================================================
-- 0006 · audit_logs, support_sessions, support_tickets
-- =============================================================================

-- Append-only. Sem FK em restaurant_id/actor_id de propósito: o histórico de
-- auditoria sobrevive à remoção de restaurantes/usuários (e FKs com ação
-- referencial tentariam UPDATE/DELETE, bloqueados pelo trigger de imutabilidade).
create table public.audit_logs (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid,
  actor_id       uuid,
  action         text not null,
  resource_type  text,
  resource_id    uuid,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint audit_logs_action_not_blank check (char_length(btrim(action)) > 0),
  constraint audit_logs_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index audit_logs_restaurant_created_idx on public.audit_logs (restaurant_id, created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);
create index audit_logs_resource_idx on public.audit_logs (resource_type, resource_id);

-- ---------------------------------------------------------------------------
-- Sessões de suporte (acesso temporário SOMENTE LEITURA de um platform admin)
-- ---------------------------------------------------------------------------
create table public.support_sessions (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references public.restaurants (id) on delete cascade,
  admin_id       uuid not null references auth.users (id) on delete cascade,
  reason         text not null,
  started_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  ended_at       timestamptz,
  constraint support_sessions_reason_chk check (char_length(btrim(reason)) >= 10 and char_length(reason) <= 500),
  constraint support_sessions_expiry_chk check (
    expires_at > started_at and expires_at <= started_at + interval '60 minutes'
  ),
  constraint support_sessions_ended_chk check (ended_at is null or ended_at >= started_at)
);

-- Consulta quente de has_support_access: sessões abertas do admin para um restaurante.
create index support_sessions_active_idx
  on public.support_sessions (admin_id, restaurant_id, expires_at)
  where ended_at is null;
create index support_sessions_restaurant_idx on public.support_sessions (restaurant_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Tickets simples do módulo de suporte
-- ---------------------------------------------------------------------------
create table public.support_tickets (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid references public.restaurants (id) on delete set null,
  opened_by      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject        text not null,
  body           text,
  status         public.support_ticket_status not null default 'open',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint support_tickets_subject_chk check (char_length(btrim(subject)) between 3 and 200),
  constraint support_tickets_body_chk check (body is null or char_length(body) <= 5000)
);

create index support_tickets_restaurant_status_idx on public.support_tickets (restaurant_id, status);
create index support_tickets_opened_by_idx on public.support_tickets (opened_by, created_at desc);
create index support_tickets_status_idx on public.support_tickets (status, created_at desc);

create trigger support_tickets_set_updated_at
  before update on public.support_tickets
  for each row execute function public.set_updated_at();
