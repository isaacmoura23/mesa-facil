-- =============================================================================
-- DB-6 / 0118 — price_cart com modo "equipe" (Fase 4).
--
--   app_private.price_cart_core(restaurant, fulfillment, items, zone, p_staff)
--       ÚNICA implementação do cálculo/validação (corpo de price_cart da 0113).
--   app_private.price_cart(restaurant, fulfillment, items, zone)
--       agora é um wrapper fino: price_cart_core(..., p_staff => false).
--       Mesma assinatura, mesmo retorno, mesmos GRANTs => validate_cart e
--       create_public_order seguem idênticos.
--
-- p_staff = true (usado só por create_staff_order, lançamento pela equipe):
--   IGNORA: restaurant_settings.accepts_orders, horário de funcionamento
--           (RESTAURANT_CLOSED) e pedido mínimo (BELOW_MINIMUM).
--   MANTÉM: restaurante ativo, modalidade habilitada (FULFILLMENT_DISABLED),
--           produto/variante/adicional ativos e disponíveis, grupos min/max,
--           quantidades, limites de custo (F-21) e preços SEMPRE do banco.
-- =============================================================================

create or replace function app_private.price_cart_core(
  p_restaurant_id    uuid,
  p_fulfillment      text,
  p_items            jsonb,
  p_delivery_zone_id uuid,
  p_staff            boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max_lines       constant integer := 50;
  c_max_qty         constant integer := 99;
  c_max_mods        constant integer := 50;    -- ids de adicionais por linha
  c_max_total_mods  constant integer := 200;   -- F-21: ids de adicionais no carrinho todo
  c_max_errors      constant integer := 50;    -- F-21: erros acumulados
  c_max_notes       constant integer := 500;
  c_uuid_re         constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  v_rest        record;
  v_set         record;
  v_zone        record;
  v_prod        record;
  v_prod_ok     boolean;
  v_mod         record;
  v_grp         record;
  v_var         record;
  v_fulfillment public.fulfillment_type;
  v_errors      jsonb := '[]'::jsonb;
  v_items       jsonb := '[]'::jsonb;
  v_n           integer;
  v_idx         integer;
  v_item        jsonb;
  v_err_before  integer;
  v_pid         uuid;
  v_vid         uuid;
  v_vraw        jsonb;
  v_has_var     boolean;
  v_var_json    jsonb;
  v_qty         integer;
  v_notes       text;
  v_raw         jsonb;
  v_el          jsonb;
  v_mid_txt     text;
  v_mid         uuid;
  v_mod_ids     uuid[];
  v_line_mods   jsonb;
  v_mods_sum    bigint;
  v_total_mods  bigint;
  v_truncated   boolean := false;
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
  if not found or (not p_staff and not v_set.accepts_orders) then
    v_errors := v_errors || pg_catalog.jsonb_build_object(
      'code', 'RESTAURANT_UNAVAILABLE', 'message', 'O restaurante não está aceitando pedidos no momento.');
  end if;
  v_min := coalesce(v_set.min_order_cents, 0);

  if not p_staff and not app_private.is_open_now(v_rest.id, pg_catalog.now()) then
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
    -- F-21: teto TOTAL de ids de adicionais (linhas com > c_max_mods já são
    -- recusadas sozinhas, sem custo, e não entram na soma).
    -- (CASE: a ordem de avaliação de WHERE não é garantida; o CASE evita
    -- jsonb_array_length sobre valor que não é array.)
    select coalesce(pg_catalog.sum(
             case
               when pg_catalog.jsonb_typeof(e.value) = 'object'
                and pg_catalog.jsonb_typeof(e.value -> 'modifier_ids') = 'array'
                then case
                       when pg_catalog.jsonb_array_length(e.value -> 'modifier_ids') <= c_max_mods
                       then pg_catalog.jsonb_array_length(e.value -> 'modifier_ids')
                       else 0
                     end
               else 0
             end), 0)
      into v_total_mods
    from pg_catalog.jsonb_array_elements(p_items) as e(value);
    if v_total_mods > c_max_total_mods then
      v_errors := v_errors || pg_catalog.jsonb_build_object(
        'code', 'TOO_MANY_MODIFIERS',
        'message', 'O carrinho pode ter no máximo ' || c_max_total_mods || ' adicionais no total.');
      v_n := 0;
    end if;
  end if;

  for v_idx in 0 .. v_n - 1 loop
    -- F-21: não acumula mais erros (ainda há itens por validar).
    if pg_catalog.jsonb_array_length(v_errors) >= c_max_errors then
      v_errors := app_private.cap_errors(v_errors, c_max_errors);
      v_truncated := true;
      exit;
    end if;

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

    -- variante: o preço unitário vem SEMPRE do banco (variante, se houver; senão o produto)
    v_unit     := v_prod.price_cents;
    v_var_json := null;
    select exists (
             select 1 from public.product_variants pv
             where pv.restaurant_id = v_rest.id and pv.product_id = v_prod.id and pv.is_active
           ) into v_has_var;
    v_vraw := v_item -> 'variant_id';
    if v_vraw is null or pg_catalog.jsonb_typeof(v_vraw) = 'null' then
      if v_has_var then
        v_errors := v_errors || pg_catalog.jsonb_build_object(
          'code', 'VARIANT_REQUIRED', 'item_index', v_idx, 'message', 'Escolha uma opção (tamanho) para este produto.');
      end if;
    else
      v_vid := null;
      if pg_catalog.jsonb_typeof(v_vraw) = 'string' and (v_vraw #>> '{}') ~ c_uuid_re then
        v_vid := (v_vraw #>> '{}')::uuid;
      end if;
      if v_vid is null then
        v_errors := v_errors || pg_catalog.jsonb_build_object(
          'code', 'VARIANT_NOT_ALLOWED', 'item_index', v_idx, 'message', 'Opção não permitida para este produto.');
      else
        select pv.id, pv.name, pv.price_cents, pv.is_active, pv.is_available into v_var
        from public.product_variants pv
        where pv.id = v_vid and pv.restaurant_id = v_rest.id and pv.product_id = v_prod.id;
        if not found then
          v_errors := v_errors || pg_catalog.jsonb_build_object(
            'code', 'VARIANT_NOT_ALLOWED', 'item_index', v_idx, 'message', 'Opção não permitida para este produto.');
        elsif not (v_var.is_active and v_var.is_available) then
          v_errors := v_errors || pg_catalog.jsonb_build_object(
            'code', 'VARIANT_UNAVAILABLE', 'item_index', v_idx,
            'message', 'A opção "' || v_var.name || '" está indisponível.');
        else
          v_unit := v_var.price_cents;
          v_var_json := pg_catalog.jsonb_build_object(
            'id', v_var.id, 'name', v_var.name, 'price_cents', v_var.price_cents);
        end if;
      end if;
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

    -- linha só entra se não teve nenhum erro (adicionais = delta sobre o preço unitário)
    if pg_catalog.jsonb_array_length(v_errors) = v_err_before then
      v_line := (v_unit + v_mods_sum) * v_qty;
      v_subtotal := v_subtotal + v_line;
      v_items := v_items || pg_catalog.jsonb_build_object(
        'product_id',       v_prod.id,
        'name',             v_prod.name,
        'variant',          v_var_json,
        'unit_price_cents', v_unit,
        'quantity',         v_qty,
        'modifiers',        v_line_mods,
        'modifiers_cents',  v_mods_sum,
        'notes',            v_notes,
        'line_total_cents', v_line);
    end if;
  end loop;

  -- F-21: o último item pode ter passado do teto; mantém só os primeiros.
  if not v_truncated and pg_catalog.jsonb_array_length(v_errors) > c_max_errors then
    v_errors := app_private.cap_errors(v_errors, c_max_errors);
  end if;

  -- pedido mínimo (só quando todas as linhas são válidas; senão o subtotal é parcial)
  if not p_staff and v_n > 0 and pg_catalog.jsonb_array_length(v_items) = v_n and v_subtotal < v_min then
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

-- Wrapper: assinatura pública anterior preservada (CREATE OR REPLACE mantém GRANTs).
create or replace function app_private.price_cart(
  p_restaurant_id    uuid,
  p_fulfillment      text,
  p_items            jsonb,
  p_delivery_zone_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.price_cart_core(p_restaurant_id, p_fulfillment, p_items, p_delivery_zone_id, false);
$$;

revoke all on function app_private.price_cart_core(uuid, text, jsonb, uuid, boolean) from public, anon, authenticated;
revoke all on function app_private.price_cart(uuid, text, jsonb, uuid)               from public, anon, authenticated;
