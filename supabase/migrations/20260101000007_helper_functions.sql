-- =============================================================================
-- 0007 · Funções de apoio do contrato
-- =============================================================================
-- Todas: SECURITY DEFINER + set search_path = '' + nomes totalmente qualificados.
-- Padrão de privilégios: REVOKE de public/anon/authenticated e GRANT explícito
-- (o Supabase concede EXECUTE a anon/authenticated por default privileges).

-- ---------------------------------------------------------------------------
-- log_audit: único ponto de escrita em audit_logs (uso interno / outras migrações).
-- Não é chamável por clientes. Ator = auth.uid() (nulo em service role).
-- ---------------------------------------------------------------------------
create or replace function public.log_audit(
  p_restaurant    uuid,
  p_action        text,
  p_resource_type text default null,
  p_resource_id   uuid default null,
  p_metadata      jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_logs (restaurant_id, actor_id, action, resource_type, resource_id, metadata)
  values (p_restaurant, auth.uid(), p_action, p_resource_type, p_resource_id, coalesce(p_metadata, '{}'::jsonb));
$$;

revoke execute on function public.log_audit(uuid, text, text, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Platform admin
-- ---------------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins pa where pa.user_id = auth.uid()
  );
$$;

-- superadmin: operações mutáveis de plataforma (criar restaurante, planos, assinaturas, status).
-- 'support' pode abrir sessões de suporte (somente leitura) e atender tickets.
create or replace function public.is_platform_superadmin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid() and pa.role = 'superadmin'
  );
$$;

-- ---------------------------------------------------------------------------
-- Vínculo/permissões
-- ---------------------------------------------------------------------------
create or replace function public.is_member(rid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.restaurant_memberships m
    join public.restaurants r on r.id = m.restaurant_id
    where m.restaurant_id = rid
      and m.user_id = auth.uid()
      and m.status = 'active'
      and r.status <> 'suspended'
  );
$$;

-- Matriz do papel + overrides. Regras de segurança:
--  * owner: IGNORA overrides e nunca obtém permissão operacional (defesa em profundidade);
--  * team.manage: não pode ser concedido por override (só quem a matriz já dá: owner);
--  * vínculo precisa estar 'active' e restaurante não 'suspended'.
create or replace function public.has_permission(rid uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.restaurant_memberships m
    join public.restaurants r on r.id = m.restaurant_id
    join public.permissions p on p.key = perm
    where m.restaurant_id = rid
      and m.user_id = auth.uid()
      and m.status = 'active'
      and r.status <> 'suspended'
      and not (m.role = 'owner' and p.is_operational)
      and case
            when m.role = 'owner' or perm = 'team.manage' then
              exists (
                select 1 from public.role_permissions rp
                where rp.role = m.role and rp.permission_key = perm
              )
            else
              coalesce(
                (select o.granted
                   from public.membership_permission_overrides o
                  where o.membership_id = m.id and o.permission_key = perm),
                exists (
                  select 1 from public.role_permissions rp
                  where rp.role = m.role and rp.permission_key = perm
                )
              )
          end
  );
$$;

-- Sessão de suporte vigente (não expirada, não encerrada) do próprio platform admin.
-- Concede APENAS leitura: é usada somente em policies de SELECT.
create or replace function public.has_support_access(rid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_platform_admin()
     and exists (
       select 1 from public.support_sessions s
       where s.restaurant_id = rid
         and s.admin_id = auth.uid()
         and s.ended_at is null
         and s.expires_at > pg_catalog.now()
     );
$$;

create or replace function public.my_permissions(rid uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(p.key order by p.key), '{}'::text[])
  from public.permissions p
  where public.has_permission(rid, p.key);
$$;

-- Restaurantes do usuário (vínculo ativo). `status` = status do RESTAURANTE
-- (inclui suspended/pending para a UI mostrar o aviso adequado).
create or replace function public.my_restaurants()
returns table (
  restaurant_id uuid,
  slug          text,
  name          text,
  role          public.restaurant_role,
  status        public.restaurant_status
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.slug, r.name, m.role, r.status
  from public.restaurant_memberships m
  join public.restaurants r on r.id = m.restaurant_id
  where m.user_id = auth.uid()
    and m.status = 'active'
  order by r.name, r.id;
$$;

-- Convites pendentes do usuário logado. O convite por e-mail só vale se o e-mail
-- da conta estiver confirmado (evita reivindicar convite com e-mail alheio).
create or replace function public.my_pending_invitations()
returns table (
  membership_id   uuid,
  restaurant_id   uuid,
  restaurant_name text,
  role            public.restaurant_role,
  invited_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.restaurant_id, r.name, m.role, m.created_at
  from public.restaurant_memberships m
  join public.restaurants r on r.id = m.restaurant_id
  left join auth.users me on me.id = auth.uid()
  where auth.uid() is not null
    and m.status = 'invited'
    and r.status <> 'suspended'
    and (
      m.user_id = auth.uid()
      or (
        m.user_id is null
        and me.email_confirmed_at is not null
        and m.invited_email = lower(me.email)
      )
    )
  order by m.created_at desc;
$$;

-- Colegas ativos de um mesmo restaurante (policy de leitura de profiles).
create or replace function public.shares_restaurant_with(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.restaurant_memberships a
    join public.restaurant_memberships b on b.restaurant_id = a.restaurant_id
    join public.restaurants r on r.id = a.restaurant_id
    where a.user_id = auth.uid() and a.status = 'active'
      and b.user_id = p_user      and b.status = 'active'
      and r.status <> 'suspended'
  );
$$;

-- Resolução pública de slug: somente restaurantes ATIVOS, somente campos públicos.
create or replace function public.resolve_restaurant_by_slug(p_slug text)
returns table (
  id        uuid,
  slug      text,
  name      text,
  status    public.restaurant_status,
  logo_path text
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.slug, r.name, r.status, r.logo_path
  from public.restaurants r
  where r.slug = lower(btrim(coalesce(p_slug, '')))
    and r.status = 'active'
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
revoke execute on function public.is_platform_admin()                  from public, anon, authenticated;
revoke execute on function public.is_platform_superadmin()             from public, anon, authenticated;
revoke execute on function public.is_member(uuid)                      from public, anon, authenticated;
revoke execute on function public.has_permission(uuid, text)           from public, anon, authenticated;
revoke execute on function public.has_support_access(uuid)             from public, anon, authenticated;
revoke execute on function public.my_permissions(uuid)                 from public, anon, authenticated;
revoke execute on function public.my_restaurants()                     from public, anon, authenticated;
revoke execute on function public.my_pending_invitations()             from public, anon, authenticated;
revoke execute on function public.shares_restaurant_with(uuid)         from public, anon, authenticated;
revoke execute on function public.resolve_restaurant_by_slug(text)     from public, anon, authenticated;

grant execute on function public.is_platform_admin()                   to authenticated;
grant execute on function public.is_platform_superadmin()              to authenticated;
grant execute on function public.is_member(uuid)                       to authenticated;
grant execute on function public.has_permission(uuid, text)            to authenticated;
grant execute on function public.has_support_access(uuid)              to authenticated;
grant execute on function public.my_permissions(uuid)                  to authenticated;
grant execute on function public.my_restaurants()                      to authenticated;
grant execute on function public.my_pending_invitations()              to authenticated;
grant execute on function public.shares_restaurant_with(uuid)          to authenticated;
-- Único endpoint público (rota /{slug} para visitantes).
grant execute on function public.resolve_restaurant_by_slug(text)      to anon, authenticated;
