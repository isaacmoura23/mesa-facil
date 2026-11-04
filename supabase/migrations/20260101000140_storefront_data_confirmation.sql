-- =============================================================================
-- 0140 · Confirmação dos dados do cardápio (horários, taxa, contato, aviso)
-- =============================================================================
-- * storefront_confirmations: UMA linha por restaurante com quando e quem confirmou
--   e uma "impressão digital" (SHA-256 em hexa, calculada pelo servidor) dos dados
--   mostrados na hora da confirmação. Se os dados mudarem depois, a impressão deixa
--   de bater e a tela pede nova confirmação.
-- * confirm_storefront_data(p_restaurant, p_hash): quem tem restaurant.settings.manage
--   grava/atualiza a linha. Audita 'storefront.data_confirmed'.
-- Escrita SOMENTE pela RPC (SECURITY DEFINER). Clientes só leem (RLS).
-- =============================================================================
create table public.storefront_confirmations (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  confirmed_at  timestamptz not null default now(),
  confirmed_by  uuid references auth.users (id) on delete set null,
  data_hash     text not null check (data_hash ~ '^[0-9a-f]{64}$')
);

alter table public.storefront_confirmations enable row level security;
alter table public.storefront_confirmations force row level security;

create policy storefront_confirmations_select on public.storefront_confirmations
  for select to authenticated using (public.has_permission(restaurant_id, 'restaurant.settings.manage'));

revoke all on table public.storefront_confirmations from public, anon, authenticated;
grant select on public.storefront_confirmations to authenticated;

create or replace function public.confirm_storefront_data(p_restaurant uuid, p_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_restaurant is null or not public.has_permission(p_restaurant, 'restaurant.settings.manage') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_hash' using errcode = '22023';
  end if;

  insert into public.storefront_confirmations (restaurant_id, confirmed_at, confirmed_by, data_hash)
  values (p_restaurant, now(), v_uid, p_hash)
  on conflict (restaurant_id) do update
    set confirmed_at = excluded.confirmed_at,
        confirmed_by = excluded.confirmed_by,
        data_hash    = excluded.data_hash;

  perform public.log_audit(p_restaurant, 'storefront.data_confirmed', 'restaurant', p_restaurant, '{}'::jsonb);
end;
$$;

revoke all on function public.confirm_storefront_data(uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_storefront_data(uuid, text) to authenticated;
