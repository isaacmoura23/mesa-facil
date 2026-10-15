-- =============================================================================
-- DB-2 / 0109 — Storage: bucket público 'restaurant-public'.
--
-- Layout obrigatório dos objetos:
--   restaurants/{restaurant_id}/logo/<arquivo>       -> restaurant.settings.manage
--   restaurants/{restaurant_id}/products/<arquivo>   -> menu.manage
-- Leitura: bucket público => URL pública /object/public/... não passa por RLS
-- (imagens do cardápio). NÃO existe policy de SELECT para anon, então o bucket
-- não pode ser LISTADO anonimamente. Escrita/remoção: somente o path do próprio
-- restaurante e com a permissão correta (o owner pode logo e produtos; kitchen,
-- cashier e waiter não escrevem nada).
-- Limites: 5 MB e apenas imagens raster (SVG fica de fora de propósito: XSS).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'restaurant-public', 'restaurant-public', true, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Extrai o restaurant_id do 2º segmento do path SEM estourar erro: só faz o
-- cast para uuid depois de validar o formato (path malicioso => NULL => negado).
create or replace function public.storage_path_restaurant_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when (storage.foldername(p_name))[1] = 'restaurants'
     and (storage.foldername(p_name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then ((storage.foldername(p_name))[2])::uuid
  end;
$$;

-- Pode escrever/remover este objeto? (restaurante do path + permissão da pasta)
create or replace function public.can_manage_restaurant_asset(p_name text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    case (storage.foldername(p_name))[3]
      when 'logo'     then public.has_permission(s.rid, 'restaurant.settings.manage')
      when 'products' then public.has_permission(s.rid, 'menu.manage')
      else false
    end,
    false)
  from (select public.storage_path_restaurant_id(p_name) as rid) s
  where s.rid is not null;
$$;

revoke execute on function public.storage_path_restaurant_id(text) from public, anon;
revoke execute on function public.can_manage_restaurant_asset(text) from public, anon;
grant  execute on function public.storage_path_restaurant_id(text) to authenticated;
grant  execute on function public.can_manage_restaurant_asset(text) to authenticated;

-- A função acima retorna 0 linhas (NULL) quando o path é inválido; nas policies
-- usamos coalesce para tratar como false.
create policy restaurant_public_select_staff on storage.objects
  for select to authenticated
  using (bucket_id = 'restaurant-public' and coalesce(public.can_manage_restaurant_asset(name), false));

create policy restaurant_public_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'restaurant-public' and coalesce(public.can_manage_restaurant_asset(name), false));

create policy restaurant_public_update on storage.objects
  for update to authenticated
  using (bucket_id = 'restaurant-public' and coalesce(public.can_manage_restaurant_asset(name), false))
  with check (bucket_id = 'restaurant-public' and coalesce(public.can_manage_restaurant_asset(name), false));

create policy restaurant_public_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'restaurant-public' and coalesce(public.can_manage_restaurant_asset(name), false));
