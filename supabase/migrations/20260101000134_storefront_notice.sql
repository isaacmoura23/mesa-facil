-- =============================================================================
-- 0134 · Aviso da vitrine (texto fixo no topo do cardápio público)
-- =============================================================================
-- Coluna nova em restaurant_settings. Como as colunas têm grants próprios
-- (migração 0113), a nova precisa de SELECT (anon + authenticated) e de
-- INSERT/UPDATE (authenticated; a RLS restringe a quem tem
-- restaurant.settings.manage). public_menu passa a devolver `restaurant.notice`.

alter table public.restaurant_settings
  add column storefront_notice text;

alter table public.restaurant_settings
  add constraint restaurant_settings_storefront_notice_len
  check (storefront_notice is null or char_length(storefront_notice) between 1 and 240);

grant select (storefront_notice) on public.restaurant_settings to anon, authenticated;
grant insert (storefront_notice), update (storefront_notice) on public.restaurant_settings to authenticated;

CREATE OR REPLACE FUNCTION public.public_menu(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
         s.whatsapp, s.phone, s.address_text, s.storefront_url, s.storefront_notice into v_set
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
      'storefront_url', v_set.storefront_url,
      'notice', v_set.storefront_notice),
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
$function$;
