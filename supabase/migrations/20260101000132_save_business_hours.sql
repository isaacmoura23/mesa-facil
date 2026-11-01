-- 0132 — save_business_hours(p_restaurant, p_hours jsonb): salvar horários de forma atômica (Fase 8, P8-DB)
--
-- p_hours: array de {weekday: 0..6, opens_at: "HH:MM[:SS]", closes_at: "HH:MM[:SS]"}; [] limpa todos os horários.
-- closes_at <= opens_at = vira o dia (ex.: 18:00 -> 02:00 pertence ao weekday de abertura).
-- Substitui TODAS as faixas do restaurante numa única transação (falha em qualquer faixa desfaz tudo).
-- Reaproveita os triggers da 0126 (máx. 6 faixas/dia e sobreposição no mesmo dia) e valida também a virada de dia:
-- a parte após a meia-noite não pode invadir a faixa do dia seguinte.
-- Exige restaurant.settings.manage (FORBIDDEN 42501; não-membro => RESTAURANT_NOT_FOUND P0002).
-- Erros: INVALID_BUSINESS_HOURS (22023), BUSINESS_HOURS_LIMIT / BUSINESS_HOURS_OVERLAP (23514).
-- Retorno: {ok:true, count:n, hours:[{weekday,opens_at,closes_at}...]} (opens/closes como "HH:MM").

create or replace function public.save_business_hours(p_restaurant uuid, p_hours jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_time constant text := '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$';
  e       jsonb;
  v_wd    text;
  v_o     text;
  v_c     text;
  v_rows  jsonb := '[]'::jsonb;
  v_out   jsonb;
begin
  perform app_private.require_perm(p_restaurant, 'restaurant.settings.manage', 'RESTAURANT_NOT_FOUND');

  if p_hours is null or jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 42 then
    raise exception 'INVALID_BUSINESS_HOURS: informe uma lista com até 42 faixas' using errcode = '22023';
  end if;

  for e in select x.value from jsonb_array_elements(p_hours) x loop
    if jsonb_typeof(e) <> 'object'
       or jsonb_typeof(e -> 'weekday') is distinct from 'number'
       or jsonb_typeof(e -> 'opens_at') is distinct from 'string'
       or jsonb_typeof(e -> 'closes_at') is distinct from 'string' then
      raise exception 'INVALID_BUSINESS_HOURS: faixa inválida' using errcode = '22023';
    end if;
    v_wd := e ->> 'weekday';
    v_o := e ->> 'opens_at';
    v_c := e ->> 'closes_at';
    if v_wd !~ '^[0-6]$' or v_o !~ c_time or v_c !~ c_time or v_o::time = v_c::time then
      raise exception 'INVALID_BUSINESS_HOURS: dia (0-6) ou horário inválido, abertura e fechamento devem diferir'
        using errcode = '22023';
    end if;
    v_rows := v_rows || jsonb_build_object('weekday', v_wd::int, 'opens_at', v_o::time, 'closes_at', v_c::time);
  end loop;

  -- Serializa com os triggers da 0126 (mesma chave) e com outros salvamentos.
  perform pg_advisory_xact_lock(hashtextextended('business_hours:' || p_restaurant::text, 0));

  delete from public.business_hours h where h.restaurant_id = p_restaurant;

  -- Ordem determinística; o trigger valida limite/sobreposição linha a linha (current_user = dono da função).
  insert into public.business_hours (restaurant_id, weekday, opens_at, closes_at)
  select p_restaurant, (r ->> 'weekday')::smallint, (r ->> 'opens_at')::time, (r ->> 'closes_at')::time
  from jsonb_array_elements(v_rows) with ordinality as t(r, ord)
  order by (r ->> 'weekday')::int, (r ->> 'opens_at')::time, t.ord;

  -- Virada de dia: a cauda (00:00..closes_at) de uma faixa que cruza a meia-noite não pode sobrepor
  -- faixas do dia seguinte (a sobreposição dentro do mesmo dia já foi validada pelo trigger).
  if exists (
    select 1
      from public.business_hours a
      join public.business_hours b
        on b.restaurant_id = a.restaurant_id and b.weekday = (a.weekday + 1) % 7
     where a.restaurant_id = p_restaurant
       and a.closes_at <= a.opens_at
       and b.opens_at < a.closes_at
  ) then
    raise exception 'BUSINESS_HOURS_OVERLAP: a virada de dia sobrepõe a faixa do dia seguinte' using errcode = '23514';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'weekday', h.weekday, 'opens_at', to_char(h.opens_at, 'HH24:MI'), 'closes_at', to_char(h.closes_at, 'HH24:MI'))
           order by h.weekday, h.opens_at), '[]'::jsonb)
    into v_out
    from public.business_hours h where h.restaurant_id = p_restaurant;

  perform public.log_audit(p_restaurant, 'settings.business_hours_saved', 'restaurant', p_restaurant,
    jsonb_build_object('count', jsonb_array_length(v_out)));

  return jsonb_build_object('ok', true, 'count', jsonb_array_length(v_out), 'hours', v_out);
end;
$$;

revoke all on function public.save_business_hours(uuid, jsonb) from public, anon;
grant execute on function public.save_business_hours(uuid, jsonb) to authenticated;
