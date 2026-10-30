-- 0133 — Correções de banco da revisão de segurança (Fase 8, P8-DB)
--
-- S-08  qr_token: SELECT por coluna (authenticated perde o privilégio de tabela e ganha todas as colunas MENOS
--       qr_token); fora da publicação Realtime (lista de colunas). Quem tem tables.manage lê via
--       list_table_qr_tokens(p_restaurant) e rotate_table_qr (inalterada). INSERT ... RETURNING qr_token deixa de
--       funcionar para clientes (o token é gerado no servidor, F-03).
-- F-35  set_table_status checa a permissão antes do ramo "unchanged".
-- F-43  CHECK delivery_zones_prefixes_valid valida CADA elemento (a forma textual do array só tem elementos
--       sem aspas quando são 1..8 dígitos; '' e '1,2' ficam entre aspas e falham).
-- F-44/F-45 sanitize_audit_metadata remove chaves senha|segred*|chave* e valores "Bearer eyJ..."/JWT após espaço.
--       (S-05/S-09/S-10/S-11: sem mudança de banco; ver docs.)

-- ---------------------------------------------------------------------------
-- S-08
-- ---------------------------------------------------------------------------
revoke select on public.restaurant_tables from authenticated;
grant select (id, restaurant_id, name, area, capacity, status, sort_order, created_at, updated_at)
  on public.restaurant_tables to authenticated;

-- Lista de colunas na publicação exige que a identidade de réplica caiba nela: troca FULL (que carregaria o
-- qr_token na linha antiga) por índice único (restaurant_id, id). Efeito: eventos UPDATE/DELETE de
-- restaurant_tables trazem só essas chaves como "old" (o app só usa payload.old em orders).
alter table public.restaurant_tables replica identity using index restaurant_tables_restaurant_id_id_key;
alter publication supabase_realtime drop table public.restaurant_tables;
alter publication supabase_realtime add table public.restaurant_tables
  (id, restaurant_id, name, area, capacity, status, sort_order, created_at, updated_at);

create or replace function public.list_table_qr_tokens(p_restaurant uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app_private.require_perm(p_restaurant, 'tables.manage', 'RESTAURANT_NOT_FOUND');
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'qr_token', t.qr_token)
                     order by t.sort_order, t.name)
    from public.restaurant_tables t where t.restaurant_id = p_restaurant), '[]'::jsonb);
end;
$$;
revoke all on function public.list_table_qr_tokens(uuid) from public, anon;
grant execute on function public.list_table_qr_tokens(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- F-43
-- ---------------------------------------------------------------------------
alter table public.delivery_zones drop constraint delivery_zones_prefixes_valid;
alter table public.delivery_zones add constraint delivery_zones_prefixes_valid check (
  cardinality(postal_code_prefixes) <= 50
  and postal_code_prefixes::text ~ '^\{([0-9]{1,8}(,[0-9]{1,8})*)?\}$'
);

-- ---------------------------------------------------------------------------
-- F-35 (set_table_status) e F-44/F-45 (sanitize_audit_metadata)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_table_status(p_table uuid, p_to text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid  uuid := auth.uid();
  v_rid  uuid;
  v_to   public.table_status;
  v_t    public.restaurant_tables%rowtype;
  v_perm text;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED: faça login para continuar' using errcode = '28000';
  end if;
  select t.restaurant_id into v_rid from public.restaurant_tables t where t.id = p_table;
  if v_rid is null or not public.is_member(v_rid) then
    raise exception 'TABLE_NOT_FOUND: mesa não encontrada' using errcode = 'P0002';
  end if;

  begin
    v_to := upper(btrim(coalesce(p_to, '')))::public.table_status;
  exception when others then
    v_to := null;
  end;
  if v_to is null or v_to not in ('AVAILABLE', 'INACTIVE') then
    raise exception 'INVALID_TABLE_STATUS: use AVAILABLE ou INACTIVE' using errcode = '22023';
  end if;

  select t.* into v_t from public.restaurant_tables t where t.id = p_table and t.restaurant_id = v_rid for update;

  -- F-35: a permissão vale ANTES do ramo "unchanged" (não vaza nome/estado da mesa a quem não pode operar).
  v_perm := case when 'INACTIVE' in (v_t.status::text, v_to::text) then 'tables.manage' else 'tables.operate' end;
  if not public.has_permission(v_rid, v_perm) then
    raise exception 'FORBIDDEN: requer permissão %', v_perm using errcode = '42501';
  end if;

  if v_t.status = v_to then
    return jsonb_build_object('ok', true, 'unchanged', true, 'table', jsonb_build_object(
      'id', v_t.id, 'name', v_t.name, 'status', v_t.status));
  end if;

  if (v_t.status::text, v_to::text) not in
     (('CLEANING', 'AVAILABLE'), ('OCCUPIED', 'AVAILABLE'), ('AVAILABLE', 'INACTIVE'),
      ('CLEANING', 'INACTIVE'), ('INACTIVE', 'AVAILABLE')) then
    raise exception 'TABLE_INVALID_TRANSITION: % -> % não é permitido', v_t.status, v_to using errcode = 'P0001';
  end if;
  if exists (select 1 from public.tabs tb
             where tb.restaurant_id = v_rid and tb.table_id = p_table and tb.status = 'OPEN') then
    raise exception 'TABLE_HAS_OPEN_TAB: feche ou cancele a comanda antes' using errcode = 'P0001';
  end if;

  update public.restaurant_tables set status = v_to where id = p_table and restaurant_id = v_rid
  returning * into v_t;

  perform public.log_audit(v_rid, 'table.status_changed', 'restaurant_table', p_table,
    jsonb_build_object('to', v_to));

  return jsonb_build_object('ok', true, 'unchanged', false, 'table', jsonb_build_object(
    'id', v_t.id, 'name', v_t.name, 'status', v_t.status));
end;
$function$;
CREATE OR REPLACE FUNCTION app_private.sanitize_audit_metadata(p jsonb, p_depth integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
declare
  k   text;
  v   jsonb;
  res jsonb;
begin
  if p is null then
    return null;
  end if;
  if p_depth > 8 then
    return '"[truncado]"'::jsonb;
  end if;
  case jsonb_typeof(p)
    when 'object' then
      res := '{}'::jsonb;
      for k, v in select e.key, e.value from jsonb_each(p) e loop
        if k ~* '(token|secret|passw|pwd|api[_-]?key|senha|segred|chave|authorization|credential|cookie|jwt|bearer|signature|private[_-]?key)' then
          continue;
        end if;
        res := res || jsonb_build_object(k, app_private.sanitize_audit_metadata(v, p_depth + 1));
      end loop;
      return res;
    when 'array' then
      select coalesce(jsonb_agg(app_private.sanitize_audit_metadata(e, p_depth + 1)), '[]'::jsonb)
        into res from jsonb_array_elements(p) e;
      return res;
    when 'string' then
      if (p #>> '{}') ~ '(^|\s)(bearer\s+)?eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.' then
        return '"[removido]"'::jsonb;
      end if;
      return p;
    else
      return p;
  end case;
end;
$function$;
