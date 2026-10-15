-- =============================================================================
-- 0013 · Policies RLS (uma por comando; apenas `authenticated`, salvo plans)
-- =============================================================================
-- Convenções: auth.uid() embrulhado em (select ...) para initPlan; permissões via
-- public.has_permission(restaurant_id, ...). Tabelas sem policy de um comando = comando negado.

-- ---------------------------------------------------------------------------
-- profiles: cada um lê/edita o seu; colegas ativos do mesmo restaurante podem LER.
-- Sem INSERT (trigger handle_new_user) nem DELETE (cascade de auth.users).
-- ---------------------------------------------------------------------------
create policy profiles_select_own_or_colleague on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.shares_restaurant_with(id));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- restaurants: SELECT membros / platform admin / sessão de suporte.
-- UPDATE: settings.manage ou superadmin (status/slug barrados por trigger para não-superadmin).
-- Sem INSERT/DELETE.
-- ---------------------------------------------------------------------------
create policy restaurants_select on public.restaurants
  for select to authenticated
  using (
    public.is_member(id)
    or public.is_platform_admin()
    or public.has_support_access(id)
  );

create policy restaurants_update on public.restaurants
  for update to authenticated
  using (public.has_permission(id, 'restaurant.settings.manage') or public.is_platform_superadmin())
  with check (public.has_permission(id, 'restaurant.settings.manage') or public.is_platform_superadmin());

-- ---------------------------------------------------------------------------
-- restaurant_memberships: SELECT próprio, team.manage ou sessão de suporte.
-- NENHUMA policy de insert/update/delete: somente RPCs SECURITY DEFINER.
-- ---------------------------------------------------------------------------
create policy restaurant_memberships_select on public.restaurant_memberships
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.has_permission(restaurant_id, 'team.manage')
    or public.has_support_access(restaurant_id)
  );

-- ---------------------------------------------------------------------------
-- platform_admins: SOMENTE o próprio registro; zero policies de escrita.
-- ---------------------------------------------------------------------------
create policy platform_admins_select_own on public.platform_admins
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Catálogo de permissões: leitura para autenticados; escrita só por migração/service role.
-- ---------------------------------------------------------------------------
create policy permissions_select on public.permissions
  for select to authenticated using (true);

create policy role_permissions_select on public.role_permissions
  for select to authenticated using (true);

-- Overrides: visíveis a quem gere a equipe do restaurante; escrita só por RPC.
create policy membership_permission_overrides_select on public.membership_permission_overrides
  for select to authenticated
  using (public.has_permission(restaurant_id, 'team.manage'));

-- ---------------------------------------------------------------------------
-- audit_logs: team.manage do restaurante, platform admin ou sessão de suporte (leitura).
-- INSERT só via public.log_audit; UPDATE/DELETE bloqueados também por trigger.
-- ---------------------------------------------------------------------------
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (
    (restaurant_id is not null and (
      public.has_permission(restaurant_id, 'team.manage')
      or public.has_support_access(restaurant_id)
    ))
    or public.is_platform_admin()
  );

-- ---------------------------------------------------------------------------
-- plans: catálogo público (is_active). Plataforma vê todos e escreve (superadmin).
-- ---------------------------------------------------------------------------
create policy plans_select_active on public.plans
  for select to anon, authenticated
  using (is_active);

create policy plans_select_platform on public.plans
  for select to authenticated
  using (public.is_platform_admin());

create policy plans_insert on public.plans
  for insert to authenticated
  with check (public.is_platform_superadmin());

create policy plans_update on public.plans
  for update to authenticated
  using (public.is_platform_superadmin())
  with check (public.is_platform_superadmin());

create policy plans_delete on public.plans
  for delete to authenticated
  using (public.is_platform_superadmin());

-- ---------------------------------------------------------------------------
-- subscriptions: leitura pelo restaurante (team.manage) e plataforma; escrita superadmin.
-- ---------------------------------------------------------------------------
create policy subscriptions_select on public.subscriptions
  for select to authenticated
  using (public.has_permission(restaurant_id, 'team.manage') or public.is_platform_admin());

create policy subscriptions_insert on public.subscriptions
  for insert to authenticated
  with check (public.is_platform_superadmin());

create policy subscriptions_update on public.subscriptions
  for update to authenticated
  using (public.is_platform_superadmin())
  with check (public.is_platform_superadmin());

create policy subscriptions_delete on public.subscriptions
  for delete to authenticated
  using (public.is_platform_superadmin());

-- ---------------------------------------------------------------------------
-- support_sessions: o admin vê as suas, superadmin vê todas, e o restaurante
-- (team.manage) vê quem acessou e por quê. Escrita só pelas RPCs.
-- ---------------------------------------------------------------------------
create policy support_sessions_select on public.support_sessions
  for select to authenticated
  using (
    admin_id = (select auth.uid())
    or public.is_platform_superadmin()
    or public.has_permission(restaurant_id, 'team.manage')
  );

-- ---------------------------------------------------------------------------
-- support_tickets
-- ---------------------------------------------------------------------------
create policy support_tickets_select on public.support_tickets
  for select to authenticated
  using (
    opened_by = (select auth.uid())
    or public.is_platform_admin()
    or (restaurant_id is not null and public.has_permission(restaurant_id, 'team.manage'))
  );

create policy support_tickets_insert on public.support_tickets
  for insert to authenticated
  with check (
    opened_by = (select auth.uid())
    and status = 'open'
    and (restaurant_id is null or public.is_member(restaurant_id))
  );

create policy support_tickets_update_platform on public.support_tickets
  for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());
