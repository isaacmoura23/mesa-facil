-- =============================================================================
-- 0010 · RPCs de equipe: convite, aceite, papel, revogação e permissões individuais
-- =============================================================================
-- Regras comuns (todas exigem team.manage no restaurante do vínculo — o restaurante é
-- SEMPRE derivado do banco, nunca confiado ao cliente):
--  * ninguém altera o próprio papel/status;
--  * não existe 'owner' por RPC: não se atribui, não se rebaixa, não se revoga
--    (garante que nunca se cria nem se perde o último owner);
--  * team.manage não é delegável por override.

-- ---------------------------------------------------------------------------
-- invite_member: cria (ou reativa) vínculo 'invited' por e-mail. O convidado precisa aceitar.
-- ---------------------------------------------------------------------------
create or replace function public.invite_member(
  p_restaurant uuid,
  p_email      text,
  p_role       public.restaurant_role
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_email    text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_existing public.restaurant_memberships%rowtype;
  v_id       uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_restaurant is null or not public.has_permission(p_restaurant, 'team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_role is null or p_role = 'owner' then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if pg_catalog.char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  -- Vínculo existente: pelo e-mail do convite OU por conta já existente com esse e-mail.
  select m.* into v_existing
  from public.restaurant_memberships m
  where m.restaurant_id = p_restaurant
    and (
      m.invited_email = v_email
      or m.user_id in (select u.id from auth.users u where pg_catalog.lower(u.email) = v_email)
    )
  order by (m.status = 'active') desc, (m.status = 'invited') desc
  limit 1
  for update of m;

  if not found then
    insert into public.restaurant_memberships (restaurant_id, user_id, role, status, invited_email, invited_by)
    values (p_restaurant, null, p_role, 'invited', v_email, v_uid)
    returning id into v_id;
  elsif v_existing.status = 'active' then
    raise exception 'already_member' using errcode = '23505';
  else
    -- 'invited' (reenvio/atualiza papel) ou 'revoked' (reconvite): sem herdar overrides antigos.
    delete from public.membership_permission_overrides o where o.membership_id = v_existing.id;
    update public.restaurant_memberships m
       set role = p_role, status = 'invited', invited_email = v_email, invited_by = v_uid
     where m.id = v_existing.id
    returning m.id into v_id;
  end if;

  perform public.log_audit(
    p_restaurant, 'member.invited', 'membership', v_id,
    jsonb_build_object('email', v_email, 'role', p_role)
  );
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- accept_invitation: o próprio convidado ativa o vínculo.
-- ---------------------------------------------------------------------------
create or replace function public.accept_invitation(p_membership uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_m     public.restaurant_memberships%rowtype;
  v_email text;
  v_conf  timestamptz;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select m.* into v_m
  from public.restaurant_memberships m
  where m.id = p_membership and m.status = 'invited'
  for update;
  if not found then
    raise exception 'invitation_not_found' using errcode = 'P0002';
  end if;

  if v_m.user_id is not null then
    if v_m.user_id <> v_uid then
      raise exception 'invitation_not_found' using errcode = 'P0002';
    end if;
  else
    select pg_catalog.lower(u.email), u.email_confirmed_at into v_email, v_conf
    from auth.users u where u.id = v_uid;
    if v_conf is null or v_email is distinct from v_m.invited_email then
      raise exception 'invitation_not_found' using errcode = 'P0002';
    end if;
  end if;

  if exists (select 1 from public.restaurants r where r.id = v_m.restaurant_id and r.status = 'suspended') then
    raise exception 'restaurant_suspended' using errcode = '42501';
  end if;

  begin
    update public.restaurant_memberships m
       set user_id = v_uid, status = 'active'
     where m.id = v_m.id;
  exception when unique_violation then
    raise exception 'already_member' using errcode = '23505';
  end;

  perform public.log_audit(
    v_m.restaurant_id, 'member.invitation_accepted', 'membership', v_m.id,
    jsonb_build_object('role', v_m.role)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- change_member_role
-- ---------------------------------------------------------------------------
create or replace function public.change_member_role(
  p_membership uuid,
  p_role       public.restaurant_role
)
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
  -- Mesma resposta para "não existe" e "sem permissão": não vaza existência de vínculos.
  if not found or not public.has_permission(v_m.restaurant_id, 'team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if v_m.user_id is not distinct from v_uid then
    raise exception 'cannot_modify_self' using errcode = '42501';
  end if;
  if v_m.role = 'owner' or p_role is null or p_role = 'owner' then
    raise exception 'owner_protected' using errcode = '42501';
  end if;
  if v_m.status = 'revoked' then
    raise exception 'membership_revoked' using errcode = '22023';
  end if;
  if v_m.role = p_role then
    return;
  end if;

  update public.restaurant_memberships m set role = p_role where m.id = v_m.id;
  -- Overrides pertenciam ao papel anterior: recomeça da matriz padrão do novo papel.
  delete from public.membership_permission_overrides o where o.membership_id = v_m.id;

  perform public.log_audit(
    v_m.restaurant_id, 'member.role_changed', 'membership', v_m.id,
    jsonb_build_object('from', v_m.role, 'to', p_role)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- revoke_member
-- ---------------------------------------------------------------------------
create or replace function public.revoke_member(p_membership uuid)
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
  if v_m.status = 'revoked' then
    return;
  end if;

  update public.restaurant_memberships m set status = 'revoked' where m.id = v_m.id;
  delete from public.membership_permission_overrides o where o.membership_id = v_m.id;

  perform public.log_audit(
    v_m.restaurant_id, 'member.revoked', 'membership', v_m.id,
    jsonb_build_object('role', v_m.role, 'previous_status', v_m.status)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- set_member_permission: concede/remove uma permissão sobre o padrão do papel.
-- Se o valor pedido coincide com o padrão do papel, o override é removido (estado limpo).
-- ---------------------------------------------------------------------------
create or replace function public.set_member_permission(
  p_membership uuid,
  p_permission text,
  p_granted    boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_m       public.restaurant_memberships%rowtype;
  v_default boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select m.* into v_m from public.restaurant_memberships m where m.id = p_membership for update;
  if not found or not public.has_permission(v_m.restaurant_id, 'team.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_granted is null then
    raise exception 'invalid_granted' using errcode = '22023';
  end if;
  if v_m.user_id is not distinct from v_uid then
    raise exception 'cannot_modify_self' using errcode = '42501';
  end if;
  -- Owner nunca recebe/perde permissões por override (permissões operacionais incluídas).
  if v_m.role = 'owner' then
    raise exception 'owner_permissions_are_fixed' using errcode = '42501';
  end if;
  if v_m.status = 'revoked' then
    raise exception 'membership_revoked' using errcode = '22023';
  end if;
  if not exists (select 1 from public.permissions p where p.key = p_permission) then
    raise exception 'unknown_permission' using errcode = '22023';
  end if;
  if p_permission = 'team.manage' then
    raise exception 'team_manage_not_delegable' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.role_permissions rp
    where rp.role = v_m.role and rp.permission_key = p_permission
  ) into v_default;

  if p_granted = v_default then
    delete from public.membership_permission_overrides o
     where o.membership_id = v_m.id and o.permission_key = p_permission;
  else
    insert into public.membership_permission_overrides
      (membership_id, restaurant_id, permission_key, granted, created_by)
    values (v_m.id, v_m.restaurant_id, p_permission, p_granted, v_uid)
    on conflict (membership_id, permission_key)
    do update set granted = excluded.granted, created_by = excluded.created_by;
  end if;

  perform public.log_audit(
    v_m.restaurant_id, 'member.permission_changed', 'membership', v_m.id,
    jsonb_build_object('permission', p_permission, 'granted', p_granted, 'role', v_m.role)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
revoke execute on function public.invite_member(uuid, text, public.restaurant_role)        from public, anon, authenticated;
revoke execute on function public.accept_invitation(uuid)                                  from public, anon, authenticated;
revoke execute on function public.change_member_role(uuid, public.restaurant_role)        from public, anon, authenticated;
revoke execute on function public.revoke_member(uuid)                                      from public, anon, authenticated;
revoke execute on function public.set_member_permission(uuid, text, boolean)               from public, anon, authenticated;

grant execute on function public.invite_member(uuid, text, public.restaurant_role)         to authenticated;
grant execute on function public.accept_invitation(uuid)                                   to authenticated;
grant execute on function public.change_member_role(uuid, public.restaurant_role)         to authenticated;
grant execute on function public.revoke_member(uuid)                                       to authenticated;
grant execute on function public.set_member_permission(uuid, text, boolean)                to authenticated;
