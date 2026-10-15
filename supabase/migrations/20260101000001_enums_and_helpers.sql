-- =============================================================================
-- 0001 · Pré-requisitos, schema privado, enums do contrato e set_updated_at
-- =============================================================================
-- Nenhuma extensão é necessária: gen_random_uuid() é nativo (PG >= 13) e e-mails
-- são normalizados em minúsculas (sem citext).

-- Segurança: FORCE ROW LEVEL SECURITY só é seguro se o dono das funções
-- SECURITY DEFINER tiver BYPASSRLS (no Supabase, `postgres` tem). Sem isso as
-- funções de apoio (que leem as tabelas sob RLS) recursariam. Falha cedo e claro.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_roles r
    where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)
  ) then
    raise exception 'O papel % precisa de BYPASSRLS/superuser para executar estas migrações (FORCE RLS + SECURITY DEFINER).', current_user;
  end if;
end
$$;

-- Schema privado: funções internas/trigger que NÃO devem ser expostas pela API.
create schema if not exists app_private;
revoke all on schema app_private from public;

-- ---------------------------------------------------------------------------
-- Enums do contrato
-- ---------------------------------------------------------------------------
create type public.restaurant_role as enum ('owner', 'manager', 'cashier', 'kitchen', 'waiter');
create type public.membership_status as enum ('invited', 'active', 'revoked');
create type public.restaurant_status as enum ('pending', 'active', 'suspended');
create type public.platform_admin_role as enum ('superadmin', 'support');

-- Enums auxiliares (billing e suporte)
create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'canceled');
create type public.support_ticket_status as enum ('open', 'in_progress', 'resolved', 'closed');

-- ---------------------------------------------------------------------------
-- Trigger genérico de updated_at
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

-- Função de trigger: ninguém precisa (nem deve) chamá-la pela API.
revoke execute on function public.set_updated_at() from public, anon, authenticated;
