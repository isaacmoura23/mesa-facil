-- =============================================================================
-- 0012 · RLS (ENABLE + FORCE) e GRANTs mínimos por tabela
-- =============================================================================
-- Princípio: default-deny. Primeiro REVOGA tudo de anon/authenticated (o Supabase concede
-- ALL por default privileges), depois concede só o necessário. service_role não é tocado.
-- FORCE RLS: o dono da tabela também obedece às policies (as funções SECURITY DEFINER do
-- projeto rodam como `postgres`, que possui BYPASSRLS — verificado na migração 0001).

alter table public.profiles                       enable row level security;
alter table public.restaurants                    enable row level security;
alter table public.restaurant_memberships         enable row level security;
alter table public.platform_admins                enable row level security;
alter table public.permissions                    enable row level security;
alter table public.role_permissions               enable row level security;
alter table public.membership_permission_overrides enable row level security;
alter table public.audit_logs                     enable row level security;
alter table public.plans                          enable row level security;
alter table public.subscriptions                  enable row level security;
alter table public.support_sessions               enable row level security;
alter table public.support_tickets                enable row level security;

alter table public.profiles                       force row level security;
alter table public.restaurants                    force row level security;
alter table public.restaurant_memberships         force row level security;
alter table public.platform_admins                force row level security;
alter table public.permissions                    force row level security;
alter table public.role_permissions               force row level security;
alter table public.membership_permission_overrides force row level security;
alter table public.audit_logs                     force row level security;
alter table public.plans                          force row level security;
alter table public.subscriptions                  force row level security;
alter table public.support_sessions               force row level security;
alter table public.support_tickets                force row level security;

revoke all on public.profiles                       from public, anon, authenticated;
revoke all on public.restaurants                    from public, anon, authenticated;
revoke all on public.restaurant_memberships         from public, anon, authenticated;
revoke all on public.platform_admins                from public, anon, authenticated;
revoke all on public.permissions                    from public, anon, authenticated;
revoke all on public.role_permissions               from public, anon, authenticated;
revoke all on public.membership_permission_overrides from public, anon, authenticated;
revoke all on public.audit_logs                     from public, anon, authenticated;
revoke all on public.plans                          from public, anon, authenticated;
revoke all on public.subscriptions                  from public, anon, authenticated;
revoke all on public.support_sessions               from public, anon, authenticated;
revoke all on public.support_tickets                from public, anon, authenticated;

-- profiles: leitura + edição apenas de colunas de exibição (id/created_at imutáveis).
grant select on public.profiles to authenticated;
grant update (full_name, phone, avatar_url) on public.profiles to authenticated;

-- restaurants: UPDATE por coluna. status/slug passam pelo trigger guard_restaurants_update
-- (só superadmin); sem INSERT/DELETE (restaurantes nascem por RPC).
grant select on public.restaurants to authenticated;
grant update (name, slug, status, logo_path, timezone) on public.restaurants to authenticated;

-- Tabelas somente-leitura para clientes (escrita exclusivamente por RPC/service role).
grant select on public.restaurant_memberships          to authenticated;
grant select on public.platform_admins                 to authenticated;
grant select on public.permissions                     to authenticated;
grant select on public.role_permissions                to authenticated;
grant select on public.membership_permission_overrides to authenticated;
grant select on public.audit_logs                      to authenticated;
grant select on public.support_sessions                to authenticated;

-- Catálogo público de planos; escrita só superadmin (policies abaixo).
grant select on public.plans to anon, authenticated;
grant insert, update, delete on public.plans to authenticated;

grant select, insert, update, delete on public.subscriptions to authenticated;

-- Tickets: abrir (colunas controladas) e, para a plataforma, mudar o status.
grant select on public.support_tickets to authenticated;
grant insert (restaurant_id, subject, body) on public.support_tickets to authenticated;
grant update (status) on public.support_tickets to authenticated;
