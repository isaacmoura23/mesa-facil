-- =============================================================================
-- 0008 · Triggers de proteção (anti-escalonamento, imutabilidade, auditoria)
-- =============================================================================
-- Estratégia em camadas:
--  1) GRANTs: clientes (anon/authenticated) não têm INSERT/UPDATE/DELETE nas tabelas sensíveis;
--  2) RLS: sem policies de escrita;
--  3) estes triggers: mesmo que um GRANT/policy seja aberto por engano, escrita direta de
--     papéis de API falha. As RPCs SECURITY DEFINER rodam como dono (current_user = postgres),
--     então passam. `current_user` (e não um GUC) é usado de propósito: não é forjável pelo cliente.
-- Papéis privilegiados (service_role/postgres) seguem permitidos para manutenção.

-- Bloqueia QUALQUER escrita direta vinda dos papéis da API (nível de statement).
create or replace function app_private.block_client_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'direct_write_forbidden: % em % só é permitido via RPC', tg_op, tg_table_name
      using errcode = '42501';
  end if;
  return null;
end;
$$;

create trigger restaurant_memberships_block_client_writes
  before insert or update or delete or truncate on public.restaurant_memberships
  for each statement execute function app_private.block_client_writes();

create trigger membership_permission_overrides_block_client_writes
  before insert or update or delete or truncate on public.membership_permission_overrides
  for each statement execute function app_private.block_client_writes();

create trigger platform_admins_block_client_writes
  before insert or update or delete or truncate on public.platform_admins
  for each statement execute function app_private.block_client_writes();

create trigger support_sessions_block_client_writes
  before insert or update or delete or truncate on public.support_sessions
  for each statement execute function app_private.block_client_writes();

create trigger role_permissions_block_client_writes
  before insert or update or delete or truncate on public.role_permissions
  for each statement execute function app_private.block_client_writes();

create trigger permissions_block_client_writes
  before insert or update or delete or truncate on public.permissions
  for each statement execute function app_private.block_client_writes();

-- ---------------------------------------------------------------------------
-- restaurant_memberships: colunas estruturais imutáveis e owner protegido
-- (vale também para service role; manutenção excepcional exige desabilitar o trigger).
-- ---------------------------------------------------------------------------
create or replace function app_private.guard_membership_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
     or new.restaurant_id is distinct from old.restaurant_id then
    raise exception 'membership_immutable_column' using errcode = '42501';
  end if;

  -- user_id só pode ser preenchido uma vez (aceite de convite por e-mail).
  if old.user_id is not null and new.user_id is distinct from old.user_id then
    raise exception 'membership_user_immutable' using errcode = '42501';
  end if;

  -- Papel owner: ninguém vira owner por UPDATE nem deixa de ser (nem é revogado).
  if new.role = 'owner' and old.role is distinct from 'owner' then
    raise exception 'owner_cannot_be_assigned' using errcode = '42501';
  end if;
  if old.role = 'owner' and (new.role is distinct from 'owner' or new.status is distinct from old.status) then
    raise exception 'owner_is_protected' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger restaurant_memberships_guard_columns
  before update on public.restaurant_memberships
  for each row execute function app_private.guard_membership_columns();

-- Owner não pode nascer por INSERT fora de create_restaurant/register_restaurant:
-- essas RPCs são o único caminho e já inserem com role='owner' diretamente.

-- ---------------------------------------------------------------------------
-- membership_permission_overrides: nunca para owner, nunca para team.manage
-- ---------------------------------------------------------------------------
create or replace function app_private.guard_permission_overrides()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_role public.restaurant_role;
begin
  select m.role into v_role
  from public.restaurant_memberships m
  where m.id = new.membership_id;

  if v_role = 'owner' then
    raise exception 'owner_permissions_are_fixed' using errcode = '42501';
  end if;
  if new.permission_key = 'team.manage' then
    raise exception 'team_manage_not_delegable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger membership_permission_overrides_guard
  before insert or update on public.membership_permission_overrides
  for each row execute function app_private.guard_permission_overrides();

-- ---------------------------------------------------------------------------
-- restaurants: id/created_at imutáveis; status e slug só pela plataforma
-- ---------------------------------------------------------------------------
create or replace function app_private.guard_restaurants_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'restaurant_id_immutable' using errcode = '42501';
  end if;

  if current_user in ('anon', 'authenticated') then
    if new.created_at is distinct from old.created_at
       or new.created_by is distinct from old.created_by then
      raise exception 'restaurant_column_forbidden' using errcode = '42501';
    end if;
    if (new.status is distinct from old.status or new.slug is distinct from old.slug)
       and not public.is_platform_superadmin() then
      raise exception 'restaurant_status_slug_platform_only' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger restaurants_guard_update
  before update on public.restaurants
  for each row execute function app_private.guard_restaurants_update();

-- Auditoria de mudança de status/slug (inclusive por update direto do superadmin).
create or replace function app_private.audit_restaurants_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status or new.slug is distinct from old.slug then
    perform public.log_audit(
      new.id,
      'restaurant.updated_by_platform',
      'restaurant',
      new.id,
      jsonb_build_object(
        'status_from', old.status, 'status_to', new.status,
        'slug_from', old.slug, 'slug_to', new.slug
      )
    );
  end if;
  return null;
end;
$$;

create trigger restaurants_audit_update
  after update on public.restaurants
  for each row execute function app_private.audit_restaurants_update();

-- ---------------------------------------------------------------------------
-- audit_logs: append-only (inclusive para service role)
-- ---------------------------------------------------------------------------
create or replace function app_private.audit_logs_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs_are_append_only' using errcode = '42501';
end;
$$;

create trigger audit_logs_no_update_delete
  before update or delete on public.audit_logs
  for each row execute function app_private.audit_logs_immutable();

create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function app_private.audit_logs_immutable();

-- Inserção direta por clientes também é barrada (só log_audit/RPCs, como dono).
create trigger audit_logs_block_client_insert
  before insert on public.audit_logs
  for each statement execute function app_private.block_client_writes();
