-- =============================================================================
-- 0011 · RPCs de sessão de suporte (acesso temporário SOMENTE LEITURA)
-- =============================================================================

-- open_support_session: platform admin + motivo (>=10 chars) + duração máx. 60 min.
-- Uma sessão aberta anterior do mesmo admin no mesmo restaurante é encerrada (sem acumular).
create or replace function public.open_support_session(
  p_restaurant uuid,
  p_reason     text,
  p_minutes    integer default 30
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
  v_id     uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if pg_catalog.char_length(v_reason) < 10 or pg_catalog.char_length(v_reason) > 500 then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 60 then
    raise exception 'invalid_duration' using errcode = '22023';
  end if;
  if p_restaurant is null or not exists (select 1 from public.restaurants r where r.id = p_restaurant) then
    raise exception 'restaurant_not_found' using errcode = 'P0002';
  end if;

  update public.support_sessions s
     set ended_at = pg_catalog.now()
   where s.admin_id = v_uid and s.restaurant_id = p_restaurant and s.ended_at is null;

  insert into public.support_sessions (restaurant_id, admin_id, reason, started_at, expires_at)
  values (
    p_restaurant, v_uid, v_reason, pg_catalog.now(),
    pg_catalog.now() + pg_catalog.make_interval(mins => p_minutes)
  )
  returning id into v_id;

  -- Transparência: o restaurante (team.manage) enxerga o acesso e o motivo no audit_logs.
  perform public.log_audit(
    p_restaurant, 'support.session_opened', 'support_session', v_id,
    jsonb_build_object('reason', v_reason, 'minutes', p_minutes)
  );
  return v_id;
end;
$$;

-- close_support_session: apenas o próprio admin que abriu encerra a sua sessão.
create or replace function public.close_support_session(p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_s   public.support_sessions%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select s.* into v_s from public.support_sessions s where s.id = p_session for update;
  if not found or v_s.admin_id <> v_uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_s.ended_at is not null then
    return;
  end if;

  update public.support_sessions s set ended_at = pg_catalog.now() where s.id = v_s.id;

  perform public.log_audit(
    v_s.restaurant_id, 'support.session_closed', 'support_session', v_s.id,
    jsonb_build_object('expired', v_s.expires_at <= pg_catalog.now())
  );
end;
$$;

revoke execute on function public.open_support_session(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.close_support_session(uuid)               from public, anon, authenticated;
grant  execute on function public.open_support_session(uuid, text, integer) to authenticated;
grant  execute on function public.close_support_session(uuid)               to authenticated;
