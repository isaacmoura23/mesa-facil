-- =============================================================================
-- 0139 · Equipe: reativar acesso revogado, tela "acesso encerrado" e lista da equipe para o gerente
-- =============================================================================
-- * reactivate_member(p_membership): quem tem team.manage devolve o acesso de um vínculo REVOGADO (com conta)
--   com o mesmo papel e as permissões padrão do papel (ajustes antigos não voltam). Audita 'member.reactivated'.
-- * my_revoked_restaurants(): restaurantes ativos em que o usuário logado teve o acesso revogado (só nome e slug),
--   para a tela "Seu acesso foi encerrado". Não revela dados além do que a vitrine pública já mostra.
-- * list_team_basic(p_restaurant): lista SOMENTE LEITURA da equipe para dono e gerente (nome, papel, situação).
--   Sem e-mail, permissões ou ajustes: quem edita a equipe continua sendo só quem tem team.manage (dono).
-- =============================================================================
create or replace function public.reactivate_member(p_membership uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_m   public.restaurant_memberships%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select m.* into v_m from public.restaurant_memberships m where m.id = p_membership for update;
  if not found or not public.has_permission(v_m.restaurant_id, 'team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_m.user_id is not distinct from v_uid then
    raise exception 'cannot_modify_self' using errcode = '42501';
  end if;
  if v_m.role = 'owner' then
    raise exception 'owner_protected' using errcode = '42501';
  end if;
  if v_m.status <> 'revoked' then
    raise exception 'not_revoked' using errcode = '22023';
  end if;
  if v_m.user_id is null then
    -- Convite nunca aceito: não há conta para reativar; use "Convidar de novo".
    raise exception 'no_account' using errcode = '22023';
  end if;

  delete from public.membership_permission_overrides o where o.membership_id = v_m.id;
  update public.restaurant_memberships m set status = 'active' where m.id = v_m.id;

  perform public.log_audit(
    v_m.restaurant_id, 'member.reactivated', 'membership', v_m.id,
    jsonb_build_object('role', v_m.role)
  );
end;
$$;

create or replace function public.my_revoked_restaurants()
returns table (slug text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select r.slug, r.name
    from public.restaurant_memberships m
    join public.restaurants r on r.id = m.restaurant_id
   where m.user_id = auth.uid()
     and m.status = 'revoked'
     and r.status = 'active'
   order by r.name, r.id;
$$;

create or replace function public.list_team_basic(p_restaurant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if auth.uid() is null or p_restaurant is null or not exists (
    select 1 from public.restaurant_memberships m
     where m.restaurant_id = p_restaurant and m.user_id = auth.uid()
       and m.status = 'active' and m.role in ('owner', 'manager')
  ) then
    raise exception 'RESTAURANT_NOT_FOUND: não encontrado' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'membership_id', t.id, 'full_name', t.full_name, 'role', t.role, 'status', t.status)
         order by t.ord, t.created_at, t.id), '[]'::jsonb)
    into v_rows
    from (
      select m.id, nullif(btrim(pr.full_name), '') as full_name, m.role::text as role, m.status::text as status,
             m.created_at, case m.role when 'owner' then 0 when 'manager' then 1 else 2 end as ord
        from public.restaurant_memberships m
        left join public.profiles pr on pr.id = m.user_id
       where m.restaurant_id = p_restaurant and m.status = 'active'
    ) t;

  return jsonb_build_object('rows', v_rows);
end;
$$;

revoke all on function public.reactivate_member(uuid) from public, anon, authenticated;
grant execute on function public.reactivate_member(uuid) to authenticated;
revoke all on function public.my_revoked_restaurants() from public, anon, authenticated;
grant execute on function public.my_revoked_restaurants() to authenticated;
revoke all on function public.list_team_basic(uuid) from public, anon, authenticated;
grant execute on function public.list_team_basic(uuid) to authenticated;
