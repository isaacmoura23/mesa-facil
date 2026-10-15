-- =============================================================================
-- DB-3 / 0112 — Fase 2 (Cardápio): RPCs públicas de leitura, precificação de
-- carrinho no servidor e reordenação administrativa.
--
--   app_private.is_open_now(rid, at)          interno (sem grants a clientes)
--   app_private.day_intervals(rid, date)      interno
--   app_private.menu_products_json(rid, cat)  interno
--   app_private.price_cart(...)               interno — ÚNICA fonte de cálculo
--                                             (Fase 3 reutiliza em create_public_order)
--   public.public_menu(p_slug)                anon + authenticated
--   public.validate_cart(...)                 anon + authenticated
--   public.reorder_menu(...)                  authenticated (menu.manage)
--
-- Todas SECURITY DEFINER, search_path = '', nomes qualificados, sem escrita
-- (exceto reorder_menu). Nada aqui desativa RLS: as funções rodam como dono
-- (BYPASSRLS) mas só devolvem o que é público/necessário e SEMPRE filtram por
-- restaurant_id; o preço vem do banco, nunca do JSON do cliente.
-- Não há mudança de semântica nas tabelas existentes (nenhum índice/constraint
-- novo foi necessário: os índices de 0101/0102 já cobrem as consultas abaixo).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Horários: intervalos de funcionamento de uma data (exceção substitui o dia).
-- ---------------------------------------------------------------------------
create or replace function app_private.day_intervals(p_restaurant_id uuid, p_date date)
returns table (opens_at time, closes_at time)
language sql
stable
security definer
set search_path = ''
as $$
  select e.opens_at, e.closes_at
  from public.business_hour_exceptions e
  where e.restaurant_id = p_restaurant_id and e.on_date = p_date and not e.is_closed
  union all
  select h.opens_at, h.closes_at
  from public.business_hours h
  where h.restaurant_id = p_restaurant_id
    and h.weekday = extract(dow from p_date)::smallint
    and not exists (
      select 1 from public.business_hour_exceptions e2
      where e2.restaurant_id = p_restaurant_id and e2.on_date = p_date
    );
$$;

-- ---------------------------------------------------------------------------
-- Aberto agora? Fuso do restaurante; exceção do dia (feriado) substitui a grade;
-- closes_at < opens_at = vira o dia (o "rabo" é contado no dia seguinte).
-- Sem nenhum horário cadastrado => fechado.
-- ---------------------------------------------------------------------------
create or replace function app_private.is_open_now(p_restaurant_id uuid, p_at timestamptz default pg_catalog.now())
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz    text;
  v_local timestamp;
  v_today date;
  v_time  time;
begin
  select r.timezone into v_tz from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    return false;
  end if;
  begin
    v_local := p_at at time zone v_tz;
  exception when others then
    v_local := p_at at time zone 'America/Sao_Paulo';
  end;
  v_today := v_local::date;
  v_time  := v_local::time;

  return exists (
           select 1 from app_private.day_intervals(p_restaurant_id, v_today) i
           where (i.opens_at < i.closes_at and v_time >= i.opens_at and v_time < i.closes_at)
              or (i.opens_at > i.closes_at and v_time >= i.opens_at)
         )
      or exists (
           select 1 from app_private.day_intervals(p_restaurant_id, v_today - 1) i
           where i.opens_at > i.closes_at and v_time < i.closes_at
         );
end;
$$;

-- ---------------------------------------------------------------------------
-- JSON de produtos ativos de uma categoria (p_category_id nulo = sem categoria).
-- ---------------------------------------------------------------------------
create or replace function app_private.menu_products_json(p_restaurant_id uuid, p_category_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id',            p.id,
      'name',          p.name,
      'description',   p.description,
      'price_cents',   p.price_cents,
      'image_path',    p.image_path,
      'is_available',  p.is_available,
      'modifier_groups', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id',             g.id,
            'name',           g.name,
            'min_selections', g.min_selections,
            'max_selections', g.max_selections,
            'modifiers', coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'id',                m.id,
                  'name',              m.name,
                  'price_delta_cents', m.price_delta_cents,
                  'is_available',      m.is_available
                ) order by m.sort_order, m.name, m.id)
              from public.modifiers m
              where m.restaurant_id = g.restaurant_id and m.group_id = g.id and m.is_active
            ), '[]'::jsonb)
          ) order by g.sort_order, l.sort_order, g.name, g.id)
        from public.product_modifier_groups l
        join public.modifier_groups g
          on g.restaurant_id = l.restaurant_id and g.id = l.group_id and g.is_active
        where l.restaurant_id = p.restaurant_id and l.product_id = p.id
      ), '[]'::jsonb)
    ) order by p.sort_order, p.name, p.id), '[]'::jsonb)
  from public.products p
  where p.restaurant_id = p_restaurant_id
    and p.is_active
    and p.category_id is not distinct from p_category_id;
$$;

-- ---------------------------------------------------------------------------
-- price_cart — validação + precificação (fonte única).
-- Entrada p_items: [{product_id, quantity, modifier_ids:[uuid], notes?}]
-- Qualquer outro campo (price_cents, unit_price_cents, total...) é IGNORADO.
-- Nunca lança por dado do cliente: devolve ok=false + errors[]. item_index é
-- 0-based (posição em p_items). Valores em centavos inteiros.
-- Códigos além do contrato: TOO_MANY_ITEMS, NOTES_TOO_LONG.
-- ---------------------------------------------------------------------------
create or replace function app_private.price_cart(
  p_restaurant_id    uuid,
  p_fulfillment      text,
  p_items            jsonb,
  p_delivery_zone_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max_lines  constant integer := 50;
  c_max_qty    constant integer := 99;
  c_max_mods   constant integer := 50;   -- ids de adicionais por linha
  c_max_notes  constant integer := 500;
  c_uuid_re    constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  v_rest        record;
  v_set         record;
  v_zone        record;
  v_prod        record;
  v_prod_ok     boolean;
  v_mod         record;
  v_grp         record;
  v_fulfillment public.fulfillment_type;
  v_errors      jsonb := '[]'::jsonb;
  v_items       jsonb := '[]'::jsonb;
  v_n           integer;
  v_idx         integer;
  v_item        jsonb;
  v_err_before  integer;
  v_pid         uuid;
  v_qty         integer;
  v_notes       text;
  v_raw         jsonb;
  v_el          jsonb;
  v_mid_txt     text;
  v_mid         uuid;
  v_mod_ids     uuid[];
  v_line_mods   jsonb;
  v_mods_sum    bigint;
  v_counts      jsonb;
  v_cnt         integer;
  v_unit        bigint;
  v_line        bigint;
  v_subtotal    bigint := 0;
  v_fee         bigint := 0;
  v_discount    bigint := 0;
  v_min         bigint := 0;
  v_have_zone   boolean := false;
begin
  -- Restaurante: inexistente e não-ativo são indistinguíveis.
  select r.id, r.status into v_rest
  from public.restaurants r
  where r.id = p_restaurant_id and r.status = 'active';
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'errors', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'code', 'RESTAURANT_UNAVAILABLE', 'message', 'Restaurante indisponível.')),
      'items', '[]'::jsonb,
      'subtotal_cents', 0, 'delivery_fee_cents', 0, 'discount_cents', 0,
      'total_cents', 0, 'minimum_order_cents', 0);
  end if;

  select s.accepts_orders, s.min_order_cents, s.enabled_fulfillment_types into v_set
  from public.restaurant_settings s where s.restaurant_id = v_rest.id;
  if not found or not v_set.accepts_orders then
    v_errors := v_errors || pg_catalog.jsonb_build_object(
      'code', 'RESTAURANT_UNAVAILABLE', 'message', 'O restaurante não está aceitando pedidos no momento.');
  end if;
  v_min := coalesce(v_set.min_order_cents, 0);

  if not app_private.is_open_now(v_rest.id, pg_catalog.now()) then
    v_errors := v_errors || pg_catalog.jsonb_build_object(
      'code', 'RESTAURANT_CLOSED', 'message', 'O restaurante está fechado no momento.');
  end if;

  -- Modalidade
  begin
    v_fulfillment := pg_catalog.upper(pg_catalog.btrim(coalesce(p_fulfillment, '')))::public.fulfillment_type;
  exception when others then
    v_fulfillment := null;
  end;
  if v_fulfillment is null or v_set.enabled_fulfillment_types is null
     or not (v_fulfillment = any (v_set.enabled_fulfillment_types)) then
    v_errors := v_errors || pg_catalog.jsonb_build_object(
      'code', 'FULFILLMENT_DISABLED', 'message', 'Esta modalidade de pedido não está disponível.');
  end if;

  -- Zona de entrega (apenas DELIVERY)
  if v_fulfillment = 'DELIVERY' then
    if p_delivery_zone_id is null then
      v_errors := v_errors || pg_catalog.jsonb_build_object(
        'code', 'ZONE_REQUIRED', 'message', 'Selecione a região de entrega.');
    else
      select z.fee_cents, z.min_order_cents into v_zone
      from public.delivery_zones z
      where z.id = p_delivery_zone_id and z.restaurant_id = v_rest.id and z.is_active;
      if not found then
        v_errors := v_errors || pg_catalog.jsonb_build_object(
          'code', 'ZONE_UNAVAILABLE', 'message', 'Região de entrega indisponível.');
      else
        v_have_zone := true;
        v_fee := v_zone.fee_cents;
        v_min := greatest(v_min, v_zone.min_order_cents);
      end if;
    end if;
  end if;

  -- Itens
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' or pg_catalog.jsonb_array_length(p_items) = 0 then
    v_errors := v_errors || pg_catalog.jsonb_build_object(
      'code', 'EMPTY_CART', 'message', 'O carrinho está vazio.');
    v_n := 0;
  elsif pg_catalog.jsonb_array_length(p_items) > c_max_lines then
    v_errors := v_errors || pg_catalog.jsonb_build_object(
      'code', 'TOO_MANY_ITEMS',
      'message', 'O carrinho pode ter no máximo ' || c_max_lines || ' itens.');
    v_n := 0;
  else
    v_n := pg_catalog.jsonb_array_length(p_items);
  end if;

  for v_idx in 0 .. v_n - 1 loop
    v_item := p_items -> v_idx;
    v_err_before := pg_catalog.jsonb_array_length(v_errors);

    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      v_errors := v_errors || pg_catalog.jsonb_build_object(
        'code', 'PRODUCT_UNAVAILABLE', 'item_index', v_idx, 'message', 'Item inválido.');
      continue;
    end if;

    -- quantidade (inteiro 1..99)
    v_qty := null;
    if pg_catalog.jsonb_typeof(v_item -> 'quantity') = 'number'
       and (v_item ->> 'quantity') ~ '^[0-9]{1,3}$' then
      v_qty := (v_item ->> 'quantity')::integer;
    end if;
    if v_qty is null or v_qty < 1 or v_qty > c_max_qty then
      v_errors := v_errors || pg_catalog.jsonb_build_object(
        'code', 'INVALID_QUANTITY', 'item_index', v_idx,
        'message', 'A quantidade deve estar entre 1 e ' || c_max_qty || '.');
    end if;

    -- observação
    v_notes := null;
    if v_item ? 'notes' and pg_catalog.jsonb_typeof(v_item -> 'notes') <> 'null' then
      if pg_catalog.jsonb_typeof(v_item -> 'notes') <> 'string'
         or pg_catalog.char_length(v_item ->> 'notes') > c_max_notes then
        v_errors := v_errors || pg_catalog.jsonb_build_object(
          'code', 'NOTES_TOO_LONG', 'item_index', v_idx,
          'message', 'A observação deve ter no máximo ' || c_max_notes || ' caracteres.');
      else
        v_notes := nullif(pg_catalog.btrim(v_item ->> 'notes'), '');
      end if;
    end if;

    -- produto (inexistente, de outro restaurante, inativo, indisponível ou em
    -- categoria inativa: um único código, sem revelar o motivo)
    v_pid := null;
    if pg_catalog.jsonb_typeof(v_item -> 'product_id') = 'string'
       and (v_item ->> 'product_id') ~ c_uuid_re then
      v_pid := (v_item ->> 'product_id')::uuid;
    end if;
    v_prod_ok := false;
    if v_pid is not null then
      select p.id, p.name, p.price_cents into v_prod
      from public.products p
      left join public.menu_categories c
        on c.restaurant_id = p.restaurant_id and c.id = p.category_id
      where p.id = v_pid
        and p.restaurant_id = v_rest.id
        and p.is_active and p.is_available
        and (p.category_id is null or c.is_active);
      v_prod_ok := found;
    end if;
    if not v_prod_ok then
      v_errors := v_errors || pg_catalog.jsonb_build_object(
        'code', 'PRODUCT_UNAVAILABLE', 'item_index', v_idx, 'message', 'Produto indisponível.');
      continue;
    end if;

    -- adicionais
    v_mod_ids := '{}'::uuid[];
    v_raw := v_item -> 'modifier_ids';
    if v_raw is null or pg_catalog.jsonb_typeof(v_raw) = 'null' then
      v_raw := '[]'::jsonb;
    end if;
    if pg_catalog.jsonb_typeof(v_raw) <> 'array' then
      v_errors := v_errors || pg_catalog.jsonb_build_object(
        'code', 'MODIFIER_NOT_ALLOWED', 'item_index', v_idx, 'message', 'Adicionais inválidos.');
      v_raw := '[]'::jsonb;
    elsif pg_catalog.jsonb_array_length(v_raw) > c_max_mods then
      v_errors := v_errors || pg_catalog.jsonb_build_object(
        'code', 'MODIFIER_GROUP_MAX', 'item_index', v_idx,
        'message', 'Adicionais demais neste item.');
      v_raw := '[]'::jsonb;
    end if;

    for v_el in select e.value from pg_catalog.jsonb_array_elements(v_raw) as e(value) loop
      v_mid := null;
      if pg_catalog.jsonb_typeof(v_el) = 'string' then
        v_mid_txt := v_el #>> '{}';
        if v_mid_txt ~ c_uuid_re then
          v_mid := v_mid_txt::uuid;
        end if;
      end if;
      if v_mid is null or v_mid = any (v_mod_ids) then
        v_errors := v_errors || pg_catalog.jsonb_build_object(
          'code', 'MODIFIER_NOT_ALLOWED', 'item_index', v_idx,
          'message', 'Adicional inválido ou repetido.');
      else
        v_mod_ids := v_mod_ids || v_mid;
      end if;
    end loop;

    v_line_mods := '[]'::jsonb;
    v_mods_sum  := 0;
    v_counts    := '{}'::jsonb;

    foreach v_mid in array v_mod_ids loop
      select m.id, m.name, m.price_delta_cents, m.is_available, m.is_active,
             g.id as group_id, g.name as group_name, g.is_active as group_active,
             exists (
               select 1 from public.product_modifier_groups l
               where l.restaurant_id = m.restaurant_id
                 and l.product_id = v_prod.id and l.group_id = m.group_id
             ) as linked
        into v_mod
      from public.modifiers m
      join public.modifier_groups g on g.restaurant_id = m.restaurant_id and g.id = m.group_id
      where m.id = v_mid and m.restaurant_id = v_rest.id;

      if not found or not v_mod.linked then
        v_errors := v_errors || pg_catalog.jsonb_build_object(
          'code', 'MODIFIER_NOT_ALLOWED', 'item_index', v_idx,
          'message', 'Adicional não permitido para este produto.');
      elsif not (v_mod.is_active and v_mod.group_active and v_mod.is_available) then
        v_errors := v_errors || pg_catalog.jsonb_build_object(
          'code', 'MODIFIER_UNAVAILABLE', 'item_index', v_idx,
          'message', 'O adicional "' || v_mod.name || '" está indisponível.');
      else
        v_mods_sum := v_mods_sum + v_mod.price_delta_cents;
        v_counts := pg_catalog.jsonb_set(
          v_counts, array[v_mod.group_id::text],
          pg_catalog.to_jsonb(coalesce((v_counts ->> v_mod.group_id::text)::integer, 0) + 1));
        v_line_mods := v_line_mods || pg_catalog.jsonb_build_object(
          'id', v_mod.id, 'name', v_mod.name, 'price_delta_cents', v_mod.price_delta_cents,
          'group_id', v_mod.group_id, 'group_name', v_mod.group_name);
      end if;
    end loop;

    -- mínimo/máximo por grupo (todos os grupos ativos vinculados ao produto)
    for v_grp in
      select g.id, g.name, g.min_selections, g.max_selections
      from public.product_modifier_groups l
      join public.modifier_groups g
        on g.restaurant_id = l.restaurant_id and g.id = l.group_id and g.is_active
      where l.restaurant_id = v_rest.id and l.product_id = v_prod.id
      order by l.sort_order, g.name, g.id
    loop
      v_cnt := coalesce((v_counts ->> v_grp.id::text)::integer, 0);
      if v_cnt < v_grp.min_selections then
        v_errors := v_errors || pg_catalog.jsonb_build_object(
          'code', 'MODIFIER_GROUP_MIN', 'item_index', v_idx, 'group_id', v_grp.id,
          'message', 'Escolha pelo menos ' || v_grp.min_selections || ' em "' || v_grp.name || '".');
      elsif v_cnt > v_grp.max_selections then
        v_errors := v_errors || pg_catalog.jsonb_build_object(
          'code', 'MODIFIER_GROUP_MAX', 'item_index', v_idx, 'group_id', v_grp.id,
          'message', 'Escolha no máximo ' || v_grp.max_selections || ' em "' || v_grp.name || '".');
      end if;
    end loop;

    -- linha só entra se não teve nenhum erro
    if pg_catalog.jsonb_array_length(v_errors) = v_err_before then
      v_unit := v_prod.price_cents;
      v_line := (v_unit + v_mods_sum) * v_qty;
      v_subtotal := v_subtotal + v_line;
      v_items := v_items || pg_catalog.jsonb_build_object(
        'product_id',       v_prod.id,
        'name',             v_prod.name,
        'unit_price_cents', v_unit,
        'quantity',         v_qty,
        'modifiers',        v_line_mods,
        'modifiers_cents',  v_mods_sum,
        'notes',            v_notes,
        'line_total_cents', v_line);
    end if;
  end loop;

  -- pedido mínimo (só quando todas as linhas são válidas; senão o subtotal é parcial)
  if v_n > 0 and pg_catalog.jsonb_array_length(v_items) = v_n and v_subtotal < v_min then
    v_errors := v_errors || pg_catalog.jsonb_build_object(
      'code', 'BELOW_MINIMUM',
      'message', 'O pedido mínimo é de R$ ' || pg_catalog.replace(pg_catalog.to_char(v_min / 100.0, 'FM999999990.00'), '.', ','));
  end if;

  return pg_catalog.jsonb_build_object(
    'ok',                  pg_catalog.jsonb_array_length(v_errors) = 0,
    'errors',              v_errors,
    'items',               v_items,
    'subtotal_cents',      v_subtotal,
    'delivery_fee_cents',  v_fee,
    'discount_cents',      v_discount,
    'total_cents',         v_subtotal + v_fee - v_discount,
    'minimum_order_cents', v_min);
end;
$$;

-- ---------------------------------------------------------------------------
-- public_menu
-- ---------------------------------------------------------------------------
create or replace function public.public_menu(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rest   record;
  v_set    record;
  v_cats   jsonb;
  v_uncat  jsonb;
  v_hours  jsonb;
  v_exc    jsonb;
  v_zones  jsonb;
  v_today  date;
begin
  select r.id, r.name, r.slug, r.logo_path, r.timezone into v_rest
  from public.restaurants r
  where r.slug = pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, ''))) and r.status = 'active';
  if not found then
    return null;   -- restaurant_not_found (inexistente e não-ativo são indistinguíveis)
  end if;

  select s.accepts_orders, s.prep_time_minutes, s.min_order_cents,
         s.enabled_fulfillment_types, s.pickup_instructions into v_set
  from public.restaurant_settings s where s.restaurant_id = v_rest.id;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', c.id, 'name', c.name, 'description', c.description, 'sort_order', c.sort_order,
      'products', app_private.menu_products_json(c.restaurant_id, c.id)
    ) order by c.sort_order, c.name, c.id), '[]'::jsonb)
  into v_cats
  from public.menu_categories c
  where c.restaurant_id = v_rest.id and c.is_active;

  -- Produtos ativos sem categoria aparecem numa categoria sintética ao final.
  v_uncat := app_private.menu_products_json(v_rest.id, null);
  if pg_catalog.jsonb_array_length(v_uncat) > 0 then
    v_cats := v_cats || pg_catalog.jsonb_build_object(
      'id', 'uncategorized', 'name', 'Outros', 'description', null,
      'sort_order', 2147483647, 'products', v_uncat);
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'weekday', h.weekday,
           'opens_at', pg_catalog.to_char(h.opens_at, 'HH24:MI'),
           'closes_at', pg_catalog.to_char(h.closes_at, 'HH24:MI')
         ) order by h.weekday, h.opens_at), '[]'::jsonb)
  into v_hours
  from public.business_hours h where h.restaurant_id = v_rest.id;

  begin
    v_today := (pg_catalog.now() at time zone v_rest.timezone)::date;
  exception when others then
    v_today := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  end;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'on_date', e.on_date,
           'is_closed', e.is_closed,
           'opens_at', pg_catalog.to_char(e.opens_at, 'HH24:MI'),
           'closes_at', pg_catalog.to_char(e.closes_at, 'HH24:MI'),
           'description', e.description
         ) order by e.on_date), '[]'::jsonb)
  into v_exc
  from public.business_hour_exceptions e
  where e.restaurant_id = v_rest.id and e.on_date >= v_today and e.on_date < v_today + 60;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', z.id, 'name', z.name, 'fee_cents', z.fee_cents,
           'min_order_cents', z.min_order_cents, 'estimated_minutes', z.estimated_minutes,
           'neighborhoods', z.neighborhoods
         ) order by z.name, z.id), '[]'::jsonb)
  into v_zones
  from public.delivery_zones z where z.restaurant_id = v_rest.id and z.is_active;

  return pg_catalog.jsonb_build_object(
    'restaurant', pg_catalog.jsonb_build_object(
      'id', v_rest.id, 'name', v_rest.name, 'slug', v_rest.slug,
      'logo_path', v_rest.logo_path, 'timezone', v_rest.timezone),
    'settings', pg_catalog.jsonb_build_object(
      'accepts_orders',            coalesce(v_set.accepts_orders, false),
      'prep_time_minutes',         v_set.prep_time_minutes,
      'min_order_cents',           coalesce(v_set.min_order_cents, 0),
      'enabled_fulfillment_types', coalesce(pg_catalog.to_jsonb(v_set.enabled_fulfillment_types), '[]'::jsonb),
      'pickup_instructions',       v_set.pickup_instructions,
      'business_hours',            v_hours,
      'business_hour_exceptions',  v_exc,
      'delivery_zones',            v_zones),
    'is_open_now', app_private.is_open_now(v_rest.id, pg_catalog.now()),
    'categories',  v_cats);
end;
$$;

-- ---------------------------------------------------------------------------
-- validate_cart — resolve o slug e delega tudo a app_private.price_cart.
-- ---------------------------------------------------------------------------
create or replace function public.validate_cart(
  p_slug             text,
  p_fulfillment      text,
  p_items            jsonb,
  p_delivery_zone_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_rid uuid;
begin
  select r.id into v_rid
  from public.restaurants r
  where r.slug = pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, ''))) and r.status = 'active';
  -- v_rid nulo => price_cart responde RESTAURANT_UNAVAILABLE (sem diferenciar o motivo).
  return app_private.price_cart(v_rid, p_fulfillment, p_items, p_delivery_zone_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- reorder_menu — reordena atomicamente (sort_order = posição na lista, base 0).
-- Erros estáveis: not_authenticated(28000), invalid_kind(22023), forbidden(42501),
-- invalid_ids(22023: vazia, nula, duplicada, >1000 ou id que não pertence ao
-- restaurante/tipo). Retorna {ok, kind, count}.
-- ---------------------------------------------------------------------------
create or replace function public.reorder_menu(p_restaurant uuid, p_kind text, p_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_table text;
  v_found integer;
  v_n     integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  v_table := case p_kind
    when 'category'       then 'menu_categories'
    when 'product'        then 'products'
    when 'modifier_group' then 'modifier_groups'
    when 'modifier'       then 'modifiers'
    else null
  end;
  if v_table is null then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;

  if p_restaurant is null or not public.has_permission(p_restaurant, 'menu.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_n := pg_catalog.cardinality(p_ids);
  if p_ids is null or v_n is null or v_n = 0 or v_n > 1000
     or pg_catalog.array_position(p_ids, null) is not null
     or (select pg_catalog.count(distinct u) from pg_catalog.unnest(p_ids) as u) <> v_n then
    raise exception 'invalid_ids' using errcode = '22023';
  end if;

  -- Serializa reordenações do mesmo restaurante/tipo (sem deadlock entre linhas).
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('reorder_menu:' || p_restaurant::text || ':' || p_kind, 0));

  execute pg_catalog.format(
    'select pg_catalog.count(*) from public.%I t where t.restaurant_id = $1 and t.id = any ($2)', v_table)
    into v_found using p_restaurant, p_ids;
  if v_found <> v_n then
    raise exception 'invalid_ids' using errcode = '22023';
  end if;

  execute pg_catalog.format(
    'update public.%I t set sort_order = (u.pos - 1)::integer '
    'from pg_catalog.unnest($2) with ordinality as u(id, pos) '
    'where t.restaurant_id = $1 and t.id = u.id and t.sort_order is distinct from (u.pos - 1)::integer', v_table)
    using p_restaurant, p_ids;

  perform public.log_audit(
    p_restaurant, 'menu.reordered', p_kind, null,
    pg_catalog.jsonb_build_object('kind', p_kind, 'count', v_n, 'ids', pg_catalog.to_jsonb(p_ids)));

  return pg_catalog.jsonb_build_object('ok', true, 'kind', p_kind, 'count', v_n);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privilégios (o Supabase concede EXECUTE a anon/authenticated por default
-- privileges; revoga tudo e devolve só o necessário).
-- ---------------------------------------------------------------------------
revoke all on function app_private.day_intervals(uuid, date)                          from public, anon, authenticated;
revoke all on function app_private.is_open_now(uuid, timestamptz)                    from public, anon, authenticated;
revoke all on function app_private.menu_products_json(uuid, uuid)                    from public, anon, authenticated;
revoke all on function app_private.price_cart(uuid, text, jsonb, uuid)               from public, anon, authenticated;
revoke all on function public.public_menu(text)                                      from public, anon, authenticated;
revoke all on function public.validate_cart(text, text, jsonb, uuid)                 from public, anon, authenticated;
revoke all on function public.reorder_menu(uuid, text, uuid[])                       from public, anon, authenticated;

grant execute on function public.public_menu(text)                    to anon, authenticated;
grant execute on function public.validate_cart(text, text, jsonb, uuid) to anon, authenticated;
grant execute on function public.reorder_menu(uuid, text, uuid[])     to authenticated;
