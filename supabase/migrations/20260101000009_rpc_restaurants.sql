-- =============================================================================
-- 0009 · RPCs de restaurante: create_restaurant (plataforma) e register_restaurant (self-service)
-- =============================================================================
-- Erros: mensagens são códigos estáveis (not_authenticated, forbidden, invalid_slug, slug_unavailable ...).

-- Apenas superadmin da plataforma: cria restaurante ATIVO com o owner informado.
create or replace function public.create_restaurant(p_name text, p_slug text, p_owner_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_slug text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, '')));
  v_id   uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not public.is_platform_superadmin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if pg_catalog.char_length(v_name) not between 2 and 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if p_owner_id is null or not exists (select 1 from auth.users u where u.id = p_owner_id) then
    raise exception 'owner_not_found' using errcode = '22023';
  end if;

  begin
    insert into public.restaurants (name, slug, status, created_by)
    values (v_name, v_slug, 'active', v_uid)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'slug_unavailable' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_slug' using errcode = '23514';
  end;

  insert into public.restaurant_memberships (restaurant_id, user_id, role, status, invited_by)
  values (v_id, p_owner_id, 'owner', 'active', v_uid);

  perform public.log_audit(
    v_id, 'restaurant.created', 'restaurant', v_id,
    jsonb_build_object('slug', v_slug, 'owner_id', p_owner_id, 'by', 'platform')
  );
  return v_id;
end;
$$;

-- Autoatendimento: qualquer usuário autenticado cria um restaurante PENDENTE (aguarda
-- aprovação da plataforma) e vira owner. Limite simples contra abuso.
create or replace function public.register_restaurant(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := pg_catalog.btrim(coalesce(p_name, ''));
  v_slug  text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, '')));
  v_id    uuid;
  v_owned integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if pg_catalog.char_length(v_name) not between 2 and 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  select pg_catalog.count(*) into v_owned
  from public.restaurant_memberships m
  where m.user_id = v_uid and m.role = 'owner' and m.status <> 'revoked';
  if v_owned >= 5 then
    raise exception 'restaurant_limit_reached' using errcode = '54000';
  end if;

  begin
    insert into public.restaurants (name, slug, status, created_by)
    values (v_name, v_slug, 'pending', v_uid)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'slug_unavailable' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_slug' using errcode = '23514';
  end;

  insert into public.restaurant_memberships (restaurant_id, user_id, role, status, invited_by)
  values (v_id, v_uid, 'owner', 'active', v_uid);

  perform public.log_audit(
    v_id, 'restaurant.registered', 'restaurant', v_id,
    jsonb_build_object('slug', v_slug, 'by', 'self_service')
  );
  return v_id;
end;
$$;

revoke execute on function public.create_restaurant(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.register_restaurant(text, text)     from public, anon, authenticated;
grant  execute on function public.create_restaurant(text, text, uuid) to authenticated;
grant  execute on function public.register_restaurant(text, text)     to authenticated;
