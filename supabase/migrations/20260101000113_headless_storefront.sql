-- =============================================================================
-- DB-4 / 0113 — Etapa 2.5 (SaaS headless): variantes de produto, selos,
-- contato/vitrine em restaurant_settings, public_menu e price_cart atualizados,
-- limites de custo do carrinho (F-21) e RPC de origens para o CORS da API.
--
--   public.product_variants                 tabela nova (RLS + FORCE, grants mínimos)
--   public.products.badges                  text[] com CHECK
--   public.order_items.variant_id / variant_name_snapshot
--   public.restaurant_settings              whatsapp, phone, address_text,
--                                           storefront_origins, storefront_url
--   public.variant_has_orders(uuid)         guarda do DELETE de variante
--   public.get_storefront_origins(uuid)     leitura STAFF de storefront_origins
--   public.storefront_origins(text)         leitura PÚBLICA (anon) por slug
--   app_private.menu_products_json          + badges, variants, menor preço
--   public.public_menu                      + restaurant.contact / storefront_url
--   app_private.price_cart (validate_cart)  + variant_id, F-21
--
-- Novos códigos de erro de validate_cart / price_cart (além dos 15 do contrato
-- e de TOO_MANY_ITEMS / NOTES_TOO_LONG da 0112):
--   VARIANT_REQUIRED     produto com variantes ativas e item sem variant_id
--   VARIANT_NOT_ALLOWED  variant_id malformado, inexistente, de outro produto,
--                        de outro restaurante, ou produto sem variantes ativas
--                        (indistinguíveis entre si)
--   VARIANT_UNAVAILABLE  variante do produto, porém inativa ou indisponível
--   TOO_MANY_MODIFIERS   mais de 200 ids de adicionais no carrinho (soma das
--                        linhas com ≤ 50 ids; linha com > 50 segue como
--                        MODIFIER_GROUP_MAX). Nenhuma linha é processada.
--   TOO_MANY_ERRORS      após 50 erros a validação para: errors fica com os 50
--                        primeiros + este (último). items não é completado.
--
-- Privacidade: restaurant_settings é lido por anon/authenticated em restaurantes
-- ativos (policy pública). storefront_origins é a ÚNICA coluna fora do grant de
-- SELECT de anon e authenticated (grant por coluna). Equipe lê via
-- get_storefront_origins(); o CORS da API usa storefront_origins(slug).
-- ATENÇÃO: coluna nova em restaurant_settings precisa de GRANT SELECT próprio.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- product_variants
-- ---------------------------------------------------------------------------
create table public.product_variants (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  product_id    uuid not null,
  name          text not null,
  price_cents   integer not null check (price_cents >= 0),
  sort_order    integer not null default 0,
  is_available  boolean not null default true,   -- em estoque agora
  is_default    boolean not null default false,  -- pré-selecionada na vitrine
  is_active     boolean not null default true,   -- soft-delete / oculta
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, product_id)
    references public.products (restaurant_id, id) on delete cascade,
  constraint product_variants_name_len
    check (char_length(btrim(name)) between 1 and 40 and char_length(name) <= 40)
);
create index product_variants_restaurant_idx on public.product_variants (restaurant_id, sort_order);
create index product_variants_product_idx    on public.product_variants (restaurant_id, product_id, sort_order);
-- No máximo 1 variante padrão ativa por produto.
create unique index product_variants_one_default_uq
  on public.product_variants (product_id) where is_default and is_active;
-- Nome único (sem diferenciar caixa/espaços nas pontas) entre as ativas do produto.
create unique index product_variants_name_uq
  on public.product_variants (product_id, lower(btrim(name))) where is_active;

create trigger product_variants_touch before update on public.product_variants
  for each row execute function public.set_updated_at();

-- Variante que já foi vendida nunca é apagada (soft-delete via is_active).
create or replace function public.variant_has_orders(vid uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return coalesce(
    (select public.is_member(v.restaurant_id)
            and exists (select 1 from public.order_items oi where oi.variant_id = v.id)
       from public.product_variants v where v.id = vid),
    false);
end;
$$;
revoke execute on function public.variant_has_orders(uuid) from public, anon;
grant  execute on function public.variant_has_orders(uuid) to authenticated;

alter table public.product_variants enable row level security;
alter table public.product_variants force row level security;

create policy product_variants_select_public on public.product_variants
  for select to anon, authenticated
  using (is_active and public.restaurant_is_public(restaurant_id));
create policy product_variants_select_staff on public.product_variants
  for select to authenticated
  using (public.is_member(restaurant_id) or public.has_support_access(restaurant_id));
create policy product_variants_insert on public.product_variants
  for insert to authenticated
  with check (public.has_permission(restaurant_id, 'menu.manage'));
create policy product_variants_update on public.product_variants
  for update to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage'))
  with check (public.has_permission(restaurant_id, 'menu.manage'));
create policy product_variants_delete on public.product_variants
  for delete to authenticated
  using (public.has_permission(restaurant_id, 'menu.manage') and not public.variant_has_orders(id));

revoke all on table public.product_variants from anon, authenticated;
grant select on public.product_variants to anon;
grant select, insert, update, delete on public.product_variants to authenticated;

-- ---------------------------------------------------------------------------
-- products.badges
-- (sem subquery em CHECK: duplicados via comparação par a par; limite de 4 itens
-- e array unidimensional começando em 1 garantem que os índices cobrem tudo.)
-- ---------------------------------------------------------------------------
alter table public.products
  add column badges text[] not null default '{}';

alter table public.products
  add constraint products_badges_valid check (
    coalesce(array_ndims(badges), 1) = 1
    and coalesce(array_lower(badges, 1), 1) = 1
    and cardinality(badges) <= 4
    and badges <@ array['NEW', 'POPULAR', 'REGIONAL', 'SWEET', 'SPICY', 'VEGETARIAN']::text[]
    and (cardinality(badges) < 2 or badges[1] <> badges[2])
    and (cardinality(badges) < 3 or (badges[1] <> badges[3] and badges[2] <> badges[3]))
    and (cardinality(badges) < 4 or (badges[1] <> badges[4] and badges[2] <> badges[4] and badges[3] <> badges[4]))
  );

-- ---------------------------------------------------------------------------
-- order_items: variante escolhida + snapshot do nome.
-- Não há trigger/guard de colunas em order_items (sem policy de INSERT/UPDATE/
-- DELETE e sem grants de escrita: pedidos nascem só por RPC DEFINER), então as
-- colunas novas já nascem "congeladas" para clientes diretos.
-- ---------------------------------------------------------------------------
alter table public.order_items
  add column variant_id uuid,
  add column variant_name_snapshot text
    check (variant_name_snapshot is null or char_length(btrim(variant_name_snapshot)) between 1 and 40);

alter table public.order_items
  add constraint order_items_variant_fk
    foreign key (restaurant_id, variant_id)
    references public.product_variants (restaurant_id, id) on delete set null (variant_id);

alter table public.order_items
  add constraint order_items_variant_has_snapshot
    check (variant_id is null or variant_name_snapshot is not null);

create index order_items_variant_idx on public.order_items (variant_id) where variant_id is not null;

-- ---------------------------------------------------------------------------
-- restaurant_settings: contato e dados da vitrine headless
-- ---------------------------------------------------------------------------
alter table public.restaurant_settings
  add column whatsapp           text,
  add column phone              text,
  add column address_text       text,
  add column storefront_origins text[] not null default '{}',
  add column storefront_url     text;

alter table public.restaurant_settings
  add constraint restaurant_settings_whatsapp_fmt
    check (whatsapp is null or whatsapp ~ '^\+?[0-9]{10,15}$'),
  add constraint restaurant_settings_phone_fmt
    check (phone is null or phone ~ '^[0-9+()./ -]{6,30}$'),
  add constraint restaurant_settings_address_len
    check (address_text is null or char_length(address_text) <= 200),
  add constraint restaurant_settings_storefront_url_fmt
    check (storefront_url is null or (
      char_length(storefront_url) <= 200
      and storefront_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?([/?#][^[:space:]<>"'']*)?$'
    ));

-- storefront_origins: até 5 origens https completas (esquema+host[:porta]),
-- minúsculas, sem caminho, sem '*', sem duplicadas.
do $$
declare
  c_re  constant text := '^https://[a-z0-9.-]{1,253}(:[0-9]{1,5})?$';
  v_sql text := 'coalesce(array_ndims(storefront_origins), 1) = 1'
             || ' and coalesce(array_lower(storefront_origins, 1), 1) = 1'
             || ' and cardinality(storefront_origins) <= 5';
  i int;
  j int;
begin
  for i in 1 .. 5 loop
    v_sql := v_sql || format(
      ' and (cardinality(storefront_origins) < %1$s or coalesce(storefront_origins[%1$s] ~ %2$L, false))', i, c_re);
  end loop;
  for i in 1 .. 4 loop
    for j in i + 1 .. 5 loop
      v_sql := v_sql || format(
        ' and (cardinality(storefront_origins) < %2$s or storefront_origins[%1$s] <> storefront_origins[%2$s])', i, j);
    end loop;
  end loop;
  execute 'alter table public.restaurant_settings add constraint restaurant_settings_storefront_origins_valid check ('
          || v_sql || ')';
end
$$;

-- Leitura por coluna: tudo menos storefront_origins (anon E authenticated; a
-- policy pública dá a qualquer logado as linhas de restaurantes ativos).
-- INSERT/UPDATE de authenticated continuam como na 0108 (policy settings.manage).
do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.restaurant_settings'::regclass
    and a.attnum > 0 and not a.attisdropped
    and a.attname <> 'storefront_origins';
  revoke select on public.restaurant_settings from anon, authenticated;
  execute format('grant select (%s) on public.restaurant_settings to anon, authenticated', v_cols);
end
$$;

-- Leitura STAFF (membros do restaurante ou sessão de suporte).
create or replace function public.get_storefront_origins(p_restaurant uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_restaurant is null
     or not (public.is_member(p_restaurant) or public.has_support_access(p_restaurant)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select s.storefront_origins from public.restaurant_settings s where s.restaurant_id = p_restaurant
  ), '{}'::text[]);
end;
$$;
revoke all on function public.get_storefront_origins(uuid) from public, anon, authenticated;
grant execute on function public.get_storefront_origins(uuid) to authenticated;

-- Leitura PÚBLICA para o CORS da API: só restaurante ativo; senão '{}'.
create or replace function public.storefront_origins(p_slug text)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.storefront_origins
    from public.restaurants r
    join public.restaurant_settings s on s.restaurant_id = r.id
    where r.slug = pg_catalog.lower(pg_catalog.btrim(coalesce(p_slug, ''))) and r.status = 'active'
  ), '{}'::text[]);
$$;
revoke all on function public.storefront_origins(text) from public, anon, authenticated;
grant execute on function public.storefront_origins(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Auxiliar: mantém os N primeiros erros e fecha com TOO_MANY_ERRORS.
-- ---------------------------------------------------------------------------
create or replace function app_private.cap_errors(p_errors jsonb, p_max integer)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(t.e order by t.pos), '[]'::jsonb)
         || pg_catalog.jsonb_build_object(
              'code', 'TOO_MANY_ERRORS',
              'message', 'Há erros demais; corrija os primeiros e tente novamente.')
  from (
    select x.e, x.pos
    from pg_catalog.jsonb_array_elements(p_errors) with ordinality as x(e, pos)
    where x.pos <= p_max
  ) t;
$$;
revoke all on function app_private.cap_errors(jsonb, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- JSON de produtos: + badges, variants; price_cents = menor preço entre
-- variantes ativas e disponíveis (ou o preço base se não houver).
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
      'price_cents',   coalesce((
        select pg_catalog.min(v.price_cents)
        from public.product_variants v
        where v.restaurant_id = p.restaurant_id and v.product_id = p.id
          and v.is_active and v.is_available
      ), p.price_cents),
      'image_path',    p.image_path,
      'is_available',  p.is_available,
      'badges',        pg_catalog.to_jsonb(p.badges),
      'variants', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id',           v.id,
            'name',         v.name,
            'price_cents',  v.price_cents,
            'is_available', v.is_available,
            'is_default',   v.is_default
          ) order by v.sort_order, v.name, v.id)
        from public.product_variants v
        where v.restaurant_id = p.restaurant_id and v.product_id = p.id and v.is_active
      ), '[]'::jsonb),
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
-- price_cart — 0112 + variantes (variant_id) + limites de custo (F-21).
-- Entrada p_items: [{product_id, variant_id?, quantity, modifier_ids:[uuid], notes?}]
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
-- public_menu — + restaurant.contact / restaurant.storefront_url
-- (os produtos trazem badges/variants via app_private.menu_products_json)
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
         s.enabled_fulfillment_types, s.pickup_instructions,
         s.whatsapp, s.phone, s.address_text, s.storefront_url into v_set
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
      'logo_path', v_rest.logo_path, 'timezone', v_rest.timezone,
      'contact', pg_catalog.jsonb_build_object(
        'whatsapp',     v_set.whatsapp,
        'phone',        v_set.phone,
        'address_text', v_set.address_text),
      'storefront_url', v_set.storefront_url),
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

-- CREATE OR REPLACE preserva os GRANTs; reafirmados por clareza.
revoke all on function app_private.menu_products_json(uuid, uuid)      from public, anon, authenticated;
revoke all on function app_private.price_cart(uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.public_menu(text)                        from public, anon, authenticated;
grant execute on function public.public_menu(text) to anon, authenticated;
