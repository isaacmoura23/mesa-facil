-- =============================================================================
-- 0002 · profiles + trigger handle_new_user
-- =============================================================================

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  phone       text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint profiles_full_name_len check (full_name is null or char_length(full_name) <= 120),
  constraint profiles_phone_len     check (phone is null or char_length(phone) <= 30),
  constraint profiles_avatar_len    check (avatar_url is null or char_length(avatar_url) <= 500)
);

comment on table public.profiles is 'Perfil 1:1 com auth.users. Criado automaticamente por handle_new_user.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Cria o profile no signup. SECURITY DEFINER porque roda no contexto do Auth.
-- O full_name vem de raw_user_meta_data (apenas exibição; NUNCA usado em autorização).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill para usuários pré-existentes (no-op em banco novo).
insert into public.profiles (id)
select u.id from auth.users u
on conflict (id) do nothing;
