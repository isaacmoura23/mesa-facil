-- =============================================================================
-- DB-2 / 0100 — Fundações do domínio: extensões, enums e funções utilitárias.
-- Depende (DB-1): public.restaurants. Funções do contrato (is_member,
-- has_permission, has_support_access) são usadas nas policies das migrações
-- seguintes — nunca reimplementadas aqui.
-- =============================================================================

-- pgcrypto (gen_random_bytes) fica no schema "extensions" no Supabase.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums de domínio (nomes sem prefixo de DB-1; falha explícita se houver colisão)
-- ---------------------------------------------------------------------------
create type public.fulfillment_type as enum ('DELIVERY', 'PICKUP', 'DINE_IN');

create type public.order_status as enum (
  'RECEIVED', 'CONFIRMED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY',
  'COMPLETED', 'CANCELLED', 'REJECTED'
);

-- Usado tanto em orders.payment_status quanto em payments.status
-- (em payments, 'UNPAID' é proibido por CHECK).
create type public.payment_status as enum ('UNPAID', 'PENDING', 'PAID', 'REFUNDED', 'FAILED');

create type public.payment_method as enum ('CASH', 'PIX', 'CREDIT', 'DEBIT', 'VOUCHER', 'OTHER');

create type public.table_status as enum ('AVAILABLE', 'OCCUPIED', 'CLEANING', 'INACTIVE');

create type public.tab_status as enum ('OPEN', 'CLOSED', 'CANCELLED');

create type public.print_document_type as enum (
  'KITCHEN_TICKET', 'PARTIAL_BILL', 'FINAL_BILL', 'ORDER_RECEIPT'
);

-- Nunca existe transição automática para PRINTED: apenas uma ação explícita
-- (RPC/serviço de impressão confirmado) pode marcar como impresso.
create type public.print_job_status as enum (
  'REQUESTED', 'DISPATCHED', 'PRINTED', 'FAILED', 'CANCELLED'
);

-- ---------------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------------

-- Código público aleatório (Crockford base32, sem I/L/O/U): 10 bytes = 80 bits
-- -> 16 caracteres. Inadivinhável; usado para acompanhamento público de pedido
-- e token de QR de mesa. Usa CSPRNG do pgcrypto.
create or replace function public.generate_public_code(p_bytes integer default 10)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_raw    bytea := extensions.gen_random_bytes(p_bytes);
  v_bits   text := '';
  v_result text := '';
  i        integer;
begin
  for i in 0 .. length(v_raw) - 1 loop
    v_bits := v_bits || (get_byte(v_raw, i)::bit(8))::text;
  end loop;
  for i in 0 .. (length(v_bits) / 5) - 1 loop
    v_result := v_result || substr(v_alphabet, (substr(v_bits, i * 5 + 1, 5)::bit(5))::integer + 1, 1);
  end loop;
  return v_result;
end;
$$;

-- Restaurante visível ao público? (status 'active'). SECURITY DEFINER para que
-- policies de anon não precisem de acesso à tabela restaurants.
create or replace function public.restaurant_is_public(rid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.restaurants r
    where r.id = rid and r.status = 'active'
  );
$$;

grant execute on function public.restaurant_is_public(uuid) to anon, authenticated;

-- Chamada direta de cliente (PostgREST) vs. código interno (RPC SECURITY DEFINER
-- roda como dono da função, service_role etc.). Triggers de proteção de colunas
-- usam isto: clientes diretos têm colunas sensíveis congeladas; as RPCs (que
-- validam permissão por conta própria) podem alterá-las.
create or replace function public.is_direct_client()
returns boolean
language sql
stable
set search_path = ''
as $$
  select current_user in ('anon', 'authenticated');
$$;

-- Privilégios (o Supabase concede EXECUTE a anon por default privileges).
-- restaurant_is_public: booleano sobre dado já público (restaurante ativo).
-- Demais helpers: só usuários logados (e service_role/dono, que mantêm acesso).
revoke execute on function public.generate_public_code(integer) from public, anon;
revoke execute on function public.is_direct_client() from public, anon;
grant  execute on function public.generate_public_code(integer) to authenticated;
grant  execute on function public.is_direct_client() to authenticated;
